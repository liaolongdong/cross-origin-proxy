import type { RequestLogEntry } from './types';

/** 深链 URL 筛选的上界：地址栏是外部输入，超过这个长度按截断处理 */
export const MAX_LOG_URL_FILTER_LENGTH = 2048;

export interface LogFilterState {
  method: string;
  status: string;
  ruleName: string;
  urlKeyword: string;
}

/**
 * 日志四轴筛选判据
 *
 * 与 `LogDrawer` 原先的内联实现逐条等价：状态区间左闭右开，`error` 档只认 error 字段，
 * URL 同时匹配原始地址与代理地址且大小写不敏感。
 */
export function logMatchesFilters(log: RequestLogEntry, filter: LogFilterState): boolean {
  const matchesMethod = !filter.method || log.method === filter.method;
  const status = log.status;
  const matchesStatus =
    !filter.status ||
    (filter.status === '2xx' && typeof status === 'number' && status >= 200 && status < 300) ||
    (filter.status === '4xx' && typeof status === 'number' && status >= 400 && status < 500) ||
    (filter.status === '5xx' && typeof status === 'number' && status >= 500) ||
    (filter.status === 'error' && !!log.error);
  const matchesRule = !filter.ruleName || log.ruleName === filter.ruleName;
  const keyword = filter.urlKeyword.toLowerCase();
  const matchesUrl =
    !keyword || log.originalUrl.toLowerCase().includes(keyword) || log.proxiedUrl.toLowerCase().includes(keyword);
  return matchesMethod && matchesStatus && matchesRule && matchesUrl;
}

/**
 * 解析 `#logs?url=<encoded>` 里的筛选词
 *
 * 地址栏内容按不可信输入处理：解码失败按「没有筛选」处理，超长截断到上界，绝不把畸形串塞进界面。
 */
export function parseLogUrlFilter(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw).slice(0, MAX_LOG_URL_FILTER_LENGTH);
  } catch {
    return '';
  }
}
