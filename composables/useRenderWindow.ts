import { ref } from 'vue';

/**
 * 大列表的「按帧续载」窗口
 *
 * 一次挂满整屏行数时，慢的不是列表里哪个函数，而是行数本身：日志抽屉在 500 条上实测
 * 「点击 → 首行出现」要 3.7~4.9s（单个长任务 1.9s），而同一份夹具只挂 50 行是 392ms；
 * CPU profile 里组件自身代码占 0.5%。所以这里只做一件事——首屏挂一小截，剩下的每帧往前推一步，
 * 让浏览器在两次挂载之间有机会画帧、响应点击。
 *
 * 刻意不是分页、也不是虚拟化：窗口只往前推，不需要任何用户动作，最终这一屏还是完整的
 * （代价是全部挂上要 6~7s，比一次挂满晚一些，但那段时间里界面是可用可滚的）。
 */

/** 首屏一次挂上的行数 */
export const RENDER_WINDOW_START = 60;
/** 之后每帧续载的行数：再大单帧就重新长成任务，再小整列收口太慢 */
export const RENDER_WINDOW_STEP = 60;

/** `useRenderWindow` 的入参：两个判据都取 getter，避免把某一轮的快照烤进闭包 */
export interface RenderWindowOptions {
  /** 当前这一屏要显示的行数（筛选后的口径，不是原始数据量） */
  total: () => number;
  /** 这一屏是不是真的在屏幕上：关着的抽屉不配占主线程 */
  visible: () => boolean;
  /** 首屏行数 */
  start?: number;
  /** 每帧续载行数 */
  step?: number;
}

/**
 * 建立一个按帧推进的渲染窗口。
 *
 * 生命周期钩子留给调用方：本模块只在 `arm()` 之后自己排帧，组件卸载时须自行 `cancel()`，
 * 否则这一条 rAF 链会在页面后台多跑几帧才自然收敛（收敛即停，不会常驻）。
 */
export function useRenderWindow({
  total,
  visible,
  start = RENDER_WINDOW_START,
  step = RENDER_WINDOW_STEP,
}: RenderWindowOptions) {
  const rowCount = ref(start);
  let frame: number | null = null;

  /**
   * 把列表裁到当前窗口。
   *
   * 行数已经追上时**原样返回**那个数组：500 条日志每次续载都整份 `slice` 一遍，
   * 就成了「为了少挂几行反而每帧拷一遍大数组」。
   */
  function slice<T>(list: T[]): T[] {
    return rowCount.value >= list.length ? list : list.slice(0, rowCount.value);
  }

  function advance() {
    frame = null;
    if (!visible()) return;
    const totalRows = total();
    if (rowCount.value >= totalRows) return;
    const next = Math.min(rowCount.value + step, totalRows);
    rowCount.value = next;
    // 这一帧就把尾巴吃掉：再排一帧「进去看一眼、发现已经齐了、什么也不做」，
    // 等于每屏都白跑一帧，收口的时机也说不清了。
    if (next < totalRows) frame = requestAnimationFrame(advance);
  }

  /** 让窗口继续往前推；重复调用只排一帧，不会开出第二条并发的链 */
  function arm() {
    if (frame === null) frame = requestAnimationFrame(advance);
  }

  function cancel() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  /** 退回首屏那一截：列表要被重新看见时（例如抽屉再次打开）用它换回「先挂少一点」 */
  function reset() {
    cancel();
    rowCount.value = start;
  }

  return { rowCount, slice, arm, cancel, reset };
}
