/**
 * 主题 localStorage 镜像
 *
 * `chrome.storage.local` 只能异步读，扩展页在 IPC 回来之前已经按默认配色画完首帧，
 * 切过主题的用户每次打开 popup/options 都会看到一次闪色。`utils/theme.ts` 因此照
 * `utils/i18n` 的做法加了一份 localStorage 镜像：挂载前同步应用，存储仍是事实来源。
 *
 * 这里要守住的是「同步」这个前提——镜像若改成异步生效就等于没加。
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

describe('[P3] 语言镜像与主题镜像同构', () => {
  it('两者都靠 localStorage 镜像消除首帧差异', () => {
    const i18nSrc = readFileSync('utils/i18n/index.ts', 'utf-8');
    const themeSrc = readFileSync('utils/theme.ts', 'utf-8');
    expect(i18nSrc).toContain('localStorage.getItem(LOCALE_MIRROR_KEY)');
    expect(themeSrc).toContain('readMirror(THEME_MIRROR_KEY)');
    expect(themeSrc).toContain('readMirror(THEME_MODE_MIRROR_KEY)');
  });
});
