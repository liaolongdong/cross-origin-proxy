import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProxyRule } from '@/utils/types';
import { MessageType } from '@/utils/types';
import { computeMigratedTargets } from '@/utils/ruleMigration';

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: 'https://fat.example.com/*',
    targetUrl: 'https://uat.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('computeMigratedTargets — 纯函数', () => {
  const rules = [
    makeRule({ id: 'a', targetUrl: 'https://uat1.example.com' }),
    makeRule({ id: 'b', targetUrl: 'https://uat1.example.com/v2' }),
    makeRule({ id: 'c', targetUrl: 'https://prod.example.com' }),
  ];

  it('仅返回 id 命中且 targetUrl 含查找串的变更集', () => {
    const result = computeMigratedTargets(rules, ['a', 'b', 'c'], 'uat1.example.com', 'uat2.example.com');
    expect(result.map(r => r.id).sort()).toEqual(['a', 'b']);
    expect(result.find(r => r.id === 'a')?.newUrl).toBe('https://uat2.example.com');
    expect(result.find(r => r.id === 'b')?.newUrl).toBe('https://uat2.example.com/v2');
  });

  it('find 为空时不产生任何变更（防误伤）', () => {
    expect(computeMigratedTargets(rules, ['a', 'b', 'c'], '', 'x')).toEqual([]);
  });

  it('未在 ids 内的规则不参与', () => {
    const result = computeMigratedTargets(rules, ['a'], 'uat1.example.com', 'uat2.example.com');
    expect(result.map(r => r.id)).toEqual(['a']);
  });

  it('不修改入参 rules', () => {
    const snapshot = JSON.stringify(rules);
    computeMigratedTargets(rules, ['a'], 'uat1.example.com', 'uat2.example.com');
    expect(JSON.stringify(rules)).toBe(snapshot);
  });
});

describe('storage.batchUpdateTargets — 一次写入', () => {
  const store: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('按 id 覆盖 targetUrl 并刷新 updatedAt，非命中项保持不变', async () => {
    const { batchUpdateTargets, getProxyConfig } = await import('@/utils/storage');
    store['proxy_config'] = {
      enabled: true,
      rules: [
        makeRule({ id: 'a', targetUrl: 'https://uat1.example.com', updatedAt: 111 }),
        makeRule({ id: 'b', targetUrl: 'https://prod.example.com', updatedAt: 222 }),
      ],
    };

    await batchUpdateTargets([{ id: 'a', targetUrl: 'https://uat2.example.com' }]);
    const config = await getProxyConfig();
    const a = config.rules.find(r => r.id === 'a');
    const b = config.rules.find(r => r.id === 'b');
    expect(a?.targetUrl).toBe('https://uat2.example.com');
    expect(a?.updatedAt).not.toBe(111);
    expect(b?.targetUrl).toBe('https://prod.example.com');
    expect(b?.updatedAt).toBe(222);
  });
});

describe('messageRouter — BATCH_UPDATE_TARGETS', () => {
  type RouterListener = (
    message: unknown,
    sender: unknown,
    sendResponse: (response?: unknown) => void,
  ) => boolean | undefined;

  let listener: RouterListener | undefined;
  const store: Record<string, unknown> = {};

  beforeEach(() => {
    listener = undefined;
    for (const key of Object.keys(store)) delete store[key];
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ id: 'a', targetUrl: 'https://uat1.example.com' })],
    };
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: () => 'chrome-extension://test/',
        onMessage: {
          addListener: vi.fn((fn: RouterListener) => {
            listener = fn;
          }),
        },
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('非受信 sender 时同步拒绝', async () => {
    const { setupMessageRouter } = await import('@/entrypoints/background/messageRouter');
    setupMessageRouter();
    const sendResponse = vi.fn();
    const result = listener!(
      { type: MessageType.BATCH_UPDATE_TARGETS, data: { updates: [{ id: 'a', targetUrl: 'https://x' }] } },
      { url: 'https://evil.example.com/' },
      sendResponse,
    );
    expect(result).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ success: false, error: 'Unauthorized sender' });
  });

  it('updates 非法（非数组）时同步回传错误', async () => {
    const { setupMessageRouter } = await import('@/entrypoints/background/messageRouter');
    setupMessageRouter();
    const sendResponse = vi.fn();
    const result = listener!(
      { type: MessageType.BATCH_UPDATE_TARGETS, data: { updates: 'nope' } },
      { url: 'chrome-extension://test/options/index.html' },
      sendResponse,
    );
    expect(result).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ success: false, error: 'Invalid updates' });
  });

  it('合法 updates 异步回传 { success: true }', async () => {
    const { setupMessageRouter } = await import('@/entrypoints/background/messageRouter');
    setupMessageRouter();
    const sendResponse = vi.fn();
    const result = listener!(
      {
        type: MessageType.BATCH_UPDATE_TARGETS,
        data: { updates: [{ id: 'a', targetUrl: 'https://uat2.example.com' }] },
      },
      { url: 'chrome-extension://test/options/index.html' },
      sendResponse,
    );
    expect(result).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });
});
