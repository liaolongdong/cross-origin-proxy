/**
 * 语言 localStorage 镜像
 *
 * 与 `utils/theme.ts` 那两份镜像同构：`chrome.storage.local` 只能异步读，扩展页在 IPC
 * 回来之前已经按推断出的语言画完首帧，切过语言的用户每次打开 popup/options 都会看到一次
 * 换语言。`utils/i18n` 因此把偏好镜像到 `localStorage`，模块加载时同步取用，存储仍是事实来源。
 *
 * 这里要守住的四件事：
 * - **不排在 IPC 之后**：首帧那次取值必须来自镜像，且取值时**一笔存储读取都没发起**——
 *   改成异步生效就等于没加（首帧仍按推断值画，之后闪一下）。
 * - **以存储为准**：镜像只是缓存，其它扩展页改过设置后本页要跟齐；别的键变了不许动它。
 * - **镜像不得领先于存储**：落盘失败时提前写镜像，下次进来会先闪一下用户没选定的语言，
 *   再被异步校正回去——那正是镜像要消掉的那个闪色，只是换了方向。
 * - **镜像自身坏了不伤功能**：读不到镜像只是少一次首帧加速，写不进镜像不能让已经落盘的保存翻成失败。
 *
 * 探针（`.test-tmp/probe-r17b.py`，不入库）实测过本文件之前那五格全仓不红：摘掉首帧读镜像、
 * 摘掉挂载后的校正整块、摘掉 onChanged 监听、把镜像写入挪到落盘之后、校正后不回写镜像。
 * 另有半格是**环境**在守而非断言在守：摘掉 `detectDefaultLocale` 的 try/catch 会让
 * `tests/i18n.test.ts` 整文件收集失败（那支文件没有 `chrome` 全局），所以本文件把这条退回
 * 中文的判据也断言一次，让它的归属人变成断言本身。
 *
 * 落证在 `.test-tmp/mutate-r17.py`（不入库）：14 条变异里 13 条必须红，唯一例外是摘掉
 * `stored !== currentLocale.value` 那个**等价改写**（把同一个值再写一遍不可观察），它必须活——
 * 它红了就说明断言钉的是写法而不是落点。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** localStorage 替身（node 环境没有） */
let mirror: Map<string, string>;
/** storage.local 里躺着的数据 */
let store: Record<string, unknown>;
/** 浏览器 UI 语言，`detectDefaultLocale()` 据此推断首帧 */
let uiLanguage = 'zh-CN';
/** 是否提供 `chrome.i18n`（不提供即模拟 SW/异常上下文里读不到 UI 语言） */
let provideI18n = true;
let changeHandlers: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void>;
/** 两笔 IPC 各自可注入失败：`get` 模拟页面初始化时读不到，`set` 模拟保存时落盘失败 */
let failGet = false;
let failSet = false;
/** `localStorage` 自身也可能读/写都抛（隐私模式、被站点策略禁用）；两个方向各自可注入 */
let mirrorReadThrows = false;
let mirrorWriteThrows = false;
/** 到目前为止发起过几笔 `storage.local.get` —— 首帧取值必须排在任何一笔之前完成 */
let getCalls = 0;

function stubChrome(): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => {
      if (mirrorReadThrows) throw new Error('SecurityError');
      return mirror.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (mirrorWriteThrows) throw new Error('QuotaExceededError');
      mirror.set(key, value);
    },
  });
  const storage = {
    local: {
      get: vi.fn(async (key: string) => {
        getCalls += 1;
        if (failGet) throw new Error('IPC unavailable');
        return { [key]: store[key] };
      }),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        if (failSet) throw new Error('QUOTA_EXCEEDED');
        Object.assign(store, obj);
      }),
    },
    onChanged: { addListener: vi.fn(handler => changeHandlers.push(handler)) },
  };
  vi.stubGlobal('chrome', provideI18n ? { storage, i18n: { getUILanguage: () => uiLanguage } } : { storage });
}

/** 重新求值模块：`currentLocale` 的初值在模块加载那一刻算好，只能靠重导入观察 */
async function loadI18n(): Promise<typeof import('@/utils/i18n')> {
  vi.resetModules();
  return await import('@/utils/i18n');
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  mirror = new Map();
  store = {};
  changeHandlers = [];
  uiLanguage = 'zh-CN';
  provideI18n = true;
  failGet = false;
  failSet = false;
  mirrorReadThrows = false;
  mirrorWriteThrows = false;
  getCalls = 0;
  stubChrome();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('首帧 — 镜像同步定语言', () => {
  it('有镜像时模块加载那一刻就定好语言，且此刻一笔存储读取都没发起', async () => {
    mirror.set('cop_locale', 'en');
    store.locale = 'zh_CN';
    uiLanguage = 'zh-CN';

    const i18n = await loadI18n();

    // 断言发生在任何一次存储回包之前：镜像没被读到就会落到推断值 zh_CN
    expect(i18n.currentLocale.value).toBe('en');
    expect(i18n.t('confirm')).toBe('OK');
    // 光看语言值钉不住「不等 IPC」：把取值挪进异步通道也可能在它落下之后才被读到。
    // 这一句钉的是路径——首帧取值走的是镜像，不是一笔 `get`（变异 M14 就照这条改）
    expect(getCalls).toBe(0);
  });

  it('无镜像时按浏览器 UI 语言推断：zh 前缀算中文，其余算英文', async () => {
    uiLanguage = 'zh-TW';
    expect((await loadI18n()).currentLocale.value).toBe('zh_CN');

    uiLanguage = 'en-US';
    expect((await loadI18n()).currentLocale.value).toBe('en');
  });

  it('镜像里躺着读不懂的值时不当真：宁可退回推断，再等存储校正', async () => {
    mirror.set('cop_locale', 'fr');
    store.locale = 'en';
    uiLanguage = 'zh-CN';

    const i18n = await loadI18n();
    // 首帧：'fr' 不是本扩展支持的语言，按 UI 语言推断
    expect(i18n.currentLocale.value).toBe('zh_CN');

    i18n.initLocaleSync();
    await flush();
    // 存储回包后落到真实偏好，并把这个值回填进镜像
    expect(i18n.currentLocale.value).toBe('en');
    expect(mirror.get('cop_locale')).toBe('en');
  });

  it('连 chrome.i18n 都读不到时退回中文，而不是让模块求值当场抛', async () => {
    // `provideI18n` 是在装配桩对象那一刻被读走的，所以翻完旗标必须重新装配一次；
    // 只改旗标不重装配，`chrome.i18n` 还在，这一格就成了空转（变异 M3 实测过它当时不红）
    provideI18n = false;
    stubChrome();

    const i18n = await loadI18n();

    expect(i18n.currentLocale.value).toBe('zh_CN');
  });
});

describe('initLocaleSync — 仍以存储为准', () => {
  it('异步校正以存储为准，并回写镜像', async () => {
    mirror.set('cop_locale', 'en');
    store.locale = 'zh_CN';

    const i18n = await loadI18n();
    i18n.initLocaleSync();
    await flush();

    expect(i18n.currentLocale.value).toBe('zh_CN');
    expect(mirror.get('cop_locale')).toBe('zh_CN');
  });

  it('存储里没有偏好时不动首帧，也不把推断结果写进镜像（现状记录）', async () => {
    uiLanguage = 'en-US';

    const i18n = await loadI18n();
    i18n.initLocaleSync();
    await flush();

    expect(i18n.currentLocale.value).toBe('en');
    expect(mirror.has('cop_locale')).toBe(false);
  });

  it('其它扩展页改过设置时，本页同时更新语言与镜像', async () => {
    const i18n = await loadI18n();
    i18n.initLocaleSync();
    const onStorageChanged = changeHandlers.at(-1)!;

    onStorageChanged({ locale: { newValue: 'en' } }, 'local');

    expect(i18n.currentLocale.value).toBe('en');
    expect(mirror.get('cop_locale')).toBe('en');
  });

  it('非 local 区与非法语言值一概不动：镜像不能被一个读不懂的值钉住', async () => {
    mirror.set('cop_locale', 'zh_CN');

    const i18n = await loadI18n();
    i18n.initLocaleSync();
    const onStorageChanged = changeHandlers.at(-1)!;

    // 两次调用各测一道闸门：摘掉 `isLocaleName` 红在第一句后，摘掉 areaName 判据红在第二句后
    onStorageChanged({ locale: { newValue: 'fr' } }, 'local');
    expect(i18n.currentLocale.value).toBe('zh_CN');

    onStorageChanged({ locale: { newValue: 'en' } }, 'session');
    expect(i18n.currentLocale.value).toBe('zh_CN');
    expect(mirror.get('cop_locale')).toBe('zh_CN');
  });

  it('变更事件里没有 `locale` 这个键时原样退出：既不动语言，也不在监听器里抛', async () => {
    mirror.set('cop_locale', 'zh_CN');

    const i18n = await loadI18n();
    i18n.initLocaleSync();
    const onStorageChanged = changeHandlers.at(-1)!;

    // 摘掉那句 `if (!change) return` 不会改变任何可观察的**值**，它改变的是：真机上每笔
    // 与语言无关的存储变更（改规则、写日志）都会在这个监听器里抛 TypeError
    expect(() => onStorageChanged({ proxy_config: { newValue: {} } }, 'local')).not.toThrow();
    expect(i18n.currentLocale.value).toBe('zh_CN');
    expect(mirror.get('cop_locale')).toBe('zh_CN');
  });
});

describe('存储读取失败 — 不改渲染，也不把读不到的那一笔当成「偏好已改」', () => {
  it('一次 IPC 抖动不能把首帧语言永久钉成另一个值，也不能留下没人接手的拒绝', async () => {
    mirror.set('cop_locale', 'en');
    store.locale = 'zh_CN';
    failGet = true;

    // 那句 `.then()` 若不接 `.catch()`，这笔拒绝会一路飘到宿主：真浏览器里是控制台上一条
    // Uncaught (in promise)，这里是 vitest 的 Unhandled Errors。断言它，而不是依赖报告器。
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    const i18n = await loadI18n();
    i18n.initLocaleSync();
    await flush();

    try {
      expect(i18n.currentLocale.value).toBe('en');
      expect(mirror.get('cop_locale')).toBe('en');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

describe('语言写入路径同步刷新镜像', () => {
  it('保存语言后立即写入镜像，不必等本次变更事件绕回来', async () => {
    const i18n = await loadI18n();

    await i18n.setLocale('en');

    expect(mirror.get('cop_locale')).toBe('en');
    expect(store.locale).toBe('en');
  });

  it('落盘失败时不写镜像：镜像不能声称一个没存进 storage 的偏好', async () => {
    const i18n = await loadI18n();
    await i18n.setLocale('en');
    mirror.delete('cop_locale');
    failSet = true;

    await expect(i18n.setLocale('zh_CN')).rejects.toThrow('QUOTA_EXCEEDED');

    expect(mirror.has('cop_locale')).toBe(false);
  });

  it('落盘失败时本页语言仍然即时切换，不回滚（现状记录）', async () => {
    const i18n = await loadI18n();
    failSet = true;

    await expect(i18n.setLocale('en')).rejects.toThrow('QUOTA_EXCEEDED');

    expect(i18n.currentLocale.value).toBe('en');
  });
});

/**
 * 镜像自身不可用 —— 它只是缓存，两处 `try/catch` 都不许成为功能的一部分。
 *
 * 刻意**不**断 `typeof localStorage === 'undefined'` 那两道守卫：background SW 没有 `localStorage`，
 * 而这里的桩永远存在，摘掉守卫也照样被同文件的 `try/catch` 接住（可观察结果不变）。那两个 `typeof`
 * 与 `try/catch` 是同一件事的两道写法，测不出区别，写断言只会钉住拼写。
 */
describe('localStorage 不可用 — 镜像读不到写不进都不伤功能', () => {
  it('读镜像抛错时首帧仍按 UI 语言推断，而不是让模块求值当场失败', async () => {
    mirrorReadThrows = true;
    store.locale = 'en';

    const i18n = await loadI18n();
    expect(i18n.currentLocale.value).toBe('zh_CN');

    // 读不到镜像不等于读不到存储：校正与回填仍然照常
    i18n.initLocaleSync();
    await flush();
    expect(i18n.currentLocale.value).toBe('en');
  });

  it('写镜像抛错时不牵连已经落盘成功的保存', async () => {
    mirrorWriteThrows = true;
    const i18n = await loadI18n();

    await i18n.setLocale('en');

    expect(store.locale).toBe('en');
    expect(i18n.currentLocale.value).toBe('en');
  });
});
