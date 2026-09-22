import type {
  ProxyConfig,
  ProxyRule,
  RequestLogEntry,
  EnvironmentProfile,
  ImportMode,
  VariableStore,
  ConfigHistoryEntry,
  ConfigHistoryReason,
} from '@/utils/types';
import {
  STORAGE_KEYS,
  DEFAULT_PROXY_CONFIG,
  MAX_LOG_ENTRIES,
  MAX_LOG_BODY_SIZE,
  MAX_LOG_FIELD_SIZE,
  MAX_LOG_HEADER_COUNT,
  MAX_LOG_TOTAL_SIZE,
  MAX_RULES,
  MAX_CONFIG_HISTORY,
  MAX_CONFIG_HISTORY_TOTAL_SIZE,
} from '@/utils/constants';
import { truncateForLog } from '@/utils/formatters';
import { logger } from '@/utils/logger';
import { deduplicateRules } from '@/utils/ruleConflicts';
import { isValidRuleShape } from '@/utils/ruleValidation';
import { sanitizeVariables } from '@/utils/variables';
import { generateId } from '@/utils/generateId';

// ─── Storage Mutex Lock ─────────────────────────────────────────────────────

let storageMutex: Promise<void> = Promise.resolve();

function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = storageMutex.then(fn, fn);
  storageMutex = next.then(
    () => {},
    () => {},
  );
  return next;
}

// ─── Proxy Config Memory Cache ───────────────────────────────────────────────

let cachedConfig: ProxyConfig | null = null;

/** 凭据变量表缓存（真值只在后台侧落地，见 `utils/variables.ts` 的世界边界说明） */
let cachedVariables: VariableStore | null = null;

// 监听 storage 变化，跨上下文时使缓存失效
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (STORAGE_KEYS.PROXY_CONFIG in changes) cachedConfig = null;
  if (STORAGE_KEYS.VARIABLES in changes) cachedVariables = null;
});

/**
 * 手动使配置缓存失效
 */
export function invalidateConfigCache(): void {
  cachedConfig = null;
}

/**
 * 读取完整代理配置
 */
export async function getProxyConfig(): Promise<ProxyConfig> {
  if (cachedConfig !== null) {
    return cachedConfig;
  }
  const result = await chrome.storage.local.get(STORAGE_KEYS.PROXY_CONFIG);
  const config = (result[STORAGE_KEYS.PROXY_CONFIG] as ProxyConfig | undefined) ?? DEFAULT_PROXY_CONFIG;
  cachedConfig = config;
  return config;
}

/**
 * 取配置里的规则数组，**非数组一律当空**
 *
 * `storage.local` 按不可信输入对待：手改或旧版本残留都能让 `rules` 变成一个对象、一个字符串，
 * 或者干脆没有这个键。直接 `config.rules.filter(...)` 就在那一刻抛 TypeError，而三个调用点
 * 没有一个接得住：徽章监听器没有 catch（数字从此停在改动前那个值），`getProxyStatus` 整条读取
 * 失败（弹窗什么都读不出来）。取值口径只留这一个出口，别在调用点各写一份 `Array.isArray`。
 */
export function configRules(config: ProxyConfig | undefined): ProxyRule[] {
  return Array.isArray(config?.rules) ? config.rules : [];
}

/**
 * 保存完整代理配置
 */
export async function saveProxyConfig(config: ProxyConfig): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.PROXY_CONFIG]: config });
  } finally {
    // 失败同样要失效缓存：多数调用链是「读出缓存对象 → 就地改 → 写回」，
    // 写入被拒（配额/异常）时若保留缓存，内存里就留下一份 storage 里并不存在的配置
    cachedConfig = null;
  }
}

/**
 * 切换代理总开关（带锁，避免 messageRouter 侧 read-modify-write 竞态）
 */
export async function toggleProxy(enabled?: boolean): Promise<boolean> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    config.enabled = enabled ?? !config.enabled;
    await saveProxyConfig(config);
    return config.enabled;
  });
}

/**
 * 切换单条规则开关（带锁，避免并发竞态）
 */
export async function toggleRule(ruleId: string, enabled?: boolean): Promise<{ success: boolean; error?: string }> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    const rule = config.rules.find(r => r.id === ruleId);
    if (!rule) {
      return { success: false, error: `Rule not found: ${ruleId}` };
    }
    rule.enabled = enabled ?? !rule.enabled;
    rule.updatedAt = Date.now();
    await saveProxyConfig(config);
    return { success: true };
  });
}

/**
 * 添加一条规则（超过 MAX_RULES 上限时拒绝，避免规则集无限膨胀）
 */
export async function addRule(rule: ProxyRule): Promise<void> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    if (config.rules.length >= MAX_RULES) {
      throw new Error('MAX_RULES_EXCEEDED');
    }
    config.rules.push(rule);
    await saveProxyConfig(config);
  });
}

/**
 * 批量添加规则（单次写入，超过 MAX_RULES 上限时整体拒绝）
 */
export async function batchAddRules(rules: ProxyRule[]): Promise<void> {
  if (rules.length === 0) return;
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    if (config.rules.length + rules.length > MAX_RULES) {
      throw new Error('MAX_RULES_EXCEEDED');
    }
    config.rules.push(...rules);
    await saveProxyConfig(config);
  });
}

/**
 * 更新一条规则
 *
 * 整体替换语义：updates 为完整业务规则体（id 与时间戳除外），未出现的可选字段即被清除。
 * 不能改回部分合并——表单关闭 mock/拦截等开关后 updates 缺省该 key，合并会保留旧值导致功能无法关闭。
 * createdAt 保留原值，updatedAt 由存储层重新生成。
 */
export async function updateRule(
  ruleId: string,
  updates: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<void> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    const index = config.rules.findIndex(r => r.id === ruleId);
    if (index === -1) {
      throw new Error(`Rule not found: ${ruleId}`);
    }
    const { createdAt } = config.rules[index];
    config.rules[index] = { ...updates, id: ruleId, createdAt, updatedAt: Date.now() };
    await saveProxyConfig(config);
  });
}

/**
 * 删除一条规则
 */
export async function deleteRule(ruleId: string): Promise<void> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    config.rules = config.rules.filter(r => r.id !== ruleId);
    await saveProxyConfig(config);
  });
}

/**
 * 批量删除规则（一次写入）
 *
 * 这一步是成套换掉规则集，所以先记一份恢复点；一个都没删掉时不记，
 * 否则「选中 3 条、它们早已被删」这种空操作会挤掉真正的事故现场。
 */
export async function batchDeleteRules(ruleIds: string[]): Promise<ProxyConfig> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    const idSet = new Set(ruleIds);
    const remaining = config.rules.filter(r => !idSet.has(r.id));
    if (remaining.length !== config.rules.length) {
      await pushConfigHistory('batch-delete', config);
    }
    config.rules = remaining;
    await saveProxyConfig(config);
    return config;
  });
}

/**
 * 批量启停规则（一次写入，避免逐条 sendMessage 引发多次 DNR 重建）
 */
export async function batchToggleRules(ruleIds: string[], enabled: boolean): Promise<void> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    const idSet = new Set(ruleIds);
    const now = Date.now();
    for (const rule of config.rules) {
      if (idSet.has(rule.id)) {
        rule.enabled = enabled;
        rule.updatedAt = now;
      }
    }
    await saveProxyConfig(config);
  });
}

/**
 * 批量迁移目标 URL（一次写入）：按 updates 中的 id 定位规则并覆盖其 targetUrl。
 * 仅更新 targetUrl 确有变化的规则（幂等，避免无谓的 updatedAt 抖动与 DNR 重建）。
 */
export async function batchUpdateTargets(updates: { id: string; targetUrl: string }[]): Promise<void> {
  if (updates.length === 0) return;
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    const byId = new Map(config.rules.map(r => [r.id, r]));
    const now = Date.now();
    for (const update of updates) {
      const rule = byId.get(update.id);
      if (rule && rule.targetUrl !== update.targetUrl) {
        rule.targetUrl = update.targetUrl;
        rule.updatedAt = now;
      }
    }
    await saveProxyConfig(config);
  });
}

/**
 * 拖拽排序：按 orderedIds 重排规则数组，并重写 priority 使其与新顺序一致
 */
export async function reorderRules(orderedIds: string[]): Promise<void> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    const validIds = orderedIds.filter((id): id is string => typeof id === 'string');
    const idSet = new Set(validIds);
    const byId = new Map(config.rules.map(r => [r.id, r]));
    const reordered: ProxyRule[] = [];
    for (const id of validIds) {
      const rule = byId.get(id);
      if (rule) reordered.push(rule);
    }
    // 安全兜底：补充未出现在 orderedIds 中的规则
    for (const rule of config.rules) {
      if (!idSet.has(rule.id)) reordered.push(rule);
    }
    const now = Date.now();
    reordered.forEach((rule, index) => {
      rule.priority = index + 1;
      rule.updatedAt = now;
    });
    config.rules = reordered;
    await saveProxyConfig(config);
  });
}

/** `importProxyConfig` 的返回：成功时带回实际新增数与被去重跳过数 */
export interface ImportProxyConfigResult {
  success: boolean;
  error?: string;
  added?: number;
  skipped?: number;
}

/**
 * 导入配置：在存储锁内完成整体替换或合并
 *
 * 合并必须是原子的：不持锁的「读 → 去重 → 拼 → 写」会被并发的新增/导入互相覆盖，
 * 静默丢掉另一边刚写入的规则；去重与上限校验都得基于锁内这份最新快照。
 * 两种模式都受 MAX_RULES 约束（替换模式此前不检查，会把超限的脏配置整包收进来）。
 *
 * @param options.enabled 总开关目标值；`undefined` 表示沿用当前开关（合并模式的既有语义）
 */
export async function importProxyConfig(
  incoming: ProxyRule[],
  options: { mode: ImportMode; enabled?: boolean },
): Promise<ImportProxyConfigResult> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    if (options.mode === 'merge') {
      const newRules = deduplicateRules(config.rules, incoming);
      if (config.rules.length + newRules.length > MAX_RULES) {
        return { success: false, error: 'MAX_RULES_EXCEEDED' };
      }
      await saveProxyConfig({
        enabled: options.enabled ?? config.enabled,
        rules: [...config.rules, ...newRules],
      });
      return { success: true, added: newRules.length, skipped: incoming.length - newRules.length };
    }
    if (incoming.length > MAX_RULES) {
      return { success: false, error: 'MAX_RULES_EXCEEDED' };
    }
    // 成套替换前先把现状记进恢复点：这一步在写之前，回退要的正是「被换掉的那一份」
    await pushConfigHistory('replace-import', config);
    await saveProxyConfig({ enabled: options.enabled ?? false, rules: incoming });
    return { success: true, added: incoming.length, skipped: 0 };
  });
}

/**
 * 读取请求日志
 */
export async function getRequestLogs(): Promise<RequestLogEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.REQUEST_LOGS);
  return (result[STORAGE_KEYS.REQUEST_LOGS] as RequestLogEntry[] | undefined) ?? [];
}

/**
 * 按字符总量预算裁剪日志：从头部（最新）累加，超出预算即丢弃其后的条目。
 * 方向与 {@link saveRequestLogs} 的条数环形缓冲一致（数组尾部是最旧的日志）。
 */
export function trimLogsToBudget(logs: RequestLogEntry[], budget: number = MAX_LOG_TOTAL_SIZE): RequestLogEntry[] {
  let total = 0;
  const kept: RequestLogEntry[] = [];
  for (const log of logs) {
    total += logEntrySize(log);
    // 至少留下最新一条：否则「单条就超预算」会把整份日志清成空数组，刚发生的请求反而查不到
    if (total > budget && kept.length > 0) break;
    kept.push(log);
  }
  return kept;
}

function textLength(value: string | undefined): number {
  // 读出的历史数据可能缺字段，预算计算不该因此抛错
  return value?.length ?? 0;
}

function headerMapSize(headers: Record<string, string> | undefined): number {
  if (!headers) return 0;
  let total = 0;
  for (const [name, value] of Object.entries(headers)) total += textLength(name) + textLength(value);
  return total;
}

/**
 * 一条日志写进 storage 后占用的字符量
 *
 * 预算必须算整条日志，不是只算正文：URL、方法、规则名、错误文案与头表同样是写入的字符，
 * 只统计正文等于在配额上留第二个无上限出口。
 */
export function logEntrySize(log: RequestLogEntry): number {
  return (
    textLength(log.requestBody) +
    textLength(log.responseBody) +
    textLength(log.originalUrl) +
    textLength(log.proxiedUrl) +
    textLength(log.method) +
    textLength(log.ruleName) +
    textLength(log.error) +
    headerMapSize(log.requestHeaders) +
    headerMapSize(log.responseHeaders)
  );
}

/**
 * 保存请求日志（环形缓冲，最大 MAX_LOG_ENTRIES 条，并按正文总量预算裁剪）
 */
export async function saveRequestLogs(logs: RequestLogEntry[]): Promise<void> {
  const trimmed = trimLogsToBudget(logs.slice(0, MAX_LOG_ENTRIES));
  await chrome.storage.local.set({ [STORAGE_KEYS.REQUEST_LOGS]: trimmed });
}

// ─── Request Log Buffered Writes ─────────────────────────────────────────────

let logBuffer: RequestLogEntry[] = [];
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 刷写串行队列：阈值触发与防抖定时器可能交叠，若两个 flush 并发执行，
 * 各自读到旧日志后先后写入会互相覆盖导致日志丢失，因此串行化
 */
let flushQueue: Promise<void> = Promise.resolve();

/**
 * 将缓冲区日志刷写到 storage（并发安全）
 */
export function flushLogs(): Promise<void> {
  const next = flushQueue.then(doFlushLogs, doFlushLogs);
  flushQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

async function doFlushLogs(): Promise<void> {
  if (logFlushTimer !== null) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  if (logBuffer.length === 0) return;

  const bufferSnapshot = logBuffer;
  logBuffer = [];

  try {
    const logs = await getRequestLogs();
    // 数组约定「头部是最新」，而缓冲区是追加序（最旧在前），故倒序插到头部：
    // 直接 unshift 会让同批日志倒着展示，超上限时 `slice(0, MAX)` 丢掉的还正是刚发生的请求。
    // 不改动 bufferSnapshot 本身——失败回滚那条路径要按时间顺序放回去。
    logs.unshift(...bufferSnapshot.slice().reverse());
    await saveRequestLogs(logs);
  } catch (error) {
    // 快照已从缓冲区取走，直接丢弃等于静默丢日志：按时间顺序放回去等下一次刷写重试。
    // 缓冲区是「最旧在前」的追加序，故收口时切掉头部——配额持续失败也要留下刚发生的请求。
    logger.error('Request log flush failed, keeping entries for retry:', error);
    logBuffer = [...bufferSnapshot, ...logBuffer].slice(-MAX_LOG_ENTRIES);
  }
}

function scheduleLogFlush(): void {
  // 达到阈值立即刷写
  if (logBuffer.length >= 10) {
    void flushLogs();
    return;
  }
  // 否则 1s 防抖刷写
  if (logFlushTimer !== null) {
    clearTimeout(logFlushTimer);
  }
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    void flushLogs();
  }, 1000);
}

/** 日志里需要按长度收口的文本字段（`id`/`timestamp`/`status` 等由本扩展生成，天然有界） */
type TextLogField = 'requestBody' | 'responseBody' | 'originalUrl' | 'proxiedUrl' | 'method' | 'ruleName' | 'error';

/**
 * 日志里各文本字段的字符上限。正文另有更大额度（它才是排障主体），其余字段一律走
 * {@link MAX_LOG_FIELD_SIZE}——它们全都来自页面或上游响应，属于可控输入。
 */
const LOG_FIELD_LIMITS: Record<TextLogField, number> = {
  requestBody: MAX_LOG_BODY_SIZE,
  responseBody: MAX_LOG_BODY_SIZE,
  originalUrl: MAX_LOG_FIELD_SIZE,
  proxiedUrl: MAX_LOG_FIELD_SIZE,
  method: MAX_LOG_FIELD_SIZE,
  ruleName: MAX_LOG_FIELD_SIZE,
  error: MAX_LOG_FIELD_SIZE,
};

/**
 * 写入前收口：正文按 32K 截断，URL / 方法 / 规则名 / 错误文案按 8K 截断，
 * 头表按条数（{@link MAX_LOG_HEADER_COUNT}）与单值长度收口。
 *
 * 收口放在存储层而不是各写入点：`proxyHandler` 有五条分支写日志（mock/复杂/回退/异常/WS），
 * 漏掉任何一处都等于留一条无上限路径。只裁正文同样是不够的——页面可以用
 * `fetch('https://a.com/?' + 'x'.repeat(5e6))` 或一条超长 Cookie 头把字符写进日志，
 * 那些字段既不进正文上限、也不进总量预算时，500 条一样能占满配额。
 *
 * 未超限的条目原样返回（含 `undefined` 字段，HAR 导出按 `responseBody !== undefined`
 * 过滤，不能把它变成空字符串）；被裁过的可选字段只覆盖值，不新增键。
 */
export function capLogEntry(entry: RequestLogEntry): RequestLogEntry {
  const patch: Partial<RequestLogEntry> = {};
  for (const [field, limit] of Object.entries(LOG_FIELD_LIMITS) as [TextLogField, number][]) {
    const capped = capText(entry[field], limit);
    if (capped !== entry[field]) patch[field] = capped;
  }
  const requestHeaders = capHeaderMap(entry.requestHeaders);
  if (requestHeaders !== entry.requestHeaders) patch.requestHeaders = requestHeaders;
  const responseHeaders = capHeaderMap(entry.responseHeaders);
  if (responseHeaders !== entry.responseHeaders) patch.responseHeaders = responseHeaders;
  return Object.keys(patch).length > 0 ? { ...entry, ...patch } : entry;
}

function capText(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value.length <= limit) return value;
  return truncateForLog(value, limit);
}

/**
 * 头表收口：超出条数上限的丢弃、值超长的截断。
 *
 * 头名不裁——它由浏览器的头解析器给出（超长名在建 `Headers` 时就抛错），进不到这里。
 */
function capHeaderMap(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  const all = Object.entries(headers);
  const kept = all.slice(0, MAX_LOG_HEADER_COUNT);
  const capped: Record<string, string> = {};
  let trimmed = kept.length !== all.length;
  for (const [name, value] of kept) {
    const nextValue = capText(value, MAX_LOG_FIELD_SIZE) ?? '';
    if (nextValue !== value) trimmed = true;
    capped[name] = nextValue;
  }
  return trimmed ? capped : headers;
}

/**
 * 添加一条请求日志（缓冲写入，10 条或 1s 刷写一次）
 */
export async function addRequestLog(entry: RequestLogEntry): Promise<void> {
  logBuffer.push(capLogEntry(entry));
  scheduleLogFlush();
}

/**
 * 清空所有请求日志
 *
 * 与 flush 共用串行队列：若 clear 与进行中的 flush（已读旧数据、写入挂起）
 * 交错执行，flush 会把旧日志写回导致“清空后复活”，故排队串行化
 */
export function clearRequestLogs(): Promise<void> {
  const next = flushQueue.then(doClearLogs, doClearLogs);
  flushQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

async function doClearLogs(): Promise<void> {
  logBuffer = [];
  if (logFlushTimer !== null) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.REQUEST_LOGS]: [] });
}

// ─── Environment Profiles ────────────────────────────────────────────────────

/**
 * 获取所有环境配置
 */
export async function getProfiles(): Promise<EnvironmentProfile[]> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.PROFILES);
  return (result[STORAGE_KEYS.PROFILES] as EnvironmentProfile[] | undefined) ?? [];
}

/**
 * 保存一个环境配置（按 id 更新或新增）
 */
export async function saveProfile(profile: EnvironmentProfile): Promise<void> {
  return withStorageLock(async () => {
    const profiles = await getProfiles();
    const index = profiles.findIndex(p => p.id === profile.id);
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.push(profile);
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.PROFILES]: profiles });
  });
}

/**
 * 加载环境配置：将指定 profile 的规则集替换当前配置
 *
 * 与替换式导入同属成套替换，写之前记一份恢复点。「加载快照必然打开总开关」是既有语义，本轮不动。
 */
export async function loadProfile(profileId: string): Promise<{ success: boolean; error?: string }> {
  return withStorageLock(async () => {
    const profiles = await getProfiles();
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }
    await pushConfigHistory('load-profile', await getProxyConfig());
    await saveProxyConfig({ enabled: true, rules: profile.rules });
    return { success: true };
  });
}

/**
 * 删除一个环境配置
 */
export async function deleteProfile(profileId: string): Promise<void> {
  return withStorageLock(async () => {
    const profiles = await getProfiles();
    await chrome.storage.local.set({
      [STORAGE_KEYS.PROFILES]: profiles.filter(p => p.id !== profileId),
    });
  });
}

// ─── Credential Variables ────────────────────────────────────────────────────

/**
 * 读取凭据变量表
 *
 * 只允许后台侧调用：规则里的 `{{名称}}` 在出站请求组装前才展开，真值永远不下发到页面世界。
 * 与配置表同理由 `storage.onChanged` 失效，SW 被回收后从 `storage.local` 重建。
 */
export async function getVariables(): Promise<VariableStore> {
  if (cachedVariables !== null) return cachedVariables;
  const result = await chrome.storage.local.get(STORAGE_KEYS.VARIABLES);
  const sanitized = sanitizeVariables(result[STORAGE_KEYS.VARIABLES]);
  // 存储被手改成非键值对象时按空表处理：规则里的引用会原样发出并表现为上游 401，
  // 比让每次代理请求抛错可读
  cachedVariables = sanitized?.store ?? {};
  return cachedVariables;
}

/**
 * 整表保存凭据变量
 *
 * 走锁与 `saveProxyConfig` 同形：写入成功的同一上下文里立刻换上新表，避免下一次读还拿旧缓存；
 * 写入被拒（配额/异常）时置空缓存，不让内存里留下一份 storage 中不存在的凭据。
 * `dropped` 回报被收口丢弃的条目数，界面据此提示用户，而不是静默少存几把密钥。
 */
export async function saveVariables(variables: unknown): Promise<{ dropped: number }> {
  return withStorageLock(async () => {
    const sanitized = sanitizeVariables(variables);
    if (!sanitized) {
      cachedVariables = null;
      throw new Error('INVALID_VARIABLES_PAYLOAD');
    }
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.VARIABLES]: sanitized.store });
    } catch (error) {
      cachedVariables = null;
      throw error;
    }
    cachedVariables = sanitized.store;
    return { dropped: sanitized.dropped };
  });
}

// ─── Config Restore Points（配置恢复点） ──────────────────────────────────────

/** 读侧认识的成因；不在表里的按 `unknown` 展示，不硬塞成某个已知成因 */
const HISTORY_REASONS: readonly ConfigHistoryReason[] = [
  'replace-import',
  'load-profile',
  'batch-delete',
  'before-restore',
  'unknown',
];

function historyEntrySize(entry: ConfigHistoryEntry): number {
  return JSON.stringify(entry).length;
}

/**
 * 收口恢复点列表：先按份数、再按字符预算，两个方向都是「从最新一份往旧留」
 *
 * 与 {@link trimLogsToBudget} 同方向（数组头 = 最新）。这里刻意**不**保证「至少留一份」：
 * 单份就超预算，说明这份配置大到存它反而会挤掉用户下一次正常的规则保存，
 * 那种情况下宁可不给恢复点。
 */
export function capConfigHistory(
  entries: ConfigHistoryEntry[],
  maxEntries: number = MAX_CONFIG_HISTORY,
  budget: number = MAX_CONFIG_HISTORY_TOTAL_SIZE,
): ConfigHistoryEntry[] {
  let total = 0;
  const kept: ConfigHistoryEntry[] = [];
  for (const entry of entries.slice(0, maxEntries)) {
    total += historyEntrySize(entry);
    if (total > budget) break;
    kept.push(entry);
  }
  return kept;
}

/**
 * 读出侧的收口：`config_history` 是可以被手改的 storage 数据，而回退会把它重新变成生效配置
 *
 * 整份不是数组就当作没有恢复点（宁可空列表也不半解析）；单条缺 id 的直接丢弃，
 * 否则界面上没有可回退的句柄。规则逐条过与导入侧同一份结构判据，
 * `ruleCount` 因此就是「点回退能拿回几条」的真实数字。
 */
export function sanitizeConfigHistory(raw: unknown): ConfigHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: ConfigHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) continue;
    const rawConfig = e.config as Record<string, unknown> | undefined;
    if (!rawConfig || typeof rawConfig !== 'object' || !Array.isArray(rawConfig.rules)) continue;
    const rules = rawConfig.rules.filter(isValidRuleShape).map(r => ({ ...r }));
    entries.push({
      id: e.id,
      savedAt: typeof e.savedAt === 'number' && Number.isFinite(e.savedAt) ? e.savedAt : 0,
      reason: HISTORY_REASONS.includes(e.reason as ConfigHistoryReason) ? (e.reason as ConfigHistoryReason) : 'unknown',
      ruleCount: rules.length,
      config: { enabled: rawConfig.enabled === true, rules },
    });
  }
  return entries;
}

async function readConfigHistory(): Promise<ConfigHistoryEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG_HISTORY);
  // 写侧已按预算收口，这里只兜住"手改进 storage"这一种来路：列表不无界增长，界面不无界渲染
  return sanitizeConfigHistory(result[STORAGE_KEYS.CONFIG_HISTORY]).slice(0, MAX_CONFIG_HISTORY);
}

/** 恢复点列表（最新在前），只经消息层给扩展自己的页面读 */
export function getConfigHistory(): Promise<ConfigHistoryEntry[]> {
  return readConfigHistory();
}

/**
 * 记下写入前的整包快照
 *
 * **只能在已持锁的调用里用**（替换式导入、加载快照、批量删除、回退前自查）：快照必须与它所对应的
 * 那次写入取自同一份锁内配置，锁外再读一次就可能记成「别的时刻的配置」；`withStorageLock` 也不可
 * 重入。刻意不缓存这份数据：读它的是设置页一次列表渲染，写在成套操作那一刻，缓存只会带来陈旧。
 *
 * 恢复点是安全网而不是主流程，所以下面三种情形都只 warn 后**跳过这一份**，绝不把用户请求的那次
 * 替换带失败：读旧账抛错、新快照单份就越过预算（此时旧账原样留着）、写配额失败。吞掉异常不等于
 * 静默——配额真满时紧随其后的配置写入会带着自己的错误浮出水面，那才是用户需要知道的那一句。
 */
async function pushConfigHistory(reason: ConfigHistoryReason, snapshot: ProxyConfig): Promise<void> {
  let history: ConfigHistoryEntry[];
  try {
    history = await readConfigHistory();
  } catch (error) {
    // 连旧账都读不出来，就更不能往上写：跳过这一份，主写入照常
    logger.warn('Failed to read restore points, skipping this one:', error);
    return;
  }
  const entry: ConfigHistoryEntry = {
    id: generateId(),
    savedAt: Date.now(),
    reason,
    ruleCount: snapshot.rules.length,
    config: { enabled: snapshot.enabled, rules: snapshot.rules },
  };
  const next = capConfigHistory([entry, ...history]);
  if (!next.length && history.length) {
    // 单份新快照自己就越过预算：那就不记这一份，但**绝不能把已在预算内的旧恢复点一起抹掉**——
    // 用户刚做的正是整套替换，此刻那几份旧账是他唯一的退路
    logger.warn('Restore point skipped: this snapshot alone exceeds the config history budget');
    return;
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG_HISTORY]: next });
  } catch (error) {
    logger.warn('Failed to record a config restore point:', error);
  }
}

/**
 * 回退到一个恢复点
 *
 * 先把当前配置也记一份再写：回退自己不能是那个不可逆的动作（回退错了还能再回退回来）。
 * 只回退规则集，**总开关维持现状**——点「回退」要的是找回规则，而不是让代理被顺手打开或关掉；
 * 快照里那份 `enabled` 因此只是记录，不参与回退结果。
 */
export async function restoreConfigHistory(
  id: string,
): Promise<{ success: boolean; error?: string; restored?: number }> {
  return withStorageLock(async () => {
    const entry = (await readConfigHistory()).find(h => h.id === id);
    if (!entry) return { success: false, error: 'HISTORY_ENTRY_NOT_FOUND' };
    if (entry.ruleCount > MAX_RULES) {
      // 手改过的存储能塞进超限快照；照写会让 DNR 整批被拒，等于回退完代理直接不工作
      return { success: false, error: 'MAX_RULES_EXCEEDED' };
    }
    const current = await getProxyConfig();
    await pushConfigHistory('before-restore', current);
    await saveProxyConfig({ enabled: current.enabled, rules: entry.config.rules });
    return { success: true, restored: entry.ruleCount };
  });
}
