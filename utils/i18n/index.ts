/**
 * 国际化（i18n）核心模块（自研轻量响应式方案，参照 account-password-helper）
 *
 * 设计要点：
 * - `currentLocale` 是模块级共享 ref，所有组件通过它响应语言切换（无需重载页面）
 * - 语言包按「语言 × 命名空间」拆分在 locales/{locale}/{namespace}.json，
 *   构建期静态 import 合并为扁平字典，key 与旧 chrome.i18n 方案保持一致，
 *   因此组件侧 `t('xxx')` 用法零改动
 * - 占位符沿用 chrome.i18n 的 `$1..$9` 风格，t() 第二参传入替换值
 * - 语言偏好持久化在 chrome.storage.local，并镜像到 localStorage：
 *   页面入口可同步读取镜像消除首帧闪烁；storage.onChanged 实现跨页面实时同步
 * - manifest 的名称/描述仍走 chrome.i18n（_locales 仅保留这两个键）
 */

import { ref } from 'vue';
import { STORAGE_KEYS } from '@/utils/constants';

import zhCommon from '@/locales/zh_CN/common.json';
import zhOptions from '@/locales/zh_CN/options.json';
import zhPopup from '@/locales/zh_CN/popup.json';
import enCommon from '@/locales/en/common.json';
import enOptions from '@/locales/en/options.json';
import enPopup from '@/locales/en/popup.json';

/** 支持的语言 */
export type LocaleName = 'zh_CN' | 'en';

/** 语言选项元数据（设置面板语言切换器用） */
export const LOCALE_OPTIONS: readonly { name: LocaleName; label: string }[] = [
  { name: 'zh_CN', label: '简体中文' },
  { name: 'en', label: 'English' },
];

/** localStorage 镜像键（消除挂载前的 storage IPC 等待） */
const LOCALE_MIRROR_KEY = 'cop_locale';

/** 各语言的合并字典（common + options + popup 命名空间扁平合并） */
const BUNDLES: Record<LocaleName, Record<string, string>> = {
  zh_CN: { ...zhCommon, ...zhOptions, ...zhPopup },
  en: { ...enCommon, ...enOptions, ...enPopup },
};

function isLocaleName(value: unknown): value is LocaleName {
  return value === 'zh_CN' || value === 'en';
}

/** 依据浏览器 UI 语言推断默认语言（未设置过偏好时使用） */
function detectDefaultLocale(): LocaleName {
  try {
    return chrome.i18n.getUILanguage().toLowerCase().startsWith('zh') ? 'zh_CN' : 'en';
  } catch {
    return 'zh_CN';
  }
}

/** 从 localStorage 镜像同步读取（background SW 无 localStorage，需守卫） */
function readMirror(): LocaleName | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const value = localStorage.getItem(LOCALE_MIRROR_KEY);
    return isLocaleName(value) ? value : null;
  } catch {
    return null;
  }
}

function writeMirror(locale: LocaleName): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LOCALE_MIRROR_KEY, locale);
    }
  } catch {
    // 忽略镜像写入失败（隐私模式等），storage.local 仍是数据源
  }
}

/** 当前语言（共享响应式状态，t() 依赖它实现切换后全组件自动更新） */
export const currentLocale = ref<LocaleName>(readMirror() ?? detectDefaultLocale());

/**
 * 取当前语言的国际化文案
 * @param key 语言包键名（与旧 chrome.i18n 方案的 key 一致）
 * @param substitutions 占位符替换值（对应文案中的 $1..$9）
 */
export function t(key: string, substitutions?: string | number | (string | number)[]): string {
  const bundle = BUNDLES[currentLocale.value] ?? BUNDLES.zh_CN;
  let message = bundle[key];
  if (message === undefined) return key;

  if (substitutions !== undefined) {
    const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
    subs.forEach((value, index) => {
      message = message.replace(new RegExp(`\\$${index + 1}`, 'g'), String(value));
    });
  }
  return message;
}

/** 切换语言并持久化（storage.onChanged 会同步其它扩展页） */
export async function setLocale(locale: LocaleName): Promise<void> {
  currentLocale.value = locale;
  writeMirror(locale);
  await chrome.storage.local.set({ [STORAGE_KEYS.LOCALE]: locale });
}

/**
 * 扩展页语言同步：读取持久化偏好并监听变更实时切换
 * 在 options/popup 的 main.ts 中调用（fire-and-forget）
 */
export function initLocaleSync(): void {
  void chrome.storage.local.get(STORAGE_KEYS.LOCALE).then(result => {
    const stored = result[STORAGE_KEYS.LOCALE];
    if (isLocaleName(stored) && stored !== currentLocale.value) {
      currentLocale.value = stored;
      writeMirror(stored);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[STORAGE_KEYS.LOCALE];
    if (!change) return;
    if (isLocaleName(change.newValue)) {
      currentLocale.value = change.newValue;
      writeMirror(change.newValue);
    }
  });
}
