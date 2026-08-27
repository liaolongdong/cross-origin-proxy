/**
 * i18n composable — 转发自研响应式 i18n 模块（utils/i18n）
 *
 * 保持组件侧 `const { t } = useI18n()` 的既有用法零改动，
 * 同时暴露 locale 与 setLocale 供设置面板做应用内语言切换。
 */
import { t, currentLocale, setLocale } from '@/utils/i18n';

export function useI18n() {
  return { t, locale: currentLocale, setLocale };
}
