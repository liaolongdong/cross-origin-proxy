import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestLogEntry } from '@/utils/types';
import { STORAGE_KEYS, MAX_LOG_BODY_SIZE, MAX_LOG_ENTRIES } from '@/utils/constants';
import { truncateForLog } from '@/utils/formatters';

/** 真实 `chrome.storage.local.get` 每次返回反序列化副本；桩必须同样如此，否则就地改读出的对象等于改了「存储」 */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function logEntry(id: string, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id,
    timestamp: 0,
    ruleId: 'r1',
    ruleName: 'rule',
    originalUrl: 'https://a.com/x',
    proxiedUrl: 'https://b.com/x',
    method: 'POST',
    proxyType: 'sw',
    ...overrides,
  };
}

// ─── truncateForLog（纯函数，无需 chrome 桩） ────────────────────────────────

describe('truncateForLog', () => {
  it('未超限原样返回', () => {
    expect(truncateForLog('hello', 100)).toBe('hello');
    expect(truncateForLog('', 100)).toBe('');
  });

  it('超限时截断并标注原始长度', () => {
    const value = 'x'.repeat(50);
    const result = truncateForLog(value, 20);
    expect(result.startsWith('x'.repeat(20))).toBe(true);
    expect(result).toContain('original 50 chars');
  });

  it('边界：恰好等于上限不截断', () => {
    const value = 'y'.repeat(20);
    expect(truncateForLog(value, 20)).toBe(value);
  });
});

// ─── 写入侧收口：正文上限 + 总量预算 + 失败恢复 ──────────────────────────────

describe('日志配额收口', () => {
  let store: Record<string, unknown> = {};
  let failNextSet = false;
  /** 持续失败模式：模拟配额长期不可用，用于验证缓冲区收口的丢弃方向 */
  let alwaysFail = false;
  const setSpy = vi.fn(async (obj: Record<string, unknown>) => {
    if (alwaysFail) throw new Error('QUOTA_BYTES quota exceeded');
    if (failNextSet) {
      failNextSet = false;
      throw new Error('QUOTA_BYTES quota exceeded');
    }
    Object.assign(store, clone(obj));
  });

  beforeEach(() => {
    store = {};
    failNextSet = false;
    alwaysFail = false;
    setSpy.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: clone(store[key]) })),
          set: setSpy,
        },
        onChanged: { addListener: vi.fn() },
      },
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('超大正文入缓冲后，落到 storage 的是截断文本', async () => {
    const { addRequestLog, flushLogs, getRequestLogs } = await import('@/utils/storage');
    const huge = 'z'.repeat(MAX_LOG_BODY_SIZE + 5000);
    await addRequestLog(logEntry('big', { requestBody: huge, responseBody: huge }));
    await flushLogs();

    const [stored] = await getRequestLogs();
    const req = stored.requestBody ?? '';
    const res = stored.responseBody ?? '';
    expect(req.length).toBeLessThan(huge.length);
    expect(res).toContain('original');
  });

  it('未超限条目不产生副本、不改写调用方对象', async () => {
    const { capLogEntryBodies } = await import('@/utils/storage');
    const entry = logEntry('small', { requestBody: '{"a":1}' });
    expect(capLogEntryBodies(entry)).toBe(entry);

    const big = logEntry('big', { responseBody: 'q'.repeat(MAX_LOG_BODY_SIZE + 1) });
    const capped = capLogEntryBodies(big);
    expect(capped).not.toBe(big);
    expect(big.responseBody).toHaveLength(MAX_LOG_BODY_SIZE + 1); // 不就地改写
  });

  it('undefined 正文保持 undefined，不被写成空串（HAR 导出依赖该判定）', async () => {
    const { capLogEntryBodies } = await import('@/utils/storage');
    const entry = logEntry('bin', { responseIsBase64: true });
    const capped = capLogEntryBodies(entry);
    expect('responseBody' in capped).toBe(false);
    expect(capped.responseBody).toBeUndefined();
  });

  it('trimLogsToBudget：从最新端累加，丢弃超预算的旧条目', async () => {
    const { trimLogsToBudget } = await import('@/utils/storage');
    const big = 'b'.repeat(1000);
    const logs = [
      logEntry('newest'),
      logEntry('mid', { responseBody: big }),
      logEntry('oldest', { responseBody: big }),
    ];

    expect(trimLogsToBudget(logs, 2500).map(l => l.id)).toEqual(['newest', 'mid', 'oldest']);
    expect(trimLogsToBudget(logs, 1500).map(l => l.id)).toEqual(['newest', 'mid']);
    expect(trimLogsToBudget(logs, 10).map(l => l.id)).toEqual(['newest']);
  });

  it('预算再小也至少保留最新一条，不把整份日志清成空数组', async () => {
    const { trimLogsToBudget } = await import('@/utils/storage');
    const logs = [logEntry('only', { responseBody: 'b'.repeat(5000) })];
    expect(trimLogsToBudget(logs, 1)).toEqual(logs);
    expect(trimLogsToBudget([], 1)).toEqual([]);
  });

  it('刷写失败：不丢条目、不产生未处理拒绝，下一次刷写补写成功', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { addRequestLog, flushLogs, getRequestLogs } = await import('@/utils/storage');

    failNextSet = true;
    await addRequestLog(logEntry('retry-me'));
    await expect(flushLogs()).resolves.toBeUndefined();
    expect(await getRequestLogs()).toHaveLength(0);

    await addRequestLog(logEntry('next'));
    await flushLogs();
    const ids = (await getRequestLogs()).map(l => l.id);
    expect(ids).toContain('retry-me');
    expect(ids).toContain('next');
    // 补写的旧条目排在后面：数组约定「头部是最新」，环形缓冲与正文预算都按这个方向裁剪
    expect(ids).toEqual(['next', 'retry-me']);
    // 失败不能静默：必须有日志留痕
    expect(errorSpy).toHaveBeenCalled();
  });

  it('刷写持续失败时缓冲区按上限收口，丢掉的是最旧的一条而不是最新的', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { addRequestLog, flushLogs, getRequestLogs } = await import('@/utils/storage');

    alwaysFail = true;
    // 每满 10 条触发一次失败刷写，缓冲区边涨边收口
    for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) {
      await addRequestLog(logEntry(`log-${i}`));
    }
    alwaysFail = false;
    await flushLogs();

    const ids = (await getRequestLogs()).map(l => l.id);
    expect(ids).toHaveLength(MAX_LOG_ENTRIES);
    expect(ids[0]).toBe(`log-${MAX_LOG_ENTRIES + 4}`);
    expect(ids).not.toContain('log-0');
    // 留下的必须是一段连续的「最新窗口」
    expect(ids.map(id => Number(id.slice(4)))).toEqual(
      Array.from({ length: MAX_LOG_ENTRIES }, (_, i) => MAX_LOG_ENTRIES + 4 - i),
    );
  });

  it('saveProxyConfig 写入失败后使缓存失效，不把未落盘的对象当事实来源', async () => {
    const { getProxyConfig, saveProxyConfig } = await import('@/utils/storage');
    store[STORAGE_KEYS.PROXY_CONFIG] = { enabled: false, rules: [] };

    const config = await getProxyConfig();
    config.rules.push({
      id: 'dirty',
      name: 'dirty',
      enabled: true,
      matchPattern: 'https://a.com/*',
      targetUrl: 'https://b.com',
      matchType: 'wildcard',
      priority: 1,
      createdAt: 0,
      updatedAt: 0,
    });

    failNextSet = true;
    await expect(saveProxyConfig(config)).rejects.toThrow('quota exceeded');
    const reread = await getProxyConfig();
    expect(reread.rules).toHaveLength(0);
  });
});
