/**
 * 环境响应对比（C1）的判据、发送与形状
 *
 * 三层各按外部可观察面测：
 * 1. `utils/envDiff.ts` 纯函数按「输入 → 答案」表；
 * 2. `entrypoints/background/envDiff.ts` 用**真的** `Response` + 挂 `signal` 的 fetch 桩走完整
 *    链路——两道协议闸、展开后的 CRLF 重判、体积越界掐流、超时与取消都落在这层；
 * 3. `composables/useEnvDiff.ts` 按假 `chrome.runtime.sendMessage` 测并发两侧、轮次令牌与取消的
 *    收件人名单。
 * 界面那一层（渲染、点击、Esc 级联）在本环境没有运行时对应物，由文件末尾的源码契约钉形状。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MessageType } from '@/utils/types';

vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const storageSet = vi.fn(async () => {});
const VARIABLES: Record<string, string> = {
  TOKEN: 'secret123',
  PATH: 'users',
  EVIL: 'a\r\nX-Injected: 1',
  BASE: 'file://',
};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (key: string) => (key === 'variables' ? { variables: { ...VARIABLES } } : {})),
      set: storageSet,
    },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { getURL: vi.fn(() => 'chrome-extension://test/') },
});

const { prepareEnvDiffRequest, prettifyEnvDiffBody, findFirstBodyDiffLine } = await import('@/utils/envDiff');
const envDiffBg = await import('@/entrypoints/background/envDiff');
const { MAX_BODY_SIZE } = await import('@/entrypoints/background/proxyHandler');
const { useEnvDiff } = await import('@/composables/useEnvDiff');

const MIB = 1024 * 1024;

function basePayload(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    url: 'https://api.example.com/users',
    method: 'GET',
    headers: {},
    ...over,
  };
}

describe('prepareEnvDiffRequest：后台侧的载荷重判', () => {
  it('合法与宽容的形状', () => {
    expect(prepareEnvDiffRequest(basePayload())).toEqual({
      url: 'https://api.example.com/users',
      method: 'GET',
      headers: {},
      body: undefined,
      sendCredentials: false,
    });
    // trim + 大写归一；空串 body 当「没带」而不是「带了一段空文本」
    expect(prepareEnvDiffRequest(basePayload({ url: '  https://a.b/x  ', method: ' post ', body: '' }))).toEqual({
      url: 'https://a.b/x',
      method: 'POST',
      headers: {},
      body: undefined,
      sendCredentials: false,
    });
    // sendCredentials 只认严格 true——字符串 'true' 不算（与规则侧同一条判据）
    const asString = prepareEnvDiffRequest(basePayload({ sendCredentials: 'true' }));
    const asTrue = prepareEnvDiffRequest(basePayload({ sendCredentials: true }));
    expect('reject' in asString ? asString.reject : asString.sendCredentials).toBe(false);
    expect('reject' in asTrue ? asTrue.reject : asTrue.sendCredentials).toBe(true);
  });

  it('拒绝的形状逐个点名', () => {
    expect(prepareEnvDiffRequest(basePayload({ url: 'ftp://a.b' }))).toEqual({ reject: 'url' });
    expect(prepareEnvDiffRequest(basePayload({ url: '/relative/path' }))).toEqual({ reject: 'url' });
    expect(prepareEnvDiffRequest(basePayload({ url: '' }))).toEqual({ reject: 'url' });
    expect(prepareEnvDiffRequest(basePayload({ url: 42 }))).toEqual({ reject: 'url' });
    expect(prepareEnvDiffRequest(basePayload({ method: 'GE T' }))).toEqual({ reject: 'method' });
    expect(prepareEnvDiffRequest(basePayload({ method: '' }))).toEqual({ reject: 'method' });
    expect(prepareEnvDiffRequest(basePayload({ method: 7 }))).toEqual({ reject: 'method' });
    expect(prepareEnvDiffRequest(basePayload({ headers: { 'bad header': 'v' } }))).toEqual({ reject: 'headers' });
    expect(prepareEnvDiffRequest(basePayload({ headers: { ok: 'value with\r\ninjected' } }))).toEqual({
      reject: 'headers',
    });
    expect(prepareEnvDiffRequest(basePayload({ headers: { ok: 3 } }))).toEqual({ reject: 'headers' });
    expect(prepareEnvDiffRequest(basePayload({ headers: ['a'] }))).toEqual({ reject: 'headers' });
    const many: Record<string, string> = {};
    for (let i = 0; i < 65; i++) many[`x-h-${i}`] = '1';
    expect(prepareEnvDiffRequest(basePayload({ headers: many }))).toEqual({ reject: 'headers' });
    expect(prepareEnvDiffRequest(null)).toEqual({ reject: 'url' });
    expect(prepareEnvDiffRequest('not an object')).toEqual({ reject: 'url' });
  });
});

describe('正文的比较口径', () => {
  it('像 JSON 就格式化，读不出来原样交回', () => {
    // JSON.parse 保持键的插入序，格式化只统一缩进与空白，**不重排键**——
    // 两份同键序不同空白的回包会判成一致，两份键序不同的会按行报差异，这是刻意的取舍
    expect(prettifyEnvDiffBody('{"b":2,"a":1}')).toBe('{\n  "b": 2,\n  "a": 1\n}');
    expect(prettifyEnvDiffBody('[1,2]')).toBe('[\n  1,\n  2\n]');
    expect(prettifyEnvDiffBody('not json {{')).toBe('not json {{');
    expect(prettifyEnvDiffBody('<html><body>')).toBe('<html><body>');
    expect(prettifyEnvDiffBody('')).toBe('');
  });

  it('逐行找第一处差异', () => {
    const a = 'x\ny\nz';
    expect(findFirstBodyDiffLine(a, a)).toBeNull();
    expect(findFirstBodyDiffLine('x\ny\nz', 'x\nQ\nz')).toBe(2);
    // 公共部分逐行相同而长度不同：短的那份「从这里往后没有了」
    expect(findFirstBodyDiffLine('x\ny', 'x\ny\nz')).toBe(3);
    expect(findFirstBodyDiffLine('', 'x')).toBe(1);
    expect(findFirstBodyDiffLine('', '')).toBeNull();
  });
});

describe('后台执行侧：两道闸、展开、体积、超时与取消', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  beforeEach(() => {
    fetchMock.mockReset();
    storageSet.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function jsonResponse(body: string, status = 200, contentType = 'application/json'): Response {
    return new Response(body, {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'content-type': contentType },
    });
  }

  it('第一道闸：进门那串不是 http(s) 就不出门', async () => {
    const result = await envDiffBg.runEnvDiff(basePayload({ url: 'ftp://a.b/x' }) as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('变量展开后仍不是 http(s) 也不出门——第二道闸挡的是「进门合法、出门越界」那一格', async () => {
    const result = await envDiffBg.runEnvDiff(basePayload({ url: '{{BASE}}etc/passwd' }) as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('展开把 CRLF 带进头值：整笔拒绝而不是删掉那条头', async () => {
    const result = await envDiffBg.runEnvDiff(basePayload({ headers: { 'x-token': '{{EVIL}}' } }) as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('headers');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('成功路径：展开后的地址与头真的出门，GET 不带 body，回包原样交回', async () => {
    fetchMock.mockResolvedValue(jsonResponse('{"env":"uat"}'));
    const result = await envDiffBg.runEnvDiff(
      basePayload({ url: 'https://api.example.com/{{PATH}}', headers: { authorization: 'Bearer {{TOKEN}}' } }) as never,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://api.example.com/users');
    expect(calledInit.headers).toEqual({ authorization: 'Bearer secret123' });
    expect('body' in calledInit).toBe(false);
    expect(calledInit.credentials).toBe('omit');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"env":"uat"}');
    expect(result.truncated).toBe(false);
  });

  it('未定义的引用按字面量出门（与代发同一口径，界面上的话由弹窗自己说）', async () => {
    fetchMock.mockResolvedValue(jsonResponse('{}'));
    await envDiffBg.runEnvDiff(basePayload({ url: 'https://a.b/{{UNDEFINED_NAME}}' }) as never);
    expect(fetchMock.mock.calls[0][0]).toBe('https://a.b/{{UNDEFINED_NAME}}');
  });

  it('sendCredentials 严格 true 才 include；带 body 的方法才把 body 交出去', async () => {
    fetchMock.mockResolvedValue(jsonResponse('{}'));
    await envDiffBg.runEnvDiff(basePayload({ method: 'POST', body: 'hello', sendCredentials: true }) as never);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
    expect(init.body).toBe('hello');
  });

  it('请求体越界：失败信封，fetch 一次都不发', async () => {
    const big = 'x'.repeat(MAX_BODY_SIZE + 1);
    const result = await envDiffBg.runEnvDiff(basePayload({ method: 'POST', body: big }) as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('body');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('回包正文越界：不算失败——状态与耗时是真的，只有正文没读回来，且剩余流被掐掉', async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 12) {
          controller.close();
          return;
        }
        sent++;
        controller.enqueue(new Uint8Array(MIB));
      },
    });
    fetchMock.mockResolvedValue(
      new Response(stream, { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' } }),
    );
    const result = await envDiffBg.runEnvDiff(basePayload() as never);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.error).toBe('bodyTooLarge');
  });

  it('30 秒读不到回包判超时；桩按 signal 落 AbortError，与真 fetch 同形', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const pending = envDiffBg.runEnvDiff(basePayload() as never);
    // 必须用 Async 版：`runEnvDiff` 在排定 30s 闸之前还有一个 await，同步版会先跑过头再空等
    await vi.advanceTimersByTimeAsync(31000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
  });

  it('取消把 abort 交进那一次 fetch；键对不上时安静回 false', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const pending = envDiffBg.runEnvDiff(basePayload({ requestId: 'cancel-me' }) as never);
    await vi.waitFor(() => expect(envDiffBg.cancelEnvDiff('cancel-me')).toBe(true));
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('cancelled');
    expect(envDiffBg.cancelEnvDiff('cancel-me')).toBe(false);
  });

  it('fetch 抛出（DNS/连接失败）落在 network 档', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await envDiffBg.runEnvDiff(basePayload() as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('network');
  });

  it('空响应回 body:null 而不是空串——「回了个空」与「没读到」在界面上各说各话', async () => {
    // 204 按 fetch 规格不能有 body：真 `Response` 构造器会直接拒空串，桩要交出与它同形的对象
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const result = await envDiffBg.runEnvDiff(basePayload() as never);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
    expect(result.body).toBeNull();
  });

  it('这一趟不写任何存储：对比不是页面请求，日志与命中统计都不该多这笔账', async () => {
    fetchMock.mockResolvedValue(jsonResponse('{}'));
    await envDiffBg.runEnvDiff(basePayload() as never);
    expect(storageSet).not.toHaveBeenCalled();
  });
});

describe('编排层 useEnvDiff：两侧并发、轮次令牌与取消名单', () => {
  const sendMessage = vi.fn();
  vi.stubGlobal('chrome', {
    ...globalThis.chrome,
    runtime: { ...globalThis.chrome.runtime, sendMessage },
  });

  const okEnvelope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    requestId: 'x',
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '{"env":"dev"}',
    truncated: false,
    durationMs: 5,
    ...over,
  });

  it('两侧各带自己的 requestId 并发发出，结果按 a/b 对号入座', async () => {
    sendMessage.mockImplementation(async () => okEnvelope());
    const { runPair, running } = useEnvDiff();
    const promise = runPair(
      { url: 'https://a.example/x', method: 'GET', headers: {} },
      { url: 'https://b.example/x', method: 'GET', headers: {} },
    );
    expect(running.value).toBe(true);
    const pair = await promise;
    expect(running.value).toBe(false);
    const sends = sendMessage.mock.calls
      .map(call => call[0] as { type: string; data: { requestId?: string; url?: string } })
      .filter(message => message.type === MessageType.ENV_DIFF_REQUEST);
    expect(sends).toHaveLength(2);
    expect(sends[0].data.requestId).not.toBe(sends[1].data.requestId);
    expect(sends[0].data.url).toBe('https://a.example/x');
    expect(sends[1].data.url).toBe('https://b.example/x');
    expect(pair?.a.body).toBe('{"env":"dev"}');
  });

  it('回包不成形状落 noAnswer，而不是画成「请求没到达」', async () => {
    sendMessage.mockImplementation(async () => undefined);
    const { runPair } = useEnvDiff();
    const pair = await runPair(
      { url: 'https://a.example/x', method: 'GET', headers: {} },
      { url: 'https://b.example/x', method: 'GET', headers: {} },
    );
    expect(pair?.a.ok).toBe(false);
    expect(pair?.a.error).toBe('noAnswer');
    expect(pair?.b.error).toBe('noAnswer');
  });

  it('消息层抛出同样落 noAnswer（SW 回收期的迟到失败不许变成「环境没回应」）', async () => {
    // `mockRejectedValue` 撞上 vitest 4 的 `mockReset` 会把拒绝变成整条测试的失败
    // （与本仓无关的裸 mock 也复现）；这里用等价形状 `async () => { throw }`
    sendMessage.mockImplementation(async () => {
      throw new Error('message port closed');
    });
    const { runPair } = useEnvDiff();
    const pair = await runPair(
      { url: 'https://a.example/x', method: 'GET', headers: {} },
      { url: 'https://b.example/x', method: 'GET', headers: {} },
    );
    expect(pair?.a.error).toBe('noAnswer');
  });

  it('status 非有限数按畸形收口；布尔与数字被钳成真值', async () => {
    sendMessage.mockImplementation(async () => okEnvelope({ status: Number.NaN, durationMs: -3 }));
    const { runPair } = useEnvDiff();
    const pair = await runPair(
      { url: 'https://a.example/x', method: 'GET', headers: {} },
      { url: 'https://b.example/x', method: 'GET', headers: {} },
    );
    expect(pair?.a.error).toBe('noAnswer');
  });

  it('取消：两笔各发一条 ENV_DIFF_CANCEL，迟到的回包整轮作废且不把忙态按下去', async () => {
    const releases: Array<(value: unknown) => void> = [];
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === MessageType.ENV_DIFF_REQUEST) {
        return new Promise(resolve => releases.push(resolve));
      }
      return Promise.resolve({ success: true });
    });
    const { runPair, cancel, running } = useEnvDiff();
    const promise = runPair(
      { url: 'https://a.example/x', method: 'GET', headers: {} },
      { url: 'https://b.example/x', method: 'GET', headers: {} },
    );
    await vi.waitFor(() => expect(releases.length).toBe(2));
    cancel();
    expect(running.value).toBe(false);
    // 两份迟到回包原样落定
    releases.forEach((release, index) => release(okEnvelope({ body: `late-${index}` })));
    const pair = await promise;
    expect(pair).toBeNull();
    const cancels = sendMessage.mock.calls
      .map(call => call[0] as { type: string })
      .filter(message => message.type === MessageType.ENV_DIFF_CANCEL);
    expect(cancels).toHaveLength(2);
  });

  it('在途名单只认还活着的那几笔：落定之后取消不再补发', async () => {
    sendMessage.mockImplementation(async () => okEnvelope());
    const { runPair, cancel } = useEnvDiff();
    await runPair(
      { url: 'https://a.example/x', method: 'GET', headers: {} },
      { url: 'https://b.example/x', method: 'GET', headers: {} },
    );
    sendMessage.mockClear();
    cancel();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('接线契约（无 jsdom 的那一层的形状）', () => {
  const router = readFileSync('entrypoints/background/messageRouter.ts', 'utf-8');
  const bridge = readFileSync('entrypoints/content.ts', 'utf-8');
  const dialog = readFileSync('components/options/EnvDiffDialog.vue', 'utf-8');
  const app = readFileSync('components/options/App.vue', 'utf-8');
  const bg = readFileSync('entrypoints/background/envDiff.ts', 'utf-8');

  it('ENV_DIFF 两条都过 sender gate，且桥接层永远不转发它们', () => {
    expect(router).toContain(
      'EXTENSION_OUTBOUND_TYPES = new Set([MessageType.ENV_DIFF_REQUEST, MessageType.ENV_DIFF_CANCEL])',
    );
    const gateStart = router.indexOf('STATE_MUTATING_TYPES.has(message.type)');
    expect(gateStart).toBeGreaterThan(-1);
    expect(router.slice(gateStart, router.indexOf('sendResponse({ success: false', gateStart))).toContain(
      'EXTENSION_OUTBOUND_TYPES.has(message.type)',
    );
    expect(bridge, '桥接层多了一个通往 SW 的出站口——加出口必须回来重判分档').not.toContain('ENV_DIFF');
  });

  it('请求分支走异步通道，取消分支同步回执', () => {
    const caseStart = router.indexOf('case MessageType.ENV_DIFF_REQUEST');
    const caseEnd = router.indexOf('case MessageType.ENV_DIFF_CANCEL');
    expect(caseStart).toBeGreaterThan(-1);
    expect(caseEnd).toBeGreaterThan(caseStart);
    expect(router.slice(caseStart, caseEnd)).toContain('respondAsync');
    expect(router.slice(caseEnd)).toContain('sendResponse({ success: cancelEnvDiff(');
  });

  it('执行侧不碰日志、不抬交叉校验基线', () => {
    expect(bg).not.toContain('addRequestLog');
    expect(bg).not.toContain('countProxyRequestForTab');
    expect(bg).not.toContain('trackRuleHit');
  });

  it('弹窗：非安全方法先问一句（判据复用重放那一份），关面板时掐掉在途并把 visible 交回去', () => {
    const confirmAt = dialog.indexOf('needsReplayConfirm(method.value)');
    const runAt = dialog.indexOf('runPair(sideInput(urlA.value)');
    expect(confirmAt, '确认闸门不见了：POST 会直接发给两个环境').toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(-1);
    expect(confirmAt, '问话排在发出之后就成了先斩后奏').toBeLessThan(runAt);
    expect(dialog, '确认句没点名方法或两个地址').toMatch(
      /envDiffConfirmBody.*method|t\('envDiffConfirmBody', \[method/,
    );
    expect(dialog).toContain('if (running.value) stopPair();');
    // EP 的 X／遮罩只发 `close`，`update:visible` 得由这里回传——漏了它，App 侧旗标永留 true，
    // 第二次点顶栏／⌘K／深链都不再触发 watcher（评审抓到的那次「弹窗再也打不开」）
    const closeStart = dialog.indexOf('function handleDialogClose');
    expect(closeStart).toBeGreaterThan(-1);
    expect(
      dialog.slice(closeStart, dialog.indexOf('\n}', closeStart)),
      '关闭没把 visible 回传给容器：弹窗第二次打不开',
    ).toContain("emit('update:visible', false)");
  });

  it('App：hash、快捷键让位判据与 Escape 级联三处都在', () => {
    expect(app).toContain("hash === '#env-diff'");
    expect(app).toContain('showEnvDiff.value = true;');
    const overlayStart = app.indexOf('const anyOverlayOpen = computed(');
    expect(app.slice(overlayStart, app.indexOf(');', overlayStart))).toContain('showEnvDiff.value');
    const escapeStart = app.indexOf("if (e.key === 'Escape')");
    expect(app.slice(escapeStart, app.indexOf('\n}\n', escapeStart))).toContain('showEnvDiff.value');
  });
});
