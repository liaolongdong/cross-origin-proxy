import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// F8①：刷写失败回灌到缓冲区的日志，必须被已有一分钟心跳补一次盘
//
// doFlushLogs 在取走快照时就摘掉了防抖定时器，失败回灌后若没有新请求触发阈值，
// 这批日志只能等 SW 回收时那一下大概率来不及的 onSuspend。
// ═══════════════════════════════════════════════════════════════════════════════

const flushLogs = vi.fn();

vi.mock('@/utils/storage', () => ({ flushLogs: () => flushLogs() }));

vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type AlarmListener = (alarm: { name: string }) => void;

const listeners: AlarmListener[] = [];

beforeEach(() => {
  listeners.length = 0;
  flushLogs.mockReset();
  vi.stubGlobal('chrome', {
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn((cb: AlarmListener) => listeners.push(cb)) },
    },
  });
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setupKeepalive — 心跳顺带补刷日志缓冲', () => {
  it('保活闹钟触发一次 flushLogs（空缓冲区由存储层自己早退）', async () => {
    const { setupKeepalive } = await import('@/entrypoints/background/keepalive');
    setupKeepalive();

    expect(listeners.length).toBeGreaterThan(0);
    listeners.forEach(cb => cb({ name: 'proxy-auto-off' }));
    expect(flushLogs).not.toHaveBeenCalled();

    listeners.forEach(cb => cb({ name: 'sw-keepalive' }));
    expect(flushLogs).toHaveBeenCalledTimes(1);
  });
});
