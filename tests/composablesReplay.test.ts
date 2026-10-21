/**
 * 重放那一趟往返按运行时测：发出去的是什么、落回来变成屏上哪一句话、迟到的那一份算不算
 *
 * 组件的渲染与交互在这个环境里没有对应物（node、无 jsdom），但 composable 有——而这一层最贵的
 * 三件事恰好都不在渲染里：
 * 1. **发出去的那一笔不许带 `ruleId`**。带上了就是替用户假定他现在关心的还是当时那条规则，
 *    而「现在会怎么走」必须是后台重新匹配一遍的答案（`resolveSelectedRule` 那侧完全合法，
 *    所以这不是它能拦住的错，只能由这里钉住「我们没递过去」）。
 * 2. **迟到的回包不许落在下一行上**。在途期间换行，那一趟照样会落定；不认轮次的话，
 *    屏幕上是一行的方法、下面挂的是另一行的结局。
 * 3. **失败日志里不许出现目标地址与凭据头**。重放用的就是这条记录当初发出去的那组头，
 *    里面有真 token，而 logger 的输出会进控制台——那里没有打码这一步。
 *
 * `clearReplay` / `onUnmounted` 那两句接线由本文件末尾的源码契约钉（组件实例外的生命周期钩子
 * 永不触发，本环境没有运行时对应物）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MessageType } from '@/utils/types';
import type { RequestLogEntry } from '@/utils/types';

// 桩就地写：`vi.mock` 会被提到文件最顶端，工厂里引用外层 const 会撞在初始化之前
vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sendMessage = vi.fn();
vi.stubGlobal('chrome', { runtime: { sendMessage } });

import { useRequestReplay } from '@/composables/useRequestReplay';

function entryOf(over: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: 'log-1',
    timestamp: 1,
    ruleId: 'rule-1',
    ruleName: 'FAT → UAT',
    originalUrl: 'https://fat.example.com/api/orders',
    proxiedUrl: 'https://uat.example.com/api/orders',
    method: 'GET',
    status: 200,
    proxyType: 'sw',
    requestHeaders: { authorization: 'Bearer secret-token-abc', 'content-type': 'application/json' },
    requestBody: undefined,
    ...over,
  };
}

const envelope = (over: Record<string, unknown> = {}) => ({
  requestId: 'x',
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: '{"env":"uat"}',
  isBase64: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue(envelope());
});

describe('runReplay — 发出去的那一笔', () => {
  it('走 PROXY_REQUEST 这一个入口，载荷是这条记录自己的地址、方法、头与正文', async () => {
    const { runReplay } = useRequestReplay();
    await runReplay(entryOf({ method: 'POST', requestBody: '{"id":7}' }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const message = sendMessage.mock.calls[0][0] as { type: MessageType; data: Record<string, unknown> };
    expect(message.type).toBe(MessageType.PROXY_REQUEST);
    expect(message.data.url).toBe('https://fat.example.com/api/orders');
    expect(message.data.method).toBe('POST');
    expect(message.data.body).toBe('{"id":7}');
    expect(message.data.headers).toEqual({
      authorization: 'Bearer secret-token-abc',
      'content-type': 'application/json',
    });
    expect(typeof message.data.requestId).toBe('string');
    expect(message.data.requestId as string).toMatch(/^replay-/);
  });

  it('刻意不带 ruleId：让后台按地址与方法重新匹配一遍，才是「现在会怎么走」的答案', async () => {
    const { runReplay } = useRequestReplay();
    await runReplay(entryOf());
    const message = sendMessage.mock.calls[0][0] as { data: Record<string, unknown> };
    expect('ruleId' in message.data).toBe(false);
  });

  it('发不出去的记录根本不出门（不拿一次网络错误当「重放了」）', async () => {
    const { runReplay, replayView } = useRequestReplay();
    for (const bad of [
      entryOf({ originalUrl: 'wss://fat.example.com/ws' }),
      entryOf({ originalUrl: '' }),
      entryOf({ method: '   ' }),
    ]) {
      await runReplay(bad);
    }
    expect(sendMessage).not.toHaveBeenCalled();
    expect(replayView.value).toBeNull();
  });

  it('在途那一格先立起来，回包还没落地时不许有任何读数', async () => {
    let release: (value: unknown) => void = () => {};
    sendMessage.mockImplementation(() => new Promise(resolve => (release = resolve)));
    const { runReplay, replayView } = useRequestReplay();

    const pending = runReplay(entryOf());
    expect(replayView.value).toMatchObject({ ownerId: 'log-1', running: true, reading: null, transportFailed: false });

    release(envelope({ statusText: 'Mock', status: 204 }));
    await pending;
    expect(replayView.value).toMatchObject({ running: false });
    expect(replayView.value?.reading?.outcome).toBe('mock');
    // 耗时是量出来的，不是画死的：在途那一格必须是 0
    expect(replayView.value?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('回包怎么落进屏幕', () => {
  it('一份正常的信封读成 answered，并带着原样的状态码', async () => {
    const { runReplay, replayView } = useRequestReplay();
    sendMessage.mockResolvedValue(envelope({ status: 503, statusText: 'Service Unavailable' }));
    await runReplay(entryOf());
    expect(replayView.value?.reading).toMatchObject({
      outcome: 'answered',
      status: 503,
      statusText: 'Service Unavailable',
    });
  });

  it('往返失败不是「服务器报错」，也不是「没走代理」：它是「这一笔的答案没读到」', async () => {
    const { runReplay, replayView } = useRequestReplay();
    sendMessage.mockRejectedValue(new Error('message port closed'));
    await runReplay(entryOf());

    expect(replayView.value).toMatchObject({ running: false, transportFailed: true, reading: null });
    expect(replayView.value?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('失败那一条日志里不许出现目标地址、方法或任何一个头（重放用的正是当初那组凭据）', async () => {
    const { runReplay } = useRequestReplay();
    sendMessage.mockRejectedValue(new Error('boom'));
    await runReplay(entryOf());

    const { logger } = await import('@/utils/logger');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(vi.mocked(logger.warn).mock.calls[0]);
    expect(line).not.toContain('fat.example.com');
    expect(line).not.toContain('secret-token-abc');
    expect(line).not.toContain('application/json');
  });

  it('回收期那种「不是信封」的回包收成 malformed，而不是把 0 当状态码报出去', async () => {
    const { runReplay, replayView } = useRequestReplay();
    sendMessage.mockResolvedValue({ success: false });
    await runReplay(entryOf());
    expect(replayView.value).toMatchObject({ running: false, transportFailed: false });
    expect(replayView.value?.reading?.outcome).toBe('malformed');
  });
});

describe('迟到的那一份不算数', () => {
  it('在途期间换行并收回读数，之后落定的那一笔不许再写回屏幕', async () => {
    let release: (value: unknown) => void = () => {};
    sendMessage.mockImplementation(() => new Promise(resolve => (release = resolve)));
    const { runReplay, replayView, clearReplay } = useRequestReplay();

    const pending = runReplay(entryOf());
    clearReplay('log-1');
    expect(replayView.value).toBeNull();

    release(envelope({ statusText: 'Mock' }));
    await pending;
    // 摘掉轮次令牌的话，这一句就是红的：迟到的回包会把一段 nobody 看的读数挂回屏幕
    expect(replayView.value).toBeNull();
  });

  it('连着点两行时，屏幕上留的是后点那一行的账，前一行迟到的回包不许盖上去', async () => {
    const releases: ((value: unknown) => void)[] = [];
    sendMessage.mockImplementation(() => new Promise(resolve => releases.push(resolve)));
    const { runReplay, replayView } = useRequestReplay();

    const first = runReplay(entryOf({ id: 'log-A' }));
    const second = runReplay(entryOf({ id: 'log-B' }));
    expect(replayView.value?.ownerId).toBe('log-B');

    // 先让第二笔落定，再让第一笔迟到
    releases[1](envelope({ status: 404, statusText: 'Not Found' }));
    await second;
    releases[0](envelope({ status: 200, statusText: 'Mock' }));
    await first;

    expect(replayView.value?.ownerId).toBe('log-B');
    expect(replayView.value?.reading?.status).toBe(404);
  });

  it('clearReplay 报的是别行的 id 时不动当前这一屏', async () => {
    const { runReplay, replayView, clearReplay } = useRequestReplay();
    await runReplay(entryOf({ id: 'log-A' }));
    clearReplay('log-B');
    expect(replayView.value?.ownerId).toBe('log-A');
    clearReplay();
    expect(replayView.value).toBeNull();
  });
});

/**
 * 组件那两句接线：本环境没有运行时对应物（`onUnmounted` 在组件实例外永不触发），按源码钉
 *
 * 丢掉 `clearReplay` 的后果不是报错，是「换个行还看得见上一行的结局」——
 * 那正是本文件上面两条运行时用例专门挡住的事，而它的一半住在组件里。
 */
describe('LogDrawer 的装配（源码契约）', () => {
  const drawer = readFileSync('components/options/LogDrawer.vue', 'utf8');

  it('换行与关抽屉都收回重放那一格，且换行只收自己那一行', () => {
    expect(drawer).toContain('clearReplay()');
    expect(drawer).toMatch(/clearReplay\((selectedLog\.value\?\.id|log\.id)\)/);
  });

  it('确认那道闸门在组件这一侧，按 needsReplayConfirm 判，而不是在 composable 里', () => {
    expect(drawer).toContain('needsReplayConfirm');
    expect(drawer).toContain('ElMessageBox.confirm');
  });

  it('发出去的那一笔走 composable，组件不自己拼 PROXY_REQUEST（判据与往返只有一份）', () => {
    expect(drawer).not.toContain('MessageType.PROXY_REQUEST');
  });
});
