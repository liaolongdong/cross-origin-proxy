/**
 * 过渡与动效的运行时工具（零依赖）
 *
 * 这里只放「CSS 自己做不到、又会被多处复用」的那几件小事：
 * - 实时判断系统是否要求减少动效（`prefers-reduced-motion`）；
 * - 用 View Transitions 把一次「改 DOM 就整页换脸」的操作变成交叉淡入（换肤、换语言）；
 * - 列表重排需要的 FLIP 归位（矩形快照 + 反向平移放开）。
 *
 * 时长与缓动一律由调用方从 `assets/theme/tokens.css` 的 `--cop-duration-*` / `--cop-ease-*`
 * 取，本模块不写第二份观感数值——文件里出现的字面量全部只是「读不到令牌时」的兜底，
 * 与 CSS 侧 `var(--cop-duration-recolour, 280ms)` 是同一层含义。
 * 组件里能纯 CSS 表达的动效不要搬进 JS。
 */

/** 带 View Transitions 的 document（TS 的 DOM 类型未必收录该 API，此处按可选成员收窄） */
type ViewTransitionDocument = Document & {
  startViewTransition?: (callback?: () => void | Promise<void>) => unknown;
};

/**
 * `startViewTransition()` 返回值里需要接手的那两个 promise。
 *
 * 只声明用到的成员，且全部可选：`tests/motionTokens.test.ts` 里那份假 `document` 返回的是
 * `undefined`，按必需字段写就成了「类型说一定有、运行时是 undefined」。
 */
type ViewTransitionHandle = {
  ready?: Promise<void>;
  finished?: Promise<void>;
  updateCallbackDone?: Promise<void>;
};

/**
 * 读令牌层里的动效取值（`--cop-ease-*` 这类只能被 CSS 消费的字符串）。
 *
 * Web Animations API 要的是字符串参数，而时长与缓动的唯一事实来源在
 * `assets/theme/tokens.css`——在 JS 里再抄一份 `cubic-bezier(...)` 就是第二个事实源，
 * 改令牌时必然漏改。所以由这里按需读计算值，读不到（样式还没加载、非页面上下文）时用兜底。
 */
export function readMotionToken(name: string, fallback: string): string {
  try {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * 把 `--cop-duration-*` 读成毫秒数（WAAPI 的 `duration` 只吃数字）。
 *
 * `90ms` 与 `.2s` 两种写法都认；令牌缺失或解析不出数字时退回 `fallback`，
 * 因为对动画来说「拿个接近的值」永远比「时长 NaN」好——后者会让整段动画直接消失。
 */
export function motionTokenToMs(name: string, fallback: number): number {
  const raw = readMotionToken(name, '');
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith('ms') ? value : value * 1000;
}

/**
 * 系统「减少动态效果」偏好。
 *
 * 每次调用都实时读，不缓存：用户在系统设置里改这一项时，正在跑的页面应当立刻照办，
 * 缓存一次就等于把这条无障碍偏好在整个会话里否决了。非页面上下文（SW）没有 matchMedia，
 * 一律按「不减弱」返回，由调用方自己的 `document` 守卫兜住。
 */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 把一次会改变整页画面的更新包进 View Transition，让新旧两帧交叉溶解。
 *
 * 用途是「换肤」与「换语言」这类一改就让几十个元素同时换值的操作——不加过渡时它长得像
 * 页面重载了一次。注意回调里若其实没有视觉变化，浏览器仍然会走一遍快照，所以调用方要
 * 自己先判断值是否真的变了（见 `utils/theme.ts` 的 `applyThemeVisually`）。
 *
 * 以下情形退回直接执行，行为与接入前完全一致：
 * - `prefers-reduced-motion: reduce`（此时 CSS 侧时长也被令牌层压成 0.01ms）；
 * - 运行时不支持该 API（SW 没有 `document`；老版本 Chromium 不命中）；
 * - 过渡被引擎**当场判死**——回调一次都没跑（见下面那两处接手）。
 *
 * 「同值重写不该淡」这条判断不在这里，而在调用方——因为只有调用方知道「已经有一次在途的
 * 过渡正把画面画成什么」，见 `utils/theme.ts` 的 `requestVisual` 与 `utils/i18n` 的
 * `setLocaleValue`。只看根元素当前值是不够的：过渡回调被浏览器推迟到下一帧，回声赶在它前面时
 * 根元素上还挂着旧值，于是回声被当成一次真变更，把正在淡的那一次当场顶掉。
 *
 * @param update 实际执行变更的回调；Vue 的响应式赋值需配合 `await nextTick()`，
 *   否则新帧在 DOM 更新之前就被采完，淡出来的还是旧画面。
 */
export function withViewTransition(update: () => void | Promise<void>): void {
  const doc = typeof document === 'undefined' ? undefined : (document as ViewTransitionDocument);
  if (!doc?.startViewTransition || prefersReducedMotion()) {
    void update();
    return;
  }
  /**
   * 「这一次变更到底落地了没有」。调用方（`requestVisual` / `setLocaleValue`）把「在途目标」
   * 记在过渡回调跑过之后才收账，所以回调**一次都不跑**时那笔账会永远擦不掉——之后同一目标的
   * 请求全被当成回声吞掉，表现是「设置里点了、页面不跟着换，再点也没反应」。
   */
  let ran = false;
  const runUpdate = () => {
    if (ran) return;
    ran = true;
    return update();
  };

  let handle: ViewTransitionHandle | undefined;
  try {
    // 规格把「文档 not fully active」定为同步抛 `InvalidStateError`；这一条按规格兜住
    handle = doc.startViewTransition(runUpdate) as ViewTransitionHandle | undefined;
  } catch {
    void runUpdate();
    return;
  }
  // 接手这两个 promise 不是为了处理错误，而是因为它们**正常**就会拒绝：后一次过渡顶掉前一次时，
  // 前一次的 `ready` 以 `AbortError: Transition was skipped` 拒绝，`finished` 同因落回拒绝。
  // 画面不受影响（DOM 早在回调里改完了），但没人接手就是一条 Uncaught (in promise)——
  // 2026-09-26 在真实 Chrome 里量过：未打补丁的构建里一次换肤一条，全部来自存储回声顶出来的
  // 那第二次过渡。
  handle?.ready?.catch(() => {});
  handle?.finished?.catch(() => {});
  /**
   * `updateCallbackDone` 被拒有两种来路，只有一种需要接手：
   * - 回调跑过、回调里抛了 → `ran` 已是 true，这里什么都不做（真抛错留下未处理拒绝更该被看见）；
   * - 回调压根没跑 → 实测 2026-09-26 那版 Chrome 对 not fully active 的文档**不抛**，而是直接
   *   把过渡判死：`ready` 与 `updateCallbackDone` 双双 reject（AbortError），回调一次也不跑。
   *   这一条不兜住就是上面那段「账擦不掉」的来路，所以补一次直接执行。
   */
  handle?.updateCallbackDone?.catch(() => {
    void runUpdate();
  });
}

/** 快照一批元素的当前位置，配合 {@link applyFlip} 在 DOM 变更后使用 */
export function readRects(elements: Iterable<HTMLElement>): Map<HTMLElement, DOMRect> {
  const rects = new Map<HTMLElement, DOMRect>();
  for (const el of elements) rects.set(el, el.getBoundingClientRect());
  return rects;
}

/**
 * 以 {@link readRects} 留下的旧位置为 First，把当前（已在新位置）的元素反向平移回旧位置
 * 再放开——即 FLIP 的 Invert + Play 两步，用来把「列表突然换位」变成一次看得见的移动。
 *
 * 用 Web Animations API 而不是「写 inline transform、下一帧摘掉、靠 CSS transition 收尾」：
 * 后者要求元素把 transform 交给动画，而列表元素自己往往也有 transform（悬浮上浮、拖拽抬起），
 * 收尾时一并撤掉就会顺带改坏人家的样式。keyframe 动画跑完即散场，不留任何样式。
 *
 * @param rects 变更前用 `readRects` 拿到的同一批元素的位置
 * @param durationMs 归位时长；不传则读 `--cop-duration-base`（对动画来说「时长缺失」比
 *   「差一档」严重得多，所以留字面量兜底，和 CSS 里 `var(--x, 220ms)` 同一层含义）
 * @param easing 缓动；不传则读 `--cop-ease-spring`（物体自己落位的那一档手感）
 */
export function applyFlip(rects: Map<HTMLElement, DOMRect>, durationMs?: number, easing?: string): void {
  if (prefersReducedMotion() || !rects.size) return;
  const ms = durationMs ?? motionTokenToMs('--cop-duration-base', 220);
  const curve = easing ?? readMotionToken('--cop-ease-spring', 'cubic-bezier(0.34, 1.4, 0.64, 1)');
  for (const [el, before] of rects) {
    if (!el.isConnected) continue;
    const after = el.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    // 亚像素抖动（滚动位置、缩放取整）不算移动，否则每次重排都有行在呼吸
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }], {
      duration: ms,
      easing: curve,
    });
  }
}
