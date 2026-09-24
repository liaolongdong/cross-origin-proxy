import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ConfigHistoryEntry, ProxyRule } from '@/utils/types';
import { MAX_CONFIG_HISTORY, MAX_CONFIG_HISTORY_TOTAL_SIZE, MAX_RULES, STORAGE_KEYS } from '@/utils/constants';

// 内存版 chrome.storage.local mock（在存储被测模块前安装），写入按 JSON 往返模拟真实序列化。
// `failHistoryWrite` 单独让恢复点写入失败，用来验证「安全网写失败不阻断主流程」；
// `failHistoryRead` 同理管读取侧（SW 回收/存储异常时 get 也会抛）。
// `quota` 把整包占用卡住（真实 Chrome 按「这次写入落定后的总量」判定），用来验恢复点不与主写入抢配额。
// `writeOrder` 只记**真正落盘**的那几笔（被拒的不算），顺序即契约。
let store: Record<string, unknown> = {};
let failHistoryWrite = false;
let failHistoryRead = false;
let quota = Infinity;
let writeOrder: string[] = [];

const bytes = (value: unknown): number => JSON.stringify(value).length;

/** 被覆盖的键按新值计，其余原样留着——这就是 Chrome 判配额时看的那个数 */
function projectedUsage(items: Record<string, unknown>): number {
  const next = { ...store, ...JSON.parse(JSON.stringify(items)) };
  return Object.values(next).reduce((sum: number, value: unknown) => sum + bytes(value), 0);
}

const setSpy = vi.fn(async (items: Record<string, unknown>) => {
  if (failHistoryWrite && Object.prototype.hasOwnProperty.call(items, STORAGE_KEYS.CONFIG_HISTORY)) {
    throw new TypeError('QUOTA_EXCEEDED');
  }
  if (projectedUsage(items) > quota) throw new TypeError('QUOTA_EXCEEDED');
  writeOrder.push(...Object.keys(items));
  store = { ...store, ...JSON.parse(JSON.stringify(items)) };
});

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (keys: unknown) => {
        if (failHistoryRead && keys === STORAGE_KEYS.CONFIG_HISTORY) throw new TypeError('STORAGE_UNAVAILABLE');
        return store;
      }),
      set: setSpy,
    },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { sendMessage: vi.fn() },
});

const {
  importProxyConfig,
  addRule,
  batchDeleteRules,
  loadProfile,
  getProxyConfig,
  invalidateConfigCache,
  capConfigHistory,
  sanitizeConfigHistory,
  getConfigHistory,
  restoreConfigHistory,
} = await import('@/utils/storage');

function makeRule(id: string, overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: `https://api-${id}.example.com/*`,
    targetUrl: 'https://target.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 直接铺现场配置（绕过写入侧，避免把被测的那一步混进前置条件） */
function seedConfig(rules: ProxyRule[], enabled = true): void {
  store = { [STORAGE_KEYS.PROXY_CONFIG]: { enabled, rules } };
  invalidateConfigCache();
}

function seedHistory(entries: unknown[]): void {
  store[STORAGE_KEYS.CONFIG_HISTORY] = entries;
}

function storedHistory(): ConfigHistoryEntry[] {
  return (store[STORAGE_KEYS.CONFIG_HISTORY] ?? []) as ConfigHistoryEntry[];
}

function reset(): void {
  store = {};
  failHistoryWrite = false;
  failHistoryRead = false;
  quota = Infinity;
  writeOrder = [];
  setSpy.mockClear();
  invalidateConfigCache();
}

describe('恢复点何时落下 — 只有成套替换才记', () => {
  beforeEach(reset);

  it('替换式导入记下「被换掉的那一份」', async () => {
    seedConfig([makeRule('old')]);
    await importProxyConfig([makeRule('new')], { mode: 'replace' });

    const history = storedHistory();
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('replace-import');
    expect(history[0].ruleCount).toBe(1);
    expect(history[0].config.rules.map(r => r.id)).toEqual(['old']);
    expect(history[0].id).toBeTruthy();
    expect(typeof history[0].savedAt).toBe('number');
  });

  it('合并式导入不留恢复点（没有整包被换掉）', async () => {
    seedConfig([makeRule('old')]);
    await importProxyConfig([makeRule('new')], { mode: 'merge' });
    expect(storedHistory()).toHaveLength(0);
  });

  it('替换式导入被上限拒绝时也不留恢复点（没有发生写入）', async () => {
    seedConfig([makeRule('old')]);
    const incoming = Array.from({ length: MAX_RULES + 1 }, (_, i) => makeRule(`n${i}`));
    const result = await importProxyConfig(incoming, { mode: 'replace' });

    expect(result).toEqual({ success: false, error: 'MAX_RULES_EXCEEDED' });
    expect(storedHistory()).toHaveLength(0);
    expect((await getProxyConfig()).rules.map(r => r.id)).toEqual(['old']);
  });

  it('加载快照记下加载前的配置', async () => {
    seedConfig([makeRule('old')]);
    store[STORAGE_KEYS.PROFILES] = [{ id: 'p1', name: 'P1', rules: [makeRule('from-profile')], createdAt: 0 }];

    await loadProfile('p1');
    const history = storedHistory();
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('load-profile');
    expect(history[0].config.rules.map(r => r.id)).toEqual(['old']);
  });

  it('快照不存在时不落恢复点（失败的操作不该污染历史）', async () => {
    seedConfig([makeRule('old')]);
    const result = await loadProfile('nope');

    expect(result.success).toBe(false);
    expect(storedHistory()).toHaveLength(0);
  });

  it('批量删除真删掉了东西才记，快照是删除前的完整规则集', async () => {
    seedConfig([makeRule('a'), makeRule('b'), makeRule('c')]);
    await batchDeleteRules(['a', 'b']);

    const history = storedHistory();
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('batch-delete');
    expect(history[0].config.rules.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('批量删除空操作（选中的 id 早已被删）不落恢复点', async () => {
    seedConfig([makeRule('a')]);
    await batchDeleteRules(['gone']);
    expect(storedHistory()).toHaveLength(0);
  });

  it('单条新增不进历史（恢复点只兜「成套换掉」这种事故）', async () => {
    seedConfig([]);
    await addRule(makeRule('new'));
    expect(storedHistory()).toHaveLength(0);
  });

  it('恢复点写入失败只告警，不让已经落盘的主操作翻成失败', async () => {
    seedConfig([makeRule('old')]);
    failHistoryWrite = true;

    const result = await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect(result.success).toBe(true);
    expect((await getProxyConfig()).rules.map(r => r.id)).toEqual(['new']);
    expect(storedHistory()).toHaveLength(0);
  });

  it('读旧账失败同样只告警（安全网不能反过来咬主流程一口）', async () => {
    seedConfig([makeRule('old')]);
    failHistoryRead = true;

    const result = await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect(result.success).toBe(true);
    expect((await getProxyConfig()).rules.map(r => r.id)).toEqual(['new']);
    expect(storedHistory()).toHaveLength(0);
  });
});

describe('恢复点排在主写入之后 — 安全网不抢主操作的配额', () => {
  beforeEach(reset);

  // 每一对「主写入 → 恢复点」的顺序就是这条契约的全部，且每对都得单独钉：它们住在彼此独立的调用点上，
  // 只改其中一处（例如只挪替换式导入）剩下的照样是「先记再写」。调用点与断言是否配齐，由下面那条
  // 计数互咬的用例负责，所以这里不写「几处」——那个数字一漂，这句话就成了假的安心来源。
  it('替换式导入：新配置先落盘，恢复点后写', async () => {
    seedConfig([makeRule('old')]);
    await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect(writeOrder).toEqual([STORAGE_KEYS.PROXY_CONFIG, STORAGE_KEYS.CONFIG_HISTORY]);
  });

  it('批量删除：剩余规则集先落盘，删除前的整包后记', async () => {
    seedConfig([makeRule('a'), makeRule('b')]);
    await batchDeleteRules(['a']);
    expect(writeOrder).toEqual([STORAGE_KEYS.PROXY_CONFIG, STORAGE_KEYS.CONFIG_HISTORY]);
  });

  it('加载快照：profile 的规则集先落盘，加载前的配置后记', async () => {
    seedConfig([makeRule('old')]);
    store[STORAGE_KEYS.PROFILES] = [{ id: 'p1', name: 'P1', rules: [makeRule('from-profile')], createdAt: 0 }];
    await loadProfile('p1');
    expect(writeOrder).toEqual([STORAGE_KEYS.PROXY_CONFIG, STORAGE_KEYS.CONFIG_HISTORY]);
  });

  it('回退：回退结果先落盘，回退前的现状后记', async () => {
    seedConfig([makeRule('current')]);
    seedHistory([validEntry('h1')]);
    await restoreConfigHistory('h1');
    expect(writeOrder).toEqual([STORAGE_KEYS.PROXY_CONFIG, STORAGE_KEYS.CONFIG_HISTORY]);
  });

  it('每一处恢复点写入都有自己那对顺序用例（两份计数彼此制衡）', () => {
    // 上面那组「一个调用点一对断言」是这条契约的全部射程，而任何写在注释里的调用点个数都会漂：
    // 加第五处 `pushConfigHistory` 而忘了配对断言，剩下的用例照样全绿，新那处的顺序从此没人钉。
    // 所以这里不比字面数字，比两份**互相独立**的计数——生产侧多一处、测试侧没跟上，当场红。
    const callSites = readFileSync('utils/storage.ts', 'utf-8').match(/await pushConfigHistory\(/g) ?? [];
    const orderCases =
      readFileSync('tests/configHistory.test.ts', 'utf-8').match(
        /expect\(writeOrder\)\.toEqual\(\[STORAGE_KEYS\.PROXY_CONFIG, STORAGE_KEYS\.CONFIG_HISTORY\]\);/g,
      ) ?? [];
    expect(orderCases).toHaveLength(callSites.length);
    // 计数为 0 时上一条会自证（0 == 0），所以正向半边也得钉：调用点确实存在
    expect(callSites.length).toBeGreaterThan(0);
  });

  it('配额只够一次整包写入时：主写入拿走它，这一份恢复点让路', async () => {
    const oldRules = [makeRule('old')];
    const incoming = Array.from({ length: 30 }, (_, i) => makeRule(`n${i}`));
    const filler = 'y'.repeat(200_000);
    // 恢复点这一份到底占多少字符，按 pushConfigHistory 实际写出的形状算（键序、uuid 长度、时间戳位数一致）
    const historyPayload = [
      {
        id: '0'.repeat(36),
        savedAt: 1700000000000,
        reason: 'replace-import',
        ruleCount: oldRules.length,
        config: { enabled: true, rules: oldRules },
      },
    ];
    // 卡位：余量够「旧配置 + 恢复点」，也够「新配置」，但不够「新配置 + 恢复点」——
    // 谁先写谁活下来，后写的那一笔必被拒。150 字符的松弛量是留给 JSON 细节的，不是留给顺序的。
    quota = bytes(filler) + bytes({ enabled: false, rules: incoming }) + bytes(historyPayload) - 150;
    seedConfig(oldRules);
    store[STORAGE_KEYS.REQUEST_LOGS] = filler;

    const result = await importProxyConfig(incoming, { mode: 'replace' });
    expect(result.success).toBe(true);
    expect((await getProxyConfig()).rules).toHaveLength(30);
    // 这一份确实没记上——正是它该让路的那一种；主操作活着，用户才谈得上回来找退路
    expect(storedHistory()).toHaveLength(0);
  });

  it('快照自己形状不对（手改过的 storage）时只跳过这一份，不推翻已经落盘的主写入', async () => {
    // 恢复点排在主写入之后，就意味着 pushConfigHistory 里任何一句抛出去，都会把一次**已经成功**的
    // 替换翻成 rejection。`rules: null` 是 AGENTS 明列的可信来路（手改或被截断的旧数据）。
    store = { [STORAGE_KEYS.PROXY_CONFIG]: { enabled: true, rules: null } };
    invalidateConfigCache();

    const result = await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect(result.success).toBe(true);
    expect((await getProxyConfig()).rules.map(r => r.id)).toEqual(['new']);
    expect(storedHistory()).toHaveLength(0);
  });
});

describe('capConfigHistory — 份数与字符预算都从最新往旧留', () => {
  function entry(id: string, padSize = 0): ConfigHistoryEntry {
    return {
      id,
      savedAt: Number(id.replace(/\D/g, '')) || 0,
      reason: 'replace-import',
      ruleCount: 1,
      config: { enabled: true, rules: [makeRule('r', { matchPattern: 'x'.repeat(padSize) || 'https://a/*' })] },
    };
  }

  it(`超过 ${MAX_CONFIG_HISTORY} 份时丢掉最旧的`, () => {
    const many = Array.from({ length: MAX_CONFIG_HISTORY + 2 }, (_, i) => entry(`e${i}`));
    expect(capConfigHistory(many).map(e => e.id)).toEqual(
      Array.from({ length: MAX_CONFIG_HISTORY }, (_, i) => `e${i}`),
    );
  });

  it('按整包字符预算截断，保留的是最新那几份', () => {
    const one = historySize(entry('e0'));
    const many = Array.from({ length: 4 }, (_, i) => entry(`e${i}`));
    const kept = capConfigHistory(many, MAX_CONFIG_HISTORY, one * 2 + 1);

    expect(kept.map(e => e.id)).toEqual(['e0', 'e1']);
    expect(kept.length).toBe(2);
  });

  it('单份就超预算时宁可不给恢复点（与日志「至少留一条」的语义刻意相反）', () => {
    const huge = entry('e0', 64);
    expect(capConfigHistory([huge], MAX_CONFIG_HISTORY, historySize(huge) - 1)).toEqual([]);
  });

  it(`存储层写入侧同样收口：单份快照超 ${MAX_CONFIG_HISTORY_TOTAL_SIZE} 字符时不落恢复点，导入仍成功`, async () => {
    reset();
    seedConfig([makeRule('huge', { matchPattern: 'x'.repeat(MAX_CONFIG_HISTORY_TOTAL_SIZE + 10) })]);

    const result = await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect(result.success).toBe(true);
    expect(storedHistory()).toHaveLength(0);
  });

  it('新快照单份越预算时，预算内的旧恢复点原样留着（换掉规则集不该顺手抹掉退路）', async () => {
    reset();
    seedConfig([makeRule('huge', { matchPattern: 'x'.repeat(MAX_CONFIG_HISTORY_TOTAL_SIZE + 10) })]);
    seedHistory([entry('e-keep')]);

    const result = await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect(result.success).toBe(true);
    expect(storedHistory().map(e => e.id)).toEqual(['e-keep']);
  });
});

describe('sanitizeConfigHistory — 存储里的历史是可被手改的数据', () => {
  it('整包不是数组时按「没有恢复点」处理，不半解析', () => {
    expect(sanitizeConfigHistory(undefined)).toEqual([]);
    expect(sanitizeConfigHistory({})).toEqual([]);
    expect(sanitizeConfigHistory('nope')).toEqual([]);
  });

  it('缺 id 的条目直接丢弃（界面上没有可回退的句柄）', () => {
    const noId = { ...validEntry('h1') } as Record<string, unknown>;
    delete noId.id;
    expect(sanitizeConfigHistory([noId, validEntry('h2')]).map(e => e.id)).toEqual(['h2']);
  });

  it('config 缺失或 rules 不是数组的条目丢弃', () => {
    expect(sanitizeConfigHistory([{ id: 'a', savedAt: 1, reason: 'unknown', ruleCount: 0 }])).toEqual([]);
    expect(
      sanitizeConfigHistory([{ id: 'a', savedAt: 1, reason: 'load-profile', ruleCount: 1, config: { rules: 'x' } }]),
    ).toEqual([]);
  });

  it('非法规则逐条过滤，ruleCount 重算成「点回退能拿回几条」的真实数字', () => {
    const dirty = validEntry('h1');
    dirty.config.rules = [makeRule('ok'), { id: 'x', name: 'no-pattern' } as unknown as ProxyRule];
    dirty.ruleCount = 99;

    const [clean] = sanitizeConfigHistory([dirty]);
    expect(clean.ruleCount).toBe(1);
    expect(clean.config.rules.map(r => r.id)).toEqual(['ok']);
  });

  it('认不出的成因标成 unknown，而不是丢掉快照或硬塞进已知成因', () => {
    const future = validEntry('h1');
    future.reason = 'from-a-newer-version' as ConfigHistoryEntry['reason'];

    expect(sanitizeConfigHistory([future])[0].reason).toBe('unknown');
  });

  it('savedAt 非有限数按 0 处理（界面显示为未知时间而不是 Invalid Date）', () => {
    const bad = validEntry('h1');
    bad.savedAt = '昨天' as unknown as number;
    expect(sanitizeConfigHistory([bad])[0].savedAt).toBe(0);
  });

  it('enabled 只认真正的 true，其余一律 false', () => {
    const entry = validEntry('h1');
    entry.config.enabled = 'yes' as unknown as boolean;
    expect(sanitizeConfigHistory([entry])[0].config.enabled).toBe(false);
  });

  it('读取侧每次都从 storage 取（没有内存缓存可陈旧）', async () => {
    reset();
    seedHistory([validEntry('h1')]);
    expect((await getConfigHistory()).map(e => e.id)).toEqual(['h1']);

    seedHistory([validEntry('h2')]);
    expect((await getConfigHistory()).map(e => e.id)).toEqual(['h2']);
  });

  it(`手改进 storage 的几百条历史，读取侧最多给 ${MAX_CONFIG_HISTORY} 份（界面不无界渲染）`, async () => {
    reset();
    seedHistory(Array.from({ length: MAX_CONFIG_HISTORY + 20 }, (_, i) => validEntry(`h${i}`)));
    expect(await getConfigHistory()).toHaveLength(MAX_CONFIG_HISTORY);
  });
});

describe('restoreConfigHistory — 回退本身必须是可逆的', () => {
  beforeEach(reset);

  it('回退规则集但维持当前总开关，并把现状补记一份 before-restore', async () => {
    seedConfig([makeRule('current')], false);
    seedHistory([
      {
        id: 'h1',
        savedAt: 1,
        reason: 'replace-import',
        ruleCount: 1,
        config: { enabled: true, rules: [makeRule('old')] },
      },
    ]);

    const result = await restoreConfigHistory('h1');
    expect(result).toEqual({ success: true, restored: 1 });

    const config = await getProxyConfig();
    expect(config.rules.map(r => r.id)).toEqual(['old']);
    // 快照里那份 enabled=true 只是记录：点「找回规则」不该顺手把代理打开
    expect(config.enabled).toBe(false);

    const history = storedHistory();
    expect(history).toHaveLength(2);
    expect(history[0].reason).toBe('before-restore');
    expect(history[0].config.rules.map(r => r.id)).toEqual(['current']);
  });

  it('未知 id 明确失败，不写任何配置', async () => {
    seedConfig([makeRule('current')]);
    seedHistory([validEntry('h1')]);
    const before = JSON.stringify(store[STORAGE_KEYS.PROXY_CONFIG]);

    expect(await restoreConfigHistory('nope')).toEqual({ success: false, error: 'HISTORY_ENTRY_NOT_FOUND' });
    expect(JSON.stringify(store[STORAGE_KEYS.PROXY_CONFIG])).toBe(before);
    expect(storedHistory()).toHaveLength(1);
  });

  it(`手改过的超限快照拒绝回退（照写会让 DNR 整批被拒）`, async () => {
    seedConfig([makeRule('current')]);
    seedHistory([
      {
        id: 'big',
        savedAt: 1,
        reason: 'replace-import',
        ruleCount: MAX_RULES + 1,
        config: { enabled: true, rules: Array.from({ length: MAX_RULES + 1 }, (_, i) => makeRule(`r${i}`)) },
      },
    ]);

    expect(await restoreConfigHistory('big')).toEqual({ success: false, error: 'MAX_RULES_EXCEEDED' });
    expect((await getProxyConfig()).rules.map(r => r.id)).toEqual(['current']);
    expect(storedHistory()).toHaveLength(1);
  });

  it('回退到空规则集是合法操作（用户可能就是要清空）', async () => {
    seedConfig([makeRule('current')]);
    seedHistory([
      { id: 'empty', savedAt: 1, reason: 'batch-delete', ruleCount: 0, config: { enabled: false, rules: [] } },
    ]);

    expect(await restoreConfigHistory('empty')).toEqual({ success: true, restored: 0 });
    expect((await getProxyConfig()).rules).toHaveLength(0);
  });
});

/**
 * 界面措辞不得承诺恢复点的写入时机
 *
 * 每一处写入点现在一律排在主写入之后（上面那组「落盘顺序」钉的是代码，调用点是否配齐由那条计数互咬的
 * 用例负责），而这三个 key 走出去的几句界面文案，是恢复点在扩展 bundle 里说这件事的唯一出口——恢复点
 * 没有别的可观察面，读者只能照句子理解成「我那次替换之前，旧配置已经先存好了」。改了代码不改文案，
 * 两边都会以为自己在对齐事实，所以顺序契约与措辞落在同一支文件里。
 *
 * 判据是「同一句里出现顺序承诺」，实现却刻意做成禁字：`先`（中英）与 `before` / `first`（英）在这三句
 * 话里只承担一个语义——「记」发生在被替换的那次写入之前。要写「请先…」之类的客套，请把这句话换成不含
 * 时序的说法，而不是往守卫里加例外。反过来，`改动前的配置`、`被换掉的那份` 说的是快照的**内容**（那次
 * 写入换掉的那一份配置），换序之后依然成立，所以不在禁列。
 *
 * 英文侧为什么两个词都禁：`first` 钉住的是被换掉的那句 "stored first"，而下一句最可能长回来的写法是
 * "record the config **before** replacing"——只禁 `first` 拦不住它。三句现值里 `before` 一个都没有，
 * 所以这条禁字今天是零成本的。射程只到 `RECORDING_COPY_KEYS` 这三句：`restoreReason*` 那一组标签以
 * "Before a replace-mode import" 之类开头，说的是这份快照**属于哪一次操作**（provenance），换序前后
 * 都成立，所以既不在禁列里、也不在这条守卫的射程里。
 *
 * 负向半边单独存在会空转（把整句删掉、或把 key 改名也算通过），所以每条同时钉正向：这句话仍然要说清
 * 「被换掉的那一份会记成恢复点」，中英各一份。扩展内是这三句，另加 `docs/llms.txt` 的那一条 bullet
 * （它不走 key、也不进 bundle，上面那两条 `it.each` 一句也够不着，所以要单独钉一次）。剩下的外部落点
 * 都在同一份「顺序承诺」下等收：README 两份的回退子句、两份落地页，以及 `docs/llms-full.txt` 的第 109
 * 行——那一条中英都还在说「回退之前同样**先**留一份」/ "records its own point **first**"，别把它当
 * 已经对齐了（`llms.txt` 收口这一格时曾把它记成「已是内容口径」，那是错的）。这些文件正被同机另一会话
 * 改，改它们要连带中英成对与 `docs/` 的日期三件套，留待那一轮一起收。
 */
const zhOptions = JSON.parse(readFileSync('locales/zh_CN/options.json', 'utf-8')) as Record<string, string>;
const enOptions = JSON.parse(readFileSync('locales/en/options.json', 'utf-8')) as Record<string, string>;

/** 会提到「整套替换会留一份恢复点」的三句界面文案 */
const RECORDING_COPY_KEYS = ['restorePointsHint', 'restoreConfirm', 'importPreviewReplaces'] as const;

describe('恢复点的界面措辞 — 不承诺写入时机', () => {
  it.each(RECORDING_COPY_KEYS)('%s：中英两侧都没有「先记」这种顺序承诺', key => {
    expect(zhOptions[key]).not.toContain('先');
    // 两个词都要禁：`first` 钉的是被换掉的那句说法，`before` 拦住下一句最可能长回来的写法
    expect(enOptions[key]).not.toMatch(/\b(before|first)\b/i);
  });

  it.each([
    { key: 'restorePointsHint', zh: ['改动前的配置', '$1'], en: [/replace the whole rule set/i, /record/i, /\$1/] },
    { key: 'restoreConfirm', zh: ['恢复点', '记为'], en: [/restore point/i, /recorded/i] },
    { key: 'importPreviewReplaces', zh: ['恢复点', '记为'], en: [/restore point/i, /kept as/i] },
  ] as const)('$key：仍然把「被换掉的那一份会记成恢复点」说给用户', ({ key, zh, en }) => {
    for (const needle of zh) expect(zhOptions[key]).toContain(needle);
    for (const pattern of en) expect(enOptions[key]).toMatch(pattern);
  });

  /**
   * `docs/llms.txt` 是这一事实面向引用型 AI 引擎的两个出口之一（另一个是 `llms-full.txt`，
   * 见上文），所以按 bullet 单独钉一次：它不走 key、不进 bundle，上面那两条 `it.each`
   * 一句也够不着它。中英同条，禁字与正向判据照抄。
   */
  it('docs/llms.txt 的恢复点那条 bullet：同样只说内容、不承诺写入时机', () => {
    const text = readFileSync('docs/llms.txt', 'utf-8');
    const bullet = text.split('\n').find(line => line.startsWith('- Config restore points:')) ?? '';
    expect(bullet.length, 'llms.txt 里那条 - Config restore points: 不见了').toBeGreaterThan(0);
    expect(bullet).not.toContain('先');
    expect(bullet).not.toMatch(/\b(before|first)\b/i);
    expect(bullet).toContain('记成恢复点');
    expect(bullet).toMatch(/recorded as a restore point/i);
    // 「什么都没删掉的批量删除不落恢复点」（storage.ts 的 `remaining.length !== previous.length`），
    // 这句限定是 `llms-full.txt` 一直写对、而 `llms.txt` 本轮才补上的那一格
    expect(bullet).toContain('真正删掉了东西');
    expect(bullet).toMatch(/that actually removed something/i);
  });
});

function validEntry(id: string): ConfigHistoryEntry {
  return {
    id,
    savedAt: 2,
    reason: 'replace-import',
    ruleCount: 1,
    config: { enabled: true, rules: [makeRule('r1')] },
  };
}

function historySize(entry: ConfigHistoryEntry): number {
  return JSON.stringify(entry).length;
}
