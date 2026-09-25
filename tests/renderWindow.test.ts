/**
 * 大列表的按帧续载窗口（`composables/useRenderWindow.ts`）
 *
 * 起因是 2026-09-25 那次满容量实测：日志抽屉一次挂 500 行，「点击 → 首行出现」要 3.7~4.9s，
 * 而代价只跟**行数**有关（CPU profile 里组件自身代码 0.5%）。修法是首屏挂一截、其余每帧往前推，
 * 于是这个窗口自己成了承重件——它一旦不往前走，用户看到的就是「日志只有 60 条」，
 * 而且是一条错得很安静的话：滚动条、统计条都照常，没人会怀疑是没挂完。
 * 所以这里按「窗口会不会停住」来选断言，而不是按它现在恰好推进到几。
 *
 * 本环境（vitest node）没有 DOM，`requestAnimationFrame` / `cancelAnimationFrame` 一律手桩，
 * 帧由测试自己踩：一次 `runFrames(1)` 等于让浏览器画一帧。
 * **测不到的那半**：`el-table` 一次挂 60 行到底比挂 500 行快多少，是真机量的（见
 * `.test-tmp/verify-drawer-curve.cjs`），这里只钉「推进 / 收手 / 退回首屏」这三件事。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { useRenderWindow, RENDER_WINDOW_START, RENDER_WINDOW_STEP } from '@/composables/useRenderWindow';

/** 手桩的帧队列：key 是 rAF 返回的句柄，值是该帧要跑的回调 */
let frames = new Map<number, () => void>();
let frameId = 0;
const cancelCalls: number[] = [];

function runFrames(count = 1) {
  for (let i = 0; i < count; i++) {
    const due = [...frames.values()];
    frames.clear();
    due.forEach(cb => cb());
  }
}

beforeEach(() => {
  frames = new Map();
  frameId = 0;
  cancelCalls.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    const id = ++frameId;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelCalls.push(id);
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 一个可改的「这一屏有多少行」，模拟筛选与自动刷新带来的长度变化 */
function makeList(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `L${i}` }));
}

describe('useRenderWindow：窗口只往前推', () => {
  it('初始只交出首屏那一截，而不是一整屏', () => {
    const win = useRenderWindow({ total: () => 500, visible: () => true });
    const list = makeList(500);
    expect(win.rowCount.value).toBe(RENDER_WINDOW_START);
    expect(win.slice(list)).toHaveLength(RENDER_WINDOW_START);
    expect(list).toHaveLength(500);
  });

  it('每帧前进一格，追平之后不再排下一帧', () => {
    const win = useRenderWindow({ total: () => 500, visible: () => true });
    win.arm();
    expect(frames.size).toBe(1);

    const seen: number[] = [];
    // 20 帧足够跨过 500 行：多跑的那些帧必须什么都没排,否则这条链永不停
    for (let i = 0; i < 20; i++) {
      runFrames(1);
      seen.push(win.rowCount.value);
    }
    expect(seen[0]).toBe(RENDER_WINDOW_START + RENDER_WINDOW_STEP);
    expect(win.rowCount.value).toBe(500);
    // 收口那一帧之后队列必须是空的——「还留着待办」就是后台一直重排整张表
    expect(frames.size).toBe(0);
    // 步长固定，且最后一步钳在总数上，不会挂出 520 行
    expect(seen.slice(0, 3)).toEqual([120, 180, 240]);
    expect(seen.filter(n => n > 500)).toEqual([]);
  });

  it('最后一帧直接把尾巴吃掉：追平之后不再白排一帧', () => {
    const win = useRenderWindow({ total: () => 150, visible: () => true });
    win.arm();
    runFrames(1);
    expect(win.rowCount.value).toBe(RENDER_WINDOW_START + RENDER_WINDOW_STEP);
    expect(frames.size).toBe(1);
    runFrames(1);
    // 这一步从 120 走到 150（不足一个步长），已经齐了就不该再有下一帧
    expect(win.rowCount.value).toBe(150);
    expect(frames.size).toBe(0);
  });

  it('本来就比首屏短的那一屏：一帧不排，slice 原样交出', () => {
    const win = useRenderWindow({ total: () => 3, visible: () => true });
    const list = makeList(3);
    win.arm();
    expect(frames.size).toBe(1);
    runFrames(1);
    expect(frames.size).toBe(0);
    expect(win.rowCount.value).toBe(RENDER_WINDOW_START);
    expect(win.slice(list)).toBe(list);
  });

  it('整屏挂完 slice 交回原数组本身', () => {
    const list = makeList(500);
    const win = useRenderWindow({ total: () => 500, visible: () => true });
    win.arm();
    for (let i = 0; i < 12; i++) runFrames(1);
    expect(win.rowCount.value).toBe(500);
    // 每次续载都整份 slice 一遍的话,500 条日志就成了「为了少挂几行反而每帧拷一遍大数组」
    expect(win.slice(list)).toBe(list);
  });

  it('重复 arm 只有一帧在途：两条链会同帧各推一格，界面看到的就是双倍步长', () => {
    const win = useRenderWindow({ total: () => 500, visible: () => true });
    win.arm();
    win.arm();
    win.arm();
    expect(frames.size).toBe(1);
    runFrames(1);
    expect(win.rowCount.value).toBe(RENDER_WINDOW_START + RENDER_WINDOW_STEP);
  });

  it('列表变短（筛选）时窗口不回退，短的这一屏整体可见', () => {
    const list = makeList(500);
    const win = useRenderWindow({ total: () => list.length, visible: () => true });
    win.arm();
    runFrames(3);
    const before = win.rowCount.value;
    expect(before).toBeGreaterThan(RENDER_WINDOW_START);

    const filtered = list.slice(0, 30);
    expect(win.slice(filtered)).toBe(filtered);
    expect(win.rowCount.value).toBe(before);
  });

  it('列表变长（新日志进来）之后重新 arm，会继续推到新的总数', () => {
    let total = 200;
    const win = useRenderWindow({ total: () => total, visible: () => true });
    win.arm();
    for (let i = 0; i < 10 && win.rowCount.value < 200; i++) runFrames(1);
    expect(win.rowCount.value).toBe(200);
    expect(frames.size).toBe(0);

    total = 500;
    win.arm();
    for (let i = 0; i < 10 && win.rowCount.value < total; i++) runFrames(1);
    expect(win.rowCount.value).toBe(500);
    expect(win.slice(makeList(500))).toHaveLength(500);
  });
});

describe('useRenderWindow：没人看的那一屏不干活', () => {
  it('这一屏不在屏幕上时，一帧都不推进，也不留待办', () => {
    const win = useRenderWindow({ total: () => 500, visible: () => false });
    win.arm();
    runFrames(3);
    expect(win.rowCount.value).toBe(RENDER_WINDOW_START);
    expect(frames.size).toBe(0);
  });

  it('推进途中屏幕收起来：当帧收手，剩下的行不再往后挂', () => {
    let visible = true;
    const win = useRenderWindow({ total: () => 500, visible: () => visible });
    win.arm();
    runFrames(2);
    expect(win.rowCount.value).toBe(RENDER_WINDOW_START + RENDER_WINDOW_STEP * 2);
    visible = false;
    runFrames(2);
    expect(win.rowCount.value).toBe(RENDER_WINDOW_START + RENDER_WINDOW_STEP * 2);
    expect(frames.size).toBe(0);
  });

  it('reset 退回首屏那一截并取消在途的那一帧', () => {
    const win = useRenderWindow({ total: () => 500, visible: () => true });
    win.arm();
    runFrames(2);
    const inFlight = [...frames.keys()];
    win.reset();
    expect(win.rowCount.value).toBe(RENDER_WINDOW_START);
    expect(frames.size).toBe(0);
    // 取消必须真的叫到 cancelAnimationFrame：只在回调里看旗标，在途那一帧还会白跑一次
    expect(cancelCalls).toEqual(inFlight);
  });
});

describe('日志抽屉的接线（源码契约）', () => {
  const src = readFileSync('components/options/LogDrawer.vue', 'utf-8');

  it('表格画的是窗口化那一份', () => {
    expect(src).toContain(':data="windowedLogs"');
    expect(src).toContain('logRowWindow.slice(filteredLogs.value)');
    expect(src).not.toContain(':data="filteredLogs"');
  });

  it('统计条与规则名下拉都读全量，续载过程中不许先报一个少数', () => {
    expect(src).toContain('computeLogStats(filteredLogs.value)');
    expect(src).not.toMatch(/computeLogStats\((windowedLogs|filteredLogs\.value\.slice)/);
    // 下拉的候选来自整屏日志，不是已经挂上的那几行
    expect(src).toContain('for (const log of props.logs)');
  });

  it('靠「打开必重拉」arm，而不是新长出一个 visible watcher', () => {
    expect(src).toContain('watch(() => props.logs, logRowWindow.arm)');
    // 关掉抽屉要退回首屏：表格在第一次打开之后一直挂着（v-show 隐藏）
    expect(src).toContain('logRowWindow.reset()');
    expect(src).toContain('onUnmounted(logRowWindow.cancel)');
  });

  it('拉取失败那一轮也要 arm：`props.logs` 没换身份，只靠它会把界面永久锁在首屏那一截', () => {
    const armOnPullEnd = src.match(
      /watch\(\s*\(\)\s*=>\s*props\.loading,\s*loading\s*=>\s*\{\s*if \(!loading\) logRowWindow\.arm\(\);/,
    );
    expect(
      armOnPullEnd,
      src.match(/props\.loading/g) ? 'loading watcher 的 arm 被改写或缺失' : 'loading watcher 整个不见了',
    ).toBeTruthy();
  });
});
