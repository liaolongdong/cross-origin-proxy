import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// 自动关闭倒计时（F-a：此前零行为测试）
//
// 这个功能存在的理由是「忘记关代理把流量引到错误环境」，所以它最怕的不是关不掉，
// 而是**看起来在倒计时、实际那份 alarm 早没了**。下面钉的全是这类读不出来的不变量：
// 什么时候必须建、什么时候绝对不许重置、到期那一刻到底动了谁。
// ═══════════════════════════════════════════════════════════════════════════════

const getProxyConfig = vi.fn();
const toggleProxy = vi.fn();

vi.mock('@/utils/storage', () => ({
  getProxyConfig: () => getProxyConfig(),
  toggleProxy: (v: boolean) => toggleProxy(v),
}));

vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const AUTO_OFF_ALARM = 'proxy-auto-off';
const AUTO_OFF_MINUTES = 'auto_off_minutes';
const PROXY_CONFIG = 'proxy_config';

type AlarmListener = (alarm: { name: string }) => void;
type StorageListener = (changes: Record<string, unknown>, areaName: string) => void;

const alarmListeners: AlarmListener[] = [];
const storageListeners: StorageListener[] = [];

let create: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;
let clear: ReturnType<typeof vi.fn>;
let storageGet: ReturnType<typeof vi.fn>;

/** 让 `chrome.alarms.get` 报告「已有倒计时」 */
function withExistingAlarm() {
  get.mockResolvedValue({ name: AUTO_OFF_ALARM, scheduledTime: Date.now() + 60_000 });
}

/** `reevaluateAutoOff` 由监听器 `void` 发起，内部串了四个 await，微任务 flush 一层不够 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  alarmListeners.length = 0;
  storageListeners.length = 0;
  getProxyConfig.mockReset();
  toggleProxy.mockReset();
  toggleProxy.mockResolvedValue(false);

  create = vi.fn(async () => {});
  get = vi.fn(async () => undefined);
  clear = vi.fn(async () => true);
  storageGet = vi.fn(async () => ({ [AUTO_OFF_MINUTES]: 30 }));

  vi.stubGlobal('chrome', {
    alarms: {
      create,
      get,
      clear,
      onAlarm: { addListener: vi.fn((cb: AlarmListener) => alarmListeners.push(cb)) },
    },
    storage: {
      local: { get: storageGet, set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn((cb: StorageListener) => storageListeners.push(cb)) },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reevaluateAutoOff — 建不建、重置不重置', () => {
  it('总开关关闭：清掉倒计时，也不新建', async () => {
    getProxyConfig.mockResolvedValue({ enabled: false, rules: [] });
    const { reevaluateAutoOff } = await import('@/entrypoints/background/autoOff');

    await reevaluateAutoOff();

    expect(clear).toHaveBeenCalledWith(AUTO_OFF_ALARM);
    expect(create).not.toHaveBeenCalled();
  });

  it('时长为 0：同上——没配时长就不该有个看不见的倒计时挂着', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    storageGet.mockResolvedValue({ [AUTO_OFF_MINUTES]: 0 });
    const { reevaluateAutoOff } = await import('@/entrypoints/background/autoOff');

    await reevaluateAutoOff();

    expect(clear).toHaveBeenCalledWith(AUTO_OFF_ALARM);
    expect(create).not.toHaveBeenCalled();
  });

  it('开启且配了时长：按分钟建 alarm', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    const { reevaluateAutoOff } = await import('@/entrypoints/background/autoOff');

    await reevaluateAutoOff();

    expect(create).toHaveBeenCalledWith(AUTO_OFF_ALARM, { delayInMinutes: 30 });
  });

  it('已有倒计时且不是刚改时长：一个字都不动（改别的规则不给它续命）', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    withExistingAlarm();
    const { reevaluateAutoOff } = await import('@/entrypoints/background/autoOff');

    await reevaluateAutoOff();

    expect(create).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('时长刚被改过：先清再按新值重建', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    withExistingAlarm();
    storageGet.mockResolvedValue({ [AUTO_OFF_MINUTES]: 15 });
    const { reevaluateAutoOff } = await import('@/entrypoints/background/autoOff');

    await reevaluateAutoOff(true);

    expect(clear).toHaveBeenCalledWith(AUTO_OFF_ALARM);
    expect(create).toHaveBeenCalledWith(AUTO_OFF_ALARM, { delayInMinutes: 15 });
  });

  it('时长读到手改的非数字：按 0 处理，不拿它去建 alarm', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    storageGet.mockResolvedValue({ [AUTO_OFF_MINUTES]: '30' });
    const { reevaluateAutoOff } = await import('@/entrypoints/background/autoOff');

    await reevaluateAutoOff(true);

    expect(create).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith(AUTO_OFF_ALARM);
  });

  it('存储读失败：只记日志，不把异常冒给调用方', async () => {
    getProxyConfig.mockRejectedValue(new Error('storage unavailable'));
    const { logger } = await import('@/utils/logger');
    const { reevaluateAutoOff } = await import('@/entrypoints/background/autoOff');

    await expect(reevaluateAutoOff()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('setupAutoOff — 到期与存储变化', () => {
  it('倒计时到期：关掉总开关', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    const { setupAutoOff } = await import('@/entrypoints/background/autoOff');
    setupAutoOff();

    const alarmCb = alarmListeners.at(-1)!;
    alarmCb({ name: 'sw-keepalive' });
    expect(toggleProxy).not.toHaveBeenCalled();

    alarmCb({ name: AUTO_OFF_ALARM });
    expect(toggleProxy).toHaveBeenCalledWith(false);
  });

  // 监听器里那条 `PROXY_CONFIG in changes` 是本功能唯一的触发口：用户在设置页打开总开关
  // 走的是「写 storage → 这里的监听器挂倒计时」，不是直接调 alarm。漏了这一支，表现是
  // 「界面上倒计时在走、alarm 压根不存在」——正是本文件开头说的那类读不出来的失效。
  it('只改总开关（时长没变）：倒计时按现有时长挂上，且不重置已有的那份', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    storageGet.mockResolvedValue({ [AUTO_OFF_MINUTES]: 30 });
    const { setupAutoOff } = await import('@/entrypoints/background/autoOff');
    setupAutoOff();
    await settle();
    create.mockClear();
    clear.mockClear();

    storageListeners.at(-1)!(
      { [PROXY_CONFIG]: { oldValue: { enabled: false }, newValue: { enabled: true } } },
      'local',
    );
    await settle();

    expect(create).toHaveBeenCalledWith(AUTO_OFF_ALARM, { delayInMinutes: 30 });
    expect(clear).not.toHaveBeenCalled();
  });

  // 上一条钉「这条触发存在」，这一条钉它传的是 `force=false`：把监听器里的
  // `reevaluateAutoOff(durationChanged)` 写成 `reevaluateAutoOff(true)`，函数层的四条测试
  // 全绿（它们各自直接调函数、绕过了接线），而用户的真实体验是每次改规则都续一次命。
  it('已有倒计时时改配置：这条触发不重置它（force 只跟着时长变化走）', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    withExistingAlarm();
    const { setupAutoOff } = await import('@/entrypoints/background/autoOff');
    setupAutoOff();
    await settle();
    create.mockClear();
    clear.mockClear();

    storageListeners.at(-1)!({ [PROXY_CONFIG]: { oldValue: { enabled: true }, newValue: { enabled: true } } }, 'local');
    await settle();

    expect(create).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('与这两个键无关的存储变化不动倒计时', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    const { setupAutoOff } = await import('@/entrypoints/background/autoOff');
    setupAutoOff();
    // 注册时自己跑过一次兜底校验，先等它落定再清账，否则它的调用会算到本条测试头上
    await settle();
    create.mockClear();
    clear.mockClear();

    storageListeners.at(-1)!({ some_other_key: {} }, 'local');
    storageListeners.at(-1)!({ [PROXY_CONFIG]: {} }, 'sync');
    await settle();

    expect(create).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('改了时长：按新值重建（force），而不是沿用剩下的时间', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    withExistingAlarm();
    storageGet.mockResolvedValue({ [AUTO_OFF_MINUTES]: 5 });
    const { setupAutoOff } = await import('@/entrypoints/background/autoOff');
    setupAutoOff();
    await settle();
    create.mockClear();
    clear.mockClear();

    storageListeners.at(-1)!({ [AUTO_OFF_MINUTES]: { oldValue: 30, newValue: 5 } }, 'local');
    await settle();

    expect(clear).toHaveBeenCalledWith(AUTO_OFF_ALARM);
    expect(create).toHaveBeenCalledWith(AUTO_OFF_ALARM, { delayInMinutes: 5 });
  });

  it('SW 重启：注册时就做一次一致性校验（alarm 本身是持久化的）', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [] });
    const { setupAutoOff } = await import('@/entrypoints/background/autoOff');
    setupAutoOff();
    await settle();

    expect(get).toHaveBeenCalledWith(AUTO_OFF_ALARM);
  });
});
