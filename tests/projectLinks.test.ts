/**
 * 项目外链的三面契约：URL 只有一份、三处落点共用一份清单、每一枚锚点带 target/rel
 *
 * 为什么要有这一支（形状对齐 account-password-helper 的 `repoUrlLiteralGuard` + `aboutEntryWiring`
 * 两支架构守卫，按本仓的落点重写）：
 *
 * 1. **字面量不外泄**。仓库名、Pages 路径基与商店条目地址一旦在界面里各写一遍，将来改名或换
 *    Pages 基时**只有其中一处会跟着改**，其余几处指向 404；而扩展界面里的 404 只有用户点下去
 *    才发现——没有报错、没有红灯，只是那一格从此不对。
 * 2. **三处落点读同一份清单**。配置页顶栏、偏好设置弹窗、弹窗底部各排一遍的话，
 *    「商店那一条按安装来源收起」就在三处各判一遍，漏进任何一处就是画一个必然 404 的链接。
 * 3. **`target` / `rel` 是行为不是装饰**。少写 `noopener`，被打开的页面拿到 `window.opener`
 *    就能反向操纵扩展那一页；这一类改动界面照常，只有新开标签页的动作不对。
 *
 * 清单本身（条数、次序、闸门、语言分叉）按**运行时**测；三处的渲染结果与点击后的新标签页
 * 在本环境没有对应物（node 无 DOM、未装 `@vue/test-utils`），所以 markup 侧按源码契约钉。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { currentLocale } from '@/utils/i18n';
import { useProjectLinks } from '@/composables/useProjectLinks';

/** 三处渲染项目链接的界面 */
const SURFACES = [
  'components/options/HeaderBar.vue',
  'components/options/SettingsDialog.vue',
  'entrypoints/popup/App.vue',
];
/** 唯一可以出现外链字面量的两份真源 */
const URL_SOURCES = ['utils/urls.ts', 'utils/storePage.ts'];
const SCAN_DIRS = ['components', 'composables', 'entrypoints', 'utils'];
/**
 * 本项目自己的三个域名，且只认两种**会进运行时**的写法：`href="…"` 字面量，或引号里的 URL 字符串。
 *
 * 刻意不扫裸提及：注释里写一句「参考 https://github.com/…」不该把守卫判红——那种写法既不参与渲染，
 * 也不会因为仓库改名而断链。会断链的是被交出去的那个地址。
 */
const OWN_LINK_RE =
  /href=["'`][^"'`]*?(?:github\.com|chromewebstore\.google\.com|liaolongdong\.github\.io)|["'`]https?:\/\/[^\s"'`]*?(?:github\.com|chromewebstore\.google\.com|liaolongdong\.github\.io)/;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.(vue|ts)$/.test(entry.name) ? [full] : [];
  });
}

const scannedFiles = SCAN_DIRS.flatMap(listSourceFiles);

describe('外链字面量只住 utils/urls.ts 与 utils/storePage.ts', () => {
  it('扫描面真的盖住了这几份文件（扫了个空＝下面那条断言假绿）', () => {
    const normalized = scannedFiles.map(file => path.normalize(file));
    for (const mustSee of [...SURFACES, ...URL_SOURCES, 'composables/useProjectLinks.ts']) {
      expect(normalized, `扫描面里没有 ${mustSee}`).toContain(mustSee);
    }
    expect(scannedFiles.length, '四目录里至少该有一百来个源码文件').toBeGreaterThan(95);
    // 阳性对照：两处真源自己必须命中，否则「其余文件零命中」只说明正则坏了
    expect(OWN_LINK_RE.test(readFileSync('utils/urls.ts', 'utf8')), 'urls.ts 自己没被认出来').toBe(true);
    expect(OWN_LINK_RE.test(readFileSync('utils/storePage.ts', 'utf8')), 'storePage.ts 自己没被认出来').toBe(true);
    // 反向对照：注释里的裸提及不算入口，别把这条判据再放宽回「文本里出现域名」
    expect(
      OWN_LINK_RE.test('// 参考 https://github.com/liaolongdong/cross-origin-proxy 的 issue 模板'),
      '裸提及被当成了字面量入口',
    ).toBe(false);
  });

  it('界面、composable 与其余 utils 里不把本项目的外链写成字面量', () => {
    const hits = scannedFiles
      .filter(file => !URL_SOURCES.includes(path.normalize(file)))
      .filter(file => OWN_LINK_RE.test(readFileSync(file, 'utf8')))
      .map(file => `${file}: ${readFileSync(file, 'utf8').match(OWN_LINK_RE)?.[0]}`);
    expect(hits, '这些文件把外链写成了字面量').toEqual([]);
  });

  it('utils/constants.ts 不再导出任何 URL（顶栏那个 Releases 常量已搬去 urls.ts）', () => {
    const constants = readFileSync('utils/constants.ts', 'utf8');
    // 按「导出的字面量」判，不按「文本里有没有 http」判：那份文件里本来就有一句
    // `fetch('https://a.com/?' + …)` 的注释举例，它不是入口，也断不了链
    expect(constants, 'constants.ts 里又长出一个 URL 常量').not.toMatch(/export const \w+ = ['"`]https?:\/\//);
    expect(constants).not.toContain('GITHUB_RELEASES_PAGE_URL');
  });

  it('Releases / Issues / 英文说明页都从基址派生，不是各写一份完整地址', () => {
    const urls = readFileSync('utils/urls.ts', 'utf8');
    const shapes: Array<[RegExp, string]> = [
      [/export const GITHUB_RELEASES_PAGE_URL = `\$\{REPO_GITHUB_URL\}\/releases`;/, 'GITHUB_RELEASES_PAGE_URL'],
      [/export const GITHUB_ISSUES_URL = `\$\{REPO_GITHUB_URL\}\/issues`;/, 'GITHUB_ISSUES_URL'],
      [/export const PRODUCT_DOCS_URL_EN = `\$\{PRODUCT_DOCS_URL\}en\.html`;/, 'PRODUCT_DOCS_URL_EN'],
    ];
    for (const [re, what] of shapes) expect(urls, `urls.ts 的 ${what} 不再是派生写法`).toMatch(re);
    // 仓库域名只出现一次：出现第二次就意味着有人又写了一份完整地址
    expect(urls.match(/github\.com/g)?.length, 'github.com 在 urls.ts 里不止一处').toBe(1);
  });
});

describe('三处落点读的是同一份清单', () => {
  afterEach(() => {
    currentLocale.value = 'zh_CN';
  });

  for (const file of SURFACES) {
    it(`${file} 渲染的是 useProjectLinks 那一份，不是自己拼的数组`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).toContain("import { useProjectLinks } from '@/composables/useProjectLinks'");
      expect(src).toContain('const projectLinks = useProjectLinks()');
      expect(src).toContain('v-for="link in projectLinks"');
    });
  }

  it('锚点总数是 4（三处各一枚 + 顶栏版本徽标那枚既有链接），且每一枚都带 target 与 rel', () => {
    const anchors = SURFACES.flatMap(file => [
      ...readFileSync(file, 'utf8')
        .matchAll(/<a\s[\s\S]*?>/g)
        .map(m => ({ file, tag: m[0] })),
    ]);
    expect(anchors.length, '一枚锚点都没扫到＝判据空转；数目变了＝有界面自己添了一枚外链').toBe(4);
    const bad = anchors
      .filter(a => !/target="_blank"/.test(a.tag) || !/rel="noopener noreferrer"/.test(a.tag))
      .map(a => `${a.file}: ${a.tag.replace(/\s+/g, ' ')}`);
    expect(bad, '这些锚点缺 target="_blank" 或 rel="noopener noreferrer"').toEqual([]);
  });
});

describe('useProjectLinks 的清单（运行时）', () => {
  const EXTENSION_ID = 'dednngakllblfilbndkaggphohmpgcbg';
  const GOOGLE_UPDATER = 'https://clients2.google.com/service/update2/crx';
  const realChrome = globalThis.chrome;

  /** 只交出这一格真用到的那两个字段；`updateUrl` 传 undefined 就是解包加载那份 manifest */
  function stubManifest(updateUrl?: string): void {
    Object.defineProperty(globalThis, 'chrome', {
      value: { runtime: { id: EXTENSION_ID, getManifest: () => (updateUrl ? { update_url: updateUrl } : {}) } },
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'chrome', { value: realChrome, configurable: true, writable: true });
    currentLocale.value = 'zh_CN';
  });

  it('商店装的构建：四条，第三条是条目页 detail/<id>，不带 slug、不带 /reviews', () => {
    stubManifest(GOOGLE_UPDATER);
    const links = useProjectLinks().value;
    expect(links.map(l => l.key)).toEqual(['linkRepo', 'linkDocs', 'linkStore', 'linkIssues']);
    const store = links.find(l => l.key === 'linkStore');
    expect(store?.href).toBe(`https://chromewebstore.google.com/detail/${EXTENSION_ID}`);
  });

  it('解包加载：三条，商店那一条整个不进清单（那条链接在这套安装下必然 404）', () => {
    stubManifest(undefined);
    expect(useProjectLinks().value.map(l => l.key)).toEqual(['linkRepo', 'linkDocs', 'linkIssues']);
  });

  it('Edge 那种也写 update_url 的分发同样收起——认的是 Google 那台更新服务器，不是字段非空', () => {
    stubManifest('https://edge.microsoft.com/extensionwebstorebase/v1/crx');
    expect(useProjectLinks().value.some(l => l.key === 'linkStore')).toBe(false);
  });

  it('界面语言只换「使用说明」那一条的落点，其余三条不动', () => {
    stubManifest(undefined);
    const zh = useProjectLinks().value;
    currentLocale.value = 'en';
    const en = useProjectLinks().value;
    expect(zh.find(l => l.key === 'linkDocs')?.href).toBe('https://liaolongdong.github.io/cross-origin-proxy/');
    expect(en.find(l => l.key === 'linkDocs')?.href).toBe('https://liaolongdong.github.io/cross-origin-proxy/en.html');
    expect(en.filter(l => l.key !== 'linkDocs').map(l => l.href)).toEqual(
      zh.filter(l => l.key !== 'linkDocs').map(l => l.href),
    );
  });

  it('清单里的每个文案键在中英字典都存在、非空，且恰好定义在一份命名空间里', () => {
    stubManifest(GOOGLE_UPDATER);
    const keys = [...useProjectLinks().value.map(l => l.key), 'linksTitle'];
    for (const locale of ['zh_CN', 'en'] as const) {
      // 三份 json 在构建期合并成一张扁平字典：同一个键定义在两处，就是后加载的那份盖掉前一份，
      // 而界面上完全看不出被盖掉过（少一个键则把 linkRepo 这种英文标识直接画出来）
      const namespaces = ['common', 'options', 'popup'].map(ns => {
        const raw = JSON.parse(readFileSync(`locales/${locale}/${ns}.json`, 'utf8')) as Record<string, string>;
        return { ns, entries: raw };
      });
      const flat = new Map<string, string>(namespaces.flatMap(({ entries }) => Object.entries(entries)));
      for (const key of keys) {
        expect(flat.get(key), `${locale} 侧缺 '${key}'`).toBeTruthy();
        expect(String(flat.get(key)).trim(), `${locale} 侧 '${key}' 是空文案`).not.toBe('');
        expect(namespaces.filter(({ entries }) => key in entries).length, `${locale} 侧 '${key}' 定义处不止一处`).toBe(
          1,
        );
      }
    }
  });
});
