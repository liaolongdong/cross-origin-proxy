/**
 * 环境对比那份「最近请求」读数的四档状态，按运行时测
 *
 * 这里钉的是本仓最贵的那件事：`读不到 ≠ 没有`。四档次序是 读取中 → 读失败 → 从未读到 → 列表，
 * 少了「读失败」那一格，一次 SW 回收期就会把「暂时问不到」画成「这一台机器没发过请求」；
 * 而少了「从未读到」那一格，首屏那一次往返还在路上时就会被读成「还没有请求记录」。
 *
 * 另有两条只在本文件被钉住：
 * ① 低频入口——折叠区没展开就一次消息都不发（每次开弹窗都读一遍 500 条日志是白烧的一次往返）；
 * ② 轮次令牌——慢的那一次不许盖掉新的一次（与 `useRequestLog` / `useProxyStatus` 同一条纪律）。
 *
 * **本环境测不到的那半**：折叠区的展开与那一次拉取的接线住在组件里，而组件实例外
 * `onMounted` / watcher 永不触发（无 jsdom），所以「展开才拉」这一句在组件侧按源码契约钉
 * （见 `tests/full-verification.test.ts`），这里只钉「不手动调 load 就一次都不发」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { MessageType } from '@/utils/types';
import { useEnvDiffPick } from '@/composables/useEnvDiffPick';

const sendMessage = vi.fn();

function entry(i: number) {
  return {
    id: `l${i}`,
    timestamp: 1_700_000_000_000 + i,
    ruleId: 'r1',
    ruleName: 'x',
    originalUrl: `https://a.example.com/${i}`,
    proxiedUrl: `https://b.example.com/${i}`,
    method: 'GET',
    proxyType: 'sw' as const,
  };
}

beforeEach(() => {
  sendMessage.mockReset();
  vi.stubGlobal('chrome', { runtime: { id: 'test', sendMessage } });
});

async function settle() {
  await Promise.resolve();
  await nextTick();
}

describe('useEnvDiffPick — 一次都不许多发，一次都不能画错', () => {
  it('创建实例不读日志：低频入口只在被展开时才发那一条消息', async () => {
    useEnvDiffPick();
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('成功回包：行数按上界收口，loading 在途为真、落定为假，readFailed 落回 false', async () => {
    sendMessage.mockResolvedValue(Array.from({ length: 20 }, (_, i) => entry(i)));
    const pick = useEnvDiffPick();
    const inflight = pick.load();
    expect(pick.loading.value).toBe(true);
    await inflight;
    expect(pick.loading.value).toBe(false);
    expect(pick.rows.value).toHaveLength(8);
    expect(pick.readFailed.value).toBe(false);
    expect(pick.everRead.value).toBe(true);
  });

  it('非标回包与抛错都算没读到，并维持上一轮读数（那几行明明还在屏幕上）', async () => {
    sendMessage.mockResolvedValue([entry(0), entry(1)]);
    const pick = useEnvDiffPick();
    await pick.load();
    expect(pick.rows.value).toHaveLength(2);

    sendMessage.mockResolvedValue({ success: false });
    await pick.load();
    expect(pick.readFailed.value).toBe(true);
    expect(pick.rows.value).toHaveLength(2);

    sendMessage.mockRejectedValue(new Error('sw gone'));
    await pick.load();
    expect(pick.readFailed.value).toBe(true);
    expect(pick.rows.value).toHaveLength(2);
  });

  it('读到过 0 条 ≠ 读失败：空数组那一路 everRead 置真、readFailed 落假', async () => {
    sendMessage.mockResolvedValue([]);
    const pick = useEnvDiffPick();
    await pick.load();
    expect(pick.rows.value).toEqual([]);
    expect(pick.everRead.value).toBe(true);
    expect(pick.readFailed.value).toBe(false);
  });

  it('失败之后又成功一次，那句「没读到」必须自己收回去（否则一次抖动永久占着那一格）', async () => {
    const pick = useEnvDiffPick();
    sendMessage.mockResolvedValue({ success: false });
    await pick.load();
    expect(pick.readFailed.value).toBe(true);
    sendMessage.mockResolvedValue([entry(0)]);
    await pick.load();
    expect(pick.readFailed.value).toBe(false);
    expect(pick.rows.value).toHaveLength(1);
  });

  it('迟到的那一轮整包作废：慢的第一次不许盖掉快的第二次', async () => {
    const pick = useEnvDiffPick();
    sendMessage.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([entry(9)]), 30)));
    const first = pick.load();
    sendMessage.mockResolvedValue([]);
    const second = pick.load();
    await Promise.all([first, second]);
    expect(pick.rows.value).toHaveLength(0);
    expect(pick.loading.value).toBe(false);
  });

  it('发的确实是那条只读消息，不带任何写操作', async () => {
    sendMessage.mockResolvedValue([]);
    const pick = useEnvDiffPick();
    await pick.load();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: MessageType.GET_REQUEST_LOG });
  });
});
