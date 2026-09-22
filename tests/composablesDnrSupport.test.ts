/**
 * DNR 可用性判定的界面侧：过期结果不许盖掉新判定
 *
 * `utils/dnrSupport.ts` 早就有 `tests/dnrSupport.test.ts` 按纯函数测，但那支文件里
 * `composables/useDnrSupport.ts` 只以**源码契约**出现（「映射只写在一处」「三个消费点接得上」）。
 * 于是这个 composable 自己的两条判据一行都没跑过，而它们各自对应一句会骗人的界面话术：
 *
 * 1. **`checkSeq` 那道「丢弃过期结果」的闸门**。判定要走 `chrome.declarativeNetRequest.isRegexSupported`，
 *    是异步的；用户连续改两条规则就会并发出两轮判定，而后发的那轮完全可能先落定。少了这道闸门，
 *    先发的旧轮次会用**旧快照**的结果覆盖新判定——规则列表上一条本该标红的死规则当场变绿，
 *    或反过来给一条刚改好的规则挂上「不会被应用」。这一条只能靠控制 Promise 落定顺序来测，
 *    纯函数侧构造不出来。
 * 2. **抛错时维持上一份判定**。RE2 校验拿不到结果时，界面上是「没有失效规则」还是「维持上一次的
 *    结论」差别很大：前者会在真的有问题时沉默，后者至少不说新谎。
 *
 * 另外钉三件这个文件独有、`utils` 侧管不到的：就地改一个字段也要重算（`deep`，启用开关本身就
 * 决定走不走 DNR）、判定拿到的是**当下**那份数组而不是创建时的快照、`useDnrSkipText` 三种原因
 * 说三句不同的话（`undefined` 既不是空串文案也不是「intro + hint」两句）。
 *
 * 夹具与 `tests/composablesReadouts.test.ts` 同一套：只 stub `chrome` 与 `logger`，`utils/dnrSupport`
 * 整模块换成可控的假实现（这里要测的是「结果什么时候被采纳」，不是判定本身）。
 * **本环境测不到的那半**：`onMounted(recheck)` 在组件实例外永不触发，按源码契约钉住；
 * `watch` 不在其列，所以上面第 1、2 条与 deep 那三条全是真跑出来的。
 *
 * 承重已用单点变异量过（`.test-tmp/mutate-composables-dnr-support.py`）：13 个锚点各改一处 →
 * 跑本文件 → **13 条全部咬住、0 存活、0 锚点失效**，跑完源文件 `git status` 干净。
 * 这一轮的量法本身纠正了一次写反的断言：最初那条「反过来也一样」把过期那一轮落定时该发生的
 * 事写成了「旧读数先留下、再被盖掉」——正好是闸门要禁止的那半，跑第一次就红了，拆成
 * 「过期那一轮整包作废」与「顺序落定时新结论照旧生效」两条之后才是真的在钉第 1 条判据。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick, ref } from 'vue';
import { readFileSync } from 'node:fs';
import type { DnrSkipReason } from '@/utils/dnrSupport';
import type { ProxyRule } from '@/utils/types';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/utils/logger', () => ({ logger }));

const findDnrSkippedRules = vi.fn();
vi.mock('@/utils/dnrSupport', () => ({
  findDnrSkippedRules: (rules: ProxyRule[]) => findDnrSkippedRules(rules),
}));

vi.stubGlobal('chrome', {
  runtime: { sendMessage: vi.fn(), openOptionsPage: vi.fn() },
  // i18n 在未设置过语言偏好时按浏览器 UI 语言推断；给个确定值，免得断言随环境漂移
  i18n: { getUILanguage: () => 'zh-CN' },
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
});

// 组件实例外的 onMounted 必然抱怨，而那句接线正是本环境测不到的那半（只吞这一条）
const nativeWarn = console.warn;
vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  if (String(args[0]).startsWith('[Vue warn]: onMounted')) return;
  nativeWarn.apply(console, args);
});

const { useDnrSupport, useDnrSkipText } = await import('@/composables/useDnrSupport');
const { t } = await import('@/utils/i18n');

function makeRule(id: string, overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: 'https://fat.example.com/*',
    targetUrl: 'https://api.uat.example.com',
    matchType: 'wildcard',
    priority: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 手动控制的判定结果：本文件全部时序断言都靠它把「后发先至」排出来 */
function deferred() {
  let settle: (value: Map<string, DnrSkipReason> | Error) => void = () => {};
  const promise = new Promise<Map<string, DnrSkipReason>>((resolve, reject) => {
    settle = result => (result instanceof Error ? reject(result) : resolve(result));
  });
  return {
    promise,
    resolve: (value: Map<string, DnrSkipReason>) => settle(value),
    reject: (error: Error) => settle(error),
  };
}

/** 排空微任务与 Vue 的调度队列：`await` 的层数写死，不靠 `setTimeout` 蒙时间 */
async function flush() {
  for (let round = 0; round < 12; round += 1) await Promise.resolve();
  await nextTick();
}

beforeEach(() => {
  logger.debug.mockReset();
  logger.error.mockReset();
  findDnrSkippedRules.mockReset();
});

describe('useDnrSupport — 过期结果不得覆盖新判定', () => {
  it('最新一轮的判定被采纳', async () => {
    findDnrSkippedRules.mockResolvedValue(new Map([['r1', 'regexUnsupported' satisfies DnrSkipReason]]));
    const rules = ref<ProxyRule[]>([makeRule('r1')]);
    const { dnrSkippedRules } = useDnrSupport(rules);

    rules.value = [makeRule('r1')];
    await flush();
    expect(dnrSkippedRules.value.get('r1')).toBe('regexUnsupported');
  });

  it('后发先至：先发起那轮慢判定落定之后，不许把新的判定盖掉', async () => {
    const slow = deferred();
    const fast = deferred();
    findDnrSkippedRules.mockImplementationOnce(() => slow.promise).mockImplementationOnce(() => fast.promise);
    const rules = ref<ProxyRule[]>([makeRule('r1')]);
    const { dnrSkippedRules } = useDnrSupport(rules);

    rules.value[0].enabled = false;
    await flush(); // 第一轮发起（慢）
    rules.value = [makeRule('r1'), makeRule('r2')];
    await flush(); // 第二轮发起（快）
    expect(findDnrSkippedRules).toHaveBeenCalledTimes(2);

    fast.resolve(new Map([['r2', 'substitutionInvalid' satisfies DnrSkipReason]]));
    await flush();
    expect(dnrSkippedRules.value.get('r2')).toBe('substitutionInvalid');

    slow.resolve(new Map()); // 过期那一轮此刻才落定
    await flush();
    expect(dnrSkippedRules.value).toEqual(new Map([['r2', 'substitutionInvalid' satisfies DnrSkipReason]]));
  });

  it('过期那一轮落定时整包作废：连一次读数都不许留下', async () => {
    const slow = deferred();
    const fast = deferred();
    findDnrSkippedRules.mockImplementationOnce(() => slow.promise).mockImplementationOnce(() => fast.promise);
    const rules = ref<ProxyRule[]>([makeRule('r1')]);
    const { dnrSkippedRules } = useDnrSupport(rules);

    rules.value = [makeRule('r1')];
    await flush(); // 第一轮（慢）
    rules.value = [];
    await flush(); // 第二轮（快）

    slow.resolve(new Map([['r1', 'regexUnsupported' satisfies DnrSkipReason]]));
    await flush();
    // 这一句钉的是「过期结果连一次落地都没有」：一旦这里出现过 r1，
    // 界面就闪过一句凭空的「不会被应用」，即使下一轮立刻把它盖掉
    expect(dnrSkippedRules.value.size).toBe(0);

    fast.resolve(new Map());
    await flush();
    expect(dnrSkippedRules.value.size).toBe(0);
  });

  it('顺序落定时新结论照旧盖掉旧读数（闸门不是「只采纳第一次」）', async () => {
    const first = deferred();
    const second = deferred();
    findDnrSkippedRules.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const rules = ref<ProxyRule[]>([makeRule('r1')]);
    const { dnrSkippedRules } = useDnrSupport(rules);

    rules.value = [makeRule('r1')];
    await flush();
    first.resolve(new Map([['r1', 'regexUnsupported' satisfies DnrSkipReason]]));
    await flush();
    expect(dnrSkippedRules.value.size).toBe(1);

    rules.value = [];
    await flush();
    second.resolve(new Map());
    await flush();
    expect(dnrSkippedRules.value.size).toBe(0);
  });
});

describe('useDnrSupport — 判定拿的是哪一份规则、什么时候再判一次', () => {
  it('换掉整个数组会重算', async () => {
    findDnrSkippedRules.mockResolvedValue(new Map());
    const rules = ref<ProxyRule[]>([makeRule('r1')]);
    useDnrSupport(rules);

    rules.value = [makeRule('r1'), makeRule('r2')];
    await flush();
    expect(findDnrSkippedRules).toHaveBeenCalledTimes(1);
    expect(findDnrSkippedRules.mock.calls[0][0]).toHaveLength(2);
  });

  it('就地改一个字段也要重算：启用开关本身就决定走不走 DNR', async () => {
    findDnrSkippedRules.mockResolvedValue(new Map());
    const rules = ref<ProxyRule[]>([makeRule('r1')]);
    useDnrSupport(rules);

    rules.value[0].enabled = false;
    await flush();
    expect(findDnrSkippedRules).toHaveBeenCalledTimes(1);
    expect(findDnrSkippedRules.mock.calls[0][0][0].enabled).toBe(false);
  });

  it('每次重算读的是当下那份数组，不是创建时的快照', async () => {
    findDnrSkippedRules.mockResolvedValue(new Map());
    const rules = ref<ProxyRule[]>([makeRule('r1')]);
    useDnrSupport(rules);

    rules.value[0].targetUrl = 'https://changed.example.com';
    await flush();
    expect(findDnrSkippedRules.mock.calls[0][0]).toBe(rules.value);
    expect(findDnrSkippedRules.mock.calls[0][0][0].targetUrl).toBe('https://changed.example.com');
  });

  it('判定抛错：维持上一份结论，并说一句 error', async () => {
    findDnrSkippedRules.mockResolvedValueOnce(new Map([['r1', 'regexUnsupported' satisfies DnrSkipReason]]));
    const rules = ref<ProxyRule[]>([makeRule('r1')]);
    const { dnrSkippedRules } = useDnrSupport(rules);

    rules.value = [makeRule('r1')];
    await flush();
    expect(dnrSkippedRules.value.size).toBe(1);

    findDnrSkippedRules.mockRejectedValueOnce(new Error('isRegexSupported unavailable'));
    rules.value = [makeRule('r2')];
    await flush();
    expect(dnrSkippedRules.value.get('r1')).toBe('regexUnsupported');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('挂载即判一次（本环境钩子不触发，只能按源码契约钉）', () => {
    const src = readFileSync('composables/useDnrSupport.ts', 'utf-8');
    expect(src).toContain('onMounted(recheck);');
    expect(src).toContain('watch(rules, recheck, { deep: true });');
  });
});

describe('useDnrSkipText — 三种原因说三种话', () => {
  const RE2 = t('dnrSkippedRe2');
  const SUB = t('dnrSkippedSubstitution');

  const cases: Array<[string, DnrSkipReason, string]> = [
    ['正则 RE2 不兼容', 'regexUnsupported', RE2],
    ['替换串捕获引用越界', 'substitutionInvalid', SUB],
  ];

  it.each(cases)('%s：说的是字典里那一句，两种原因的措辞不许相同', (_label, reason, expected) => {
    expect(expected).not.toBe('');
    expect(expected).not.toBe(reason);
    const { skipReasonText } = useDnrSkipText();
    expect(skipReasonText(reason)).toBe(expected);
  });

  it('没有原因时是空串，不是任何一句现成的话', () => {
    const { skipReasonText } = useDnrSkipText();
    expect(skipReasonText(undefined)).toBe('');
  });

  it('完整告警三行：为什么失效 + 中间那句随原因切换 + 怎么改', () => {
    const { skipReasonLines } = useDnrSkipText();
    expect(skipReasonLines('regexUnsupported')).toEqual([t('dnrSkippedIntro'), RE2, t('dnrSkippedHint')]);
    expect(skipReasonLines('substitutionInvalid')).toEqual([t('dnrSkippedIntro'), SUB, t('dnrSkippedHint')]);
  });

  it('没有原因时一行都不说（画出来就是三行空话）', () => {
    const { skipReasonLines } = useDnrSkipText();
    expect(skipReasonLines(undefined)).toEqual([]);
  });
});
