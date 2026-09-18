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
/**
 * 单条日志正文（请求体/响应体）的字符上限，超出部分在写入前截断并留痕。
 *
 * 未设上限时，一条超大 JSON 响应（代理请求体上限本就是 10MB）就能把 `storage.local`
 * 的配额（本扩展未申请 `unlimitedStorage`，约 10MB）撑满，此后不仅日志写入失败，
 * 连配置保存也会一起失败。取 32K 字符：足以看完任何正常接口的载荷。
 */
export const MAX_LOG_BODY_SIZE = 32 * 1024;
/**
 * 全部日志正文的字符总量预算：单条有上限不代表总量安全
 * （500 条 × 两条正文 × 32K 仍远超配额），超预算时从尾部（最旧）丢弃，
 * 与 {@link MAX_LOG_ENTRIES} 的环形缓冲方向一致。
 */
export const MAX_LOG_BODY_TOTAL = 4 * 1024 * 1024;

// 规则默认值
/**
 * 规则优先级默认值（数值越小越先匹配）。
 * 新建规则的表单与「priority 缺失/非有限数」时的归一化共用此值，避免各写一份字面量。
 * 导入的规则另用 {@link IMPORTED_RULE_PRIORITY}——不可信来源给更靠后的位次，是刻意区分。
 */
export const DEFAULT_RULE_PRIORITY = 10;
/** 导入规则缺失 priority 时的兜底值（见 messageRouter 的 normalizeImportedRules） */
export const IMPORTED_RULE_PRIORITY = 100;

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
