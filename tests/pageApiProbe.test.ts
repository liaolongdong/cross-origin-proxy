/**
 * 探测这一层的唯一职责：问不到就当没问到
 *
 * `utils/pageApiProbe.ts` 是 popup 那一次点击唯一的异步边界。它决定「为本页创建规则」是
 * 给出候选、还是退回旧行为，所以承重面全在失败侧：没有内容脚本、页面不作答、回包形状不对、
 * 拿不到 tabId——四种都必须落成空数组，且**不能把点击悬在那里**。
 *
 * 另两处顺手钉住：只问顶层 frame（不带 frameId 会发给全部 frame、只取第一个应答者），
 * 以及超时用的那枚定时器在正常路径上会被撤掉。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PAGE_API_PROBE, PAGE_API_PROBE_TIMEOUT_MS } from '@/utils/constants';

const sendMessage = vi.fn();
const runtimeSendMessage = vi.fn();
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock('@/utils/logger', () => ({ logger }));
vi.stubGlobal('chrome', {
  tabs: { sendMessage },
  runtime: { sendMessage: runtimeSendMessage },
});

const { probePageApiOrigins } = await import('@/utils/pageApiProbe');

const UAT = { origin: 'https://uat-api.example.com', count: 3 };
const reply = { origins: [UAT] };

beforeEach(() => {
  sendMessage.mockReset();
  runtimeSendMessage.mockReset();
  Object.values(logger).forEach(fn => fn.mockReset());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('问得到：照单收下，且只问顶层 frame', () => {
  it('回包里的清单原样交给界面', async () => {
    sendMessage.mockResolvedValue(reply);

    await expect(probePageApiOrigins(7)).resolves.toEqual([UAT]);
  });

  it('消息只发给 frameId 0：不带 frameId 会发给全部 frame，而回包只取第一个应答者', async () => {
    sendMessage.mockResolvedValue(reply);

    await probePageApiOrigins(7);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(7, { type: PAGE_API_PROBE }, { frameId: 0 });
  });

  it('一整个来回都不经过 SW（它不在 `MessageType` 里，也不在 gate 分档里）', async () => {
    sendMessage.mockResolvedValue(reply);

    await probePageApiOrigins(7);

    expect(runtimeSendMessage).not.toHaveBeenCalled();
  });

  it('没有 tabId 时连消息都不发', async () => {
    sendMessage.mockResolvedValue(reply);

    await expect(probePageApiOrigins(undefined)).resolves.toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('问不到：一律空数组，且不让点击悬着', () => {
  it('这一页没有内容脚本（扩展刚安装/刚重载、站点禁用了它）→ 空数组', async () => {
    sendMessage.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));

    await expect(probePageApiOrigins(7)).resolves.toEqual([]);
  });

  it('那种失败只是旁路探测没成，落 debug 而不是 error', async () => {
    sendMessage.mockRejectedValue(new Error('Receiving end does not exist.'));

    await probePageApiOrigins(7);

    expect(logger.debug).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('回包形状不对（后台异常信封、别的扩展抢答）→ 空数组', async () => {
    sendMessage.mockResolvedValue({ success: false, error: 'nope' });

    await expect(probePageApiOrigins(7)).resolves.toEqual([]);
  });

  it('页面不作答：到上限就按「问不到」处理', async () => {
    vi.useFakeTimers();
    sendMessage.mockReturnValue(new Promise(() => {}));

    const settled = vi.fn();
    void probePageApiOrigins(7).then(settled);
    await vi.advanceTimersByTimeAsync(PAGE_API_PROBE_TIMEOUT_MS - 1);
    // 差一毫秒就落定，说明等的确实是那个上限而不是别的什么
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith([]);
  });

  it('超时之后才落定的失败不会变成未处理的拒绝', async () => {
    vi.useFakeTimers();
    let reject!: (error: unknown) => void;
    sendMessage.mockReturnValue(new Promise((_, r) => (reject = r)));

    const unhandled: unknown[] = [];
    const record = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', record);
    try {
      const settled = vi.fn();
      void probePageApiOrigins(7).then(settled);
      await vi.advanceTimersByTimeAsync(PAGE_API_PROBE_TIMEOUT_MS);
      expect(settled).toHaveBeenCalledWith([]);

      // 页面那边过了上限才回话（SW 回收期、frame 被挂起）：等待者已经不在了，
      // 那份拒绝必须有接手人，否则控制台多一条与用户无关的未捕获异常
      reject(new Error('late'));
      await vi.advanceTimersByTimeAsync(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('正常回包不留下待命的定时器（否则每次点击都挂一枚 800ms 的闹钟）', async () => {
    vi.useFakeTimers();
    sendMessage.mockResolvedValue(reply);

    await probePageApiOrigins(7);

    expect(vi.getTimerCount()).toBe(0);
  });
});
