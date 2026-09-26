/**
 * 动效运行时 `utils/transitions.ts`
 *
 * 这个模块存在的理由是「CSS 自己做不到那几件小事」，而它每一件都有一条**静默**的失败面：
 * 令牌读不到就退回兜底、`prefers-reduced-motion` 被缓存就等于在整个会话里否决用户的无障碍
 * 诉求、View Transition 的回调如果不同步 DOM 就会淡出旧画面、FLIP 的位移判定如果放宽，
 * 每次重排都有行在呼吸。这些都不会报错，所以逐条按**外部可观察面**钉住：
 * 传给 `el.animate` 的实参、`startViewTransition` 收到的那个回调调用起来才执行 `update`、
 * `update()` 到底被调了几次（含「过渡被当场判死」那两条）——而不是「那一行还在不在」。
 *
 * 本环境测不到的那半：真实的 `document.startViewTransition` 快照合成、CSS 侧的
 * `::view-transition-*` 时长、以及 FLIP 在真浏览器里的观感。它们没有 node 环境的对应物
 * （无 DOM，`jsdom` / `@vue/test-utils` 未装），令牌层与关键帧的静态契约另见
 * `tests/designTokens.test.ts`。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readMotionToken,
  motionTokenToMs,
  prefersReducedMotion,
  withViewTransition,
  readRects,
  applyFlip,
} from '@/utils/transitions';

/** 假的 `--cop-*` 计算值表 */
let tokens: Map<string, string>;
/** 假的 `window.matchMedia` 返回值，逐次可翻 */
let reduceMatch: boolean;
let matchMediaCalls: number;

/**
 * 一个只实现 FLIP 用得上的那三个成员的假元素。
 *
 * `getBoundingClientRect` 也是 spy 而不是裸箭头函数：`readRects` 那两格要问的就是
 * 「每个元素各被量了几次」，而 `applyFlip` 用同一份假元素，不必再造第二个夹具。
 */
function fakeEl(after: { left: number; top: number }, connected = true) {
  const animate = vi.fn();
  const getBoundingClientRect = vi.fn(() => ({ left: after.left, top: after.top }) as unknown as DOMRect);
  return {
    isConnected: connected,
    animate,
    getBoundingClientRect,
  } as unknown as HTMLElement & {
    animate: ReturnType<typeof vi.fn>;
    getBoundingClientRect: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  tokens = new Map();
  reduceMatch = false;
  matchMediaCalls = 0;
  vi.stubGlobal('document', {
    documentElement: {},
  });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => tokens.get(name) ?? '',
  }));
  vi.stubGlobal('window', {
    matchMedia: () => {
      matchMediaCalls += 1;
      return { matches: reduceMatch };
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('读令牌层（JS 侧不写第二份时长表）', () => {
  it('取到的是 trim 过的计算值', () => {
    tokens.set('--cop-ease-spring', '  cubic-bezier(0.34, 1.4, 0.64, 1) ');
    expect(readMotionToken('--cop-ease-spring', 'ease-out')).toBe('cubic-bezier(0.34, 1.4, 0.64, 1)');
  });

  it('令牌缺失或值为空串时退回调用方给的兜底', () => {
    tokens.set('--cop-ease-empty', '');
    expect(readMotionToken('--cop-ease-empty', 'ease-out')).toBe('ease-out');
    expect(readMotionToken('--cop-ease-missing', 'ease-in')).toBe('ease-in');
  });

  it('没有 `document` 的上下文（SW）不抛，直接落兜底', () => {
    vi.stubGlobal('document', undefined);
    expect(() => readMotionToken('--cop-ease-spring', 'ease-out')).not.toThrow();
    expect(readMotionToken('--cop-ease-spring', 'ease-out')).toBe('ease-out');
  });

  it('`ms` 与 `s` 两种写法都读成毫秒，读不懂的落兜底', () => {
    tokens.set('--d-ms', '320ms');
    tokens.set('--d-s', '0.28s');
    tokens.set('--d-dot-s', '.2s');
    tokens.set('--d-junk', 'fast');
    tokens.set('--d-empty', '');
    // 兜底值刻意取一个谁也撞不上的数，否则「全部走了兜底」也能全绿
    expect(motionTokenToMs('--d-ms', 777)).toBe(320);
    expect(motionTokenToMs('--d-s', 777)).toBe(280);
    expect(motionTokenToMs('--d-dot-s', 777)).toBe(200);
    expect(motionTokenToMs('--d-junk', 777)).toBe(777);
    expect(motionTokenToMs('--d-missing', 777)).toBe(777);
  });
});

describe('prefers-reduced-motion：每次现读，不缓存', () => {
  it('媒体查询说减少就是 true', () => {
    reduceMatch = true;
    expect(prefersReducedMotion()).toBe(true);
  });

  it('系统设置改了，正在跑的页面立刻照办（缓存一次就会整个会话都否决用户）', () => {
    reduceMatch = false;
    expect(prefersReducedMotion()).toBe(false);
    reduceMatch = true;
    expect(prefersReducedMotion()).toBe(true);
    reduceMatch = false;
    expect(prefersReducedMotion()).toBe(false);
    // 三格不同答案，且每次调用都真的问过 matchMedia
    expect(matchMediaCalls).toBe(3);
  });

  it('没有 `matchMedia` 的上下文按「不减弱」处理，不抛', () => {
    vi.stubGlobal('window', {});
    expect(() => prefersReducedMotion()).not.toThrow();
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('withViewTransition：该淡才淡，不该淡就直接执行', () => {
  /**
   * 假 document：`startViewTransition` 默认只记录回调、不替实现调用它。
   *
   * `throws` / `handle` 两个开关是给「引擎把过渡当场判死」那几条用的——2026-09-26 在真实
   * Chrome 里量过两种判死：规格写的同步抛，以及这一版 Chrome 实际的做法（返回句柄、`ready`
   * 与 `updateCallbackDone` 双双以 AbortError 拒绝、回调一次也不跑）。
   */
  function stubDocWithVT(opts: { throws?: boolean; handle?: unknown } = {}) {
    const startViewTransition = vi.fn((_callback: () => void | Promise<void>) => {
      if (opts.throws) throw Object.assign(new Error('not fully active'), { name: 'InvalidStateError' });
      return opts.handle;
    });
    vi.stubGlobal('document', { documentElement: {}, startViewTransition });
    return startViewTransition;
  }

  /** 让 promise 链上的接手人跑完（`catch` 挂在微任务上） */
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('支持该 API 时，交给浏览器一个回调，但自己不当执行者', () => {
    const startViewTransition = stubDocWithVT();
    const update = vi.fn();
    withViewTransition(update);
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    // 传进去之前 `update` 一次都没跑——快照要先采旧画面
    expect(update).not.toHaveBeenCalled();
    const passed = startViewTransition.mock.calls[0][0] as () => void;
    expect(typeof passed).toBe('function');
    // 「传的是回调本身」不是这条契约的目的，**调用它才执行 update** 才是；包一层也不许丢掉那次执行
    passed();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('API 缺席（老 Chromium、没有 document 的 SW）时行为与接入前一致：直接执行一次', () => {
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    vi.stubGlobal('document', undefined);
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('用户要求减少动效时，即使 API 可用也直接执行（CSS 侧没有开关可摘）', () => {
    const startViewTransition = stubDocWithVT();
    reduceMatch = true;
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it('异步回调（Vue 的 `await nextTick()`）照原样交给 API', async () => {
    const startViewTransition = stubDocWithVT();
    const update = vi.fn(async () => undefined);
    withViewTransition(update);
    const passed = startViewTransition.mock.calls[0][0] as () => Promise<void>;
    await expect(Promise.resolve(passed())).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('`startViewTransition` 同步抛（规格里文档 not fully active 的那一条）→ 变更照样落地一次', () => {
    const startViewTransition = stubDocWithVT({ throws: true });
    const update = vi.fn();
    expect(() => withViewTransition(update)).not.toThrow();
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('过渡被当场判死、回调一次都没跑 → 补一次直接执行，只补一次', async () => {
    const aborted = () => Promise.reject(Object.assign(new Error('Transition was skipped'), { name: 'AbortError' }));
    const startViewTransition = stubDocWithVT({
      handle: { ready: aborted(), finished: Promise.resolve(), updateCallbackDone: aborted() },
    });
    const update = vi.fn();
    withViewTransition(update);
    // 回调没跑，所以这一句必须是 0——否则下面那句「补到 1 次」就成了回调其实跑过的假绿
    expect(update).not.toHaveBeenCalled();
    await settle();
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('回调跑过之后才被拒（回调自己抛）→ 不许再补第二次执行', async () => {
    const rejected = () => Promise.reject(new Error('boom'));
    // 真实浏览器里回调是在另一个任务里跑的，它抛错只让 `updateCallbackDone` 落回拒绝，
    // 不会从 `startViewTransition` 冒出来——所以这里也由测试自己调用那个回调。
    const startViewTransition = stubDocWithVT({
      handle: { ready: Promise.resolve(), finished: rejected(), updateCallbackDone: rejected() },
    });
    const update = vi.fn(() => {
      throw new Error('boom');
    });
    withViewTransition(update);
    const passed = startViewTransition.mock.calls[0][0] as () => void;
    let thrown: unknown;
    try {
      passed();
    } catch (error) {
      thrown = error;
    }
    // 阳性对照：回调确实跑到了 `update` 里，所以下一句「还是 1 次」不是夹具没配合的假绿
    expect(thrown).toBeInstanceOf(Error);
    await settle();
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('readRects：按元素身份存下「变更前的这一刻」', () => {
  it('键是元素本身、值是它自己的矩形——两格的矩形不同，不许折叠成同一份', () => {
    const a = fakeEl({ left: 8, top: 40 });
    const b = fakeEl({ left: 8, top: 96 });
    const rects = readRects([a, b]);
    expect([...rects.keys()]).toEqual([a, b]);
    expect(rects.get(a)).toEqual({ left: 8, top: 40 });
    expect(rects.get(b)).toEqual({ left: 8, top: 96 });
  });

  it('每个元素各量自己那一次，不是把第一个元素的矩形分给所有人', () => {
    const a = fakeEl({ left: 0, top: 10 });
    const b = fakeEl({ left: 0, top: 90 });
    const rects = readRects([a, b]);
    expect(a.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(b.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(rects.get(b)).toEqual({ left: 0, top: 90 });
  });

  it('同一个元素重复出现只留一格（Map 的身份语义，FLIP 因此不会给同一行动画两遍）', () => {
    const el = fakeEl({ left: 0, top: 40 });
    expect(readRects([el, el]).size).toBe(1);
  });
});

describe('applyFlip：只给「真的挪了位」的元素补一段归位动画', () => {
  it('减少动效时整段跳过，一个 animate 都不发', () => {
    // 位移给足 80px：否则这一格在「reduce 分支根本不存在」时也会因为亚像素判定而假绿
    reduceMatch = true;
    const el = fakeEl({ left: 0, top: 120 });
    applyFlip(new Map([[el, { left: 0, top: 40 } as DOMRect]]), 300, 'ease-out');
    expect(el.animate).not.toHaveBeenCalled();
    // 同一份快照在不要求减少动效时确实会动画，证明上一句不是夹具的空转
    reduceMatch = false;
    applyFlip(new Map([[el, { left: 0, top: 40 } as DOMRect]]), 300, 'ease-out');
    expect(el.animate).toHaveBeenCalledTimes(1);
  });

  it('空快照什么都不做（守住「没有 rect 就不碰动画」）', () => {
    expect(() => applyFlip(new Map(), 300, 'ease-out')).not.toThrow();
  });

  it('已经从文档上摘下来的元素跳过', () => {
    const el = fakeEl({ left: 0, top: 120 }, false);
    applyFlip(new Map([[el, { left: 0, top: 40 } as DOMRect]]), 300, 'ease-out');
    expect(el.animate).not.toHaveBeenCalled();
  });

  it('亚像素抖动不动画，超过 0.5px 才动', () => {
    const jitter = fakeEl({ left: 0.4, top: 0.2 });
    applyFlip(new Map([[jitter, { left: 0, top: 0 } as DOMRect]]), 300, 'ease-out');
    expect(jitter.animate).not.toHaveBeenCalled();
    // 再夹一格「刚好越过阈值」的：只测 0.4 的话，阈值被改成 1px 也照样绿
    const justOver = fakeEl({ left: 0.6, top: 0.55 });
    applyFlip(new Map([[justOver, { left: 0, top: 0 } as DOMRect]]), 300, 'ease-out');
    expect(justOver.animate).toHaveBeenCalledTimes(1);

    const moved = fakeEl({ left: 0, top: 88 });
    applyFlip(new Map([[moved, { left: 0, top: 40 } as DOMRect]]), 300, 'ease-out');
    expect(moved.animate).toHaveBeenCalledTimes(1);
    const [frames, options] = moved.animate.mock.calls[0] as [Array<Record<string, string>>, Record<string, unknown>];
    // 起点是「旧位置减新位置」的反向平移，终点回到自身——这正是 FLIP 的 Invert + Play
    expect(frames[0]).toEqual({ transform: 'translate(0px, -48px)' });
    expect(frames[1]).toEqual({ transform: 'translate(0px, 0px)' });
    expect(options).toEqual({ duration: 300, easing: 'ease-out' });
  });

  it('不传时长与缓动时读令牌，而不是读模块里抄的一份', () => {
    tokens.set('--cop-duration-base', '410ms');
    tokens.set('--cop-ease-spring', 'cubic-bezier(0.9, 0.8, 0.7, 0.6)');
    const el = fakeEl({ left: 0, top: 200 });
    applyFlip(new Map([[el, { left: 0, top: 40 } as DOMRect]]));
    const [, options] = el.animate.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(options).toEqual({ duration: 410, easing: 'cubic-bezier(0.9, 0.8, 0.7, 0.6)' });
  });

  it('一批里各元素各按自己的位移归位', () => {
    const a = fakeEl({ left: 0, top: 80 });
    const b = fakeEl({ left: 0, top: 20 });
    const rects = new Map<HTMLElement, DOMRect>([
      [a, { left: 0, top: 40 } as DOMRect],
      [b, { left: 0, top: 40 } as DOMRect],
    ]);
    applyFlip(rects, 200, 'linear');
    const [fa] = a.animate.mock.calls[0] as [Array<Record<string, string>>];
    const [fb] = b.animate.mock.calls[0] as [Array<Record<string, string>>];
    expect(fa[0]).toEqual({ transform: 'translate(0px, -40px)' });
    expect(fb[0]).toEqual({ transform: 'translate(0px, 20px)' });
  });
});
