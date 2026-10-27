/**
 * 首装欢迎卡：可见性判据、关闭标记的读写、以及装配层的源码契约
 *
 * 这张卡只在「全新安装 → 配置页空态」这一小段路上出现，界面的渲染与交互在本环境没有运行时
 * 对应物（node 环境无 DOM），所以这里分三层测：① 纯判据按真值表逐格断言；② 关闭标记走真
 * `utils/storage.ts` 与假 `chrome.storage`；③ 装配层（App.vue / background.ts）与卡片本身按
 * 源码契约钉住「判据留在使用方、组件不读 chrome、安装分支才开页」。
 *
 * 桩必须让 `get` 返回副本（真实 Chrome 给的是反序列化副本），否则「读到的是不是同一份对象」
 * 这类错误在这一层永远看不见。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { STORAGE_KEYS } from '@/utils/constants';
import { shouldShowWelcome } from '@/utils/welcome';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

let store: Record<string, unknown> = {};

const getSpy = vi.fn(async (keys?: string | string[] | null): Promise<Record<string, unknown>> => {
  const names = keys === undefined || keys === null ? Object.keys(store) : typeof keys === 'string' ? [keys] : keys;
  const result: Record<string, unknown> = {};
  for (const name of names) {
    if (name in store) result[name] = clone(store[name]);
  }
  return result;
});

const setSpy = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
  for (const [key, value] of Object.entries(items)) store[key] = clone(value);
});

vi.stubGlobal('chrome', {
  runtime: { id: 'test-extension' },
  storage: {
    local: { get: getSpy, set: setSpy },
    onChanged: { addListener: vi.fn() },
  },
});

const { getWelcomeDismissed, dismissWelcome } = await import('@/utils/storage');

beforeEach(() => {
  store = {};
  getSpy.mockClear();
  setSpy.mockClear();
});

describe('shouldShowWelcome：三态与三条前置条件', () => {
  it('首屏那次配置读取还没落定时不画', () => {
    expect(shouldShowWelcome({ everRead: false, rulesCount: 0, dismissed: false })).toBe(false);
  });

  it('已经有一条规则时不画', () => {
    expect(shouldShowWelcome({ everRead: true, rulesCount: 1, dismissed: false })).toBe(false);
  });

  it('关过之后不画', () => {
    expect(shouldShowWelcome({ everRead: true, rulesCount: 0, dismissed: true })).toBe(false);
  });

  it('这一次还没读到关闭标记时不画（老用户不该先看到再被抹掉）', () => {
    expect(shouldShowWelcome({ everRead: true, rulesCount: 0, dismissed: null })).toBe(false);
  });

  it('读到过配置、零规则、没关过 —— 只有这一格画', () => {
    expect(shouldShowWelcome({ everRead: true, rulesCount: 0, dismissed: false })).toBe(true);
  });
});

describe('welcome_dismissed：读到什么算什么', () => {
  it('缺失时当没关过', async () => {
    await expect(getWelcomeDismissed()).resolves.toBe(false);
  });

  it('只有布尔 true 才算关过', async () => {
    store[STORAGE_KEYS.WELCOME_DISMISSED] = true;
    await expect(getWelcomeDismissed()).resolves.toBe(true);
  });

  it('手改成字符串「true」不算（不把存储原文当布尔读）', async () => {
    store[STORAGE_KEYS.WELCOME_DISMISSED] = 'true';
    await expect(getWelcomeDismissed()).resolves.toBe(false);
  });

  it('读失败当没关过：宁可再提示一次，也不静默永久隐藏', async () => {
    getSpy.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(getWelcomeDismissed()).resolves.toBe(false);
  });

  it('dismissWelcome 写的就是 welcome_dismissed = true', async () => {
    await dismissWelcome();
    expect(setSpy).toHaveBeenCalledWith({ [STORAGE_KEYS.WELCOME_DISMISSED]: true });
    expect(store[STORAGE_KEYS.WELCOME_DISMISSED]).toBe(true);
  });
});

describe('装配层源码契约', () => {
  it('App.vue 用唯一判据算可见性，并接上四个事件', () => {
    const app = read('components/options/App.vue');
    expect(app).toContain('shouldShowWelcome({');
    expect(app).toContain('dismissed: welcomeDismissed.value');
    expect(app).toContain('<WelcomeCard');
    expect(app).toContain('v-if="welcomeVisible"');
    expect(app).toContain('welcomeDismissed.value = await getWelcomeDismissed()');

    for (const binding of [
      '@add-rule="handleAddRule"',
      '@open-settings="showSettings = true"',
      '@enable-proxy="handleToggleProxy(true)"',
      '@dismiss="handleDismissWelcome"',
    ]) {
      expect(app, `WelcomeCard 少了 ${binding}`).toContain(binding);
    }

    expect(app, '关闭动作必须落盘').toContain('void dismissWelcome()');
  });

  it('欢迎卡自己不读 chrome，也不自己判可见性', () => {
    const card = read('components/options/WelcomeCard.vue');
    // 注释里会提到 `chrome.*`，所以判的是真实的 API 调用，不是字面量 "chrome."
    expect(card).not.toMatch(/chrome\.(storage|runtime|tabs)/);
    // 注释里也会提到这个判据名，所以判的是「有没有 import 进来」
    expect(card).not.toMatch(/import\s*\{[^}]*shouldShowWelcome/);
    // 关闭热区下限：24×24（与 config-sync-reload 同一条地线）
    expect(card).toContain('width: 24px;');
    expect(card).toContain('height: 24px;');
  });

  it('组件里每个欢迎文案键都在中英两份字典里', () => {
    const card = read('components/options/WelcomeCard.vue');
    const used = [...card.matchAll(/t\('(welcome[^']+)'\)/g)].map(match => match[1]);
    expect(used.length, '欢迎卡应至少引用一个 welcome* 文案键').toBeGreaterThan(0);

    for (const locale of ['zh_CN', 'en']) {
      const dict = JSON.parse(read(`locales/${locale}/options.json`)) as Record<string, string>;
      for (const key of used) {
        expect(dict[key], `${locale}/options.json 缺少 ${key}`).toBeTruthy();
      }
    }
  });

  it('只有 install 分支会打开配置页，update 不打扰', () => {
    const background = read('entrypoints/background.ts');
    const installStart = background.indexOf("details.reason === 'install'");
    const updateStart = background.indexOf("details.reason === 'update'");
    expect(installStart, '找不到 install 分支').toBeGreaterThan(-1);
    expect(updateStart, '找不到 update 分支').toBeGreaterThan(installStart);

    const installBlock = background.slice(installStart, updateStart);
    expect(installBlock).toContain("chrome.runtime.getURL('/options.html')");
    expect(installBlock).toContain('chrome.tabs.create');
    expect(
      (background.match(/chrome\.tabs\.create/g) ?? []).length,
      '全文件只允许一处 tabs.create，且在 install 分支里',
    ).toBe(1);
  });
});
