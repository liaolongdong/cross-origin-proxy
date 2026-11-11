/**
 * 批量操作的「操作前旧值」快照与回写计划
 *
 * 存在的理由只有一句：`BATCH_UPDATE_TARGETS` / `BATCH_TOGGLE_RULES` / `REORDER_RULES` 这三类
 * 按既有口径**不落配置恢复点**（见 AGENTS.md「导入预览与配置恢复点」——只有替换式导入、
 * 加载快照、真正删掉了东西的批量删除才落），所以界面里那条 5 秒撤销是它们唯一的退路。
 * 也正因为如此，撤销**绝不新增第四类恢复点**：一个动作两份账，用户下一次翻恢复点列表
 * 就会看见两条本该是一条的记录，而那份安全网的存在意义恰恰是「数得出来」。
 *
 * 全部是纯函数，且快照一律取**操作前已在手上的那份数组**：不读 storage、不发消息——
 * 写完再读回来就已经是新值了，把那份当旧值回写等于什么都没做。
 *
 * 回写用的是与正向操作完全相同的三条消息，不新增消息类型：界面无需（也不该）在这里
 * 长出第二套「规则会怎么被改」的模型。
 */
import type { ProxyRule } from '@/utils/types';

/** 一条规则的目标地址旧值 */
export interface TargetSnapshot {
  id: string;
  targetUrl: string;
}

/** 一条规则的启用状态旧值 */
export interface EnabledSnapshot {
  id: string;
  enabled: boolean;
}

/** 一次回写的载荷形状：与 `BATCH_TOGGLE_RULES` 的入参一致（一批 id 配一个布尔） */
export interface ToggleRevert {
  ruleIds: string[];
  enabled: boolean;
}

/** 同一个 id 在一次批量操作里只算一条：重复的勾选会把同一条规则盖两遍，条数也跟着说谎 */
function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * 目标地址快照
 *
 * `targetUrl` 在类型上是必填，但这份数组来自 storage——手改过的存储里什么都有。
 * 读不出就当空串：回写成空串与用户自己清空目标地址是同一件事，
 * 比「撤销按钮点了没反应」诚实，也比抛错诚实。
 */
export function captureTargets(rules: readonly ProxyRule[], ids: readonly string[]): TargetSnapshot[] {
  const byId = new Map(rules.map(item => [item.id, item.targetUrl ?? ''] as const));
  const snapshot: TargetSnapshot[] = [];
  for (const id of uniqueIds(ids)) {
    if (!byId.has(id)) continue;
    snapshot.push({ id, targetUrl: byId.get(id) ?? '' });
  }
  return snapshot;
}

/** 启用状态快照：读不出布尔一律当 `false`，回写计划里不允许出现第三种状态 */
export function captureEnabled(rules: readonly ProxyRule[], ids: readonly string[]): EnabledSnapshot[] {
  const byId = new Map(rules.map(item => [item.id, item.enabled === true] as const));
  const snapshot: EnabledSnapshot[] = [];
  for (const id of uniqueIds(ids)) {
    if (!byId.has(id)) continue;
    snapshot.push({ id, enabled: byId.get(id) ?? false });
  }
  return snapshot;
}

/** 列表顺序快照：`REORDER_RULES` 收的就是一份 id 顺序，回写同形状，不另立一种语言 */
export function captureOrder(rules: readonly ProxyRule[]): string[] {
  return rules.map(item => item.id);
}

/**
 * 按旧值分组的回写计划（至多两笔）
 *
 * `batchToggleRules(ruleIds, enabled)` 一次只能给一个布尔，而**操作前**的状态可以是混合的：
 * 勾着 3 条按「全部停用」，旧值可能是 2 真 1 假。一笔回写就会把那条本来停用的也停一遍——
 * 界面说一句「已恢复」而存储里少了一条，正是这一格要避免的谎。
 *
 * 旧值全同时只出一笔：多一笔写入就多一次没必要的存储往返与 DNR 重同步。
 */
export function planRevertToggles(snapshot: readonly EnabledSnapshot[]): ToggleRevert[] {
  const on: string[] = [];
  const off: string[] = [];
  for (const item of snapshot) {
    if (item.enabled) on.push(item.id);
    else off.push(item.id);
  }
  const plan: ToggleRevert[] = [];
  if (on.length > 0) plan.push({ ruleIds: on, enabled: true });
  if (off.length > 0) plan.push({ ruleIds: off, enabled: false });
  return plan;
}
