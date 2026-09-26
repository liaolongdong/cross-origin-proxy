/**
 * 日志表格的键盘选行判据（纯函数，界面侧只做装配）
 *
 * 抽出来只有一个理由：这一段是「哪个键该动、动到第几行」的判断，住在 SFC 里就在全仓没有
 * 运行时对应物（node 环境无 DOM，`components/` 渲染不出来），只能按源码契约钉一句「那几行还在」。
 * 判据本身是纯的，放这里就能按「输入 → 答案」逐个核。
 *
 * 三条口径写在这里，别在调用方另立一份：
 * - **只吃四个键**：`Tab` 及其余按键一律不消费。把 `Tab` 也 `preventDefault` 掉，
 *   整个抽屉的焦点顺序当场坏掉，比「键盘选不了行」更糟。
 * - **没有选中行时不凭空展开**：回车/空格在一行都没选中的情况下不消费、不动作。
 *   替用户挑第一行展开，等于让一次「按回车」变成界面上凭空多出来的一块内容。
 * - **到底了就停住但仍消费**：末行再按 ↓ 不移动，但 `preventDefault` 仍然要做——
 *   否则焦点在表格上时每按一次都把整个抽屉滚一下，看起来像是控件在跟人抢滚动条。
 */

/** 一次按键该做的事：移动到某行、展开/收起某行、或与之无关 */
export type LogRowKeyAction = 'move' | 'toggle' | 'none';

export interface LogRowKeyResult {
  /** 调用方是否要 `preventDefault()` */
  consumed: boolean;
  action: LogRowKeyAction;
  /** 目标行在窗口化列表里的下标；`action === 'none'` 时为 -1 */
  index: number;
}

/** 会被这一层接住的按键（其余一律不消费） */
const HANDLED_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' ']);

/**
 * @param rows 界面上真正画出来的那一份（窗口化之后的结果，不是全量日志）
 * @param currentId 当前高亮行的 id；`null` 表示一行都没选中
 * @param key `KeyboardEvent.key`
 */
export function resolveLogRowKey(
  rows: ReadonlyArray<{ id: string }>,
  currentId: string | null,
  key: string,
): LogRowKeyResult {
  const none: LogRowKeyResult = { consumed: false, action: 'none', index: -1 };
  if (!HANDLED_KEYS.has(key) || rows.length === 0) return none;

  const current = rows.findIndex(row => row.id === currentId);
  if (key === 'Enter' || key === ' ') {
    // 一行都没选中：不动作，也不抢走这次回车（页面原本的滚动/确认行为归页面）
    if (current < 0) return none;
    return { consumed: true, action: 'toggle', index: current };
  }

  const last = rows.length - 1;
  let next: number;
  if (key === 'ArrowDown') next = current < 0 ? 0 : Math.min(current + 1, last);
  else if (key === 'ArrowUp') next = current < 0 ? 0 : Math.max(current - 1, 0);
  // `HANDLED_KEYS` 将来加键时必须在这里补分支，否则新键会悄悄走 ↑ 的落点
  else return none;
  return { consumed: true, action: 'move', index: next };
}
