/**
 * 回包这一侧的体积上限，与 5xx 重试前那份没人读的回包。
 *
 * `MAX_BODY_SIZE` 此前只量得出**出站请求**：`response.text()` / `arrayBuffer()` 把整份正文
 * 一次性缓冲进 Service Worker，换一个后端就能稳定打进来——一个几百 MB 的下载先撑爆 worker
 * （同一时刻别的标签页在途的代理请求跟着遭殃），再按约 1.3 倍的 base64 字符串走一遍跨 world 的
 * `postMessage`。现在读的是流：数到越界就 `cancel()` 并回失败信封，口径与请求体超限那一条对齐
 * （截断式返回是把 JSON 改坏，静默成功是让日志与页面各说各话）。
 *
 * 夹具用**真的** `Response` + `ReadableStream`，不用手搓的 `{ text, arrayBuffer }` 桩：
 * 实现现在只看 `response.body` 那一条流，桩里没有它就等于「什么都没测」——
 * `proxyDeadline` / `cancelProxiedRequest` 那两份手搓桩正是因此一起换成真对象的。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubGlobal('chrome', {
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { getURL: vi.fn(() => 'chrome-extension://test/') },
});

const addRequestLog = vi.fn(async (_entry: Record<string, unknown>) => {});
let configToReturn: { enabled: boolean; rules: unknown[] } = { enabled: true, rules: [] };

// 部分 mock：只换这一支要观察的三个出口，其余留真身（同 requestGuard.test.ts 的取舍）
vi.mock('@/utils/storage', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/storage')>();
  return {
    ...actual,
    getProxyConfig: vi.fn(async () => configToReturn),
    addRequestLog: (entry: Record<string, unknown>) => addRequestLog(entry),
    getRequestLogs: vi.fn(async () => []),
  };
});

const { handleProxyRequest, MAX_BODY_SIZE } = await import('@/entrypoints/background/proxyHandler');

const MIB = 1024 * 1024;
const REQUEST = { requestId: 'req-1', url: 'https://fat.example.com/api/x', method: 'GET', headers: {} };

interface Probe {
  /** 上游那份流有没有被 `cancel()`——越界与重试这两条路径都靠它说「剩余部分不要了」 */
  cancelled: boolean;
  /** 实际被读走多少字节（越界之后不该再 pull 一块） */
  pulledBytes: number;
}

/** 一条会按需吐 `chunkSize × chunkCount` 字节的真实响应流 */
function streamingResponse(chunkSize: number, chunkCount: number, contentType: string, probe: Probe, status = 200) {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent++;
      probe.pulledBytes += chunkSize;
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      probe.cancelled = true;
    },
  });
  return new Response(stream, {
    status,
    statusText: status === 200 ? 'OK' : 'Server Error',
    headers: { 'content-type': contentType },
  });
}

/**
 * `findMatchingRule` 会把排好序的规则集缓存下来，缓存 key 只看「条数 + 每条的 id:updatedAt」
 * （`utils/urlMatcher.ts` 的 `buildRulesKey`）。这里七个用例共用一份 `matchPattern`，
 * 若 id 与 updatedAt 也相同，第二个用例拿到的就是第一个用例那份规则对象——`retryCount` 这类
 * 与匹配无关的字段从此冻结。生产环境不会走到这一步（`dnrManager` 的配置变更监听里调了
 * `invalidateMatcherCache()`），所以修法是按用例给唯一 id，而不是回去动缓存。
 */
let ruleSeq = 0;

function useRule(overrides: Record<string, unknown> = {}) {
  ruleSeq++;
  configToReturn = {
    enabled: true,
    rules: [
      {
        id: `r${ruleSeq}`,
        name: '回包上限',
        enabled: true,
        matchType: 'wildcard',
        matchPattern: 'https://fat.example.com/*',
        targetUrl: 'https://uat.example.com/',
        priority: 10,
        createdAt: 0,
        updatedAt: ruleSeq,
        ...overrides,
      },
    ],
  };
}

describe('回包按字节流读取，越界即停', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    addRequestLog.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('上限之内的文本回包照常返回，正文逐字不动', async () => {
    useRule();
    fetchMock.mockResolvedValue(
      new Response('hello 中文 ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    );

    const res = await handleProxyRequest(REQUEST);

    expect(res).toMatchObject({ status: 200, isBase64: false, body: 'hello 中文 ok' });
  });

  it('二进制回包仍走 base64，解回来是同一堆字节', async () => {
    useRule();
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    fetchMock.mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));

    const res = await handleProxyRequest(REQUEST);

    expect(res.isBase64).toBe(true);
    expect(new Uint8Array(Buffer.from(String(res.body), 'base64'))).toEqual(bytes);
  });

  it('恰好等于上限的回包照常放行（判据是「超过」，不是「达到」）', async () => {
    useRule();
    const probe: Probe = { cancelled: false, pulledBytes: 0 };
    fetchMock.mockResolvedValue(streamingResponse(MIB, MAX_BODY_SIZE / MIB, 'text/plain', probe));

    const res = await handleProxyRequest(REQUEST);

    expect(res.status).toBe(200);
    expect(String(res.body).length).toBe(MAX_BODY_SIZE);
    expect(probe.cancelled).toBe(false);
  });

  it('越界的回包以失败信封收口，剩余部分被掐掉，不再继续读', async () => {
    useRule();
    const probe: Probe = { cancelled: false, pulledBytes: 0 };
    // 64 MiB：越界之后还留着 50 多块可读，「停下来」与「把整条流抽干」在这一个数上分得开
    fetchMock.mockResolvedValue(streamingResponse(MIB, 64, 'text/plain', probe));

    const res = await handleProxyRequest(REQUEST);

    expect(res.status).toBe(0);
    expect(res.statusText).toBe('Body Too Large');
    expect(res.body).toBe(`Response body exceeds ${MAX_BODY_SIZE} bytes`);
    // 越界那一站就停：不 cancel 的话，那几百 MB 照样会被 pull 进 worker
    expect(probe.cancelled).toBe(true);
    // 上界给的是「读过头一块」这一档：底的实现逐块数字节，一到越界就 cancel；
    // 但 ReadableStream 自己会预读（实测 1～2 块在途），所以这里只断言「远没有抽干」，
    // 抽干是 64 MiB —— 摘掉 cancel 那一行，这一格当场红。
    expect(probe.pulledBytes).toBeLessThanOrEqual(MAX_BODY_SIZE + 4 * MIB);
    const entry = addRequestLog.mock.calls[0][0] as { error: string; status: number };
    expect(entry.error).toContain('Response body exceeds');
    expect(entry.status).toBe(0);
  });

  it('超限不是可重试的失败：配了 retryCount 也只发一次', async () => {
    useRule({ retryCount: 2, retryDelay: 100 });
    const probe: Probe = { cancelled: false, pulledBytes: 0 };
    fetchMock.mockResolvedValue(streamingResponse(MIB, MAX_BODY_SIZE / MIB + 1, 'text/plain', probe));

    const res = await handleProxyRequest(REQUEST);

    expect(res.statusText).toBe('Body Too Large');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5xx 重试之前先掐掉上一份没人读的回包', async () => {
    useRule({ retryCount: 1, retryDelay: 10 });
    const first: Probe = { cancelled: false, pulledBytes: 0 };
    const second: Probe = { cancelled: false, pulledBytes: 0 };
    fetchMock
      .mockResolvedValueOnce(streamingResponse(1024, 4, 'text/plain', first, 502))
      .mockResolvedValueOnce(new Response('recovered', { status: 200, headers: { 'content-type': 'text/plain' } }));

    const res = await handleProxyRequest(REQUEST);

    expect(res).toMatchObject({ status: 200, body: 'recovered' });
    // 那半截 502 的正文永远不会被读：不 cancel 就是让它在重试期间继续握着连接与内存
    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(false);
  });

  it('最后一次尝试仍是 5xx 时，那份回包照常返回给页面（不当成「没人读」掐掉）', async () => {
    useRule({ retryCount: 1, retryDelay: 10 });
    // 每次尝试一条**新的**流：`mockResolvedValue` 交回的是同一个 Response 对象，
    // 第一次被 cancel 之后再读它就是 0 字节——那测的不再是「最后一份照常读满」。
    const probes: Probe[] = [];
    fetchMock.mockImplementation(async () => {
      const probe: Probe = { cancelled: false, pulledBytes: 0 };
      probes.push(probe);
      return streamingResponse(1024, 4, 'text/plain', probe, 503);
    });

    const res = await handleProxyRequest(REQUEST);

    expect(res.status).toBe(503);
    expect(String(res.body).length).toBe(4096);
    expect(probes).toHaveLength(2);
    expect(probes[0].cancelled).toBe(true);
    expect(probes[1].cancelled).toBe(false);
  });
});
