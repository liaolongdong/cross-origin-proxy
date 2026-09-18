/**
 * 格式化工具函数
 */

/**
 * 格式化时间戳为相对时间（如“刚刚”、“5分钟前”）
 * 文案由调用方通过 labels 注入（配合 useI18n），避免硬编码语言
 */
export function formatTimeAgo(
  timestamp: number,
  labels: {
    justNow: string;
    minutesAgo: (n: string) => string;
    hoursAgo: (n: string) => string;
    daysAgo: (n: string) => string;
  },
): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return labels.justNow;
  if (diff < 3600000) return labels.minutesAgo(String(Math.floor(diff / 60000)));
  if (diff < 86400000) return labels.hoursAgo(String(Math.floor(diff / 3600000)));
  return labels.daysAgo(String(Math.floor(diff / 86400000)));
}

/**
 * 获取 HTTP 方法对应的 Element Plus tag 类型
 */
export function getMethodColor(method: string): '' | 'success' | 'warning' | 'danger' | 'info' {
  const colors: Record<string, '' | 'success' | 'warning' | 'danger' | 'info'> = {
    GET: '',
    POST: 'success',
    PUT: 'warning',
    DELETE: 'danger',
    PATCH: 'info',
  };
  return colors[method] || '';
}

/**
 * 获取 HTTP 状态码对应的 Element Plus tag 类型
 */
export function getStatusColor(status: number): '' | 'success' | 'warning' | 'danger' | 'info' {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return '';
  if (status >= 400 && status < 500) return 'warning';
  if (status >= 500) return 'danger';
  return 'info';
}

/**
 * 截断 URL 到指定长度
 */
export function truncateUrl(url: string, maxLen: number = 40): string {
  if (url.length <= maxLen) return url;
  return url.substring(0, maxLen) + '...';
}

/**
 * 截断待写入的日志正文，并在末尾标注原始长度。
 *
 * 标记是必须的：没有它，用户会把截断后的 JSON 当成完整载荷排查半天。
 * 长度以 UTF-16 码元计（与 `String.length` 一致），对正文上限这一用途足够。
 */
export function truncateForLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…[truncated, original ${value.length} chars]`;
}
