import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

// ═══════════════════════════════════════════════════════════════════════════════
// 自动关闭档位的读写（`utils/autoOff.ts`）——配置页的下拉与弹窗的档位条共用这一份
//
// 这个模块存在的理由有两半：① 档位清单只能有一份（否则弹窗给了四格、后台却认五个值）；
// ② 「写进 storage」与「倒计时落点变了吗」是两件事——重建 alarm 的人是后台的
// `storage.onChanged`（`entrypoints/background/autoOff.ts`），界面只能读回它。
// 下面按**外部可观察面**测：返回值、调了谁、调了几次，以及「读不到时说不读不到」。
//
// 轮询用的是真定时器（预算 6 × 100ms = 600ms），所以「始终对不上」那条会跑满预算——
// 这正是这条用例要量的东西：有预算、会停、不无限等。
// ═══════════════════════════════════════════════════════════════════════════════

vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AUTO_OFF_ALARM, STORAGE_KEYS, AUTO_OFF_SYNC_TRIES } from '@/utils/constants';
import {
  AUTO_OFF_PRESETS,
  AUTO_OFF_PRESET_MINUTES,
  applyAutoOffMinutes,
  readAutoOffMinutes,
  writeAutoOffMinutes,
} from '@/utils/autoOff';
import { logger } from '@/utils/logger';

const KEY = STORAGE_KEYS.AUTO_OFF_MINUTES;

let storageGet: ReturnType<typeof vi.fn>;
let storageSet: ReturnType<typeof vi.fn>;
let alarmsGet: ReturnType<typeof vi.fn>;

/** 档位读数的各种坏法：与后台 `getAutoOffMinutes` 同一口径，一律当「从不」 */
const BAD_VALUES: [string, unknown][] = [
  ['0', 0],
  ['负数', -5],
  ['NaN', Number.NaN],
  ['字符串', '30'],
  ['没这个键', undefined],
  ['null', null],
];

beforeEach(() => {
  storageGet = vi.fn(async () => ({ [KEY]: 60 }));
  storageSet = vi.fn(async () => {});
  alarmsGet = vi.fn(async () => undefined as unknown);
  vi.stubGlobal('chrome', {
    storage: { local: { get: storageGet, set: storageSet } },
    alarms: { get: alarmsGet },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[读档位] 判据与后台同一条，界面不另起一份', () => {
  it('有限正数原样交出（含 15 这种不在档位里的值——那是界面要说明的，不是要改写的）', async () => {
    storageGet.mockResolvedValue({ [KEY]: 15 });
    expect(await readAutoOffMinutes()).toBe(15);
  });

  it.each(BAD_VALUES)('%s：当「从不」，因为后台在这种值上本来就不建倒计时', async (_label, raw) => {
    storageGet.mockResolvedValue({ [KEY]: raw });
    expect(await readAutoOffMinutes()).toBe(0);
  });
});

describe('[写档位] 只写那一个键，且把失败说成失败', () => {
  it('载荷就是这一个键，不顺手带上别的', async () => {
    expect(await writeAutoOffMinutes(120)).toBe(true);
    expect(storageSet).toHaveBeenCalledWith({ [KEY]: 120 });
  });

  it('storage 抛错时回 false 而不是把异常丢给调用方（调用方只管「没写成」这一件事）', async () => {
    storageSet.mockRejectedValue(new Error('quota'));
    await expect(writeAutoOffMinutes(30)).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('[应用档位] 落点是读回来的，不是算出来的', () => {
  it('第一就读到新落点：applied，交回的是观测到的那个时刻', async () => {
    const scheduledTime = Date.now() + 60 * 60_000;
    alarmsGet.mockResolvedValue({ name: AUTO_OFF_ALARM, scheduledTime });
    const result = await applyAutoOffMinutes(60);
    expect(result).toEqual({ status: 'applied', autoOffAt: scheduledTime });
    expect(alarmsGet).toHaveBeenCalledWith(AUTO_OFF_ALARM);
  });

  it('旧落点还在、新落点晚两拍才出现：继续轮询直到对上', async () => {
    const stale = { name: AUTO_OFF_ALARM, scheduledTime: Date.now() + 10 * 60_000 };
    let calls = 0;
    alarmsGet.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) return stale;
      return { name: AUTO_OFF_ALARM, scheduledTime: Date.now() + 240 * 60_000 };
    });
    const result = await applyAutoOffMinutes(240);
    expect(result.status).toBe('applied');
    expect(calls).toBe(3);
  });

  it('预算用尽仍对不上：说「读不到」，并且只轮询到预算为止（绝不无限等）', async () => {
    alarmsGet.mockResolvedValue({ name: AUTO_OFF_ALARM, scheduledTime: Date.now() + 10 * 60_000 });
    const result = await applyAutoOffMinutes(60);
    expect(result).toEqual({ status: 'unconfirmed' });
    expect(alarmsGet).toHaveBeenCalledTimes(AUTO_OFF_SYNC_TRIES);
  });

  it('读 alarm 抛错也只是「读不到」：刚才那次写入是成功的，不许回滚成失败', async () => {
    alarmsGet.mockRejectedValue(new Error('no alarms access'));
    const result = await applyAutoOffMinutes(30);
    expect(result).toEqual({ status: 'unconfirmed' });
    expect(storageSet).toHaveBeenCalledTimes(1);
  });

  it('选「从不」要等那枚 alarm 真的不在：还在就继续等，消失了才回 autoOffAt: undefined', async () => {
    let calls = 0;
    alarmsGet.mockImplementation(async () => {
      calls += 1;
      return calls < 2 ? { name: AUTO_OFF_ALARM, scheduledTime: Date.now() + 30 * 60_000 } : undefined;
    });
    expect(await applyAutoOffMinutes(0)).toEqual({ status: 'applied', autoOffAt: undefined });
    expect(calls).toBe(2);

    // 一直还在（后台没来得及清）→ 不能替它宣布「已经关了」
    alarmsGet.mockResolvedValue({ name: AUTO_OFF_ALARM, scheduledTime: Date.now() + 30 * 60_000 });
    expect(await applyAutoOffMinutes(0)).toEqual({ status: 'unconfirmed' });
  });

  it('写入就失败：直接回 failed，一次 alarm 都不读', async () => {
    storageSet.mockRejectedValue(new Error('quota'));
    expect(await applyAutoOffMinutes(60)).toEqual({ status: 'failed' });
    expect(alarmsGet).not.toHaveBeenCalled();
  });
});

describe('[档位表] 两个界面共用同一份清单（源码契约）', () => {
  const popupSrc = readFileSync('entrypoints/popup/App.vue', 'utf-8');
  const settingsSrc = readFileSync('components/options/SettingsDialog.vue', 'utf-8');

  it('档位与顺序：0 / 30 / 60 / 120 / 240，与配置页从前手抄的那五个值一致', () => {
    expect(AUTO_OFF_PRESET_MINUTES).toEqual([0, 30, 60, 120, 240]);
    expect(AUTO_OFF_PRESETS.map(p => p.minutes)).toEqual([...AUTO_OFF_PRESET_MINUTES]);
  });

  it('每一档的措辞中英同时具备：配置页那份在 options，弹窗那格在 popup', () => {
    const zhOptions = readFileSync('locales/zh_CN/options.json', 'utf-8');
    const enOptions = readFileSync('locales/en/options.json', 'utf-8');
    const zhPopup = readFileSync('locales/zh_CN/popup.json', 'utf-8');
    const enPopup = readFileSync('locales/en/popup.json', 'utf-8');
    for (const preset of AUTO_OFF_PRESETS) {
      for (const [dict, key] of [
        [zhOptions, preset.labelKey],
        [enOptions, preset.labelKey],
        [zhPopup, preset.shortKey],
        [enPopup, preset.shortKey],
      ] as const) {
        expect(dict, key).toContain(`"${key}"`);
      }
    }
  });

  it('弹窗那一格的按钮语义齐全：原生 button、aria-pressed 说选中、aria-label 说完整的话', () => {
    const start = popupSrc.indexOf('v-for="preset in AUTO_OFF_PRESETS"');
    expect(start).toBeGreaterThan(-1);
    const chip = popupSrc.slice(start, popupSrc.indexOf('</button>', start));
    expect(chip).toContain('type="button"');
    expect(chip).toContain(':aria-pressed="autoOffMinutes === preset.minutes"');
    expect(chip).toContain(':aria-label="t(\'autoOffPickA11y\', t(preset.shortKey))"');
  });

  it('两处界面都从这份清单起，不许有人把五个档位再抄成硬编码', () => {
    expect(popupSrc).toContain('v-for="preset in AUTO_OFF_PRESETS"');
    expect(settingsSrc).toContain('v-for="preset in AUTO_OFF_PRESETS"');
    expect(settingsSrc).not.toContain(':value="\'240"');
    for (const src of [popupSrc, settingsSrc]) {
      for (const minutes of [30, 60, 120, 240]) {
        expect(src, String(minutes)).not.toMatch(new RegExp(`AUTO_OFF_MINUTES.{0,40}${minutes}`));
      }
    }
  });

  it('读到位才画那一行：读不到时整条不出现，而不是画成「从不」', () => {
    expect(popupSrc).toContain('v-if="autoOffMinutes !== null"');
    const load = popupSrc.slice(popupSrc.indexOf('async function loadAutoOffMinutes'));
    expect(load).toContain('autoOffMinutes.value = await readAutoOffMinutes()');
    expect(load, '读失败不许把 null 写成 0').not.toContain('autoOffMinutes.value = 0');
  });

  it('选中的就是当前那格时一个字都不写（点一次重启一次倒计时是凭空加戏）', () => {
    const choose = popupSrc.slice(popupSrc.indexOf('async function chooseAutoOff'));
    expect(choose).toContain('if (autoOffPending.value || autoOffMinutes.value === preset.minutes) return;');
  });

  it('代理没开时不轮询那枚压根不会被创建的 alarm', () => {
    // 后台只在 enabled 且有时长时挂倒计时；关着去轮询六趟，白等 600ms 之后还得诚实说「读不到落点」。
    // 这一条钉的是「关着走 writeAutoOffMinutes、开着才走 applyAutoOffMinutes」这个分岔本身——
    // 两处调用点在同一个函数里，改成无条件 `await applyAutoOffMinutes(...)` 依然全绿，只有分岔能拦住。
    const choose = popupSrc.slice(popupSrc.indexOf('async function chooseAutoOff'));
    expect(choose).toContain('enabled.value');
    expect(choose).toContain('await applyAutoOffMinutes(preset.minutes)');
    expect(choose).toContain('await writeAutoOffMinutes(preset.minutes)');
    expect(choose).not.toContain('const result = await applyAutoOffMinutes(preset.minutes);');
  });

  it('落点读回来了就直写倒计时，读不到就重拉状态——两条路都得有对应的人', () => {
    const choose = popupSrc.slice(popupSrc.indexOf('async function chooseAutoOff'));
    expect(choose).toContain('autoOffAt.value = result.autoOffAt;');
    expect(choose).toContain('void fetchStatus();');
    expect(choose).toContain("ElMessage.error(t('autoOffSaveFailed'));");
  });
});
