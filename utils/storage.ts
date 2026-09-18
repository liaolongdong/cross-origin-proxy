import type { ProxyConfig, ProxyRule, RequestLogEntry, EnvironmentProfile, ImportMode } from '@/utils/types';
import {
  STORAGE_KEYS,
  DEFAULT_PROXY_CONFIG,
  MAX_LOG_ENTRIES,
  MAX_LOG_BODY_SIZE,
  MAX_LOG_BODY_TOTAL,
  MAX_RULES,
} from '@/utils/constants';
import { truncateForLog } from '@/utils/formatters';
import { logger } from '@/utils/logger';
import { deduplicateRules } from '@/utils/ruleConflicts';

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

// 监听 storage 变化，跨上下文时使缓存失效
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && STORAGE_KEYS.PROXY_CONFIG in changes) {
    cachedConfig = null;
  }
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
 * 批量删除规则
 */
export async function batchDeleteRules(ruleIds: string[]): Promise<ProxyConfig> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    config.rules = config.rules.filter(r => !ruleIds.includes(r.id));
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
 * 按正文总量预算裁剪日志：从头部（最新）累加，超出预算即丢弃其后的条目。
 * 方向与 {@link saveRequestLogs} 的条数环形缓冲一致（数组尾部是最旧的日志）。
 */
export function trimLogsToBudget(logs: RequestLogEntry[], budget: number = MAX_LOG_BODY_TOTAL): RequestLogEntry[] {
  let total = 0;
  const kept: RequestLogEntry[] = [];
  for (const log of logs) {
    total += (log.requestBody?.length ?? 0) + (log.responseBody?.length ?? 0);
    // 至少留下最新一条：否则「单条就超预算」会把整份日志清成空数组，刚发生的请求反而查不到
    if (total > budget && kept.length > 0) break;
    kept.push(log);
  }
  return kept;
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

/**
 * 正文收口：超过 {@link MAX_LOG_BODY_SIZE} 的正文截断并留原始长度标记。
 *
 * 收口放在存储层而不是各写入点：`proxyHandler` 有五条分支写日志（mock/复杂/回退/异常/WS），
 * 漏掉任何一处都等于留一条无上限路径。未超限的条目原样返回（含 `undefined` 字段，
 * HAR 导出按 `responseBody !== undefined` 过滤，不能把它变成空字符串）。
 */
export function capLogEntryBodies(entry: RequestLogEntry): RequestLogEntry {
  const requestBody = capBody(entry.requestBody);
  const responseBody = capBody(entry.responseBody);
  if (requestBody === entry.requestBody && responseBody === entry.responseBody) return entry;
  return { ...entry, requestBody, responseBody };
}

function capBody(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_LOG_BODY_SIZE) return value;
  return truncateForLog(value, MAX_LOG_BODY_SIZE);
}

/**
 * 添加一条请求日志（缓冲写入，10 条或 1s 刷写一次）
 */
export async function addRequestLog(entry: RequestLogEntry): Promise<void> {
  logBuffer.push(capLogEntryBodies(entry));
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
 */
export async function loadProfile(profileId: string): Promise<{ success: boolean; error?: string }> {
  return withStorageLock(async () => {
    const profiles = await getProfiles();
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }
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
