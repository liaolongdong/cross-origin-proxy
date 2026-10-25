/**
 * 商店评分入口：判据 + 形态约束
 *
 * 这一格的**形态**就是它全部的合规风险，所以除了 URL 那两条纯判据，这里还按源码钉住几件
 * 看起来无关、实际决定它是「一行设置」还是「一次骚扰」的事：它挂在设置弹窗里（不是自动出现的
 * 模态）、点了只开一个标签页（不写存储、不发消息、不读数）、并且**只在商店装的构建上出现**——
 * 解包加载那条链接必然 404，画一个坏按钮比不画更糟。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isStoreInstalled, storeDetailUrl, storeReviewUrl } from '@/utils/storePage';

const settings = readFileSync('components/options/SettingsDialog.vue', 'utf8');

describe('storeDetailUrl — 条目页地址', () => {
  it('形状是 detail/<id>：不带 slug，也不带 /reviews', () => {
    const url = new URL(storeDetailUrl('abc'));
    expect(url.host).toBe('chromewebstore.google.com');
    expect(url.pathname).toBe('/detail/abc');
  });

  it('评分页是它加一段 /reviews（同一份基址，两条链接不会各自漂）', () => {
    expect(storeReviewUrl('abc')).toBe(`${storeDetailUrl('abc')}/reviews`);
  });
});

describe('storeReviewUrl — 条目 ID 现拼，不写 slug', () => {
  it('形状是 detail/<id>/reviews，域名是 chromewebstore', () => {
    expect(storeReviewUrl('abcdefghijklmnopabcdefghijklmnop')).toBe(
      'https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop/reviews',
    );
  });

  it('不带 slug：路径恰好是 /detail/<id>/reviews（商店名是可变文案，写死 slug 就是给下一次改名埋一条坏链）', () => {
    const url = new URL(storeReviewUrl('abc'));
    expect(url.host).toBe('chromewebstore.google.com');
    expect(url.pathname).toBe('/detail/abc/reviews');
  });
});

describe('isStoreInstalled — 认的是 Google 那台 CRX 更新服务器，不是「字段非空」', () => {
  it('商店装的那几种 Google 主机名判真', () => {
    expect(isStoreInstalled('https://clients2.google.com/service/update2/crx')).toBe(true);
    expect(isStoreInstalled('https://clients2.googleusercontent.com/service/update2/crx')).toBe(true);
    expect(isStoreInstalled('https://clients2.googleapis.com/service/update2/crx')).toBe(true);
    expect(isStoreInstalled(' https://clients2.google.com/service/update2/crx/')).toBe(true);
  });

  it('同一台主机上的别的路径判假（认的是那一条更新通道，不是「Google 的东西」）', () => {
    expect(isStoreInstalled('https://clients2.google.com/update2/request')).toBe(false);
    expect(isStoreInstalled('https://www.googleapis.com/chromewebstore/v1.1/items/x')).toBe(false);
  });

  it('别的分发渠道也写 update_url，但那套安装的 ID 属于另一个商店，那条链接必然 404', () => {
    expect(isStoreInstalled('https://edge.microsoft.com/extensionwebstorebase/v1/crx')).toBe(false);
    expect(isStoreInstalled('https://update.vendor.example/extension.xml')).toBe(false);
    expect(isStoreInstalled('https://clients2.google.com/other/path')).toBe(false);
  });

  it('解包加载（undefined）与空白值判假，形状不收窄到 string', () => {
    expect(isStoreInstalled(undefined)).toBe(false);
    expect(isStoreInstalled('')).toBe(false);
    expect(isStoreInstalled('   ')).toBe(false);
    expect(isStoreInstalled(42)).toBe(false);
    expect(isStoreInstalled(null)).toBe(false);
  });
});

describe('那一格的形态（改了就会撞政策的那两条线）', () => {
  it('读的是 manifest 的 update_url，不是硬编码真', () => {
    expect(settings).toContain('isStoreInstalled(chrome.runtime.getManifest().update_url)');
    expect(settings).toContain("storeReviewUrl(chrome.runtime.id) : ''");
  });

  it('整格挂在 v-if 上：非商店构建里它连 DOM 都不存在', () => {
    const at = settings.indexOf('v-if="reviewUrl"');
    expect(at, '那一格不再按 reviewUrl 收口了').toBeGreaterThan(-1);
    expect(settings.slice(at, at + 120)).toContain('class="setting-section"');
  });

  it('它是一节设置，不是弹窗：从这一格到 `</el-dialog>` 之间不许出现别的模态', () => {
    const start = settings.indexOf('v-if="reviewUrl"');
    // 窗口收在模板的末尾，不按固定长度切：切长了会一路滑进 `<script>`，
    // 那里本来就有 `ElMessageBox`（凭据变量删除的确认框），红了说的是量具而不是产品
    const block = settings.slice(start, settings.indexOf('</el-dialog>', start));
    expect(block.length, '没截到这一格的结尾（模板写法变了？判据已空转）').toBeGreaterThan(60);
    expect(block).not.toMatch(/<el-dialog|ElMessageBox|<el-drawer|el-notification/);
  });

  it('点下去只开一个标签页：不写 storage、不发 runtime 消息、不读数', () => {
    // 模板侧也得是「只叫这一个函数」：逻辑写进 `@click` 里就从函数体的射程里溜出去了
    expect(settings).toMatch(/@click="openReviewPage"/);
    const start = settings.indexOf('function openReviewPage');
    const fn = settings.slice(start, settings.indexOf('\n}', start) + 2);
    expect(fn.length, '没截到 openReviewPage 的函数体（写法变了？判据已空转）').toBeGreaterThan(40);
    expect(fn).toContain('chrome.tabs.create({ url: reviewUrl })');
    expect(fn).not.toMatch(/sendMessage|storage\.|localStorage/);
  });

  it('文案自己把「不自动弹出、没有奖励、不读使用数据」三件都说了', () => {
    for (const file of ['locales/zh_CN/options.json', 'locales/en/options.json']) {
      const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      expect(json.ratingTitle, `${file} 缺 ratingTitle`).toBeTruthy();
      expect(json.ratingAction, `${file} 缺 ratingAction`).toBeTruthy();
      const desc = json.ratingDesc.replace(/\s+/g, ' ');
      expect(desc.length, `${file} 的 ratingDesc 短到说不清这三件事`).toBeGreaterThan(60);
      expect(desc, `${file} 没说明它不会自动出现`).toMatch(/弹|pops up|appears on its own/i);
      expect(desc, `${file} 没说明没有奖励`).toMatch(/奖励|reward/i);
      expect(desc, `${file} 没说明不读使用数据`).toMatch(/使用数据|usage data/i);
    }
  });
});
