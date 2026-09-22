/**
 * 凭据与恢复点的界面读写层：读失败绝不能长成一张空表
 *
 * `composables/useVariables.ts` 与 `composables/useConfigHistory.ts` 是界面侧唯一那两道
 * 「问后台要本地数据」的门。存储层早有 `tests/variables.test.ts` 与 `tests/configHistory.test.ts`
 * 覆盖，`messageRouter` 那侧的门禁也有 `tests/messageRouter.test.ts`；中间这一层此前一行都没跑过，
 * 而它恰好坐在一条**用户数据丢失路径**上：设置页的凭据是整表覆盖写，`SettingsDialog.vue` 靠
 * `loadVariables()` 返回的那个布尔决定「这次提交要不要拦」（`variablesLoadFailed`）。
 * 那个布尔一旦在失败时说了「成功」，界面就是一张空表 + 一次失焦保存 = 用户已有凭据全没。
 *
 * 所以这一层承重的判据只有一句：**「读到了什么」与「没读到」必须永远分得开**。落成三组：
 * 1. 空表 `{}` 与空列表 `[]` 是**真读数**，返回成功——把它们当失败，设置页就永远拦住提交；
 *    信封 `{ success: false }`、`undefined`（SW 回收期）、数组、原始量、抛错是**没读到**，
 *    返回失败且**保持上一轮的值**（这一条就是上面那句话的全部内容）。
 * 2. 写只在后台点头之后才跟本地：`saveVariables` 拿到 `success !== true` 或空回包时，
 *    `variables` 必须还是旧的那张表——否则界面把没存进去的凭据显示成已存。
 *    `dropped` 缺省补 0：非零即界面与后台两侧判据漂移，那一格必须说出来而不是画成空。
 * 3. 三个忙闲旗标（`loading` / `saving` / `restoring`）要**置得起、也落得回**：在途期间必须是 true
 *    （界面据此禁用提交），成功、信封、抛错三条路径之后必须回 false（漏一条就是按钮永久禁用）。
 *
 * 夹具与 `tests/composablesReadouts.test.ts` 同一套：只 stub `chrome` 与 `logger`，
 * 回包按类型登记（`respond` 里那句 `message.type in map` 是让「显式回 undefined」与
 * 「这条消息压根不该出现」可区分的那一格）；组件实例外 `onMounted` 不触发，所以那两句接线
 * 按源码契约钉。最后一组钉的是 `SettingsDialog.vue` 里那个布尔**被怎么用**——它没有 DOM 等价物，
 * 「读失败 → 拦下一次提交」这条链的两岸各钉一半，中间那根线一断，两边单独看都还是对的。
 *
 * 承重情况已用单点变异量过（`.test-tmp/mutate-composables-credentials.py`）：38 个锚点各改一处
 * → 跑本文件 → **38 条全部咬住、0 存活、0 锚点失效**，跑完三个源文件 `git status` 干净。
 * 其中两处是这一轮才补上的，因为第一轮它们各自活了下来：
 * - `loadHistory` 不置起 `loading`：只断言「落定后为 false」是钉不住的，必须有一格在途期间的读数；
 * - `historyLoadFailed` 在 `SettingsDialog.vue` 里有**两个**赋值点（打开弹窗、回退后刷新），
 *   `toContain` 只看得到其中一个，改成数次数之后漏钉的那一半才红。回退后那次读成信封，
 *   界面说的就是「还没有恢复点」——而用户刚刚回退成功。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MessageType } from '@/utils/types';
import type { ConfigHistoryEntry, VariableStore } from '@/utils/types';

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

const { useVariables } = await import('@/composables/useVariables');
const { useConfigHistory } = await import('@/composables/useConfigHistory');

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

function makeEntry(id: string): ConfigHistoryEntry {
  return {
    id,
    savedAt: 1_700_000_000_000,
    reason: 'replace-import',
    ruleCount: 1,
    config: {
      enabled: true,
      rules: [
        {
          id: 'r1',
          name: 'fat→uat',
          enabled: true,
          matchPattern: 'https://fat.example.com/*',
          targetUrl: 'https://api.uat.example.com',
          matchType: 'wildcard',
          priority: 1,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    },
  };
}

beforeEach(() => {
  logger.warn.mockReset();
  logger.error.mockReset();
  sendMessage.mockReset();
});

describe('useVariables.loadVariables — 那个布尔是防抹凭据的唯一前提', () => {
  it.each([
    ['空表（用户确实一条凭据都没有）', {}],
    ['一张表', { TOKEN: 'abc' }],
  ])('读到%s：算成功，原样收下', async (_label, table) => {
    respond({ [MessageType.GET_VARIABLES]: table });
    const vars = useVariables();
    await expect(vars.loadVariables()).resolves.toBe(true);
    expect(vars.variables.value).toEqual(table);
    expect(vars.loading.value).toBe(false);
  });

  it.each([
    ['被门禁拒掉的信封', { success: false, error: 'UNTRUSTED_SENDER' }],
    ['SW 回收期的空回包', undefined],
    ['null', null],
    ['数组（不是键值表）', ['TOKEN']],
    ['原始量', 'TOKEN'],
  ])('%s：算失败，且**一个字段都不覆盖**', async (_label, payload) => {
    respond({ [MessageType.GET_VARIABLES]: { TOKEN: 'keep-me' } });
    const vars = useVariables();
    await vars.loadVariables();
    respond({ [MessageType.GET_VARIABLES]: payload });
    await expect(vars.loadVariables()).resolves.toBe(false);
    expect(vars.variables.value).toEqual({ TOKEN: 'keep-me' });
    expect(vars.loading.value).toBe(false);
  });

  it('信封那一句要留在日志里（点名错误、不点凭据值）', async () => {
    respond({ [MessageType.GET_VARIABLES]: { success: false, error: 'UNTRUSTED_SENDER' } });
    const vars = useVariables();
    await vars.loadVariables();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toBe('UNTRUSTED_SENDER');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('抛错同样算失败、维持上一轮，并走 error 那一级', async () => {
    respond({ [MessageType.GET_VARIABLES]: { TOKEN: 'keep-me' } });
    const vars = useVariables();
    await vars.loadVariables();

    respond({ [MessageType.GET_VARIABLES]: boom('context invalidated') });
    await expect(vars.loadVariables()).resolves.toBe(false);
    expect(vars.variables.value).toEqual({ TOKEN: 'keep-me' });
    expect(vars.loading.value).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('连续失败之后仍然保持最初读到的那一张表（不是「失败一次抹一层」）', async () => {
    respond({ [MessageType.GET_VARIABLES]: { TOKEN: 'keep-me' } });
    const vars = useVariables();
    await vars.loadVariables();

    respond({ [MessageType.GET_VARIABLES]: boom('again') });
    await vars.loadVariables();
    respond({ [MessageType.GET_VARIABLES]: undefined });
    await vars.loadVariables();
    expect(vars.variables.value).toEqual({ TOKEN: 'keep-me' });
  });

  it('失败也要在日志里点名错误码（读到的凭据值本身不许进日志）', async () => {
    respond({ [MessageType.GET_VARIABLES]: { TOKEN: 'keep-me' } });
    const vars = useVariables();
    await vars.loadVariables();
    respond({ [MessageType.GET_VARIABLES]: { success: false, error: 'UNTRUSTED_SENDER' } });
    await vars.loadVariables();

    const logged = [...logger.warn.mock.calls, ...logger.error.mock.calls]
      .map(call => call.map(arg => String(arg)).join(' '))
      .join(' | ');
    expect(logged).toContain('UNTRUSTED_SENDER');
    expect(logged).not.toContain('keep-me');
  });

  it('请求在途期间 loading 与 saving 必须是 true，落定后回 false（界面靠它禁用提交）', async () => {
    let release: (value: unknown) => void = () => {};
    sendMessage.mockImplementation(() => new Promise(resolve => (release = resolve)));
    const vars = useVariables();

    const loading = vars.loadVariables();
    expect(vars.loading.value).toBe(true);
    release({ TOKEN: 'a' });
    await loading;
    expect(vars.loading.value).toBe(false);

    const saving = vars.saveVariables({ TOKEN: 'b' });
    expect(vars.saving.value).toBe(true);
    release({ success: true });
    await saving;
    expect(vars.saving.value).toBe(false);
  });

  it('开局是「没读到过」：variables 是空对象且 loading 为 false（提交闸门此刻不许放行）', () => {
    const vars = useVariables();
    expect(vars.variables.value).toEqual({});
    expect(vars.loading.value).toBe(false);
  });
});

describe('useVariables.saveVariables — 后台点头之后才跟本地', () => {
  it('写成功：本地跟界面一致，dropped 原样带回', async () => {
    const next: VariableStore = { TOKEN: 'new', OTHER: 'x' };
    respond({ [MessageType.SET_VARIABLES]: { success: true, dropped: 2 } });
    const vars = useVariables();
    await expect(vars.saveVariables(next)).resolves.toEqual({ success: true, dropped: 2 });
    expect(vars.variables.value).toEqual(next);
    expect(vars.saving.value).toBe(false);
  });

  it('后台没报 dropped 时补 0，而不是把 undefined 交给界面去画', async () => {
    respond({ [MessageType.SET_VARIABLES]: { success: true } });
    const vars = useVariables();
    await expect(vars.saveVariables({ TOKEN: 'new' })).resolves.toEqual({ success: true, dropped: 0 });
  });

  it.each([
    ['空回包（SW 回收期）', undefined, 'SET_VARIABLES_NO_RESPONSE'],
    ['后台拒绝', { success: false, error: 'MAX_VARIABLES_EXCEEDED' }, 'MAX_VARIABLES_EXCEEDED'],
  ])('%s：失败、本地那张表不许跟着改', async (_label, payload, expectedError) => {
    respond({ [MessageType.GET_VARIABLES]: { TOKEN: 'old' } });
    const vars = useVariables();
    await vars.loadVariables();
    respond({ [MessageType.SET_VARIABLES]: payload });
    await expect(vars.saveVariables({ TOKEN: 'rewritten' })).resolves.toMatchObject({
      success: false,
      dropped: 0,
      error: expectedError,
    });
    expect(vars.variables.value).toEqual({ TOKEN: 'old' });
    expect(vars.saving.value).toBe(false);
  });

  it('抛错回的是稳定码，不是异常原文（异常文本可能带上下文）', async () => {
    respond({ [MessageType.SET_VARIABLES]: boom('storage quota') });
    const vars = useVariables();
    await expect(vars.saveVariables({ TOKEN: 'new' })).resolves.toEqual({
      success: false,
      dropped: 0,
      error: 'SET_VARIABLES_ERROR',
    });
    expect(vars.variables.value).toEqual({});
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('报文形状：整表写在 `data.variables` 里，规则侧字段一个都不带', async () => {
    respond({ [MessageType.SET_VARIABLES]: { success: true } });
    await useVariables().saveVariables({ TOKEN: 'new' });
    expect(sendMessage).toHaveBeenCalledWith({
      type: MessageType.SET_VARIABLES,
      data: { variables: { TOKEN: 'new' } },
    });
  });
});

describe('useConfigHistory.loadHistory — 「没有恢复点」与「读不到」是两句话', () => {
  it('空列表是真读数：成功、界面可以说「还没有恢复点」', async () => {
    respond({ [MessageType.GET_CONFIG_HISTORY]: [] });
    const history = useConfigHistory();
    await expect(history.loadHistory()).resolves.toBe(true);
    expect(history.history.value).toEqual([]);
    expect(history.loading.value).toBe(false);
  });

  it('有恢复点：原样收下', async () => {
    respond({ [MessageType.GET_CONFIG_HISTORY]: [makeEntry('h1')] });
    const history = useConfigHistory();
    await history.loadHistory();
    expect(history.history.value.map(entry => entry.id)).toEqual(['h1']);
  });

  it.each([
    ['被门禁拒掉的信封', { success: false, error: 'UNTRUSTED_SENDER' }],
    ['SW 回收期的空回包', undefined],
    ['不是列表的对象', { 0: makeEntry('h1') }],
    ['原始量', 42],
  ])('%s：算失败，且不清掉上一轮那份列表', async (_label, payload) => {
    respond({ [MessageType.GET_CONFIG_HISTORY]: [makeEntry('h1')] });
    const history = useConfigHistory();
    await history.loadHistory();

    respond({ [MessageType.GET_CONFIG_HISTORY]: payload });
    await expect(history.loadHistory()).resolves.toBe(false);
    expect(history.history.value.map(entry => entry.id)).toEqual(['h1']);
    expect(history.loading.value).toBe(false);
  });

  it('信封的错误码进 warn 而不是 error：与变量表同一套说话方式', async () => {
    respond({ [MessageType.GET_CONFIG_HISTORY]: { success: false, error: 'UNTRUSTED_SENDER' } });
    const history = useConfigHistory();
    await history.loadHistory();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toBe('UNTRUSTED_SENDER');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('恢复点列表在途期间 loading 是 true，落定后回 false', async () => {
    let release: (value: unknown) => void = () => {};
    sendMessage.mockImplementation(() => new Promise(resolve => (release = resolve)));
    const history = useConfigHistory();

    const pending = history.loadHistory();
    expect(history.loading.value).toBe(true);
    release([]);
    await pending;
    expect(history.loading.value).toBe(false);
  });

  it('抛错走 error 那一级，返回值同样是失败', async () => {
    respond({ [MessageType.GET_CONFIG_HISTORY]: boom('gone') });
    const history = useConfigHistory();
    await expect(history.loadHistory()).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(history.loading.value).toBe(false);
  });
});

describe('useConfigHistory.restore — 三类失败各有各的码', () => {
  it('成功：把后台报的 ruleCount 带回去', async () => {
    respond({ [MessageType.RESTORE_CONFIG_HISTORY]: { success: true, restored: 7 } });
    const history = useConfigHistory();
    await expect(history.restore('h1')).resolves.toEqual({ success: true, restored: 7 });
    expect(history.restoring.value).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith({
      type: MessageType.RESTORE_CONFIG_HISTORY,
      data: { id: 'h1' },
    });
  });

  it.each([
    ['空回包', undefined, 'RESTORE_NO_RESPONSE'],
    ['success 缺省（不是 true 就算失败）', { restored: 3 }, 'RESTORE_NO_RESPONSE'],
    ['后台拒绝', { success: false, error: 'MAX_RULES_EXCEEDED' }, 'MAX_RULES_EXCEEDED'],
  ])('%s：报失败并带上原因', async (_label, payload, expectedError) => {
    respond({ [MessageType.RESTORE_CONFIG_HISTORY]: payload });
    const history = useConfigHistory();
    await expect(history.restore('h1')).resolves.toEqual({ success: false, error: expectedError });
    expect(history.restoring.value).toBe(false);
  });

  it('回退在途期间 restoring 是 true，落定后回 false（否则按钮永久禁用）', async () => {
    let release: (value: unknown) => void = () => {};
    sendMessage.mockImplementation(() => new Promise(resolve => (release = resolve)));
    const history = useConfigHistory();

    const pending = history.restore('h1');
    expect(history.restoring.value).toBe(true);
    release({ success: true, restored: 1 });
    await pending;
    expect(history.restoring.value).toBe(false);
  });

  it('抛错回稳定码，且 restoring 一定落回（否则按钮永久禁用）', async () => {
    respond({ [MessageType.RESTORE_CONFIG_HISTORY]: boom('write failed') });
    const history = useConfigHistory();
    await expect(history.restore('h1')).resolves.toEqual({ success: false, error: 'RESTORE_CONFIG_ERROR' });
    expect(history.restoring.value).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('这两个布尔被界面怎么用（组件层没有 DOM，只能按源码契约钉）', () => {
  const dialogSrc = readFileSync('components/options/SettingsDialog.vue', 'utf-8');
  const commit = dialogSrc.slice(dialogSrc.indexOf('async function commitVariables'));

  it('设置页把 `loadVariables()` 的返回值直接当闸门：失败即置位', () => {
    expect(dialogSrc).toContain('variablesLoadFailed.value = !(await loadVariables());');
  });

  it('读失败时不许把空表灌进界面行（那正是「抹掉凭据」的前一步）', () => {
    expect(dialogSrc).toMatch(
      /variablesLoadFailed\.value = !\(await loadVariables\(\)\);\s*if \(!variablesLoadFailed\.value\) \{\s*refillRows\(variables\.value\);/,
    );
  });

  it('闸门排在整表写之前：先拒这次提交，再去遍历行', () => {
    const gate = commit.indexOf('if (variablesLoadFailed.value)');
    expect(gate).toBeGreaterThan(-1);
    // 遍历行、整表写都必须在闸门之后——闸门之前一旦读到 `variableRows`，那次点击就已经开始改数据了
    expect(commit.indexOf('variableRows.value')).toBeGreaterThan(gate);
    expect(commit.indexOf('saveVariables(')).toBeGreaterThan(gate);
    // 拒绝时必须说一句可理解的话，而不是静默吞掉这次点击
    expect(commit.slice(gate, commit.indexOf('}', gate))).toContain("ElMessage.error(t('variablesWriteBlocked')");
  });

  it('恢复点列表同样把「读不到」留给界面一句独立的话，而且两处调用点都要说', () => {
    // 打开弹窗拉一次、回退成功之后再拉一次（回退会留下 `before-restore`）。
    // 只钉一处就是漏一半：漏掉后一处，回退完那次读到信封也会画成「还没有恢复点」。
    const sites = dialogSrc.match(/historyLoadFailed\.value = !\(await loadHistory\(\)\);/g) ?? [];
    expect(sites).toHaveLength(2);
  });
});

/**
 * `constructor` / `toString` 都过 `isVariableName`（首字符是字母、字符合法），所以「按名字查这张
 * 凭据表」的三个位点一旦写成裸下标，就会顺原型链读到 `Object.prototype` 上的函数：孤儿引用不报警、
 * 使用次数画成一段函数源码、而这个名字在第一行就被判成「重复」存不进去。
 * 组件层没有 DOM 等价物，只能按源码契约钉住「走的是哪一个出口」。
 */
describe('凭据表按名字取值：三处位点都不许顺原型链（源码契约）', () => {
  const dialogSrc = readFileSync('components/options/SettingsDialog.vue', 'utf-8');

  it('「表里有没有」只问 `findUndefinedVariableRefs` 那一个出口，界面不再自己写下标判据', () => {
    expect(dialogSrc).toContain(
      'for (const name of findUndefinedVariableRefs(rule, variables.value)) names.add(name);',
    );
  });

  it('使用次数用 Map 存、用 get 取', () => {
    expect(dialogSrc).toContain('const counts = new Map<string, number>();');
    expect(dialogSrc).toContain('return variableUsage.value.get(name.trim()) ?? 0;');
    // 回到对象下标就是上面那条缺陷的回潮：`variableUsage.value['constructor']` 不是 undefined
    expect(dialogSrc).not.toContain('variableUsage.value[');
  });

  it('重名判据只认自有键', () => {
    expect(dialogSrc).toContain('Object.prototype.hasOwnProperty.call(next, name)');
    // 只钉「读」这一侧：`next[name] = value` 是建表时的写，本来就只能落在下标上
    expect(dialogSrc).not.toContain('next[name] !== undefined');
  });
});
