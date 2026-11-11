import type { RequestLogEntry, DnrHitStat } from '@/utils/types';

/**
 * 日志统计：按 status 区间计数 success/error 并返回总数
 *
 * 区间划分：200-399 视为 success（包含 3xx 重定向成功），其余（含 undefined、0）算 error。
 * 阻断请求 native 表现为 status=0，纳入 error 统计。
 */
export function computeLogStats(logs: RequestLogEntry[]): { total: number; success: number; error: number } {
  let success = 0;
  let error = 0;
  for (const log of logs) {
    const status = log.status ?? 0;
    if (status >= 200 && status < 400) {
      success++;
    } else {
      error++;
    }
  }
  return { total: logs.length, success, error };
}

/**
 * 单条规则在两条通道上的命中读数。
 *
 * 两个数的时间窗完全不同，**不能相加**：`net` 是网络层（DNR）近 5 分钟的滚动窗口，
 * `ext` 是扩展通道（SW）自上次配置变更 / SW 回收以来的累计。求和得到的既不是任何一个
 * 时间段内的命中量，还会让用户以为刷新一下就"掉了"。
 */
export interface RuleHitStats {
  net: number;
  ext: number;
}

/**
 * 按 ruleId 归并两条通道的规则级命中数（分通道保留）
 *
 * 只在一侧出现过的规则另一侧记 0；渲染侧再决定「0」要不要显示——
 * 网络层读不到时（商店安装态、配额退避）0 是「不知道」而不是「没命中」，
 * 那层判断属于视图，需要 `DnrSampleState`，故不放这里。
 */
export function groupHitStatsByRule(
  dnrStats: Pick<DnrHitStat, 'ruleId' | 'hitCount'>[],
  swStats: Pick<DnrHitStat, 'ruleId' | 'hitCount'>[],
): Map<string, RuleHitStats> {
  const map = new Map<string, RuleHitStats>();
  const touch = (ruleId: string): RuleHitStats => {
    const existing = map.get(ruleId);
    if (existing) return existing;
    const created: RuleHitStats = { net: 0, ext: 0 };
    map.set(ruleId, created);
    return created;
  };

  for (const stat of dnrStats) touch(stat.ruleId).net += stat.hitCount;
  for (const stat of swStats) touch(stat.ruleId).ext += stat.hitCount;
  return map;
}

/** {@link hitSortKeyOf} 的入参：三条都已在视图侧算好，这里不重算、只回答「用哪个数参与比较」 */
export interface HitSortKeyInput {
  /** 这条规则走不走网络层（`isSimpleRule` 的结果；刻意不经总开关，与 `hitCells` 同一口径） */
  onNet: boolean;
  /** 网络层那份采样这一轮读不读得到（`isDnrCountReadable` 的结果） */
  readable: boolean;
  /** 这条规则的分通道读数；统计里根本没有它时是 `undefined` */
  stat: RuleHitStats | undefined;
}

/**
 * 这一条规则拿哪个数参与「按命中数排序」
 *
 * 只取**自己那一格**，读不到就是 `null`。两格绝不相加：网络层是近 5 分钟滚动窗口，后台是自上次
 * 配置变更以来的累计，相加出来的数不属于任何一段时间——那正是 `groupHitStatsByRule` 的注释
 * 早就写死的边界，排序键不是新增的第一处例外，也不许成为第二处。
 *
 * `null` 说的是「这一行说不出数」，不是一个可以和 7 比的数：把它当 0 参与比较，就等于在同一列里
 * 让「不知道」挤进「一次都没命中」那一堆，而那两格今天费力分开的恰恰就是这两件事。
 */
export function hitSortKeyOf({ onNet, readable, stat }: HitSortKeyInput): number | null {
  if (!stat) return null;
  if (onNet) return readable ? stat.net : null;
  return stat.ext;
}

/**
 * 命中数那一列的比较器：`null`（说不出数）与真数之间没有大小关系
 *
 * 抽成纯函数的唯一理由是**这一格里有一个只在运行时才看得见的坑**：Element Plus 把比较结果整体
 * 乘上方向（`element-plus/es/components/table/src/util.mjs` 里 `return order * +reverse`，
 * 降序时 `reverse` 是 `-1`），所以「让 unknown 沉底」这个意图在降序下会被翻成「unknown 置顶」。
 * 最直接的写法（升序返回 1、降序返回 -1）在源码上看着完全对称，实际会把这一列最没信息量的那一格
 * 摆到第一眼——而把它排上去的理由恰恰是「谁命中得少」。
 *
 * 因此调用方必须同时满足两条：只提供**升序**与**还原**两档（见 `RuleTable.vue` 的
 * `HIT_SORT_ORDERS`），以及把 unknown 放在比较之外而不是当成一个极小/极大的数。
 * 相等时交回 `whenEqual`，由调用方给一个稳定次序（名称），否则每点一次表头就换一批顺序。
 */
export function compareHitSortKeys(keyA: number | null, keyB: number | null, whenEqual: number): number {
  if (keyA === null && keyB === null) return whenEqual;
  if (keyA === null) return 1;
  if (keyB === null) return -1;
  return keyA === keyB ? whenEqual : keyA - keyB;
}
