/**
 * 主题 localStorage 镜像
 *
 * `chrome.storage.local` 只能异步读，扩展页在 IPC 回来之前已经按默认配色画完首帧，
 * 切过主题的用户每次打开 popup/options 都会看到一次闪色。`utils/theme.ts` 因此照
 * `utils/i18n` 的做法加了一份 localStorage 镜像：挂载前同步应用，存储仍是事实来源。
 *
 * 这里要守住两件事：
 * - **同步**：镜像若改成异步生效就等于没加（首帧仍按默认配色画）。
 * - **镜像只是缓存**：读不懂的值不当真、落盘失败不提前写、读失败不回写——三条都指向
 *   「镜像不许领先于事实来源，也不许把脏值带上根元素」。语言侧的同构镜像见 `tests/localeMirror.test.ts`。
 *
 * 落证在 `.test-tmp/mutate-r18.py`（不入库，16 条变异）：这几格补上之前，摘掉首帧与变更事件处的合法性
 * 闸门、摘掉 `areaName !== 'local'` 那道区域判据、把「读不到」的兜底默认值改掉，全仓都不红。表里刻意
 * 保持 ALIVE 的三条都是等价改写：M9 摘掉首帧那道 `isThemeMode` 闸门（理由写在下面那一格注释里）、
 * M14 摘掉 `readMirror` 的 `typeof localStorage` 守卫（与它外面的 `try/catch` 是同一件事的两道写法）、
 * M15 把两份异步校正调换先后（两者各写各的属性，谁先谁后观察不到）。
 *
 * 另有三格**已有主人，本轮不再补**：把 `applyThemeToRoot` 换成别的属性名、把 `applyThemeMode` 的亮/暗
 * 两档写成同一个值、把 `system` 那档从删属性改成写 `'system'` —— 三者红的都是本文件既有的用例（不是新加
 * 的那三格）；把 `readStoredTheme` 的 `catch` 改成回默认值（抹掉「读不到 ≠ 存的就是默认值」）红的也是
 * 既有的「存储读取失败时不改渲染也不回写镜像」那条。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

/** 模拟扩展页里那个共享的 documentElement */
let root: { dataset: Record<string, string> };
/** localStorage 替身（node 环境没有） */
let mirror: Map<string, string>;
/** storage.local 里躺着的数据 */
let store: Record<string, unknown>;
let changeHandlers: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void>;

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  root = { dataset: {} };
  mirror = new Map();
  store = {};
  changeHandlers = [];
  vi.stubGlobal('document', { documentElement: root });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => mirror.get(key) ?? null,
    setItem: (key: string, value: string) => void mirror.set(key, value),
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        }),
      },
      onChanged: { addListener: vi.fn(handler => changeHandlers.push(handler)) },
    },
  });
});

const { initThemeSync, setStoredTheme, setStoredThemeMode, applyThemeMode } = await import('@/utils/theme');

describe('initThemeSync — 镜像同步生效', () => {
  it('有镜像时不等 IPC 就定好配色（这一条守住的是「同步」本身）', () => {
    mirror.set('cop_theme', 'mauve');
    mirror.set('cop_mode', 'dark');
    store.theme = 'green';
    store.theme_mode = 'light';

    initThemeSync();

    // 断言发生在任何 await 之前：此刻 storage 读取还没回来
    expect(root.dataset.theme).toBe('mauve');
    expect(root.dataset.mode).toBe('dark');
  });

  it('异步校正以存储为准，并回写镜像', async () => {
    mirror.set('cop_theme', 'mauve');
    store.theme = 'pink';
    store.theme_mode = 'dark';

    initThemeSync();
    await flush();

    expect(root.dataset.theme).toBe('pink');
    expect(mirror.get('cop_theme')).toBe('pink');
    expect(mirror.get('cop_mode')).toBe('dark');
  });

  it('无镜像时退回默认配色并把结果写进镜像', async () => {
    initThemeSync();
    await flush();

    expect(root.dataset.theme).toBe('sky');
    expect(mirror.get('cop_theme')).toBe('sky');
  });

  it('存储读取失败时不改渲染也不回写镜像：一次 IPC 抖动不能把首帧配色永久钉成默认值', async () => {
    mirror.set('cop_theme', 'mauve');
    mirror.set('cop_mode', 'dark');
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC unavailable'));

    initThemeSync();
    await flush();

    expect(root.dataset.theme).toBe('mauve');
    expect(root.dataset.mode).toBe('dark');
    expect(mirror.get('cop_theme')).toBe('mauve');
    expect(mirror.get('cop_mode')).toBe('dark');
  });

  it('其它扩展页改过设置时，本页同时更新渲染与镜像', () => {
    initThemeSync();
    const onStorageChanged = changeHandlers.at(-1)!;

    onStorageChanged({ theme: { newValue: 'orange' } }, 'local');
    onStorageChanged({ theme_mode: { newValue: 'light' } }, 'local');

    expect(root.dataset.theme).toBe('orange');
    expect(root.dataset.mode).toBe('light');
    expect(mirror.get('cop_theme')).toBe('orange');
    expect(mirror.get('cop_mode')).toBe('light');
  });
});

describe('主题写入路径同步刷新镜像', () => {
  it('保存主题后立即写入镜像，不必等本次变更事件绕回来', async () => {
    await setStoredTheme('green');
    expect(mirror.get('cop_theme')).toBe('green');

    await setStoredThemeMode('dark');
    expect(mirror.get('cop_mode')).toBe('dark');
  });

  it('落盘失败时不写镜像：镜像不能声称一个没存进 storage 的偏好', async () => {
    await setStoredTheme('green');
    await setStoredThemeMode('dark');
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('QUOTA'));

    await expect(setStoredTheme('mauve')).rejects.toThrow('QUOTA');
    await expect(setStoredThemeMode('light')).rejects.toThrow('QUOTA');
    expect(mirror.get('cop_theme')).toBe('green');
    expect(mirror.get('cop_mode')).toBe('dark');
  });
});

describe('system 模式', () => {
  it('镜像留着 "system" 时仍然只是删掉 data-mode，交回媒体查询', () => {
    root.dataset.mode = 'dark';
    applyThemeMode('system');
    expect('mode' in root.dataset).toBe(false);
  });
});

/**
 * 三个入口（首帧镜像、异步校正、变更事件）各自读一次主题与显示模式，读来的东西都可能是脏的：
 * 镜像是别的扩展页写的，存储可能被手改，`onChanged` 的 `newValue` 更是直接来自 storage 原文。
 * 令牌层只认那六个主题名与三种显示模式，落不到它们身上就是「根元素挂着一个没有任何样式的属性值」。
 */
describe('读不懂的值 — 三处入口都不当真', () => {
  it('首帧镜像里躺着非法值时根元素上不留脏值，等存储校正', async () => {
    mirror.set('cop_theme', 'bogus');
    mirror.set('cop_mode', 'bogus');
    store.theme = 'pink';
    store.theme_mode = 'dark';

    initThemeSync();

    // 断言发生在任何一次 storage 回包之前：把镜像当真就会立刻画出这两个非法值
    expect(root.dataset.theme).toBeUndefined();
    // 显示模式这一半钉不住 `isThemeMode` 那道闸门：未知值落进 `applyThemeMode` 的 else，
    // 与「不应用」给出同一个结果（删属性），变异 M9 实测 ALIVE。这里断的是**结果**——
    // 闸门与 else 分支是同一件事的两道写法，谁被摘掉都不改变任何可观察行为。
    expect('mode' in root.dataset).toBe(false);

    await flush();
    expect(root.dataset.theme).toBe('pink');
    expect(root.dataset.mode).toBe('dark');
  });

  it('变更事件里的非法值回落默认（是「重置」，不是「保持上一次」）', () => {
    mirror.set('cop_theme', 'mauve');
    mirror.set('cop_mode', 'dark');

    initThemeSync();
    const onStorageChanged = changeHandlers.at(-1)!;

    onStorageChanged({ theme: { newValue: 'bogus' }, theme_mode: { newValue: 'bogus' } }, 'local');

    // 这一格刻意不 `await flush()`：`store` 是空的，异步校正一回来就把首帧的 mauve/dark 盖成 sky/system，
    // 「回落默认」与「保持上一次」从此不可区分——留在同步这一侧，首帧那两个值才是承重的对照。
    expect(root.dataset.theme).toBe('sky');
    expect('mode' in root.dataset).toBe(false);
    expect(mirror.get('cop_theme')).toBe('sky');
    expect(mirror.get('cop_mode')).toBe('system');
  });

  it('非 local 区的同名键一概不动：别的存储区不是本模块的数据源', async () => {
    initThemeSync();
    await flush();
    const onStorageChanged = changeHandlers.at(-1)!;

    onStorageChanged({ theme: { newValue: 'orange' }, theme_mode: { newValue: 'dark' } }, 'session');

    expect(root.dataset.theme).toBe('sky');
    expect('mode' in root.dataset).toBe(false);
    expect(mirror.get('cop_theme')).toBe('sky');
  });
});

describe('[P3] 语言镜像与主题镜像同构', () => {
  it('两者都靠 localStorage 镜像消除首帧差异', () => {
    const i18nSrc = readFileSync('utils/i18n/index.ts', 'utf-8');
    const themeSrc = readFileSync('utils/theme.ts', 'utf-8');
    expect(i18nSrc).toContain('localStorage.getItem(LOCALE_MIRROR_KEY)');
    expect(themeSrc).toContain('readMirror(THEME_MIRROR_KEY)');
    expect(themeSrc).toContain('readMirror(THEME_MODE_MIRROR_KEY)');
  });
});
