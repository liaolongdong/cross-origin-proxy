/**
 * 存储门面自己记的两本内存账：互斥锁与配置／凭据缓存
 *
 * `utils/storage.ts` 是全仓唯一的 `chrome.storage.local` 出口，而它自己在内存里另记了两件事：
 * 一条把「读 → 改 → 写」串起来的 Promise 锁，和两份可复用对象（配置表、凭据变量表）。
 * 两本账都没有界面，坏了也不抛错，表现分别是：
 * - **锁失效**：两次并发写各自读到旧快照，后写的整份盖掉先写的。用户看到「加了两条规则、
 *   列表里只有一条」，而 `addRule` 两次都正常返回，日志里一个字都没有。
 * - **缓存不失效**：另一个上下文（options 页、popup）改完 storage，本上下文还拿旧对象判断与写回，
 *   于是把别人刚写的整份覆盖回去；SW 被回收后它又「自己好了」，是最难复现的一类。
 *
 * 用到本模块的测试文件有一把：5 支直接 `vi.mock` 换掉它（其中 `badgeManager` 经 `importOriginal`
 * 只替掉 `getProxyConfig`），其余虽走真实现，测的也只是自己那条业务（新增上限、导入模式、
 * 恢复点……），只有 `round2-regression` 碰过并发——那是日志刷写的串行队列。
 * 锁与这两份缓存本身，至今没有一条按运行时断言过。
 *
 * 桩必须按真实语义做：`get` 每次返回**深拷贝**（真实 Chrome 给的是反序列化副本）。这一条是承重的：
 * 少了它，两个并发读者天然共享同一个数组，「锁有没有生效」就成了自证——摘掉锁也照样绿。
 * `set` 存副本只是继续贴近序列化语义。
 *
 * 刻意不在这里测的：日志缓冲的刷写与配额收口（`round2-regression` 的并发刷写、`logQuota` 的
 * 失败回灌与总量预算）、恢复点的三份失败面（`configHistory`）、`importProxyConfig` 的两种模式
 * （`importConfig` / `importPlan`）、批量启停的落点与「只写一次」（`batchToggle`）、拖拽排序的
 * 顺序与「补到末尾」兜底（`reorderRules`）。
 * 本文件管锁、两份缓存，以及三个键在取值侧的形状收口。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProxyConfig, ProxyRule, RequestLogEntry } from '@/utils/types';
import { DEFAULT_PROXY_CONFIG, MAX_RULES, STORAGE_KEYS } from '@/utils/constants';

/** 真实 `chrome.storage` 的 onChanged 回调签名，这里只用到 `storage.ts` 会读的那两个字段 */
type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void;

/** 深拷贝，模拟「跨进程序列化」：读出的对象与存储里那份从此再无关系 */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

let store: Record<string, unknown> = {};
/** `storage.ts` 只在本文件被 import 那一次注册监听器，所以这份名单全程只增不换 */
const changeListeners: ChangeListener[] = [];
/** 读盘／写盘顺序的流水账，锁的串行性只看它 */
let opLog: string[];
/** 置为字符串时，下一次 `set` 抛该文案（配额/异常的替身） */
let failNextSet: string | false = false;

const getSpy = vi.fn(async (keys?: string | string[] | null): Promise<Record<string, unknown>> => {
  const names = keys === undefined || keys === null ? Object.keys(store) : typeof keys === 'string' ? [keys] : keys;
  const result: Record<string, unknown> = {};
  for (const name of names) {
    opLog.push(`get:${name}`);
    if (name in store) result[name] = clone(store[name]);
  }
  return result;
});

const setSpy = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
  if (failNextSet !== false) {
    const message = failNextSet;
    failNextSet = false;
    throw new Error(message);
  }
  for (const [key, value] of Object.entries(items)) {
    store[key] = clone(value);
    opLog.push(`set:${key}`);
  }
});

vi.stubGlobal('chrome', {
  runtime: { id: 'test-extension' },
  storage: {
    local: { get: getSpy, set: setSpy },
    onChanged: { addListener: vi.fn((listener: ChangeListener) => changeListeners.push(listener)) },
  },
});

const {
  addRule,
  batchAddRules,
  configRules,
  deleteRule,
  getProfiles,
  getProxyConfig,
  getRequestLogs,
  getVariables,
  invalidateConfigCache,
  saveProfile,
  saveProxyConfig,
  saveVariables,
  toggleProxy,
  toggleRule,
  updateRule,
} = await import('@/utils/storage');

function makeRule(id: string, overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: 'https://api.example.com/*',
    targetUrl: 'https://target.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** `updateRule` 收的是完整业务规则体（`id` 与两个时间戳由存储层自己处理） */
function makeRuleBody(overrides: Partial<ProxyRule> = {}): Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'> {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...body } = makeRule('unused', overrides);
  return body;
}

/** 直接把配置摆进「存储」，不经门面，以免写路径顺带把内存缓存换成我们要验的那份 */
function putConfig(config: ProxyConfig): void {
  store[STORAGE_KEYS.PROXY_CONFIG] = clone(config);
}

function storedRules(): string[] {
  const config = store[STORAGE_KEYS.PROXY_CONFIG] as ProxyConfig | undefined;
  return configRules(config).map(rule => rule.id);
}

/** 触发一次「另一个上下文改了 storage」 */
function fireChange(key: string, newValue: unknown, areaName = 'local'): void {
  for (const listener of changeListeners) listener({ [key]: { newValue } }, areaName);
}

beforeEach(() => {
  store = {};
  opLog = [];
  failNextSet = false;
  getSpy.mockClear();
  setSpy.mockClear();
  invalidateConfigCache();
  // `getProxyConfig()` 在键缺失时交出的是 `DEFAULT_PROXY_CONFIG` 那个常量本身，就地改会写脏它，
  // 而模块常量在这支文件的用例之间不会自动复位。这条守卫让「谁写脏了常量」当场红，
  // 而不是让后面那条「缺键回落」用例为一个已经被改过的默认值保持绿色。
  expect(DEFAULT_PROXY_CONFIG).toEqual({ enabled: false, rules: [] });
  // 凭据表没有公开的失效入口，唯一的复位路径就是它自己注册的那个监听器——
  // 与 `chrome.storage.local.clear()` 同理：本文件的用例不依赖清空能力，只依赖这一行确实把缓存置了空
  fireChange(STORAGE_KEYS.VARIABLES, {});
});

describe('互斥锁：并发读改写不丢更新', () => {
  it('两笔并发的 addRule 都留在存储里，后写的不盖掉先写的', async () => {
    putConfig({ enabled: true, rules: [makeRule('first')] });

    await Promise.all([addRule(makeRule('a')), addRule(makeRule('b'))]);

    expect(storedRules()).toEqual(['first', 'a', 'b']);
  });

  it('并发的是不同操作也一样串行：改总开关与改某条规则互不吃掉', async () => {
    putConfig({ enabled: true, rules: [makeRule('a'), makeRule('b')] });

    await Promise.all([toggleProxy(false), updateRule('a', makeRuleBody({ name: 'renamed', enabled: false }))]);

    const stored = store[STORAGE_KEYS.PROXY_CONFIG] as ProxyConfig;
    expect(stored.enabled).toBe(false);
    expect(configRules(stored).find(rule => rule.id === 'a')?.name).toBe('renamed');
  });

  it('两条规则各点各的开关：两个 toggleRule 的结果都留下', async () => {
    putConfig({ enabled: true, rules: [makeRule('a'), makeRule('b')] });

    const [first, second] = await Promise.all([toggleRule('a', false), toggleRule('b', false)]);

    expect([first.success, second.success]).toEqual([true, true]);
    const stored = store[STORAGE_KEYS.PROXY_CONFIG] as ProxyConfig;
    expect(configRules(stored).map(rule => [rule.id, rule.enabled])).toEqual([
      ['a', false],
      ['b', false],
    ]);
  });

  it('并发删除与新增不互相复活：被删掉的那条不会随旧快照写回', async () => {
    putConfig({ enabled: true, rules: [makeRule('a'), makeRule('b')] });

    await Promise.all([deleteRule('a'), addRule(makeRule('c'))]);

    expect(storedRules()).toEqual(['b', 'c']);
  });

  it('串行体现在读盘顺序上：第二笔的 get 发生在第一笔的 set 之后', async () => {
    putConfig({ enabled: true, rules: [] });

    await Promise.all([batchAddRules([makeRule('a')]), batchAddRules([makeRule('b')])]);

    const configKey = STORAGE_KEYS.PROXY_CONFIG;
    const writes = opLog.map((entry, index) => ({ entry, index })).filter(item => item.entry === `set:${configKey}`);
    const reads = opLog.map((entry, index) => ({ entry, index })).filter(item => item.entry === `get:${configKey}`);
    expect(writes).toHaveLength(2);
    expect(reads).toHaveLength(2);
    // 第一笔落盘必须早于第二笔取快照，否则两笔读到的是同一份旧配置
    expect(reads[1].index).toBeGreaterThan(writes[0].index);
  });

  it('写入被拒时错误原样抛给调用方', async () => {
    putConfig({ enabled: true, rules: [] });
    failNextSet = 'QUOTA_BYTES quota exceeded';

    await expect(addRule(makeRule('a'))).rejects.toThrow('QUOTA_BYTES quota exceeded');
  });

  it('一笔失败不影响下一笔：队列照常写入', async () => {
    // `withStorageLock` 里那两处吞拒绝的写法（`.then(fn, fn)` 与 `next.then((){},(){})`）
    // 互为备份：各摘一处都不改变任何可观察结果（变异清单 S2 摘前半、S18 摘后半，两条都不红），
    // 所以这里钉的是「一起拿掉」那一格。
    // 别把其中一处当冗余删掉——两处在同一轮里消失，失败之后的每一笔都不再执行、
    // 直接以第一次那个拒绝落定：队列没有挂起，但从这一刻起谁也写不进 storage。
    putConfig({ enabled: true, rules: [] });
    failNextSet = 'QUOTA_BYTES quota exceeded';
    await addRule(makeRule('boom')).catch(() => undefined);

    await addRule(makeRule('ok'));

    expect(storedRules()).toEqual(['ok']);
  });

  it('失败那一笔不把没落盘的配置留在缓存里：随后读到的与存储一致', async () => {
    putConfig({ enabled: true, rules: [makeRule('kept')] });
    failNextSet = 'IO error';
    await addRule(makeRule('lost')).catch(() => undefined);

    const config = await getProxyConfig();

    expect(configRules(config).map(rule => rule.id)).toEqual(['kept']);
  });

  it(`上限判定也在锁内：${MAX_RULES} 条时并发追加两条各自都拒`, async () => {
    putConfig({
      enabled: true,
      rules: Array.from({ length: MAX_RULES - 1 }, (_, index) => makeRule(`e${index}`)),
    });

    const settled = await Promise.allSettled([addRule(makeRule('x')), addRule(makeRule('y'))]);

    // 第一条补满上限成功，第二条才拒——两笔都读同一份「还差一条」的快照就是丢更新的老毛病
    expect(settled.map(p => p.status)).toEqual(['fulfilled', 'rejected']);
    expect(storedRules()).toHaveLength(MAX_RULES);
  });
});

describe('配置缓存：命中不读盘，跨上下文改动必须失效', () => {
  it('第二次读配置不再读盘', async () => {
    putConfig({ enabled: true, rules: [makeRule('a')] });
    await getProxyConfig();
    getSpy.mockClear();

    const config = await getProxyConfig();

    expect(getSpy).not.toHaveBeenCalled();
    expect(configRules(config).map(rule => rule.id)).toEqual(['a']);
  });

  it('命中缓存时交出的是同一个对象，不复制', async () => {
    // 先摆一份真实配置，免得这里验的其实是「回落到常量」那条路径（下面单有一条钉那个）
    putConfig({ enabled: true, rules: [makeRule('a')] });

    const first = await getProxyConfig();
    const second = await getProxyConfig();

    expect(second).toBe(first);
    // 顺手钉住「就地改之后写回的还是这一个对象」这条常用链能落盘。
    // 注意这条链本身并不依赖身份（`toggleProxy` / `addRule` 都是改完把同一个对象交给
    // `saveProxyConfig`，改成返回副本照样写对）；身份真正带来的后果是下面那条「缺键时写脏常量」，
    // 以及同一上下文里就地改对后续读者立刻可见。别把它当成「改成副本会丢更新」的理由。
    first.enabled = false;
    await saveProxyConfig(first);
    expect((store[STORAGE_KEYS.PROXY_CONFIG] as ProxyConfig).enabled).toBe(false);
  });

  it('另一个上下文改了配置就重新读盘，拿到的是它写的那份', async () => {
    putConfig({ enabled: true, rules: [makeRule('old')] });
    expect(configRules(await getProxyConfig()).map(rule => rule.id)).toEqual(['old']);

    putConfig({ enabled: false, rules: [makeRule('new')] });
    fireChange(STORAGE_KEYS.PROXY_CONFIG, store[STORAGE_KEYS.PROXY_CONFIG]);
    const config = await getProxyConfig();

    expect(config.enabled).toBe(false);
    expect(configRules(config).map(rule => rule.id)).toEqual(['new']);
  });

  it('非 local 区域的变动不碰配置缓存', async () => {
    putConfig({ enabled: true, rules: [makeRule('a')] });
    await getProxyConfig();
    getSpy.mockClear();

    // `chrome.storage.onChanged` 会报所有区域，本模块只认 local：
    // 判据必须排在读盘**之后**才看得见，所以这里读完再断言没读
    fireChange(STORAGE_KEYS.PROXY_CONFIG, { enabled: false, rules: [] }, 'session');
    await getProxyConfig();

    expect(getSpy).not.toHaveBeenCalled();
  });

  it('storage 里根本没有配置键时回落默认值，而不是把 undefined 交出去', async () => {
    const config = await getProxyConfig();

    expect(config).toBeDefined();
    expect(config.enabled).toBe(false);
    expect(configRules(config)).toEqual([]);
  });

  it('现状记录：回落的是 `DEFAULT_PROXY_CONFIG` 那个对象本身，而调用链会就地改它', async () => {
    // 这条不是「应该这样」，是把已经存在的口子钉住：`getProxyConfig()` 把模块常量当缓存交出去，
    // 而 `toggleProxy` / `addRule` 全是「读出 → 就地改 → 写回」，于是在同一上下文里
    // 常量本身会被写脏（键被删掉后的下一次读就看到上一次的残值；同一份常量还被
    // `background.ts` 的 install 分支原样写进 storage）。
    // 可达窗口很窄（首次安装、或 devtools 手删 `proxy_config` 键——与 AGENTS 里徽章那条同源），
    // 目前没有任何用户可见症状，所以留作待确认点而不是随手改行为。
    // 修掉它（回落时给一份新副本）会让这一条红——那时请连同待确认点一起更新，别只删断言。
    expect(await getProxyConfig()).toBe(DEFAULT_PROXY_CONFIG);
  });
});

describe('读写两侧对同一份坏数据的方向刻意相反', () => {
  it('取值侧当空、写入侧当错：非数组的 rules 不会被悄悄写成一份空规则集', async () => {
    store[STORAGE_KEYS.PROXY_CONFIG] = { enabled: true, rules: 'oops' };

    expect(configRules(store[STORAGE_KEYS.PROXY_CONFIG] as ProxyConfig)).toEqual([]);
    await expect(addRule(makeRule('a'))).rejects.toThrow();

    // 写入侧若跟着取值侧「当空」，下一次读到的就是 `rules: []`——用户已有的规则被抹掉
    expect(setSpy).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.PROXY_CONFIG]).toEqual({ enabled: true, rules: 'oops' });
  });
});

/**
 * 日志表与 profile 表：非数组当空
 *
 * 与上面那条 `rules` 的取值侧同一档收口（`getRequestLogs` / `getProfiles` 各自 `Array.isArray` 一次）。
 * 这两个键被手改或截断成字符串／对象时，症状都不在读取那一刻：`getRequestLogs` 的结果会被
 * flush 路径 `logs.unshift(...)`，抛进它自己的接手人之后变成「从此每一笔日志都落不了盘」；
 * `getProfiles` 的结果要过 `findIndex` / `filter`，三条写入路径抛出来的错误信封又和
 * 「profile 不存在」长得一样。所以这里断的是「读出的是空数组，不是那串字符」，
 * 而刷写与配额收口那一半仍在 `round2-regression` / `logQuota`。
 */
describe('日志表与 profile 表：非数组当空', () => {
  it('日志键是字符串 → 读出空表，不是长度为 4 的假日志', async () => {
    store[STORAGE_KEYS.REQUEST_LOGS] = 'oops';
    expect(await getRequestLogs()).toEqual([]);

    store[STORAGE_KEYS.REQUEST_LOGS] = { 0: { id: 'x' } };
    expect(await getRequestLogs()).toEqual([]);
  });

  it('日志键是数组时原样读出（判据不是无脑返回空表）', async () => {
    const entries = [{ id: 'l1', timestamp: 1 } as RequestLogEntry];
    store[STORAGE_KEYS.REQUEST_LOGS] = entries;
    expect(await getRequestLogs()).toEqual(entries);
  });

  it('profile 键是对象 → 读出空表，`v-for` 不会按字符画列表', async () => {
    store[STORAGE_KEYS.PROFILES] = { not: 'a-list' };
    expect(await getProfiles()).toEqual([]);
  });

  it('坏数据之上的第一次保存照样落盘成一份单条列表', async () => {
    store[STORAGE_KEYS.PROFILES] = 'oops';
    await saveProfile({ id: 'p1', name: 'env', rules: [], createdAt: 0 });

    expect(store[STORAGE_KEYS.PROFILES]).toEqual([{ id: 'p1', name: 'env', rules: [], createdAt: 0 }]);
    expect(await getProfiles()).toHaveLength(1);
  });
});

describe('凭据表缓存：与配置同一套失效判据', () => {
  it('命中缓存不读盘，写入成功后同一上下文立刻换上新表', async () => {
    store[STORAGE_KEYS.VARIABLES] = { TOKEN: 'old' };
    expect(await getVariables()).toEqual({ TOKEN: 'old' });

    await saveVariables({ TOKEN: 'new' });
    getSpy.mockClear();

    expect(await getVariables()).toEqual({ TOKEN: 'new' });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('另一个上下文改变量表时重新读盘', async () => {
    store[STORAGE_KEYS.VARIABLES] = { TOKEN: 'old' };
    await getVariables();

    store[STORAGE_KEYS.VARIABLES] = { OTHER: 'external' };
    fireChange(STORAGE_KEYS.VARIABLES, store[STORAGE_KEYS.VARIABLES]);

    expect(await getVariables()).toEqual({ OTHER: 'external' });
  });

  it('整表保存丢弃非法条目并如实回报条数', async () => {
    const result = await saveVariables({ TOKEN: 'ok', '1BAD': 'x', EMPTY: '   ' });

    expect(result).toEqual({ dropped: 2 });
    expect(store[STORAGE_KEYS.VARIABLES]).toEqual({ TOKEN: 'ok' });
  });

  it('非键值对象：不落盘、抛错，且不把上一次的表留在内存里', async () => {
    store[STORAGE_KEYS.VARIABLES] = { TOKEN: 'old' };
    expect(await getVariables()).toEqual({ TOKEN: 'old' });

    await expect(saveVariables(['TOKEN'])).rejects.toThrow('INVALID_VARIABLES_PAYLOAD');
    expect(setSpy).not.toHaveBeenCalled();

    store[STORAGE_KEYS.VARIABLES] = { TOKEN: 'from-storage' };
    expect(await getVariables()).toEqual({ TOKEN: 'from-storage' });
  });

  it('存储被改成非键值对象时按空表读，不让每次代理请求抛错', async () => {
    store[STORAGE_KEYS.VARIABLES] = 'not-a-table';

    expect(await getVariables()).toEqual({});
  });
});
