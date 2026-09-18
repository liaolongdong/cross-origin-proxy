import type { ProxyRule } from '@/utils/types';

/**
 * 把表格上报的勾选换算成「当前仍然存在」的规则，并换回规则列表里的最新对象。
 *
 * el-table 的选择列开启 `reserve-selection` 后，勾选按 row-key 保留在表格内部：
 * 换筛选条件时这正是想要的体验（先选一批、再筛出目标、一次批量操作），但代价是
 * 删除规则或整体替换规则集后，被删掉的规则对象仍留在选中项里，批量操作的计数会虚高、
 * 甚至作用在已不存在的 id 上；而编辑规则会用新对象替换数组项，沿用旧引用会读到过期的
 * `targetUrl`（批量迁移弹窗的预览正是取这个字段）。
 *
 * 按 id 换算一次解决两件事：不存在于 `currentRules` 的项被丢弃，命中的项换成当前对象。
 * 输出顺序沿用勾选顺序，与表格里的勾选观感一致。
 */
export function resolveSelectedRules(selection: readonly ProxyRule[], currentRules: readonly ProxyRule[]): ProxyRule[] {
  const currentById = new Map(currentRules.map(rule => [rule.id, rule]));
  return selection.flatMap(row => {
    const current = currentById.get(row.id);
    return current ? [current] : [];
  });
}
