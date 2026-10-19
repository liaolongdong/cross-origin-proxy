/**
 * 「可见行集合变了」这一次要不要做行级过渡，以及哪些行算新出现
 *
 * 只放判据、不碰 DOM：调用方（`components/options/RuleTable.vue`）负责量矩形、找元素、放 FLIP。
 * 抽在这里的理由很实在——本环境没有 DOM，`jsdom` / `@vue/test-utils` 都没装，而「哪一档该动、
 * 哪一档绝不该动」恰恰是这一整块动效里唯一会画错东西的部分（该动的时候不动 = 少一次观感，
 * 不该动的时候动了 = 满负载表格每敲一个字符重放一遍动画）。做成纯函数就能按
 * 「输入 → 答案」逐个核，见 `tests/rowMotion.test.ts`。
 */

import { MAX_ANIMATED_ROWS } from '@/utils/constants';
import type { FlipRect } from '@/utils/transitions';

/**
 * 这一批行数是否落在过渡预算内
 *
 * 四个方向各有不动的理由：
 * - **上一屏没有行**：表格刚从骨架 / 空态 / 无匹配换进来，那一次交接由外层 `panel-swap`
 *   过渡负责说「这块内容换了」，再给每行补一次上浮就是两层动画叠在一起。
 * - **这一屏没有行**：表格整个被「无匹配」面板接管，同上，而且没有行可动。
 * - **任一侧超过 {@link MAX_ANIMATED_ROWS}**：性能账，见常量注释。
 *
 * 只数「上一屏」不够：从 3 行筛到 200 行那一次同样不该动，代价落在这一帧新挂的那 197 行上。
 */
export function rowMotionAffordable(prevCount: number, nextCount: number): boolean {
  return prevCount > 0 && nextCount > 0 && prevCount <= MAX_ANIMATED_ROWS && nextCount <= MAX_ANIMATED_ROWS;
}

/**
 * 是不是同一批行换了顺序（拖拽落位）
 *
 * 那份归位动画由 `onTableDrop` 自己量、自己做——它才知道「刚才那一次拖拽」对应哪一批矩形。
 * 这里必须认出来并让开，否则同一次重排放两遍 FLIP：后一遍拿的 First 已经是前一遍的中间态，
 * 行会往错误的方向滑一下。空对空不算同一批（两侧都空时没有任何行可动）。
 */
export function isSameRowSet(prevIds: readonly string[], nextIds: readonly string[]): boolean {
  if (prevIds.length !== nextIds.length || prevIds.length === 0) return false;
  const sortedKey = (ids: readonly string[]) => [...ids].sort().join('\u0000');
  return sortedKey(prevIds) === sortedKey(nextIds);
}

/**
 * 这一屏里上一屏不在的那些行（错峰落位的对象），按这一屏的顺序返回
 *
 * 只认 id、不认内容：同一条规则被筛掉又筛回来，它相对用户就是一件新事，值得再落一次位；
 * 而一直留在屏幕上的行由 FLIP 负责，两批不能重叠，否则同一行同时收到两种动画。
 */
export function freshRowIds(prevIds: readonly string[], nextIds: readonly string[]): string[] {
  const known = new Set(prevIds);
  return nextIds.filter(id => !known.has(id));
}

/** 一行在**版面**里的位置（`offsetTop` / `offsetLeft` 那一族坐标，不是视口坐标） */
export type RowPosition = { left: number; top: number };

/**
 * 由「上一版的版面位置」与「这一版的版面位置 + 视口位置」拼出 FLIP 要的 First
 *
 * 为什么不直接拿上一次 `getBoundingClientRect()` 的结果当 First，有三条都是坑：
 * - 视口坐标会把「两次量之间页面滚过多少」算成行的位移。筛选把 200 行收成 3 行时文档变短，
 *   浏览器自己就会把滚动位置夹回去——用户明明没滚，每一行却往反方向飞一次。
 * - `getBoundingClientRect()` 含**在途动画**的 transform。拖拽落位那次 FLIP 还在放的时候紧接着
 *   改筛选，量到的就是上一段动画的中间态，下一次归位的起点因此是编的。
 * - 页面上方还有会长短变化的东西（勾选后冒出来的批量按钮）。那属于整页平移，不是列表动过，
 *   不该由行的归位动画去补。
 *
 * `offsetTop` 三条都不沾：它是相对 `offsetParent`（这里就是那张表）的版面位置，
 * 不受滚动与 transform 影响，而表格自己往哪儿摆它不管。代价是要换算回视口坐标——
 * 这一次量到的视口位置加上版面位移，就是「它上一版该在的视口位置」。
 *
 * @param before 上一版的版面位置
 * @param now 这一版的版面位置（同一个元素，`row-key` 保证复用了同一个 `<tr>`）
 * @param nowViewport 这一版同一个元素的视口位置
 */
export function flipFirstRect(before: RowPosition, now: RowPosition, nowViewport: FlipRect): FlipRect {
  return { left: nowViewport.left + (before.left - now.left), top: nowViewport.top + (before.top - now.top) };
}
