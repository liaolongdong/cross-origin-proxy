import type { ProxyConfig } from '@/utils/types';

// Storage keys
export const STORAGE_KEYS = {
  PROXY_CONFIG: 'proxy_config',
  REQUEST_LOGS: 'request_logs',
  THEME: 'theme',
  THEME_MODE: 'theme_mode', // light | dark | system
  LOCALE: 'locale',
  PROFILES: 'env_profiles',
  AUTO_OFF_MINUTES: 'auto_off_minutes', // 代理自动关闭时长（分钟），0 表示不自动关闭
} as const;

// Theme modes
export const THEME_MODES = {
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system',
} as const;

export type ThemeMode = (typeof THEME_MODES)[keyof typeof THEME_MODES];

export const DEFAULT_THEME_MODE: ThemeMode = 'system';

// Default config
export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  enabled: false,
  rules: [],
};

// Limits
export const MAX_LOG_ENTRIES = 500;
export const MAX_RULES = 200;

// DNR rule ID prefix (to avoid conflicts with other extensions)
export const DNR_RULE_ID_PREFIX = 10000;

// Message channel names
export const CONTENT_SCRIPT_CHANNEL = 'cross-origin-proxy';

// Alarm names
export const KEEPALIVE_ALARM = 'sw-keepalive';
// Chrome 120+ 允许的最小周期为 1 分钟（低于下限会被浏览器钳制并告警）
export const KEEPALIVE_INTERVAL_MINUTES = 1;
// 代理自动关闭：开启代理后倒计时到期自动关闭，防止忘记关闭代理
export const AUTO_OFF_ALARM = 'proxy-auto-off';
