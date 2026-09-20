import { logger } from '@/utils/logger';
import type { DnrSample } from '@/utils/types';
import {
  DNR_AGGREGATE_TTL_MS,
  DNR_QUOTA_WINDOW_MS,
  DNR_SAMPLE_CALL_BUDGET,
  DNR_TAB_CACHE_SIZE,
  DNR_TAB_TTL_MS,
} from '@/utils/constants';
import { aggregateMatchedInfo } from './dnrStats';

/**
 * DNR 命中采样器 —— 全仓唯一允许调用 `getMatchedRules` 的模块
 *
 * 为什么要收在这里：`declarativeNetRequestFeedback` 的读取接口是
 * 「20 次 / 10 分钟、窗口只回看 5 分钟」的稀缺资源，而本批有两个读端
 * （popup 每次开、options 每次刷新与每次回到前台）。两处各调各的，最先撞上的
 * 就是配额，而且失败是「立即抛错」不是返回空数组，静默兜底会把「读不到」显示成「零命中」。
 *
 * 分工：采样、缓存、配额与退避在这里；映射与折叠在 `dnrStats`。
 * 这里的全部状态都是模块级的，SW 回收即重建 —— 它只是缓存，不是事实来源。
 */

/** 缓存条目：`at` 是本机写入时刻，与 `sample.sampledAt` 同值，只为可读性分开 */
interface CacheEntry {
  sample: DnrSample;
  at: number;
}

let aggregateCache: CacheEntry | null = null;

/** 按标签页的采样缓存。写入序即逐出序；上限 `DNR_TAB_CACHE_SIZE`，不注册 `tabs.onRemoved` */
const tabCache = new Map<number, CacheEntry>();

/** 当前 10 分钟滑窗内已经发生的 `getMatchedRules` 调用时刻 */
const callTimes: number[] = [];

/** 退避截止时刻：API 抛错后这段时间内不再尝试调用（超限是立即失败，重试只会继续失败） */
let backoffUntil = 0;

/** 「没有读数」：`sampledAt` 保持 0，让 UI 能把它渲染成「—」而不是 0 */
function unknownSample(tabId?: number, stale = false): DnrSample {
  return tabId === undefined ? { stats: [], sampledAt: 0, stale } : { stats: [], sampledAt: 0, stale, tabId };
}

/** 滑窗内是否已用掉软上限（顺带把窗口外的旧记录滚掉） */
function budgetSpent(now: number): boolean {
  while (callTimes.length > 0 && now - callTimes[0] > DNR_QUOTA_WINDOW_MS) callTimes.shift();
  return callTimes.length >= DNR_SAMPLE_CALL_BUDGET;
}

/**
 * 当前是否存在生效的动态规则
 *
 * 空集时不可能有任何命中：通配符规则集为空、以及**代理总开关关闭**（`buildDnrRules` 会编译出
 * 空规则集）两种情形都由这一个免费调用覆盖，省下的是一次真正吃配额读取。
 * 判定本身失败时按「可能有」处理，让真正的调用去给答案——这里不该替 API 下结论。
 */
async function hasActiveDnrRules(): Promise<boolean> {
  try {
    return (await chrome.declarativeNetRequest.getDynamicRules()).length > 0;
  } catch (error) {
    logger.warn('getDynamicRules failed, falling through to match sampling:', error);
    return true;
  }
}

function writeCache(tabId: number | undefined, entry: CacheEntry): void {
  if (tabId === undefined) {
    aggregateCache = entry;
    return;
  }
  tabCache.set(tabId, entry);
  while (tabCache.size > DNR_TAB_CACHE_SIZE) {
    const oldest = tabCache.keys().next().value;
    if (oldest === undefined) break;
    tabCache.delete(oldest);
  }
}

/**
 * 两个入口共用的判定顺序：
 * 1. 缓存新鲜 → 直接返回，不调 API；
 * 2. 没有生效的动态规则 → 返回「没有读数」，不调 API（也不记为消耗配额）；
 * 3. 退避中或滑窗已满 → 返回上次缓存并标记 `stale`；无缓存则「没有读数 + stale」；
 * 4. 否则真正调用；抛错 → 进入退避，并返回第 3 步的兜底。
 */
async function readOrSample(
  filter: chrome.declarativeNetRequest.MatchedRulesFilter,
  cached: CacheEntry | null,
  ttlMs: number,
  tabId?: number,
): Promise<DnrSample> {
  const now = Date.now();
  if (cached && now - cached.at < ttlMs) return { ...cached.sample, stale: false };

  if (!(await hasActiveDnrRules())) return unknownSample(tabId);

  if (now < backoffUntil || budgetSpent(now)) {
    return cached ? { ...cached.sample, stale: true } : unknownSample(tabId, true);
  }

  callTimes.push(now);
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules(filter);
    const fresh: DnrSample = {
      stats: aggregateMatchedInfo(rulesMatchedInfo),
      sampledAt: now,
      stale: false,
      ...(tabId === undefined ? {} : { tabId }),
    };
    writeCache(tabId, { sample: fresh, at: now });
    return fresh;
  } catch (error) {
    backoffUntil = now + DNR_AGGREGATE_TTL_MS;
    logger.warn('getMatchedRules failed (quota or permission), serving cached sample:', error);
    return cached ? { ...cached.sample, stale: true } : unknownSample(tabId, true);
  }
}

/** 全局聚合采样（options 命中列与日志抽屉用） */
export function sampleAggregate(): Promise<DnrSample> {
  return readOrSample({}, aggregateCache, DNR_AGGREGATE_TTL_MS);
}

/**
 * 按标签页采样（popup 的「本页 · 近 5 分钟」用）。
 * `MatchedRulesFilter` 只有单数 `tabId`，一次调用问不了多个标签页，
 * 所以每个标签页各占一份缓存、各自消耗一次配额。
 */
export function sampleForTab(tabId: number): Promise<DnrSample> {
  return readOrSample({ tabId }, tabCache.get(tabId) ?? null, DNR_TAB_TTL_MS, tabId);
}

/**
 * 配置或 DNR 规则集变更后丢弃全部缓存，下次读端强制重新采样
 *
 * 为什么要丢：同步是 `removeRuleIds` 全量重建，DNR ruleId 与代理规则的映射可能整体改变，
 * 旧窗口里的计数已无法归属到当前规则；总开关关闭时同样不能让「历史命中」冒充「现在在工作」。
 * 退避窗口与滑窗计数**不清**：配额是浏览器侧的真实事实，清掉只会让下一次注定失败。
 */
export function invalidateDnrSample(reason: 'config-changed' | 'dnr-synced'): void {
  aggregateCache = null;
  tabCache.clear();
  logger.debug(`DNR sample cache dropped (${reason})`);
}
