/**
 * 主题工具模块
 *
 * 提供主题名类型、可选主题元数据，以及在扩展页中应用主题的辅助方法。
 * 支持三种显示模式：亮色、暗色、跟随系统。
 *
 * 设计要点：
 * - 主题名持久化在 chrome.storage.local 的独立键中
 * - 显示模式（light/dark/system）独立存储
 * - 两者各有一份 localStorage 镜像，扩展页挂载前同步应用以消除首帧闪色（与 utils/i18n 同构）
 * - 本模块直接读取 storage.local，保持轻量
 * - 屏幕上已经画出画面之后再改配色，走一次 View Transition 交叉淡入（`applyThemeVisually`），
 *   不再是整页硬翻；首帧那几次仍然同步直写，否则淡的就是一屏还没画完的默认配色
 * - 一次操作只淡一次：存储回声（`storage.onChanged` 绕回发起页自己）按「在途目标」去重，
 *   不能只比根元素当前值——过渡回调被推迟到下一帧，那时旧值还挂在根元素上（见 `pendingVisual`）
 */

import { STORAGE_KEYS, THEME_MODES, DEFAULT_THEME_MODE, type ThemeMode } from '@/utils/constants';
import { withViewTransition } from '@/utils/transitions';

/** 主题名（顺序即 UI 展示顺序） */
export type ThemeName = 'sky' | 'green' | 'pink' | 'mauve' | 'orange' | 'slate';

/** 默认主题 */
export const DEFAULT_THEME: ThemeName = 'sky';

/** 全部主题名 */
export const THEME_NAMES: readonly ThemeName[] = ['sky', 'green', 'pink', 'mauve', 'orange', 'slate'];

/** 主题选项元数据 */
export interface ThemeOption {
  name: ThemeName;
  label: string;
  labelEn: string;
  swatch: string;
}

/** 可选主题列表 */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { name: 'sky', label: '晴空蓝', labelEn: 'Sky Blue', swatch: '#409eff' },
  { name: 'green', label: '青竹绿', labelEn: 'Bamboo Green', swatch: '#69b599' },
  { name: 'pink', label: '桃花粉', labelEn: 'Peach Pink', swatch: '#d87998' },
  { name: 'mauve', label: '樱粉紫', labelEn: 'Blossom Mauve', swatch: '#ad84cd' },
  { name: 'orange', label: '落霞橙', labelEn: 'Sunset Orange', swatch: '#e28e65' },
  { name: 'slate', label: '雾墨灰', labelEn: 'Misty Slate', swatch: '#7f92b4' },
];

/** 显示模式选项 */
export interface ThemeModeOption {
  value: ThemeMode;
  label: string;
  labelEn: string;
  icon: string;
}

/** 显示模式列表 */
export const THEME_MODE_OPTIONS: readonly ThemeModeOption[] = [
  { value: 'light', label: '亮色', labelEn: 'Light', icon: 'Sunny' },
  { value: 'dark', label: '暗色', labelEn: 'Dark', icon: 'Moon' },
  { value: 'system', label: '跟随系统', labelEn: 'System', icon: 'Monitor' },
];

/** 判断是否为合法主题名 */
export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEME_NAMES as readonly string[]).includes(value);
}

/** 判断是否为合法显示模式 */
export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && Object.values(THEME_MODES).includes(value as ThemeMode);
}

/** 将主题应用到根元素 */
export function applyThemeToRoot(theme: ThemeName, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
}

/**
 * 根据显示模式应用暗色/亮色
 * - light: 强制亮色 (data-mode="light")
 * - dark:  强制暗色 (data-mode="dark")
 * - system: 不设置 data-mode，由 CSS @media (prefers-color-scheme) 自动生效
 */
export function applyThemeMode(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  if (mode === THEME_MODES.LIGHT) {
    root.dataset.mode = 'light';
  } else if (mode === THEME_MODES.DARK) {
    root.dataset.mode = 'dark';
  } else {
    // system: 移除 data-mode，让 CSS 媒体查询接管
    delete root.dataset.mode;
  }
}

/**
 * 一次视觉请求的目标：`undefined` 表示这一项不动。
 *
 * 两个属性合成一个目标是刻意的——用户在设置面板里可以一次只动配色、一次只动亮暗，
 * 但存储变更事件可以把两个键装进同一批 `changes` 里送来，此时必须只淡一次。
 */
interface VisualTarget {
  theme?: ThemeName;
  mode?: ThemeMode;
}

/**
 * 在途过渡正把根元素画成什么（每次请求写入、由该次过渡的回调收账）。
 *
 * 为什么需要这一份账：界面侧换配色是「先就地应用、再写 `chrome.storage.local`」两步，
 * 而写下去的那一笔会沿 `storage.onChanged` **绕回发起页自己**。View Transition 的回调被
 * 浏览器推迟到下一帧才跑，回声赶在它前面时根元素上还挂着旧值——只看「根元素现在是什么」，
 * 回声就会被判成一次真变更，于是第二次过渡把正在淡的那一次当场顶掉。画面照样淡过去，代价是
 * 每次换肤多拍一张整页快照，外加一条 `AbortError: Transition was skipped` 的未处理拒绝
 * （2026-09-26 在真实 Chrome 里量到，一次点击一条；接手那两条 promise 的是 `withViewTransition`）。
 *
 * 收账排在回调里、由回调自己完成：回调真正跑过，才说明「画成目标值」这件事已经落地。
 * 中途改口（在途 green、又来一笔 pink）不会被当成回声吞掉——账上的目标对不上，照常淡第二次，
 * 先跑的那次回调不会抹掉后一笔的账（见 `requestVisual` 里那句「只收自己那一份」）。
 */
const pendingVisual: VisualTarget = {};

/**
 * 把一次「配色 / 显示模式」变更包进整页交叉淡入，并按 {@link pendingVisual} 去重。
 *
 * 三种落点，按判据从严到宽：
 * - 两项都已是当前值 → 直接写，不进过渡（同值重写连快照都不该拍）；
 * - 想改的那一项**正是在途过渡的目标** → 这一笔是它自己的回声，丢掉，不开第二次过渡；
 * - 其余 → 记账 + 开一次过渡。减少动效、运行时不支持该 API、或过渡被引擎当场判死（回调一次
 *   都没跑）时，由 `withViewTransition` 退回直接执行，账因此总能被收掉，不会留下谁也擦不掉
 *   的目标——擦不掉的账会把之后同一目标的请求全当成回声吞掉。
 */
function requestVisual(target: VisualTarget, root: HTMLElement): void {
  const write = () => {
    if (target.theme !== undefined) applyThemeToRoot(target.theme, root);
    if (target.mode !== undefined) applyThemeMode(target.mode, root);
    // 只收自己那一份账：中途被后一个目标顶掉时，那份账归后者，先跑的回调不许把它抹了
    if (target.theme !== undefined && pendingVisual.theme === target.theme) delete pendingVisual.theme;
    if (target.mode !== undefined && pendingVisual.mode === target.mode) delete pendingVisual.mode;
  };

  const themeWanted = target.theme !== undefined && root.dataset.theme !== target.theme;
  // 没有 data-mode 就是「跟随系统」——媒体查询那一档不写属性，所以这里要按同一个口径比
  const modeWanted = target.mode !== undefined && (root.dataset.mode ?? THEME_MODES.SYSTEM) !== target.mode;
  if (!themeWanted && !modeWanted) {
    write();
    return;
  }
  const coveredByPending =
    (!themeWanted || pendingVisual.theme === target.theme) && (!modeWanted || pendingVisual.mode === target.mode);
  if (coveredByPending) return;

  if (themeWanted) pendingVisual.theme = target.theme;
  if (modeWanted) pendingVisual.mode = target.mode;
  withViewTransition(write);
}

/**
 * 把主题切换包进一次整页交叉淡入（屏幕上已有画面时的那条路径）。
 *
 * 为什么要淡：改一个 `data-theme` 就有几十个 `--cop-*` 同时换值，不处理的话整页在同一帧里
 * 翻过去，观感上是「页面重新加载了一次」而不是「我换了个配色」。淡的具体形态（时长、缓动、
 * 暗色→亮色不留亮度爆点）全部住在 `assets/theme/tokens.css` 的 `::view-transition-*` 那一节。
 *
 * 去重判据（同值、回声）见 {@link requestVisual}。
 */
export function applyThemeVisually(
  theme: ThemeName,
  mode?: ThemeMode,
  root: HTMLElement = document.documentElement,
): void {
  requestVisual({ theme, mode }, root);
}

/**
 * 只换显示模式（亮 / 暗 / 跟随系统）时的淡入版，判据与 {@link applyThemeVisually} 同一条。
 *
 * 与主题名那条分开，是因为这一项单独被改的场合更多（用户在亮暗之间来回切），
 * 而 `theme` 这时候原样不动——不能顺手把两个属性都写一遍，那会把
 * 「跟随系统时根元素上没有 `data-mode`」这条契约（见 tests/themeMirror.test.ts）多一个写入方。
 */
export function applyThemeModeVisually(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  requestVisual({ mode }, root);
}

/**
 * localStorage 镜像键（与 `utils/i18n` 的语言镜像同构）
 *
 * `chrome.storage.local` 只能异步读，等它回来时首帧已经按默认配色画完了，切过主题的
 * 用户每次打开 popup/options 都会看到一次闪色。扩展页同源共享 localStorage，用它做只读
 * 镜像即可在挂载前同步定色；storage.local 始终是数据源，镜像丢了就退回这一次 IPC。
 */
const THEME_MIRROR_KEY = 'cop_theme';
const THEME_MODE_MIRROR_KEY = 'cop_mode';

/** 同步读镜像（background SW 无 localStorage，需守卫） */
function readMirror(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeMirror(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // 镜像写入失败（隐私模式等）只影响首帧配色，不影响持久化
  }
}

/**
 * 读取主题原值：`undefined` 表示「读不到」（IPC 失败）。
 *
 * 与「存储里就是默认值」区分开——镜像（localStorage）是跨会话粘住的，
 * 一次抖动失败若按 DEFAULT 回写，之后每次打开的首帧都会被画成错的配色。
 */
async function readStoredTheme(): Promise<ThemeName | undefined> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.THEME);
    const theme = result[STORAGE_KEYS.THEME];
    return isThemeName(theme) ? theme : DEFAULT_THEME;
  } catch {
    return undefined;
  }
}

/** 从存储读取当前主题（读失败回落默认值） */
export async function getStoredTheme(): Promise<ThemeName> {
  return (await readStoredTheme()) ?? DEFAULT_THEME;
}

/**
 * 保存主题到存储
 *
 * 镜像在写入成功后才刷新：它表示的是「下次打开首帧该画什么」，
 * 落盘失败时提前写会让镜像领先于事实来源，下次进来先闪一下再被校正回去。
 */
export async function setStoredTheme(theme: ThemeName): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.THEME]: theme });
  writeMirror(THEME_MIRROR_KEY, theme);
}

/** 读取显示模式原值，`undefined` 表示读不到 */
async function readStoredThemeMode(): Promise<ThemeMode | undefined> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.THEME_MODE);
    const mode = result[STORAGE_KEYS.THEME_MODE];
    return isThemeMode(mode) ? mode : DEFAULT_THEME_MODE;
  } catch {
    return undefined;
  }
}

/** 从存储读取显示模式（读失败回落默认值） */
export async function getStoredThemeMode(): Promise<ThemeMode> {
  return (await readStoredThemeMode()) ?? DEFAULT_THEME_MODE;
}

/** 保存显示模式到存储，写入成功后刷新镜像（与主题色一样消除首帧闪色） */
export async function setStoredThemeMode(mode: ThemeMode): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.THEME_MODE]: mode });
  writeMirror(THEME_MODE_MIRROR_KEY, mode);
}

/**
 * 扩展页主题同步：读取并应用当前主题与显示模式，并监听变更实时切换
 * 在 options/popup 的 main.ts 中调用
 */
export function initThemeSync(): void {
  // 先按镜像同步定色：下面的存储读取是异步的，等回来时首帧已经画成默认配色了
  const mirroredTheme = readMirror(THEME_MIRROR_KEY);
  if (isThemeName(mirroredTheme)) applyThemeToRoot(mirroredTheme);
  const mirroredMode = readMirror(THEME_MODE_MIRROR_KEY);
  if (isThemeMode(mirroredMode)) applyThemeMode(mirroredMode);

  // 仍以存储为准校正一次（首次打开、镜像被清、其它页面改过设置时靠这里兜底）；
  // 读失败时什么都不做——镜像里那份上一次成功读到的值仍然比默认值更接近事实
  void readStoredTheme().then(theme => {
    if (theme === undefined) return;
    writeMirror(THEME_MIRROR_KEY, theme);
    applyThemeToRoot(theme);
  });
  void readStoredThemeMode().then(mode => {
    if (mode === undefined) return;
    writeMirror(THEME_MODE_MIRROR_KEY, mode);
    applyThemeMode(mode);
  });

  // 监听存储变更（主题色 + 显示模式），实时切换并跟进镜像
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    const themeChange = changes[STORAGE_KEYS.THEME];
    const modeChange = changes[STORAGE_KEYS.THEME_MODE];
    if (!themeChange && !modeChange) return;

    // 落不到合法值上的一律按「重置」处理，与首帧那两处同一口径
    const theme = themeChange ? (isThemeName(themeChange.newValue) ? themeChange.newValue : DEFAULT_THEME) : undefined;
    const mode = modeChange ? (isThemeMode(modeChange.newValue) ? modeChange.newValue : DEFAULT_THEME_MODE) : undefined;

    if (theme !== undefined) writeMirror(THEME_MIRROR_KEY, theme);
    if (mode !== undefined) writeMirror(THEME_MODE_MIRROR_KEY, mode);

    // 两个键同批变更时只淡一次；回声（改动页自己身上绕回来的那一次）由 `requestVisual`
    // 按「在途目标」去重——判据不能只看根元素，因为过渡回调还没跑，旧值还挂在上面。
    requestVisual({ theme, mode }, document.documentElement);
  });
}
