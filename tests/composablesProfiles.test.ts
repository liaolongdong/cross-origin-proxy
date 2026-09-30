/**
 * 环境快照的界面读写层：`composables/useProfiles.ts`
 *
 * `utils/storage.ts` 那一侧早有 `tests/configHistory.test.ts` 等覆盖，`messageRouter` 的门禁也有
 * `tests/messageRouter.test.ts`；中间这一层（Options 的快照弹窗与 popup 的切换卡共同的出口）此前
 * 一行没跑过。它承重的判据只有一句：**「读到了什么」与「没读到」必须永远分得开**，
 * 而这一句在快照这件事上比在凭据那侧更贵——载入是**整套替换**：
 *
 * 1. `GET_PROFILES` 回 `[]` 是真读数（用户确实一份快照都没存），回信封 / `undefined` / 非数组 /
 *    抛错是「没读到」。把后者画成前者，界面就说出了「你还没有快照」这句假话，
 *    而用户的快照好好躺在 storage 里。
 * 2. `LOAD_PROFILE` 的成功判据只认 `success === true`。后台失败回的是 **resolved** 的
 *    `{ success:false }`（`respondAsync` 把 reject 转成信封，见 `utils/messageResult.ts`），
 *    所以 `catch` 拦不到；漏掉这一步就是把一次没落盘的替换报成「已切换」，
 *    而用户下一秒看到的还是旧规则集。
 * 3. 后台写明原因时把原文交出去（`Profile not found` 本来就是给用户看的）；
 *    抛错与空回包这两条拿不到原因的路径**必须留空**，由调用方回落通用文案——
 *    内部码抛到界面上就是一句谁也看不懂的 `LOAD_PROFILE_FAILED`。
 * 4. 两个忙闲旗标要置得起也落得回：在途期间必须是 true（界面据此禁用按钮），
 *    成功 / 拒绝 / 抛错三条路径之后必须回 false（漏一条就是那颗按钮永久禁用）。
 *
 * 夹具与 `tests/composablesCredentials.test.ts` 同一套：只 stub `chrome` 与 `logger`，
 * 回包按类型登记（`respond` 里那句 `message.type in map` 是让「显式回 undefined」与
 * 「这条消息压根不该出现」可区分的那一格）。组件实例外 `onMounted` 不触发，所以界面接线
 * 按源码契约钉——最后一组钉的正是这个：popup 那张卡**怎么用**这两个返回值。
 * 「读不到就不许展开面板、照旧跳 Options」与「切完必须重算两处派生读数」这两条链，
 * 中间那根线一断，composable 与界面各自单独看都还是对的。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MessageType } from '@/utils/types';
import type { EnvironmentProfile } from '@/utils/types';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/utils/logger', () => ({ logger }));

const sendMessage = vi.fn();
vi.stubGlobal('chrome', {
  runtime: { sendMessage, openOptionsPage: vi.fn() },
  i18n: { getUILanguage: () => 'zh-CN' },
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
});

const nativeWarn = console.warn;
vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  const head = String(args[0]);
  if (head.startsWith('[Vue warn]: onMounted') || head.startsWith('[Vue warn]: onUnmounted')) return;
  nativeWarn.apply(console, args);
});

const { useProfiles } = await import('@/composables/useProfiles');

/** 按类型登记回包；显式登记 `undefined` 走的是「resolve 了个空」那条分支，未登记的类型当场抛 */
function respond(map: Partial<Record<MessageType, unknown | (() => unknown)>>) {
  sendMessage.mockImplementation(async (message: { type: MessageType }) => {
    if (!(message.type in map)) throw new Error(`用例未登记这条消息：${message.type}`);
    const entry = map[message.type];
    return typeof entry === 'function' ? (entry as () => unknown)() : entry;
  });
}

const boom = (what: string) => (): never => {
  throw new Error(what);
};

function makeProfile(id: string, ruleCount = 2): EnvironmentProfile {
  return {
    id,
    name: `env-${id}`,
    createdAt: 1_700_000_000_000,
    rules: Array.from({ length: ruleCount }, (_, i) => ({
      id: `${id}-r${i}`,
      name: `${id} 规则 ${i}`,
      enabled: true,
      matchType: 'wildcard' as const,
      matchPattern: 'https://fat.example.com/*',
      targetUrl: 'https://api.uat.example.com',
      priority: 10,
      createdAt: 0,
      updatedAt: 0,
    })),
  };
}

/** 读失败的那几种回包形状：信封、空回包、非数组、抛错——它们都不许动已经拿到手的列表 */
const UNREADABLE: ReadonlyArray<readonly [string, unknown]> = [
  ['被门禁拒掉的信封', { success: false, error: 'UNTRUSTED_SENDER' }],
  ['空回包（SW 回收期）', undefined],
  ['非数组对象', { 0: makeProfile('p1'), length: 1 }],
  ['字符串', '[]'],
  ['抛错', boom('message port closed')],
];

beforeEach(() => {
  logger.warn.mockReset();
  logger.error.mockReset();
  sendMessage.mockReset();
});

describe('useProfiles.loadProfiles — 列表读数与「没读到」分开', () => {
  it.each([
    ['一份快照都没有（真读数）', []],
    ['两份快照', [makeProfile('a'), makeProfile('b')]],
  ])('读到%s：返回成功，原样收下', async (_label, list) => {
    respond({ [MessageType.GET_PROFILES]: list });
    const profiles = useProfiles();
    await expect(profiles.loadProfiles()).resolves.toBe(true);
    expect(profiles.profiles.value).toEqual(list);
  });

  it.each(UNREADABLE)('%s：返回失败', async (_label, payload) => {
    respond({ [MessageType.GET_PROFILES]: payload });
    const profiles = useProfiles();
    await expect(profiles.loadProfiles()).resolves.toBe(false);
  });

  it('读失败时保持上一轮的列表：把 IO 失败画成「你还没存快照」是假话', async () => {
    respond({ [MessageType.GET_PROFILES]: [makeProfile('keep')] });
    const profiles = useProfiles();
    await profiles.loadProfiles();
    respond({ [MessageType.GET_PROFILES]: { success: false, error: 'STORAGE_READ_FAILED' } });
    await expect(profiles.loadProfiles()).resolves.toBe(false);
    expect(profiles.profiles.value).toHaveLength(1);
    expect(profiles.profiles.value[0].id).toBe('keep');
  });

  it('信封与抛错分别落 warn 与 error，两条路都不许静默', async () => {
    respond({ [MessageType.GET_PROFILES]: { success: false, error: 'NOPE' } });
    const a = useProfiles();
    await a.loadProfiles();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    respond({ [MessageType.GET_PROFILES]: boom('port closed') });
    const b = useProfiles();
    await b.loadProfiles();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('useProfiles.loadProfile — 整套替换只认 success === true', () => {
  it('后台点头：成功且不编造原因', async () => {
    respond({ [MessageType.LOAD_PROFILE]: { success: true } });
    const profiles = useProfiles();
    await expect(profiles.loadProfile('a')).resolves.toEqual({ success: true });
    expect(sendMessage).toHaveBeenCalledWith({ type: MessageType.LOAD_PROFILE, data: { profileId: 'a' } });
  });

  it('后台写明原因时把原文交出去（那句本来就是给用户看的）', async () => {
    respond({ [MessageType.LOAD_PROFILE]: { success: false, error: 'Profile not found' } });
    const profiles = useProfiles();
    await expect(profiles.loadProfile('gone')).resolves.toEqual({ success: false, error: 'Profile not found' });
  });

  it.each([
    ['空回包（SW 回收期）', undefined],
    ['不带 success 的形状', { updated: true }],
    ['字符串形状的 true', { success: 'true' }],
  ])('%s：判成失败，且**不许**把内部码当原因抛给界面', async (_label, payload) => {
    respond({ [MessageType.LOAD_PROFILE]: payload });
    const profiles = useProfiles();
    await expect(profiles.loadProfile('a')).resolves.toEqual({ success: false });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('抛错：失败、只记日志、error 留空由调用方回落通用文案', async () => {
    respond({ [MessageType.LOAD_PROFILE]: boom('port closed') });
    const profiles = useProfiles();
    await expect(profiles.loadProfile('a')).resolves.toEqual({ success: false });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('两个忙闲旗标：置得起、也落得回', () => {
  it('在途期间必须是 true，落定后回 false（界面靠它禁用按钮与避免二次替换）', async () => {
    let release: (value: unknown) => void = () => {};
    sendMessage.mockImplementation(() => new Promise(resolve => (release = resolve)));
    const profiles = useProfiles();

    const loading = profiles.loadProfiles();
    expect(profiles.loadingProfiles.value).toBe(true);
    expect(profiles.switchingProfile.value).toBe(false);
    release([makeProfile('a')]);
    await loading;
    expect(profiles.loadingProfiles.value).toBe(false);

    const switching = profiles.loadProfile('a');
    expect(profiles.switchingProfile.value).toBe(true);
    release({ success: true });
    await switching;
    expect(profiles.switchingProfile.value).toBe(false);
  });

  it.each([
    ['拒绝信封', { success: false, error: 'E' }],
    ['空回包', undefined],
  ])('载入走%s这条失败路径时 switchingProfile 照样落回', async (_label, payload) => {
    respond({ [MessageType.LOAD_PROFILE]: payload });
    const profiles = useProfiles();
    await profiles.loadProfile('a');
    expect(profiles.switchingProfile.value).toBe(false);
  });

  it('载入抛错后 switchingProfile 也落回（漏这一条就是按钮永久禁用）', async () => {
    respond({ [MessageType.LOAD_PROFILE]: boom('port closed') });
    const profiles = useProfiles();
    await profiles.loadProfile('a');
    expect(profiles.switchingProfile.value).toBe(false);
  });

  it('loadProfiles 三条落定路径都不留在途态', async () => {
    for (const [, payload] of UNREADABLE) {
      respond({ [MessageType.GET_PROFILES]: payload });
      const profiles = useProfiles();
      await profiles.loadProfiles();
      expect(profiles.loadingProfiles.value).toBe(false);
    }
  });

  it('开局是「没读到过」：列表为空、两面旗标都是 false', () => {
    const profiles = useProfiles();
    expect(profiles.profiles.value).toEqual([]);
    expect(profiles.loadingProfiles.value).toBe(false);
    expect(profiles.switchingProfile.value).toBe(false);
  });
});

describe('界面这一半：Options 弹窗与 popup 卡片怎么用这个出口（源码契约）', () => {
  const dialogSrc = readFileSync('components/options/ProfilesDialog.vue', 'utf-8');
  const popupSrc = readFileSync('entrypoints/popup/App.vue', 'utf-8');

  it('Options 弹窗改走共用出口，不再自己发那两条消息', () => {
    expect(dialogSrc).toContain("import { useProfiles } from '@/composables/useProfiles'");
    expect(dialogSrc).toContain(
      'const { profiles, loadingProfiles: loading, loadProfiles, loadProfile } = useProfiles();',
    );
    expect(dialogSrc).not.toContain('MessageType.GET_PROFILES');
    expect(dialogSrc).not.toContain('MessageType.LOAD_PROFILE');
  });

  it('整套替换前那道确认框仍留在 Options 侧（popup 不引弹窗模块）', () => {
    expect(dialogSrc).toContain('ElMessageBox.confirm(');
    // 只钉「有没有把它引进来」：源码注释里正写着为什么不用它，按 `toContain` 会被自己的解释弄红
    expect(popupSrc).not.toMatch(/import\s*\{[^}]*\bElMessageBox\b/);
    expect(popupSrc).not.toMatch(/\bElMessageBox\.(confirm|alert|prompt)\(/);
  });

  it('弹窗失败时后台原因优先、没有原因回落通用文案', () => {
    expect(dialogSrc).toContain("ElMessage.error(result.error || t('operationFailed'));");
  });

  it('popup 那张卡只有 aria-expanded、没有 aria-controls（面板是 v-if，收起时没有目标可指）', () => {
    const start = popupSrc.indexOf(':aria-expanded="profilePicker');
    expect(start).toBeGreaterThan(-1);
    const card = popupSrc.slice(start, popupSrc.indexOf('>', start));
    expect(card).toContain(':aria-expanded="profilePicker');
    expect(card).not.toContain('aria-controls');
    expect(popupSrc).toMatch(/<div\s+v-if="profilePicker"[\s\S]{0,200}?class="api-picker"/);
  });

  it('读不到或一条都没有时不展开面板，照旧直达 Options 的管理弹窗', () => {
    expect(popupSrc).toContain('const ok = profilesReadOk.value || (await refreshProfiles());');
    expect(popupSrc).toContain('if (!ok || profiles.value.length === 0) {');
    const branch = popupSrc.slice(popupSrc.indexOf('if (!ok || profiles.value.length === 0) {'));
    expect(branch.slice(0, 200)).toContain("await openOptionsPage('#profiles')");
  });

  it('挂载即预读一次，失败留给下一次点击重试（点开卡片不该有等待）', () => {
    const mounted = popupSrc.slice(popupSrc.indexOf('onMounted(() => {'));
    expect(mounted.slice(0, 400)).toContain('void refreshProfiles();');
    expect(popupSrc).toContain('if (ok) profilesReadOk.value = true;');
  });

  it('切换成功后重算两处派生读数并收起面板（规则集换了，旧账答不了新问题）', () => {
    const apply = popupSrc.slice(popupSrc.indexOf('async function applyProfile'));
    expect(apply.indexOf('if (!result.success)')).toBeLessThan(apply.indexOf('void fetchStatus();'));
    expect(apply).toContain('profilePicker.value = false;');
    expect(apply).toContain('void fetchStatus();');
    expect(apply).toContain('void computePageHit();');
  });

  it('确认那句必须点名两件副作用，而 storage 那一侧必须真的做这两件事', () => {
    // 措辞与 `utils/storage.ts` 的 `loadProfile` 同源：整套替换 + 打开总开关 + 先落恢复点
    const storageSrc = readFileSync('utils/storage.ts', 'utf-8');
    const loadFn = storageSrc.slice(storageSrc.indexOf('export async function loadProfile'));
    expect(loadFn.slice(0, 900)).toContain('enabled: true');
    expect(loadFn.slice(0, 900)).toContain("pushConfigHistory('load-profile'");
  });
});

describe('新增文案：中英成对，且两边都说到总开关与恢复点', () => {
  const zh = JSON.parse(readFileSync('locales/zh_CN/popup.json', 'utf-8')) as Record<string, string>;
  const en = JSON.parse(readFileSync('locales/en/popup.json', 'utf-8')) as Record<string, string>;
  const zhOptions = JSON.parse(readFileSync('locales/zh_CN/options.json', 'utf-8')) as Record<string, string>;
  const enOptions = JSON.parse(readFileSync('locales/en/options.json', 'utf-8')) as Record<string, string>;

  const newKeys = [
    'profilePickerTitle',
    'profilePickerRuleCount',
    'profilePickerManage',
    'profilePickerConfirm',
    'profilePickerApply',
    'profilePickerApplying',
    'profileSwitched',
  ];

  it.each(newKeys)('popup.%s 两边都存在且非空', key => {
    expect(typeof zh[key]).toBe('string');
    expect(zh[key].length).toBeGreaterThan(0);
    expect(typeof en[key]).toBe('string');
    expect(en[key].length).toBeGreaterThan(0);
  });

  it.each([
    ['popup 中文', zh.profilePickerConfirm],
    ['popup 英文', en.profilePickerConfirm],
    ['options 中文', zhOptions.confirmLoadProfile],
    ['options 英文', enOptions.confirmLoadProfile],
  ])('%s：那句话同时点名总开关与恢复点', (_label, text) => {
    expect(text).toMatch(/总开关|proxy switch/i);
    expect(text).toMatch(/恢复点|restore point/i);
  });

  it('$1/$2 两个占位符四处齐全（少一个就是界面上露出字面量）', () => {
    for (const text of [zh.profilePickerConfirm, en.profilePickerConfirm, zh.profilePickerRuleCount]) {
      expect(text).toContain('$1');
    }
    expect(zh.profilePickerConfirm).toContain('$2');
    expect(en.profilePickerConfirm).toContain('$2');
  });
});
