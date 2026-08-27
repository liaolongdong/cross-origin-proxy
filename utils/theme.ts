/**
 * 主题工具模块
 *
 * 提供主题名类型、可选主题元数据，以及在扩展页中应用主题的辅助方法。
 * 支持三种显示模式：亮色、暗色、跟随系统。
 *
 * 设计要点：
 * - 主题名持久化在 chrome.storage.local 的独立键中
 * - 显示模式（light/dark/system）独立存储
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

/** 从存储读取当前主题 */
export async function getStoredTheme(): Promise<ThemeName> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.THEME);
    const theme = result[STORAGE_KEYS.THEME];
    return isThemeName(theme) ? theme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** 保存主题到存储 */
export async function setStoredTheme(theme: ThemeName): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.THEME]: theme });
}

/** 从存储读取显示模式 */
export async function getStoredThemeMode(): Promise<ThemeMode> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.THEME_MODE);
    const mode = result[STORAGE_KEYS.THEME_MODE];
    return isThemeMode(mode) ? mode : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

/** 保存显示模式到存储 */
export async function setStoredThemeMode(mode: ThemeMode): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.THEME_MODE]: mode });
}

/**
 * 扩展页主题同步：读取并应用当前主题与显示模式，并监听变更实时切换
 * 在 options/popup 的 main.ts 中调用
 */
export function initThemeSync(): void {
  // 初始化主题色
  void getStoredTheme().then(theme => applyThemeToRoot(theme));

  // 初始化显示模式
  void getStoredThemeMode().then(mode => applyThemeMode(mode));

  // 监听存储变更（主题色 + 显示模式）
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    const themeChange = changes[STORAGE_KEYS.THEME];
    if (themeChange) {
      applyThemeToRoot(isThemeName(themeChange.newValue) ? themeChange.newValue : DEFAULT_THEME);
    }

    const modeChange = changes[STORAGE_KEYS.THEME_MODE];
    if (modeChange) {
      applyThemeMode(isThemeMode(modeChange.newValue) ? modeChange.newValue : DEFAULT_THEME_MODE);
    }
  });
}
