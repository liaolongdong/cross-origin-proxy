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

/**
 * 把 epoch ms 渲染成 `HH:MM:SS`（本地时区）
 *
 * 只用于「采样于 ……」这类相对本机时刻的说明，不做跨时区比较、不带日期。
 */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 把 epoch ms 渲染成本地日期时间（环境快照、请求日志、配置恢复点共用）
 *
 * 入参是**应用语言**（`zh_CN` / `en`），不是 BCP47 标签：新增语言在这里补一次映射即可，
 * 不该让每个调用方各写一遍 `locale === 'en' ? 'en-US' : 'zh-CN'`。
 * 未知时间戳（0 或非法值）由调用方先判掉，这里不猜。
 */
export function formatLocaleDateTime(timestamp: number, appLocale: string): string {
  return new Date(timestamp).toLocaleString(appLocale === 'en' ? 'en-US' : 'zh-CN');
}
