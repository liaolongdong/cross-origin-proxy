import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

// ═══════════════════════════════════════════════════════════════════════════════
// 图标徽章（F-a）与「规则数组取值」（F-b）
//
// 徽章是总开关在工具栏上唯一的落点，用户靠它决定「现在走的到底是哪套环境」。
// 它读的是 storage 里那份配置——按项目口径属不可信输入（手改、旧版本残留都可能），
// 所以数启用条数这一步不能假设 `rules` 一定是数组：抛出去没人接手，徽章就停在上一个数。
// ═══════════════════════════════════════════════════════════════════════════════

const getProxyConfig = vi.fn();

vi.mock('@/utils/storage', async importOriginal => {
  const real = await importOriginal<typeof import('@/utils/storage')>();
  return { ...real, getProxyConfig: () => getProxyConfig() };
});

vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let setBadgeText: ReturnType<typeof vi.fn>;
let setBadgeColor: ReturnType<typeof vi.fn>;

const rule = (enabled: boolean) => ({ id: enabled ? 'on' : 'off', name: 'r', enabled });

beforeEach(() => {
  vi.resetModules();
  getProxyConfig.mockReset();
  setBadgeText = vi.fn(async () => {});
  setBadgeColor = vi.fn(async () => {});
  vi.stubGlobal('chrome', {
    action: { setBadgeText: setBadgeText, setBadgeBackgroundColor: setBadgeColor },
    storage: { onChanged: { addListener: vi.fn() } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 取最后一次写上去的文字与颜色 */
function lastBadge(): { text: unknown; color: unknown } {
  const text = setBadgeText.mock.calls.at(-1)?.[0]?.text;
  const color = setBadgeColor.mock.calls.at(-1)?.[0]?.color;
  return { text, color };
}

describe('updateBadge — 三态', () => {
  it('总开关关闭：灰底 "OFF"', async () => {
    const { updateBadge } = await import('@/entrypoints/background/badgeManager');
    await updateBadge(false, 3);

    expect(lastBadge()).toEqual({ text: 'OFF', color: '#909399' });
  });

  it('开启：蓝底显示启用条数（禁用的那条不占数）', async () => {
    const { updateBadge } = await import('@/entrypoints/background/badgeManager');
    await updateBadge(true, 2);

    expect(lastBadge()).toEqual({ text: '2', color: '#409EFF' });
  });

  it('开启但一条规则都没启用：清空文字，而不是画一个 0', async () => {
    const { updateBadge } = await import('@/entrypoints/background/badgeManager');
    await updateBadge(true, 0);

    expect(lastBadge().text).toBe('');
  });

  it('chrome.action 不可用（如被策略禁用）：吞掉异常，不打断启动流程', async () => {
    setBadgeText.mockRejectedValue(new Error('No action for this extension.'));
    const { logger } = await import('@/utils/logger');
    const { updateBadge } = await import('@/entrypoints/background/badgeManager');

    await expect(updateBadge(true, 1)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('initBadge — 从配置数出启用条数', () => {
  it('按 enabled 计数，与规则总数不是一回事', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: [rule(true), rule(false), rule(true)] });
    const { initBadge } = await import('@/entrypoints/background/badgeManager');
    await initBadge();

    expect(lastBadge().text).toBe('2');
  });

  it('规则数组读成非数组（手改 storage / 旧数据）：按 0 处理，不抛', async () => {
    getProxyConfig.mockResolvedValue({ enabled: true, rules: { 0: rule(true), length: 1 } });
    const { initBadge } = await import('@/entrypoints/background/badgeManager');

    // 抛在这里等于徽章永远停在改动前的那个数，而界面再也读不出真实状态
    await expect(initBadge()).resolves.toBeUndefined();
    expect(lastBadge()).toEqual({ text: '', color: '#409EFF' });
  });

  it('配置整个读不到：按关闭画，异常不外溢', async () => {
    getProxyConfig.mockRejectedValue(new Error('storage unavailable'));
    const { initBadge } = await import('@/entrypoints/background/badgeManager');

    await expect(initBadge()).resolves.toBeUndefined();
    expect(setBadgeText).not.toHaveBeenCalled();
  });
});

describe('规则数组取值出口（F-b）', () => {
  it('`configRules` 只认数组，其余一律当空', async () => {
    const { configRules } = await import('@/utils/storage');
    const rules = [rule(true)];

    expect(configRules({ enabled: true, rules } as never)).toBe(rules);
    expect(configRules({ enabled: true } as never)).toEqual([]);
    expect(configRules({ enabled: true, rules: 'nope' } as never)).toEqual([]);
    expect(configRules({ enabled: true, rules: { length: 3 } } as never)).toEqual([]);
    expect(configRules(undefined)).toEqual([]);
  });

  it('三处按启用条数说话的地方共用它，不再各自裸 `.rules.filter`', () => {
    for (const file of [
      'entrypoints/background.ts',
      'entrypoints/background/badgeManager.ts',
      'entrypoints/background/proxyHandler.ts',
    ]) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).toContain('configRules(');
      expect(source, file).not.toMatch(/config\.rules\.filter|newConfig\.rules\.filter|config\.rules\.map/);
    }
  });
});
