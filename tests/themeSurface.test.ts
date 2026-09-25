/**
 * 主题模块对外的两张脸：调用方读到的值，以及界面与令牌层据以渲染的名字
 *
 * `tests/themeMirror.test.ts` 守的是镜像那半（首帧不闪色）。这里补探针实测过「改了不会红」的另外两半：
 *
 * 1. `getStoredTheme` / `getStoredThemeMode` 是配置页挂载时读的那一份（`components/options/App.vue` 的
 *    `onMounted` 拿它填选中项，并把显示模式直接交给 `applyThemeMode`）。它们对调用方承诺「永不抛、
 *    非法值回落默认」——与镜像那条「读不到 ≠ 存的就是默认值」的区分**刻意相反**：那区分是给镜像用的
 *    （读不到就不许回写），调用方只想要一个画得出来的值。它若 reject，`onMounted` 从那一行起整段不
 *    执行，后面的 DNR/SW 采样一并丢掉。
 * 2. 主题名与图标名同时住在 JS 和 CSS/Vue 两侧，改一边是静默的：主题名对不上时色板**照样点得中**，
 *    只是根元素挂上一个没有样式匹配的属性值，画出来仍是 `:root` 那套默认配色；`<component :is="opt.icon">`
 *    的图标名对不上注册表时解析出一个空白，控制台都不响。这两处都落在「Vue 组件的渲染与交互本环境测不到」
 *    那条限制里，只能用源码契约钉。
 *
 * 落证在 `.test-tmp/probe-r18.py` / `probe-r18b.py`（盲测哪些格无主）与 `.test-tmp/mutate-r18.py`
 * （最终表，均不入库）：本文件之前，把两个 `getStored*` 的兜底默认值换成别的（green / light）、
 * 把 `THEME_OPTIONS` 删掉一项、把主题名 slate 改成令牌层里没有的名字、把图标 Sunny 改成未注册的
 * DaySunny —— 这五处（都在 JS 那一侧）改写全仓都不红。令牌层那一侧的方向探针够不着，由最终表的
 * M16 单独钉。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_THEME,
  THEME_MODE_OPTIONS,
  THEME_NAMES,
  THEME_OPTIONS,
  getStoredTheme,
  getStoredThemeMode,
} from '@/utils/theme';
import { DEFAULT_THEME_MODE } from '@/utils/constants';

/** storage.local 里躺着的数据 */
let store: Record<string, unknown>;
/** 可注入的 IPC 失败 */
let failGet = false;

beforeEach(() => {
  store = {};
  failGet = false;
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          if (failGet) throw new Error('IPC unavailable');
          return { [key]: store[key] };
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getStoredTheme / getStoredThemeMode — 配置页拿来填选中项的那一份', () => {
  it('存储里是合法值时原样返回', async () => {
    store.theme = 'slate';
    store.theme_mode = 'dark';

    expect(await getStoredTheme()).toBe('slate');
    expect(await getStoredThemeMode()).toBe('dark');
  });

  it('存储里是脏值时回落默认，不把界面选不中的配色交给调用方', async () => {
    store.theme = 'bogus';
    store.theme_mode = 'bogus';

    expect(await getStoredTheme()).toBe(DEFAULT_THEME);
    expect(await getStoredThemeMode()).toBe(DEFAULT_THEME_MODE);
  });

  it('读不到时返回默认值而不是 reject：调用点没有 try/catch', async () => {
    failGet = true;

    await expect(getStoredTheme()).resolves.toBe(DEFAULT_THEME);
    await expect(getStoredThemeMode()).resolves.toBe(DEFAULT_THEME_MODE);
  });
});

describe('主题名与令牌层对账（源码契约）', () => {
  /** 注释里也会写选择器与主题名，剥掉再判，否则守卫会被自己的说明文字咬到 */
  const css = readFileSync('assets/theme/tokens.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const themeSrc = readFileSync('utils/theme.ts', 'utf-8');

  it('除默认主题外，每个主题名在令牌层都有自己的覆盖块（反向也一样：不得有指向不存在主题名的块）', () => {
    const blocks = new Set([...css.matchAll(/\[data-theme='([a-z]+)'\]/g)].map(m => m[1]));
    // 数量级守卫：两边同时被清空时集合相等会假通过
    expect(blocks.size).toBeGreaterThanOrEqual(5);
    // 默认主题住在 `:root` 基座里，本来就不该有 `[data-theme='sky']`——别把它当漏项补上。
    // 这一句双向钉住：JS 改名而令牌层没跟（配色选不中）、令牌层改名而 JS 没跟（整块死 CSS）。
    expect([...blocks].sort()).toEqual(THEME_NAMES.filter(name => name !== DEFAULT_THEME).sort());
  });

  it('JS 写到根元素上的属性名，就是令牌层在读的那两个', () => {
    // 两个方向各有各的主人：JS 侧换属性名（`dataset.theme` → `dataset.color`）红的不是这一句，而是
    // `tests/themeMirror.test.ts` 里「有镜像时不等 IPC 就定好配色」那条；这一句独占的是令牌层侧——
    // 它读用一个 JS 从不写的属性名时，只有这里红（变异 M16）。
    const written = [
      ...new Set(
        [...themeSrc.matchAll(/root\.dataset\.([A-Za-z]+)\s*=/g)].map(
          m => `data-${m[1].replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`,
        ),
      ),
    ].sort();
    const read = [...new Set([...css.matchAll(/\[data-([a-z-]+)/g)].map(m => `data-${m[1]}`))].sort();
    expect(written.length).toBeGreaterThanOrEqual(2);
    expect(written).toEqual(read);
  });

  it('THEME_OPTIONS 与 THEME_NAMES 同序同集：少一项是选不到的配色，多一项是读不回的偏好', () => {
    expect(THEME_OPTIONS.length).toBeGreaterThanOrEqual(5);
    expect(THEME_OPTIONS.map(opt => opt.name)).toEqual([...THEME_NAMES]);
  });
});

describe('显示模式图标与 SettingsDialog 的注册表对账（源码契约）', () => {
  const dialogSrc = readFileSync('components/options/SettingsDialog.vue', 'utf-8');

  it('图标确实是按名字动态解析的（这一步不成立时下面那条契约就是空话）', () => {
    expect(dialogSrc).toContain('<component :is="opt.icon"');
  });

  it('每个图标名都在弹窗里注册过：没注册就解析出一个空白图标，且没有任何报错', () => {
    // 已知边界：这里取的是第一处 `components: { ... }` 并按逗号切标识符。改成全局注册、或写成
    // `{ Sunny: Sunny }` 这种键值形式，这条都会**响亮地红**而不是静默漏判——红回来改这条即可。
    const registry = /\n\s*components:\s*\{([^}]*)\}/.exec(dialogSrc);
    expect(registry, '找不到 SettingsDialog.vue 的 components 注册表，这条契约的前提已变').toBeDefined();
    const registered = new Set(
      registry![1]
        .split(',')
        .map(name => name.trim())
        .filter(Boolean),
    );
    expect(registered.size).toBeGreaterThanOrEqual(3);
    const missing = THEME_MODE_OPTIONS.map(opt => opt.icon).filter(icon => !registered.has(icon));
    expect(missing).toEqual([]);
  });
});
