import type { ProxyConfig, ProxyRule, RequestLogEntry, EnvironmentProfile } from '@/utils/types';
import { STORAGE_KEYS, DEFAULT_PROXY_CONFIG, MAX_LOG_ENTRIES, MAX_RULES } from '@/utils/constants';

// ─── Storage Mutex Lock ─────────────────────────────────────────────────────

let storageMutex: Promise<void> = Promise.resolve();

function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = storageMutex.then(fn, fn);
  storageMutex = next.then(() => {}, () => {});
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
  const config =
    (result[STORAGE_KEYS.PROXY_CONFIG] as ProxyConfig | undefined) ?? DEFAULT_PROXY_CONFIG;
  cachedConfig = config;
  return config;
}

/**
 * 保存完整代理配置
 */
export async function saveProxyConfig(config: ProxyConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.PROXY_CONFIG]: config });
  // 写入后使缓存失效，确保下次读取拿到最新值
  cachedConfig = null;
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
export async function toggleRule(
  ruleId: string,
  enabled?: boolean,
): Promise<{ success: boolean; error?: string }> {
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
 * 更新一条规则
 */
export async function updateRule(ruleId: string, updates: Partial<ProxyRule>): Promise<void> {
  return withStorageLock(async () => {
    const config = await getProxyConfig();
    const index = config.rules.findIndex(r => r.id === ruleId);
    if (index === -1) {
      throw new Error(`Rule not found: ${ruleId}`);
    }
    config.rules[index] = { ...config.rules[index], ...updates, updatedAt: Date.now() };
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

/**
 * 读取请求日志
 */
export async function getRequestLogs(): Promise<RequestLogEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.REQUEST_LOGS);
  return (result[STORAGE_KEYS.REQUEST_LOGS] as RequestLogEntry[] | undefined) ?? [];
}

/**
 * 保存请求日志（环形缓冲，最大 MAX_LOG_ENTRIES 条）
 */
export async function saveRequestLogs(logs: RequestLogEntry[]): Promise<void> {
  const trimmed = logs.slice(0, MAX_LOG_ENTRIES);
  await chrome.storage.local.set({ [STORAGE_KEYS.REQUEST_LOGS]: trimmed });
}

// ─── Request Log Buffered Writes ─────────────────────────────────────────────

let logBuffer: RequestLogEntry[] = [];
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 将缓冲区日志刷写到 storage
 */
export async function flushLogs(): Promise<void> {
  if (logFlushTimer !== null) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  if (logBuffer.length === 0) return;

  const bufferSnapshot = logBuffer;
  logBuffer = [];

  const logs = await getRequestLogs();
  logs.unshift(...bufferSnapshot);
  await saveRequestLogs(logs);
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
 * 添加一条请求日志（缓冲写入，10 条或 1s 刷写一次）
 */
export async function addRequestLog(entry: RequestLogEntry): Promise<void> {
  logBuffer.push(entry);
  scheduleLogFlush();
}

/**
 * 清空所有请求日志
 */
export async function clearRequestLogs(): Promise<void> {
  // 同时清空缓冲区
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
  const profiles = await getProfiles();
  const index = profiles.findIndex(p => p.id === profile.id);
  if (index >= 0) {
    profiles[index] = profile;
  } else {
    profiles.push(profile);
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILES]: profiles });
}

/**
 * 加载环境配置：将指定 profile 的规则集替换当前配置
 */
export async function loadProfile(profileId: string): Promise<{ success: boolean; error?: string }> {
  const profiles = await getProfiles();
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) {
    return { success: false, error: 'Profile not found' };
  }
  await saveProxyConfig({ enabled: true, rules: profile.rules });
  return { success: true };
}

/**
 * 删除一个环境配置
 */
export async function deleteProfile(profileId: string): Promise<void> {
  const profiles = await getProfiles();
  await chrome.storage.local.set({
    [STORAGE_KEYS.PROFILES]: profiles.filter(p => p.id !== profileId),
  });
}
