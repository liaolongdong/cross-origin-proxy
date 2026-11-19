/**
 * 容量上限的用户可配置层
 *
 * 三个上限（规则条数 / 日志条数 / 恢复点份数）的**默认值**仍是 `utils/constants.ts` 的
 * `MAX_RULES` / `MAX_LOG_ENTRIES` / `MAX_CONFIG_HISTORY`——那份是判据与测试的锚。本模块
 * 只在用户于设置页改过它们时提供覆盖值；storage 里没有这一键、或读出来是坏的，一切行为
 * 与改动之前逐位相同（回退默认）。这就是存量测试不需要注入式改造也能全绿的原因。
 *
 * 读取带模块级缓存：写入路径（`addRule` / 日志 flush）是高频调用，每笔都走一次
 * `storage.local.get` 是把热路径平白加一次跨进程往返。缓存失效靠 `storage.onChanged`：
 * 设置页写这一键的瞬间，SW 与所有扩展页各自的缓存同时作废，下一笔写入按新上限走——
 * 与 `entrypoints/background/autoOff.ts` 监听 `AUTO_OFF_MINUTES` 同一族的做法。
 *
 * 三个字段共用一份 sanitize（clamp 进合法区间、非法回退默认），读写两条路都过它：
 * 手改 storage 塞进 99999 条的「上限」不会绕开区间，塞进字符串不会让读取整条失败。
 */
import { STORAGE_KEYS, MAX_RULES, MAX_LOG_ENTRIES, MAX_CONFIG_HISTORY } from '@/utils/constants';
import { logger } from '@/utils/logger';

/** 三项容量上限的当前覆盖值（已是 clamp 后的合法数） */
export interface CapacityLimits {
  /** 规则条数上限（写入闸门与导入预览共用） */
  maxRules: number;
  /** 日志环形缓冲条数上限 */
  maxLogEntries: number;
  /** 配置恢复点份数上限 */
  maxConfigHistory: number;
}

/** 每项的合法区间：上界是收「误输入一个零」这类事故的，不是承诺「这么多条一定流畅」 */
export const LIMIT_BOUNDS = {
  maxRules: { min: 20, max: 500 },
  maxLogEntries: { min: 100, max: 2000 },
  maxConfigHistory: { min: 3, max: 20 },
} as const;

/** 用户从没改过（或读坏了）时的一切行为基准：与 constants 的 MAX_* 逐位相同 */
export const DEFAULT_CAPACITY_LIMITS: CapacityLimits = {
  maxRules: MAX_RULES,
  maxLogEntries: MAX_LOG_ENTRIES,
  maxConfigHistory: MAX_CONFIG_HISTORY,
};

function clampLimit(value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(num)));
}

/**
 * 任意输入 → 合法的 `CapacityLimits`。整份不是对象、字段缺失 / 非数 / 越界 / 小数
 * 都按字段各自回退或收口，绝不抛——这个键出现在读取热路径上。
 */
export function sanitizeCapacityLimits(raw: unknown): CapacityLimits {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    maxRules: clampLimit(input.maxRules, LIMIT_BOUNDS.maxRules, MAX_RULES),
    maxLogEntries: clampLimit(input.maxLogEntries, LIMIT_BOUNDS.maxLogEntries, MAX_LOG_ENTRIES),
    maxConfigHistory: clampLimit(
      input.maxConfigHistory,
      LIMIT_BOUNDS.maxConfigHistory,
      MAX_CONFIG_HISTORY,
    ),
  };
}

let cachedLimits: CapacityLimits | null = null;
let limitsWatchInstalled = false;

function invalidateCachedLimits(changes: Record<string, { newValue?: unknown }>): void {
  if (STORAGE_KEYS.CAPACITY_LIMITS in changes) cachedLimits = null;
}

/**
 * 读当前容量上限（带缓存与回退）。缓存命中时零 storage 往返——这正是它敢出现在
 * 日志刷写热路径上的前提。首次读取时顺手装 `storage.onChanged` 失效监听。
 */
export async function readCapacityLimits(): Promise<CapacityLimits> {
  if (cachedLimits !== null) return cachedLimits;
  if (!limitsWatchInstalled) {
    limitsWatchInstalled = true;
    try {
      chrome.storage.onChanged.addListener(invalidateCachedLimits);
    } catch {
      // onChanged 不在场（mock 环境或异常运行时）：缓存不失效，但每次进程重启都从零读
    }
  }
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.CAPACITY_LIMITS);
    const limits = sanitizeCapacityLimits(result?.[STORAGE_KEYS.CAPACITY_LIMITS]);
    cachedLimits = limits;
    return limits;
  } catch (error) {
    // 读不到就按「用户从没改过」走：上限这件事宁可暂时保守，也不能让规则写入整条失败
    logger.warn(
      'Failed to read capacity limits, using defaults:',
      error instanceof Error ? error.name : typeof error,
    );
    return { ...DEFAULT_CAPACITY_LIMITS };
  }
}

/**
 * 写入新的容量上限。调用方（设置页）负责先 clamp 显示值；这里过同一份 sanitize 再落盘，
 * 让「手改 storage」与「界面写入」到达同一形状。写失败返回 `false`，由调用方回滚显示值。
 */
export async function writeCapacityLimits(next: CapacityLimits): Promise<boolean> {
  const clean = sanitizeCapacityLimits(next);
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.CAPACITY_LIMITS]: clean });
    cachedLimits = clean;
    return true;
  } catch (error) {
    logger.warn(
      'Failed to write capacity limits:',
      error instanceof Error ? error.name : typeof error,
    );
    return false;
  }
}
