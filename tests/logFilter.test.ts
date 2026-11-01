import { describe, expect, it } from 'vitest';
import {
  MAX_LOG_URL_FILTER_LENGTH,
  logMatchesFilters,
  parseLogUrlFilter,
  type LogFilterState,
} from '@/utils/logFilter';
import type { RequestLogEntry } from '@/utils/types';

const base: RequestLogEntry = {
  id: 'log-1',
  timestamp: 1,
  ruleId: 'rule-1',
  ruleName: 'FAT → UAT',
  originalUrl: 'https://fat-api.example.com/api/Users',
  proxiedUrl: 'https://uat-api.example.com/api/Users',
  method: 'GET',
  status: 200,
  proxyType: 'sw',
};

const empty: LogFilterState = { method: '', status: '', ruleName: '', urlKeyword: '' };

function log(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return { ...base, ...overrides };
}

describe('logMatchesFilters', () => {
  it('空筛选匹配一切', () => {
    expect(logMatchesFilters(log(), empty)).toBe(true);
  });

  it('方法精确匹配', () => {
    expect(logMatchesFilters(log(), { ...empty, method: 'GET' })).toBe(true);
    expect(logMatchesFilters(log(), { ...empty, method: 'POST' })).toBe(false);
  });

  it('状态区间按左闭右开：2xx / 4xx / 5xx', () => {
    expect(logMatchesFilters(log({ status: 200 }), { ...empty, status: '2xx' })).toBe(true);
    expect(logMatchesFilters(log({ status: 299 }), { ...empty, status: '2xx' })).toBe(true);
    expect(logMatchesFilters(log({ status: 199 }), { ...empty, status: '2xx' })).toBe(false);
    expect(logMatchesFilters(log({ status: 300 }), { ...empty, status: '2xx' })).toBe(false);
    expect(logMatchesFilters(log({ status: 400 }), { ...empty, status: '4xx' })).toBe(true);
    expect(logMatchesFilters(log({ status: 499 }), { ...empty, status: '4xx' })).toBe(true);
    expect(logMatchesFilters(log({ status: 500 }), { ...empty, status: '4xx' })).toBe(false);
    expect(logMatchesFilters(log({ status: 500 }), { ...empty, status: '5xx' })).toBe(true);
  });

  it('error 档只认 error 字段：代理失败没有状态码', () => {
    expect(logMatchesFilters(log({ status: undefined, error: 'Failed to fetch' }), { ...empty, status: 'error' })).toBe(
      true,
    );
    expect(logMatchesFilters(log({ status: undefined }), { ...empty, status: '2xx' })).toBe(false);
    expect(logMatchesFilters(log({ status: 200 }), { ...empty, status: 'error' })).toBe(false);
  });

  it('规则名精确匹配', () => {
    expect(logMatchesFilters(log(), { ...empty, ruleName: 'FAT → UAT' })).toBe(true);
    expect(logMatchesFilters(log(), { ...empty, ruleName: 'UAT → PROD' })).toBe(false);
  });

  it('URL 关键字同时匹配原始地址与代理地址，且大小写不敏感', () => {
    expect(logMatchesFilters(log(), { ...empty, urlKeyword: 'API/USERS' })).toBe(true);
    expect(logMatchesFilters(log(), { ...empty, urlKeyword: 'uat-api' })).toBe(true);
    expect(logMatchesFilters(log(), { ...empty, urlKeyword: 'prod-api' })).toBe(false);
  });

  it('四轴是 AND 关系', () => {
    expect(
      logMatchesFilters(log({ method: 'POST', status: 500 }), {
        method: 'POST',
        status: '5xx',
        ruleName: 'FAT → UAT',
        urlKeyword: 'api/users',
      }),
    ).toBe(true);
    expect(logMatchesFilters(log({ method: 'POST', status: 500 }), { ...empty, method: 'GET' })).toBe(false);
  });
});

describe('parseLogUrlFilter', () => {
  it('正常解码 percent-encoded 地址', () => {
    const url = 'https://fat-api.example.com/api/users?env=fat&x=1';
    expect(parseLogUrlFilter(encodeURIComponent(url))).toBe(url);
  });

  it('畸形编码按空筛选处理，不抛错', () => {
    expect(parseLogUrlFilter('%E0%A4%A')).toBe('');
  });

  it('超长地址按上界截断', () => {
    const long = 'a'.repeat(MAX_LOG_URL_FILTER_LENGTH + 100);
    expect(parseLogUrlFilter(long)).toHaveLength(MAX_LOG_URL_FILTER_LENGTH);
  });

  it('空输入返回空串', () => {
    expect(parseLogUrlFilter('')).toBe('');
    expect(parseLogUrlFilter(null)).toBe('');
    expect(parseLogUrlFilter(undefined)).toBe('');
  });
});
