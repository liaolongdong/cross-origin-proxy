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
 */

import { STORAGE_KEYS, THEME_MODES, DEFAULT_THEME_MODE, type ThemeMode } from '@/utils/constants';

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
    if (themeChange) {
      const theme = isThemeName(themeChange.newValue) ? themeChange.newValue : DEFAULT_THEME;
      writeMirror(THEME_MIRROR_KEY, theme);
      applyThemeToRoot(theme);
    }

    const modeChange = changes[STORAGE_KEYS.THEME_MODE];
    if (modeChange) {
      const mode = isThemeMode(modeChange.newValue) ? modeChange.newValue : DEFAULT_THEME_MODE;
      writeMirror(THEME_MODE_MIRROR_KEY, mode);
      applyThemeMode(mode);
    }
  });
}
