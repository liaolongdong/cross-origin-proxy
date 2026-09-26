/**
 * 文档与仓库自动化一致性守卫
 *
 * 这些约定此前只写在 `AGENTS.md` / `CONTRIBUTING.md` 里靠人工遵守，一旦漂移代价
 * 都很具体：隐私政策 404 会被商店首审拒、落地页漏图会被读者当成坏项目、
 * 中英两页 FAQ 不对齐违反项目自身的 i18n 铁律、`master` 之类的过期结论会误导贡献者。
 *
 * 只依赖 `fs` 与正则（不引入 YAML/front-matter 依赖），在 Vitest 的 node 环境下运行。
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');
/** GitHub Pages 站点根 = 仓库 `docs/` 目录；路径基 = 仓库名，不可与品牌名混淆。 */
const PAGES_BASE = 'https://liaolongdong.github.io/cross-origin-proxy';
const REPO_BASE = 'https://github.com/liaolongdong/cross-origin-proxy';

/** 读取仓库内文件的 UTF-8 文本。 */
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
/** 仓库内路径是否存在。 */
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));

const pkg = JSON.parse(read('package.json')) as {
  version: string;
  name: string;
  homepage?: string;
  scripts: Record<string, string>;
};

/** 会引用 Pages URL 的文档；新增此类文档时要加进来看得到守卫。 */
const PAGES_URL_SOURCES = [
  'README.md',
  'README.en.md',
  'CHROMEWEBSTORE.md',
  'GITHUB.md',
  'docs/index.html',
  'docs/en.html',
  'docs/alternatives.html',
  'docs/en-alternatives.html',
  'docs/privacy.html',
  'docs/llms.txt',
  'docs/llms-full.txt',
  'docs/sitemap.xml',
  'docs/robots.txt',
];

/** 面向读者的仓库根文档；用于「过期结论」扫描。 */
const HUMAN_DOCS = [
  'README.md',
  'README.en.md',
  'CONTRIBUTING.md',
  'CHROMEWEBSTORE.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'RELEASING.md',
  'GITHUB.md',
  'AGENTS.md',
];

/**
 * 需要成对守卫的中英页面（左英右中）；新增双语页面只改这一处。
 * 中文是本站默认语言，因此中文页占据 `docs/index.html`（站点根）与 `docs/alternatives.html`，
 * 英文页带 `en-` 前缀。
 */
const BILINGUAL_PAIRS: Array<[string, string]> = [
  ['docs/en.html', 'docs/index.html'],
  ['docs/en-alternatives.html', 'docs/alternatives.html'],
];

/**
 * 出现商店链接的文档。扩展 ID 写错的代价很直接：README 首屏与落地页
 * `installUrl` / `sameAs` 全部指向 404，而 JSON-LD 里的错 ID 不会有任何渲染报错。
 * `marketing/` 是 gitignore 的本地产物，因此按存在与否取用。
 */
const STORE_URL_SOURCES = [
  'README.md',
  'README.en.md',
  'CHROMEWEBSTORE.md',
  'docs/index.html',
  'docs/en.html',
  'docs/alternatives.html',
  'docs/en-alternatives.html',
  'docs/llms.txt',
  'docs/llms-full.txt',
  'marketing/directory-submissions.md',
].filter(exists);

describe('[Docs] 仓库自动化与文档一致性', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // Pages URL：产品站与隐私政策的可达性
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Pages URL 必须落到 docs/ 下真实文件', () => {
    /**
     * Pages 以 `docs/` 为站点根，所以中文页就是 `/`（`docs/index.html`）、英文页在
     * `/en.html`（`docs/en.html`）。商店详细描述里的隐私政策 URL 打不开是首审最常见拒审理由，
     * 因此这条链接网必须静态成立（运行时可达性由 `GITHUB.md` §7 的 curl 自检覆盖）。
     */
    const pathToSiteRoot = (urlPath: string): string => {
      const clean = urlPath.replace(/[?#].*$/, '').replace(/\/$/, '') || '/';
      if (clean === '/' || clean === '') return 'docs/index.html';
      return `docs${clean}`;
    };

    it.each(PAGES_URL_SOURCES)('%s 里的 Pages URL 都有对应文件', file => {
      const text = read(file);
      const urls = [...text.matchAll(new RegExp(`${PAGES_BASE}(/[\\w./-]*)?`, 'g'))];
      expect(urls.length, `${file} 应当引用 Pages URL`).toBeGreaterThan(0);

      const broken = urls
        .map(m => m[1] ?? '/')
        .filter(p => !exists(pathToSiteRoot(p)))
        .sort();
      expect(broken, `${file} 引用了不存在的 Pages 路径`).toEqual([]);
    });

    it('llms.txt / README / 落地页的站点地址与 package.json homepage 完全一致', () => {
      expect(pkg.homepage, 'package.json 需要 homepage').toBe(`${PAGES_BASE}/`);
      expect(read('GITHUB.md')).toContain(PAGES_BASE);
    });

    it('GitHub Releases 入口在中英 README 都指向 /releases（发版链路的产物落点）', () => {
      expect(read('docs/llms.txt')).toContain(`${REPO_BASE}/releases`);
      expect(read('README.md')).toContain(`${REPO_BASE}/releases`);
      expect(read('README.en.md')).toContain(`${REPO_BASE}/releases`);
    });
  });

  describe('docs/ 页面内的相对引用不能悬空', () => {
    /** `docs/index.html` 里 `assets/img/x.jpg` 之类的引用，必须能在 `docs/` 下找到。 */
    const localRefs = (file: string): string[] => {
      const html = read(`docs/${file}`);
      return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map(m => m[1])
        .filter(v => !/^(https?:|#|mailto:|tel:)/.test(v))
        .map(v => v.replace(/&amp;/g, '&').replace(/[?#].*$/, ''))
        .filter(Boolean);
    };

    /** 把引用解析成磁盘路径；目录（如站根 `./`）按 Pages 的默认文档展开为 `index.html`。 */
    const resolveLocal = (ref: string): string => {
      const target = path.join('docs', ref);
      return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? path.join(target, 'index.html') : target;
    };

    /**
     * `git` 索引里的路径集合（NUL 分隔，避免文件名转义歧义），整轮只读一次
     *
     * 「磁盘上有」与「站点上有」不是一回事：Pages 部署的是**仓库**，所以一张只在开发机磁盘上、
     * 忘了 `git add` 的图，本地 `fs.existsSync` 永远为真，线上却是 404。
     * 2026-09 落地页新增的两张图（`config-import.jpg` / `credential-variables.jpg`）正是这样漏掉的。
     */
    let trackedCache: Set<string> | undefined;
    const trackedFiles = (): Set<string> => {
      if (!trackedCache) {
        const out = execFileSync('git', ['ls-files', '-z'], {
          cwd: ROOT,
          encoding: 'utf-8',
          maxBuffer: 32 * 1024 * 1024,
        });
        trackedCache = new Set(out.split('\0').filter(Boolean));
      }
      return trackedCache;
    };

    it.each(['index.html', 'en.html', 'alternatives.html', 'en-alternatives.html', 'privacy.html'])(
      '%s 的本地资源全部存在',
      file => {
        const refs = localRefs(file);
        expect(refs.length, `${file} 应当有本地资源引用`).toBeGreaterThan(0);

        const missing = refs
          .map(resolveLocal)
          .filter(ref => !exists(ref))
          .sort();
        expect(missing, `${file} 引用了 docs/ 下不存在的文件`).toEqual([]);
      },
    );

    it.each(['index.html', 'en.html', 'alternatives.html', 'en-alternatives.html', 'privacy.html'])(
      '%s 引用的本地资源都已入库（Pages 部署的是仓库，不是工作区）',
      file => {
        const tracked = trackedFiles();
        expect(tracked.size, 'git 索引不应为空').toBeGreaterThan(0);

        const untracked = [...new Set(localRefs(file).map(resolveLocal))]
          .filter(ref => exists(ref) && !tracked.has(ref.split(path.sep).join('/')))
          .sort();
        expect(untracked, `${file} 引用了磁盘上有、但没提交进 git 的文件`).toEqual([]);
      },
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 中英落地页对等（AGENTS 的硬要求，此前只靠人工）
  // ═══════════════════════════════════════════════════════════════════════════

  describe('中英落地页条目必须一一对应', () => {
    /** 统计某文件中正则的全部命中。 */
    const countIn = (file: string, re: RegExp): number => [...read(file).matchAll(re)].length;

    /**
     * FAQ 小节的可见部分（`<section id="faq">` 到其 `</section>`）。
     * 落地页的窄屏汉堡菜单也是 `<details>`，不限定范围会把它误计成 FAQ 条目。
     */
    const faqHtml = (file: string): string =>
      read(file).match(/<section\b[^>]*\bid="faq"[\s\S]*?<\/section>/)?.[0] ?? '';

    /** 页面可见的 `<summary>` 文本（去标签、归一空白），保持文档顺序。 */
    const summaries = (file: string): string[] =>
      [...faqHtml(file).matchAll(/<summary>([\s\S]*?)<\/summary>/g)]
        .map(m =>
          m[1]
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter(Boolean);

    /** `FAQPage` 结构化数据里的 Question `name`，保持声明顺序。 */
    const faqNames = (file: string): string[] =>
      [...read(file).matchAll(/"@type":\s*"Question",\s*"name":\s*"([^"]+)"/g)].map(m => m[1]);

    /**
     * 把一段 HTML/文本归一成“读者看到的字”：去标签、解常见实体、并行走空白。
     * 结构化数据里是纯文本，页面里带 `<code>` 之类的标签，不归一没法比。
     */
    const asPlainText = (text: string): string =>
      text
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&middot;/g, '·')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    /** 页面可见的 FAQ 答案：FAQ 小节内每个 `<details>` 里 `</summary>` 之后的部分。 */
    const faqAnswers = (file: string): string[] =>
      [...faqHtml(file).matchAll(/<details\b[^>]*>[\s\S]*?<\/summary>([\s\S]*?)<\/details>/g)]
        .map(m => asPlainText(m[1]))
        .filter(Boolean);

    /** 结构化数据里 `acceptedAnswer.text`，按声明顺序，跨 `@graph` 与嵌套节点递归收集。 */
    const schemaAnswers = (file: string): string[] => {
      const found: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node !== 'object' || node === null) return;
        const record = node as Record<string, unknown>;
        const answer = record.acceptedAnswer;
        if (typeof answer === 'object' && answer !== null) {
          const text = (answer as Record<string, unknown>).text;
          if (typeof text === 'string') found.push(asPlainText(text));
        }
        Object.values(record).forEach(walk);
      };
      for (const block of read(file).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
        walk(JSON.parse(block[1]) as unknown);
      }
      return found;
    };

    it.each(BILINGUAL_PAIRS)('%s / %s 的 FAQPage 结构化数据条数相同且非空', (en, zh) => {
      const enCount = countIn(en, /"@type":\s*"Question"/g);
      expect(enCount).toBeGreaterThan(0);
      expect(countIn(zh, /"@type":\s*"Question"/g)).toBe(enCount);
    });

    it.each(BILINGUAL_PAIRS)('%s / %s 的页面可见折叠条数与 schema 条数一致', (en, zh) => {
      const enCount = [...faqHtml(en).matchAll(/<details\b/g)].length;
      expect(enCount, `${en} 的 FAQ 小节应含与 schema 条数一致的折叠项`).toBeGreaterThan(0);
      expect([...faqHtml(zh).matchAll(/<details\b/g)].length).toBe(enCount);
    });

    /**
     * 右栏目录是在替读者数问题：写「4」而那一类其实有 5 条，页面就开始撒谎，而补一条
     * FAQ 的人只会记得改问答、不会记得回来改目录。所以把两边的数咬住：每个分类都带锚点、
     * 目录与分类同序同集合、每格条数等于该分类到下一个分类之间的 `<details>` 数，
     * 外加中英两页必须是同一批锚点（切语言时目录不能跳到页面上不存在的位置）。
     *
     * 只针对两份落地页：对比页也有 `#faq` 小节，但它没有分类分组，也就没有目录可钉。
     */
    it('中英落地页的 FAQ 右栏目录与分类一一对应、条数不谎报', () => {
      const [landingEn, landingZh] = BILINGUAL_PAIRS[0];
      /** 分类：`[锚点 id, 该分类下的折叠条数]`，保持文档顺序。 */
      const categoriesOf = (file: string): Array<[string, number]> => {
        const html = faqHtml(file);
        const marks = [...html.matchAll(/<h3\b[^>]*\bid="([^"]+)"/g)].map(m => [m[1], m.index] as [string, number]);
        return marks.map(([id, start], i) => {
          const end = marks[i + 1]?.[1] ?? html.length;
          return [id, [...html.slice(start, end).matchAll(/<details\b/g)].length] as [string, number];
        });
      };

      /** 目录：`[锚点 href, 声明的条数]`，保持文档顺序。 */
      const tocOf = (file: string): Array<[string, number]> =>
        [...faqHtml(file).matchAll(/<a href="#([^"]+)">[^<]*<span class="faq-toc-n">(\d+)<\/span>/g)].map(
          m => [m[1], Number(m[2])] as [string, number],
        );

      for (const file of [landingEn, landingZh] as const) {
        expect(categoriesOf(file), `${file} 的每个 FAQ 分类都应带目录可达的锚点`).toHaveLength(5);
        expect(tocOf(file), `${file} 的右栏目录与分类不一致（锚点、顺序或条数）`).toEqual(categoriesOf(file));
      }
      expect(Object.fromEntries(tocOf(landingEn)), `${landingEn} 与 ${landingZh} 的目录锚点或条数不一致`).toEqual(
        Object.fromEntries(tocOf(landingZh)),
      );
    });

    /**
     * AGENTS.md 要求“`FAQPage` 的问答需与页面 `<details>` 文本一致”，而且只比条数
     * 是弱守卫——两边同数但讲不同问题照样能绿。这里问题与答案都逐条逐序比对：
     * 答案只比问题的话，正文里改一句话不会变红，而 Google 会当成 markup 与内容不符。
     */
    it.each([...BILINGUAL_PAIRS.flat()])('%s 的 schema 问答与页面折叠文本逐条同序一致', file => {
      expect(summaries(file).length, `${file} 应有 FAQ 折叠项`).toBeGreaterThan(0);
      expect(faqNames(file)).toEqual(summaries(file));
      expect(schemaAnswers(file), `${file} 的 FAQ 答案与页面可见文本不一致`).toEqual(faqAnswers(file));
    });

    /**
     * 区块标题的语义图标：中英两页必须挂同一套图标、同一顺序。
     * 图标只加一边或两边画得不一样，都是这一条守卫要拦的漂移——
     * 读者从中文页切到英文页时，标题行的锚点应当完全对得上。
     */
    it.each(BILINGUAL_PAIRS)('%s / %s 的区块标题图标与顺序完全一致', (en, zh) => {
      /** 按文档顺序取 `[标题 id, 去空白后的图标本体]`；没有图标的标题记为空串。 */
      const iconsOf = (file: string): Array<[string, string]> =>
        [...read(file).matchAll(/<h2 id="([^"]+)"[\s\S]*?<\/h2>/g)].map(
          m =>
            [m[1], (m[0].match(/class="section-icon"[\s\S]*?<\/svg>/)?.[0] ?? '').replace(/\s+/g, '')] as [
              string,
              string,
            ],
        );

      const [enIcons, zhIcons] = [iconsOf(en), iconsOf(zh)];
      expect(enIcons.length, `${en} 应有带语义图标的区块标题`).toBeGreaterThanOrEqual(6);
      for (const [file, icons] of [
        [en, enIcons],
        [zh, zhIcons],
      ] as const) {
        for (const [id, icon] of icons) {
          expect(icon, `${file} 的标题 #${id} 缺少 .section-icon 语义图标`).not.toBe('');
        }
      }
      expect(Object.fromEntries(zhIcons), `${en} 与 ${zh} 的区块标题（id、顺序、图标本体）不一致`).toEqual(
        Object.fromEntries(enIcons),
      );
    });

    /** 只解析 `<head>` 里的 `<link rel="alternate">` 标注：`hreflang` → 目标 URL。 */
    const hreflangMap = (file: string): Record<string, string> =>
      Object.fromEntries(
        [...read(file).matchAll(/<link\b[^>]*rel="alternate"[^>]*>/g)]
          .map(tag => {
            const lang = tag[0].match(/hreflang="([^"]+)"/)?.[1];
            const href = tag[0].match(/href="([^"]+)"/)?.[1];
            return lang && href ? ([lang, href] as const) : null;
          })
          .filter((entry): entry is readonly [string, string] => entry !== null),
      );

    /**
     * hreflang 的硬规则：每页自指、中英互指、声明 x-default，且 head 与 sitemap 两处
     * 标注必须一致（不一致时 Google 整对丢弃），所以下面两条用例分别守两边。
     * x-default 指向站点默认语言页 = 中文页（站点根），不是英文页。
     */
    it.each(BILINGUAL_PAIRS)('%s / %s 的 hreflang 自指、互指且声明 x-default', (en, zh) => {
      const urlOf = (file: string) => `${PAGES_BASE}/${path.basename(file)}`.replace('index.html', '');
      const [enMap, zhMap] = [hreflangMap(en), hreflangMap(zh)];

      expect(enMap.en, `${en} 缺少指向自己的 hreflang="en"`).toBe(urlOf(en));
      expect(enMap.zh, `${en} 缺少 hreflang="zh"`).toBe(urlOf(zh));
      expect(enMap['x-default'], `${en} 的 x-default 应指向默认语言的中文页`).toBe(urlOf(zh));

      expect(zhMap.zh, `${zh} 缺少指向自己的 hreflang="zh"`).toBe(urlOf(zh));
      expect(zhMap.en, `${zh} 缺少 hreflang="en"`).toBe(urlOf(en));
      expect(zhMap['x-default'], `${zh} 的 x-default 应指向默认语言的中文页`).toBe(urlOf(zh));
    });

    it('站点根是中文页，英文页在 /en.html', () => {
      expect(read('docs/index.html'), 'docs/index.html 必须是中文页').toContain('<html lang="zh-CN">');
      expect(read('docs/en.html'), 'docs/en.html 必须是英文页').toContain('<html lang="en">');
      expect(read('docs/alternatives.html')).toContain('<html lang="zh-CN">');
      expect(read('docs/en-alternatives.html')).toContain('<html lang="en">');
    });

    /**
     * 旧的中文页路径已下线且没有 301（Pages 是纯静态目录，无重写规则），所以文档里
     * 出现「链接到它」的形式都会 404。`GITHUB.md` §7 与 `CHANGELOG.md` 需要按名字写出
     * 这两条路径才能说明「已下线」这件事，因此只拦真正的引用形态：href 属性、
     * Markdown 链接目标、完整 Pages URL；行内代码里的提及是合法的。
     */
    it('没有文档把已下线的 /zh.html 与 /zh-alternatives.html 当链接引用', () => {
      const refForms = (path: string): RegExp =>
        new RegExp(`(href="[^"]*|\\]\\([^)]*|https?://[^\\s)"]*?)${path.replace(/\./g, '\\.')}(?=["')\\s]|$)`);
      for (const file of PAGES_URL_SOURCES) {
        for (const retired of ['/zh.html', '/zh-alternatives.html']) {
          expect(read(file), `${file} 仍链接到已下线的 ${retired}`).not.toMatch(refForms(retired));
        }
      }
    });

    /**
     * 微信交流群是刻意只放在落地页的转化模块：对比页与隐私页要保持中立叙述，
     * 商店详细描述里引导添加个人微信会被 Chrome Web Store 判为站外引流。
     * 备注关键词 `cxp` 与微信号是进群的唯一路径说明，两页必须同值。
     */
    it('微信交流群只出现在中英落地页，且两页的微信号与备注关键词一致', () => {
      const [landingEn, landingZh] = BILINGUAL_PAIRS[0];
      for (const file of [landingEn, landingZh]) {
        const html = read(file);
        expect(html, `${file} 缺少微信二维码`).toContain('assets/img/wechat-qr.png');
        expect(html, `${file} 缺少可复制的微信号`).toContain('data-copy="lld_1025"');
        expect(html, `${file} 的进群备注关键词应为 cxp`).toContain('cxp');
        // 模块现在是页脚里的紧凑卡，不再是正文里的独立区块：锚点必须落在 <footer> 内，
        // 只判断字符串是否出现会让它飘回正文、把页脚重新撑大。
        const footer = html.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)?.[0] ?? '';
        expect(footer, `${file} 的交流群卡不在页脚内`).toContain('id="community"');
        expect(footer, `${file} 页脚缺少微信紧凑卡`).toContain('footer-wechat-qr');
        // landing.js 用 `btn.parentElement.querySelector('.copy-status')` 找提示区，
        // 两者拆到不同父节点后复制结果就静默失效。
        const idLine = html.match(/<p class="footer-wechat-id">[\s\S]*?<\/p>/)?.[0] ?? '';
        expect(idLine, `${file} 的复制按钮与 .copy-status 不再同属一个父节点，复制提示会静默丢失`).toMatch(
          /data-copy="lld_1025"[\s\S]*class="copy-status"/,
        );
      }
      for (const file of [
        'docs/alternatives.html',
        'docs/en-alternatives.html',
        'docs/privacy.html',
        'CHROMEWEBSTORE.md',
      ]) {
        expect(read(file), `${file} 不该出现微信交流群`).not.toContain('wechat-qr');
      }
    });

    /**
     * 「作者的其他插件」是落地页的互链模块：同一作者的另外两款扩展在此互相导流。
     * 卡片标题与描述按语言各写一版，没法逐字比对，所以守住三件不会因翻译而变的事：
     * 每卡的目标 URL 集合、每卡的主链接指向作者自己的产品站、以及 JSON-LD `ItemList`
     * 与 HTML 卡片对等——AI 引擎读的是结构化数据，两边分叉就是页面与实体图谱各说各话。
     * 与微信模块同样的边界：对比页与隐私页保持中立叙述，商店文案不做站外引导。
     */
    it('作者的其他插件只出现在中英落地页，两页的卡片、目标 URL 与 ItemList 对等', () => {
      const [landingEn, landingZh] = BILINGUAL_PAIRS[0];
      /** 取 `#author-tools` 小节的原始 HTML（锚点属性换行，故按 id 定位而非整标签匹配）。 */
      const sectionOf = (file: string): string => {
        const html = read(file);
        const start = html.indexOf('id="author-tools"');
        return start === -1 ? '' : html.slice(start, html.indexOf('</section>', start));
      };
      /** 每张卡内的 `href` 集合，按文档顺序排列。 */
      const cardsOf = (section: string): string[][] =>
        [...section.matchAll(/<article class="tool-card[\s\S]*?<\/article>/g)].map(card =>
          [...card[0].matchAll(/href="([^"]+)"/g)].map(m => m[1]),
        );

      const [enCards, zhCards] = [cardsOf(sectionOf(landingEn)), cardsOf(sectionOf(landingZh))];
      expect(zhCards.length, `${landingZh} 的互链卡片少于两张`).toBeGreaterThanOrEqual(2);
      expect(zhCards, `${landingZh} 与 ${landingEn} 的互链卡片数量或目标 URL 不一致`).toEqual(enCards);
      for (const [file, cards] of [
        [landingZh, zhCards],
        [landingEn, enCards],
      ] as const) {
        for (const card of cards) {
          expect(card[0], `${file} 有一张互链卡的主链接不是产品站首页`).toMatch(
            /^https:\/\/liaolongdong\.github\.io\/[\w-]+\/?$/,
          );
        }
      }

      /**
       * 主推位三件事必须同时成立：只有一张 `tool-card--featured`、它排在网格第一、
       * `ItemList` 的 `"position": 1` 指向同一款产品。读者看到的「主推」与机器读到的
       * 「第一」分叉时，AI 引擎会把另一款当成代表作来引用。
       */
      for (const [file, starWord] of [
        [landingZh, '主推'],
        [landingEn, 'Featured'],
      ] as const) {
        const section = sectionOf(file);
        const classes = [...section.matchAll(/<article class="([^"]+)"/g)].map(m => m[1]);
        const featured = classes.filter(cls => cls.includes('tool-card--featured'));
        expect(featured.length, `${file} 的主推卡应当只有一张`).toBe(1);
        expect(featured[0], `${file} 的主推卡不是网格里的第一张`).toBe(classes[0]);
        // 属性与 `>` 会被 Prettier 拆行（本页内联 SVG 都是这种排版），因此只锚定 class。
        const star = section.match(/<span class="tool-star"[\s\S]*?<\/span>/);
        expect(star, `${file} 的主推卡没有角标`).toBeTruthy();
        expect(star?.[0], `${file} 的角标没有内联图标（只有文字会显得像随手加的标注）`).toContain('<svg');
        expect(star?.[0], `${file} 的角标文案不是「${starWord}」`).toContain(starWord);

        const list = read(file).match(/"ItemList"[\s\S]*?<\/script>/)?.[0] ?? '';
        expect(
          list.match(/"position":\s*1,[\s\S]*?"url":\s*"([^"]+)"/)?.[1],
          `${file} 的 ItemList 第 1 位与页面上的主推卡不是同一款产品`,
        ).toBe(zhCards[0][0]);
      }

      for (const file of [landingEn, landingZh]) {
        const list =
          [...read(file).matchAll(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g)]
            .map(tag => tag[0].match(/"@type":\s*"ItemList"[\s\S]*/)?.[0] ?? '')
            .find(Boolean) ?? '';
        expect(list, `${file} 的 JSON-LD 缺少互链小节的 ItemList`).toBeTruthy();
        const items = [...list.matchAll(/"@type":\s*"SoftwareApplication"/g)].length;
        expect(items, `${file} 的 ItemList 条目数与卡片数不一致`).toBe(zhCards.length);
        expect(
          [...list.matchAll(/"creator":\s*\{\s*"@id":\s*"([^"]+#author)"/g)].length,
          `${file} 的 ItemList 条目未全部经 creator 指回作者实体`,
        ).toBe(items);
      }

      for (const file of [
        'docs/alternatives.html',
        'docs/en-alternatives.html',
        'docs/privacy.html',
        'CHROMEWEBSTORE.md',
      ]) {
        expect(read(file), `${file} 不该出现「作者的其他插件」模块`).not.toContain('author-tools');
      }
    });

    /**
     * README 侧的同一批契约。微信号与备注关键词一旦只改一边，进群路径就在两份文档里
     * 分叉；语言互链此前也真的写反过（中文主文档指向自己、英文页指向已删除的
     * `README.zh-CN.md`），而那种链接在 GitHub 上是 404 而不是红字。
     */
    it('中英 README 互链正确，交流群信息与二维码路径一致且可解析', () => {
      const [zh, en] = [read('README.md'), read('README.en.md')];
      expect(zh, 'README.md 是中文主文档，不应再自称有 zh-CN 译本').not.toContain('README.zh-CN.md');
      expect(en, 'README.en.md 必须链回中文主文档 README.md').toContain('[简体中文](./README.md)');
      expect(en, 'README.en.md 不应再引用已改名的 README.zh-CN.md').not.toContain('README.zh-CN.md');
      expect(zh, 'README.md 必须链到英文版 README.en.md').toContain('[English](./README.en.md)');

      for (const [name, text] of [
        ['README.md', zh],
        ['README.en.md', en],
      ] as const) {
        expect(text, `${name} 缺少微信号 lld_1025`).toContain('lld_1025');
        expect(text, `${name} 的进群备注关键词应为 cxp`).toContain('cxp');
        const [, qrPath] = text.match(/<img src="([^"]+wechat-qr\.png)"/) ?? [];
        expect(qrPath, `${name} 没有引用微信二维码图片`).toBeTruthy();
        expect(exists(qrPath.replace(/^\.\//, '')), `${name} 引用的二维码 ${qrPath} 不存在`).toBe(true);
      }

      const h2 = (text: string): number => [...text.matchAll(/^## /gm)].length;
      expect(h2(en), '中英 README 的章节数必须对等（只改一边就是漂移）').toBe(h2(zh));
    });

    /**
     * 目录锚点只在 GitHub 渲染后才生效，写错不会变红、只会静默失效。GitHub 的 slug
     * 规则实测于 `/repos/…/readme` 的 HTML 渲染结果：小写，保留字母/数字/组合标记/
     * `_`/`-`，空格转 `-`。要点是变体选择符 U+FE0F 属于组合标记、**会被留下**，而它
     * 前面的 emoji 被删掉——所以 `## 🖼️ 界面预览` 的锚点是 `#️-界面预览`，目录里写
     * `#-界面预览` 就是死链。被链接的标题只能用不带 FE0F 的图标。
     */
    it('README 与 CONTRIBUTING 的页内锚点都能对上 GitHub 的标题 slug', () => {
      const slug = (heading: string): string =>
        heading
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '')
          .replace(/ /g, '-');

      for (const file of ['README.md', 'README.en.md', 'CONTRIBUTING.md']) {
        const text = read(file);
        const slugs = new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map(m => slug(m[1])));
        const anchors = [...text.matchAll(/\]\(#([^)]+)\)/g)].map(m => m[1]);
        // 目录是这条守卫的主要保护对象；CONTRIBUTING 目前没有页内锚点，只在其出现时校验。
        if (file.startsWith('README')) {
          expect(anchors, `${file} 没有页内锚点，守卫失效`).not.toHaveLength(0);
        }
        for (const anchor of anchors) {
          const base = anchor.replace(/-\d+$/, '');
          expect(slugs.has(anchor) || slugs.has(base), `${file} 的锚点 #${anchor} 在 GitHub 上不存在`).toBe(true);
        }
      }
    });

    it('sitemap 为每个中英页面对补齐 en / zh / x-default 三条 alternate', () => {
      const blocks = read('docs/sitemap.xml').split('<url>').slice(1);
      for (const [en, zh] of BILINGUAL_PAIRS) {
        for (const file of [en, zh]) {
          const url = `${PAGES_BASE}/${path.basename(file)}`.replace('index.html', '');
          const block = blocks.find(b => b.includes(`<loc>${url}</loc>`));
          expect(block, `sitemap 缺少 ${url}`).toBeTruthy();
          for (const lang of ['en', 'zh', 'x-default']) {
            expect(block, `${url} 的 sitemap 标注缺少 hreflang="${lang}"`).toContain(`hreflang="${lang}"`);
          }
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 搜索结果可见宽度与结构化数据有效性
  // ═══════════════════════════════════════════════════════════════════════════

  describe('docs/ 页面的 SERP 预算与 JSON-LD', () => {
    const SITE_PAGES = ['index.html', 'en.html', 'alternatives.html', 'en-alternatives.html', 'privacy.html'];

    /**
     * Google 按可见宽度截断摘要，而不是按码点：CJK 与全角标点约占 2 个单位。
     * 与 `_locales` 的 75/132 码点硬校验是两套预算，不能互相替代。
     */
    const displayWidth = (text: string): number =>
      [...text].reduce(
        (n, ch) =>
          n +
          (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)
            ? 2
            : 1),
        0,
      );

    /** 还原成搜索结果里真正显示的样子：去标签、解实体、并行走空白。 */
    const visible = (text: string): string =>
      text
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&middot;/g, '·')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#\d+;|&#x[0-9a-fA-F]+;/g, '0')
        .replace(/\s+/g, ' ')
        .trim();

    /** 取 `<meta>` 的 content，兼容 `name=`（description）与 `property=`（og:type）两种写法。 */
    const metaContent = (file: string, key: string): string =>
      [...read(`docs/${file}`).matchAll(/<meta\b[^>]*>/g)]
        .map(m => m[0])
        .find(tag => tag.includes(`="${key}"`))
        ?.match(/content="([^"]*)"/)?.[1] ?? '';

    /** 统计条里 `<b>` 的数字与 `<span>` 的说明文字。 */
    const stats = (file: string): Array<{ value: string; label: string }> =>
      [...read(file).matchAll(/<div class="stat"><b>([^<]+)<\/b><span>([^<]*)<\/span>/g)].map(m => ({
        value: m[1],
        label: m[2],
      }));

    it.each(SITE_PAGES)('%s 的 title 与 description 没超出搜索结果可见宽度', file => {
      const title = visible(read(`docs/${file}`).match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
      expect(title, `${file} 缺少 <title>`).not.toBe('');
      expect(
        displayWidth(title),
        `${file} 的 title 宽 ${displayWidth(title)} 单位，>60 会在搜索结果被截断`,
      ).toBeLessThanOrEqual(60);

      const description = visible(metaContent(file, 'description'));
      expect(description, `${file} 缺少 meta description`).not.toBe('');
      expect(
        displayWidth(description),
        `${file} 的 description 宽 ${displayWidth(description)} 单位，>160 会被截断`,
      ).toBeLessThanOrEqual(160);
    });

    it.each(SITE_PAGES)('%s 的每段 JSON-LD 可解析，且 og:type 有对应节点', file => {
      const html = read(`docs/${file}`);
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      expect(blocks.length, `${file} 应带结构化数据`).toBeGreaterThan(0);

      const broken: string[] = [];
      const types: string[] = [];
      for (const [index, block] of blocks.entries()) {
        try {
          const parsed = JSON.parse(block[1]) as { '@graph'?: Array<{ '@type'?: unknown }>; '@type'?: unknown };
          for (const node of parsed['@graph'] ?? [parsed]) {
            if (typeof node['@type'] === 'string') types.push(node['@type']);
          }
        } catch (error) {
          broken.push(`#${index + 1}: ${(error as Error).message}`);
        }
      }
      expect(broken, `${file} 的 JSON-LD 解析失败：页面上看不出来，但富媒体结果会全部失效`).toEqual([]);

      if (metaContent(file, 'og:type') === 'article') {
        expect(types, `${file} 声明 og:type=article 却没有 Article 节点`).toContain('Article');
      }
    });

    const SITE_ORIGIN = 'https://liaolongdong.github.io/cross-origin-proxy/';

    /** 站内 `@id` → 它应当声明在哪一页；站点根即中文落地页。 */
    const pageOfId = (id: string): string | null => {
      if (!id.startsWith(SITE_ORIGIN)) return null;
      const path = id.slice(SITE_ORIGIN.length).split('#')[0];
      return path === '' ? 'index.html' : path;
    };

    /**
     * 收集一页 JSON-LD 里「真正声明的 @id」（`@graph` 节点）与「仅作为引用出现的
     * @id」（属性值位置上只带 `@id` 的对象，如 `isPartOf` / `about` / `author`）。
     * 区分这两者的依据是位置而非字段数量：图节点在数组里，引用是属性的对象值。
     */
    const collectIds = (file: string): { declared: Set<string>; referenced: Set<string> } => {
      const declared = new Set<string>();
      const referenced = new Set<string>();
      const isRefNode = (value: unknown): value is Record<string, unknown> =>
        !!value && typeof value === 'object' && !Array.isArray(value);
      const walk = (node: unknown, asReference: boolean): void => {
        if (Array.isArray(node)) {
          node.forEach(item => walk(item, asReference));
          return;
        }
        if (!isRefNode(node)) return;
        const id = node['@id'];
        if (typeof id === 'string') (asReference ? referenced : declared).add(id);
        for (const value of Object.values(node)) {
          walk(value, isRefNode(value) && typeof value['@id'] === 'string');
        }
      };

      const blocks = [...read(`docs/${file}`).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      for (const [, body] of blocks) walk(JSON.parse(body), false);
      return { declared, referenced };
    };

    /**
     * 实体之间的边现在会跨页指（对比页与隐私页的 `isPartOf` 指向首页的 `#website`，
     * `Article.author` 指向首页的 `#author`）。锚点改名或漏声明节点时 Google 只会
     * 静默丢掉那层关系，页面渲染毫无异常，所以逐页要求站内引用都能在目标页落地。
     */
    it('JSON-LD 里指向本站的 @id 引用都能在目标页找到声明的节点', () => {
      const declaredByPage = new Map<string, Set<string>>(SITE_PAGES.map(file => [file, collectIds(file).declared]));

      const dangling: string[] = [];
      for (const file of SITE_PAGES) {
        for (const ref of collectIds(file).referenced) {
          const target = pageOfId(ref);
          if (!target) continue;
          if (!declaredByPage.get(target)?.has(ref)) dangling.push(`${file} → ${ref}`);
        }
      }
      expect(dangling, `存在悬空的站内实体引用：${dangling.join('、')}`).toEqual([]);
    });

    /** 两份落地页是站点级实体唯一的声明处，缺一个就等于整张图没有根。 */
    it.each(['index.html', 'en.html'])('%s 的 @graph 成对声明 WebSite 与 WebPage，且页面挂在站点上', file => {
      const html = read(`docs/${file}`);
      const graphTypes = new Set<string>();

      for (const [, body] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
        const parsed = JSON.parse(body) as { '@graph'?: Array<{ '@type'?: unknown }> };
        for (const node of parsed['@graph'] ?? []) {
          if (typeof node['@type'] === 'string') graphTypes.add(node['@type']);
        }
      }

      expect([...graphTypes], `${file} 缺少站点级实体`).toEqual(expect.arrayContaining(['WebSite', 'WebPage']));

      const websiteId = file === 'index.html' ? `${SITE_ORIGIN}#website` : `${SITE_ORIGIN}en.html#website`;
      const wiredToSite = new RegExp(`"isPartOf":\\s*\\{\\s*"@id":\\s*"${websiteId.replace(/[/.]/g, '\\$&')}"`);
      expect(wiredToSite.test(html), `${file} 的 WebPage 未挂在本站的 WebSite 上`).toBe(true);
    });

    /**
     * 统计条是页面读者看到的第一个数字，README 的能力清单是他真正会去核对的地方；
     * 两边各自数过一遍就已经错过一次（11 对 12），所以只允许它们引用同一个来源。
     */
    it('落地页统计条的「每规则能力数」与中英 README 的能力清单条目数一致', () => {
      const capabilityBullets = (file: string): number => {
        /** 标题带语义图标前缀（`### 🔀 代理与请求改写`），因此这里允许可选前缀，只锚定标题文字。 */
        const list = read(file).match(
          /### (?:\S+\s+)?(?:Request proxy & modification|代理与请求改写)\n([\s\S]*?)\n### /,
        )?.[1];
        expect(list, `${file} 缺少「请求代理与改写」能力清单`).toBeTruthy();
        return [...(list ?? '').matchAll(/^- \*\*/gm)].length;
      };

      const en = capabilityBullets('README.en.md');
      expect(en, '英文 README 能力清单为空').toBeGreaterThan(0);
      expect(capabilityBullets('README.md'), '中英 README 能力清单条目数必须一致').toBe(en);

      for (const [file, label] of [
        ['docs/en.html', /per-rule capabilities/],
        ['docs/index.html', /规则能力/],
      ] as const) {
        const shown = stats(file).find(s => label.test(s.label))?.value;
        expect(shown, `${file} 统计条缺少能力数一项`).toBe(String(en));
      }
    });

    it.each(BILINGUAL_PAIRS)('%s / %s 的统计条数字逐项相同（数字与语言无关）', (en, zh) => {
      const [enStats, zhStats] = [stats(en), stats(zh)];
      expect(enStats.length, `${en} 应有统计条`).toBeGreaterThan(0);
      expect(
        zhStats.map(s => s.value),
        `${zh} 与 ${en} 的统计条数字不一致`,
      ).toEqual(enStats.map(s => s.value));
    });

    /**
     * 新鲜度同时写在一页的三处：JSON-LD 的 `dateModified`、页脚（及对比页眉标）的
     * “Last updated / 最后更新”，以及 sitemap.xml 里该 URL 的 `<lastmod>`。三者靠手工
     * 同步已经错过一次，而 Google 与引用型 AI 引擎都把它当新鲜度信号。这里只要求
     * 三者**彼此一致**，不校验具体值，所以不会随着日期推移自己变红。
     * privacy.html 不在内：它页脚写的是法律意义上的「生效日期」，与 lastmod 本就不等。
     */
    const FRESHNESS_PAGES = ['index.html', 'en.html', 'alternatives.html', 'en-alternatives.html'];

    it.each(FRESHNESS_PAGES)('%s 的三处新鲜度日期彼此一致', file => {
      const text = read(`docs/${file}`);
      const inPage = [
        ...text.matchAll(/(?:"dateModified":\s*"|(?:Last|·) updated\s+|最后更新\s*|更新于\s*)(\d{4}-\d{2}-\d{2})/g),
      ].map(m => m[1]);
      expect(inPage.length, `${file} 应同时带 dateModified 与页脚最后更新日期`).toBeGreaterThanOrEqual(2);

      const url = `${PAGES_BASE}/${file}`.replace('/index.html', '/');
      const entry = read('docs/sitemap.xml')
        .split('<url>')
        .find(block => block.includes(`<loc>${url}</loc>`));
      const lastmod = entry?.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
      expect(lastmod, `${file} 在 sitemap.xml 里缺少对应的 <lastmod>`).toBeDefined();

      expect(
        new Set([...inPage, lastmod]).size,
        `${file} 的新鲜度日期不一致：${[...new Set([...inPage, lastmod])].join(' / ')}`,
      ).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 落地页动效：装饰可以加，但「减弱动效下关得掉」是站点自定的硬契约
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `landing.css` 逐项关闭动效（文末 `prefers-reduced-motion` 里一条条 `animation: none`），
   * 不用 `* { animation: none !important }` 的一刀切——后者会连带掐掉轮播进度条的
   * `animationend`，翻页机制本身就没了。代价是每加一条动画都得记得补关闭项，
   * 而漏掉的那条在正常浏览器里完全看不出来，只有开了「减弱动效」的用户替你不舒服。
   * 所以这里把「谁用了关键帧」与「减弱动效段落关掉了谁」做集合差。
   */
  describe('落地页动效', () => {
    const css = read('docs/assets/landing.css');
    const js = read('docs/assets/landing.js');
    const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    /** 取 `@media` 块的正文：括号配对即可，不为这一个检查引入 CSS 解析器。 */
    const blockBody = (from: number): string => {
      const open = withoutComments.indexOf('{', from);
      let depth = 0;
      for (let i = open; i < withoutComments.length; i += 1) {
        if (withoutComments[i] === '{') depth += 1;
        if (withoutComments[i] === '}') depth -= 1;
        if (depth === 0) return withoutComments.slice(open + 1, i);
      }
      return '';
    };
    const reducedStart = withoutComments.indexOf('@media (prefers-reduced-motion: reduce)');
    const reduced = blockBody(reducedStart);
    const rest = withoutComments.replace(reduced, '');
    const declared = new Set([...withoutComments.matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]));

    /** 减弱动效段落里被 `animation: none` 或 `display: none` 收掉的选择器。 */
    const switchedOff = new Set(
      [...reduced.matchAll(/([^{}]+)\{[^{}]*?(?:animation(?:-name)?\s*:\s*none|display\s*:\s*none)[^{}]*?\}/g)]
        .flatMap(match => match[1].split(','))
        .map(selector => flat(selector).replace(/^html\.js /, '')),
    );

    /**
     * 闸门在脚本里的动画：减弱动效下压根不会启动，不需要样式再关一次。
     * 豁免必须同时在 `landing.js` 里找得到那道闸门，否则闸门一删这里就红。
     */
    const jsGated = new Map([['lp-gallery-auto', 'autoPossible']]);

    it('每条使用关键帧的规则都在减弱动效段落里关掉', () => {
      expect(reducedStart, 'landing.css 里没有 prefers-reduced-motion 段落').toBeGreaterThan(0);
      expect(declared.size, 'landing.css 里没有 @keyframes').toBeGreaterThan(0);

      const missing = [...rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .flatMap(([, selector, body]) =>
          [...body.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)]
            .flatMap(value => value[1].split(/\s+/).filter(token => declared.has(token)))
            .map(name => [name, flat(selector).replace(/^html\.js /, '')] as const),
        )
        .filter(([name]) => !jsGated.has(name))
        .filter(([, selector]) => !switchedOff.has(selector))
        .map(([name, selector]) => `${selector} 播了 ${name}()，减弱动效段落没关它`);

      expect(missing, '新增动画漏了减弱动效关闭项').toEqual([]);
    });

    it('减弱动效段落列出的关闭项都对应真实规则，闸门也还在脚本里', () => {
      const normalizedRest = flat(rest);
      const orphan = [...switchedOff].filter(
        selector => selector && !normalizedRest.includes(`${selector} {`) && !normalizedRest.includes(`${selector},`),
      );
      expect(orphan, '这些关闭项对应不到任何规则，选择器已经漂移').toEqual([]);

      for (const [name, gate] of jsGated) {
        expect(declared.has(name), `豁免表里的 ${name} 已不存在于 landing.css`).toBe(true);
        expect(js, `减弱动效下 ${name} 改由样式负责关闭，请把豁免项删掉`).toContain(gate);
      }
    });

    /** 追光的坐标、巡航的放行都要 JS 写类名/自定义属性，样式必须与脚本用同一套名字。 */
    it('卡片追光与流程图巡航的契约名在样式与脚本两侧一致', () => {
      for (const hook of ['--lp-x', '--lp-y', 'is-live']) {
        expect(css, `landing.css 不再使用 ${hook}`).toContain(hook);
        expect(js, `landing.js 不再写入 ${hook}`).toContain(hook);
      }
      // 降级前提：这两条都必须在 html.js 之下，禁用脚本时不留没有光源的空洞。
      expect(css).toMatch(/html\.js \.feature-card::before/);
      expect(css).toMatch(/html\.js \.hero-visual \.flow-node::before/);
      expect(js).toMatch(/matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 商店提审素材：CHROMEWEBSTORE.md 是商店表单的唯一素材源
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Chrome 商店提审素材', () => {
    const doc = read('CHROMEWEBSTORE.md');

    /**
     * 全仓库的商店链接必须共用同一个扩展 ID，真值取 `CHROMEWEBSTORE.md` 的 Store URL 行。
     *
     * 只匹配「`detail/` 后紧跟一段无连字符的 slug」，因此对比页里引用的竞品链接
     * （`detail/<slug>/<id>` 形式，slug 含连字符）不会被误计。此前实测存在三种写法
     * （30 位漏字、32 位换字、真值），JSON-LD 的那两份正是错的。
     */
    it('所有商店链接共用同一个扩展 ID', () => {
      const truth = doc.match(/chromewebstore\.google\.com\/detail\/([a-z0-9]{32})(?![a-z0-9-])/)?.[1];
      expect(truth, 'CHROMEWEBSTORE.md 的 Store URL 里应能解析出 32 位扩展 ID').toBeTruthy();

      const ids = STORE_URL_SOURCES.flatMap(file => [
        ...read(file)
          .matchAll(/chromewebstore\.google\.com\/detail\/([a-z0-9]+)(?![a-z0-9-])/g)
          .map(m => ({ file, id: m[1] })),
      ]);
      expect(ids.length, '文档里应当出现商店链接').toBeGreaterThan(0);

      const wrong = ids.filter(row => row.id !== truth).map(row => `${row.file}: ${row.id}`);
      expect([...new Set(wrong)].sort(), '存在与 CHROMEWEBSTORE.md 真值不一致的商店 ID').toEqual([]);
    });

    /** 取某个小节区间内的全部 ``` 代码块（商店表单的可粘贴值就放在这里）。 */
    const blocksIn = (from: string, to: string): string[] => {
      const start = doc.indexOf(from);
      const end = doc.indexOf(to, start + from.length);
      expect(start, `CHROMEWEBSTORE.md 缺少小节 ${from}`).toBeGreaterThanOrEqual(0);
      expect(end, `CHROMEWEBSTORE.md 缺少小节 ${to}`).toBeGreaterThan(start);
      return [...doc.slice(start, end).matchAll(/```\n([\s\S]*?)```/g)].map(m => m[1].replace(/\n$/, ''));
    };

    /** `_locales/<lang>/messages.json` 里某条 message 的正文。 */
    const manifestMessage = (lang: string, key: string): string =>
      JSON.parse(read(`public/_locales/${lang}/messages.json`))[key].message as string;

    /**
     * 商店表单的名称与摘要必须与打进包里的 manifest 文案逐字相同。两者一旦分叉，
     * 提审时粘进 Dashboard 的是文档里的旧值，而用户装到的以 `manifest.json` 为准，
     * 搜索结果与详情页就互相矛盾——所以只允许有一处真值。
     */
    it.each([
      ['### 1.1', '### 1.2', 'zh_CN'],
      ['### 1.2', '### 1.3', 'en'],
    ] as const)('%s 的名称与摘要与 _locales/%s 逐字一致', (from, to, lang) => {
      const [name, summary, description] = blocksIn(from, to);
      expect(name, `${from} 名称与 manifest 的 extensionName 不一致`).toBe(manifestMessage(lang, 'extensionName'));
      expect(summary, `${from} 摘要与 manifest 的 extensionDescription 不一致`).toBe(
        manifestMessage(lang, 'extensionDescription'),
      );
      expect(description, `${from} 应当还有第三个块（详细描述）`).toBeTruthy();

      // Chrome 上传时按码点硬校验，超出直接拒包。
      expect([...name].length, `${from} 名称 >75 码点，商店会拒包`).toBeLessThanOrEqual(75);
      expect([...summary].length, `${from} 摘要 >132 码点，商店会拒包`).toBeLessThanOrEqual(132);
      expect(name, `${from} 名称含最高级/免费类词，属「误导性列表信息」高危字段`).not.toMatch(
        /\b(best|top|#1|free|top-rated|免费|最好|最强)\b/i,
      );
    });

    /**
     * 中英两份详细描述是同一次改稿的两个出口。条数不等意味着其中一边漏改——
     * 这类漂移在落地页上已有守卫，商店侧此前只靠人工数（本轮 6 处修正正是人工发现的）。
     */
    it('中英详细描述结构对等（行数、条目数、段落数）', () => {
      const shape = (from: string, to: string) => {
        const body = blocksIn(from, to)[2];
        return {
          lines: body.split('\n').length,
          bullets: [...body.matchAll(/^- /gm)].length,
          paragraphs: body.split('\n\n').length,
        };
      };
      const zh = shape('### 1.1', '### 1.2');
      expect(shape('### 1.2', '### 1.3'), '中英详细描述必须行数、条目数、段落数全等').toEqual(zh);
      expect(zh.bullets).toBeGreaterThan(0);
    });

    it('详细描述守住 16000 码点预算，且不含具体版本号', () => {
      const pairs = [
        ['zh', blocksIn('### 1.1', '### 1.2')[2]],
        ['en', blocksIn('### 1.2', '### 1.3')[2]],
      ] as const;
      for (const [lang, body] of pairs) {
        expect([...body].length, `${lang} 详细描述超出商店 16000 码点上限`).toBeLessThanOrEqual(16000);
        // 版本号写进商店文案意味着每次发版都要手动改 Dashboard；`HAR 1.2` 是格式名，不算版本号。
        expect(body, `${lang} 详细描述不应写具体版本号`).not.toMatch(/\b\d+\.\d+\.\d+\b/);
        expect(body, `${lang} 详细描述必须带隐私政策 URL`).toContain(`${PAGES_BASE}/privacy.html`);
        expect(body, `${lang} 详细描述必须带反馈与源码入口`).toContain(REPO_BASE);
      }
    });

    /**
     * §0 的预算表是对「还能不能扩写」的对外口径。它与实测脱节时，后来的人会按过时的
     * 余量决定要不要加字，所以从正文反算，不允许有第二份数字。
     */
    it('§0 预算表记录的详细描述码点数与实测一致', () => {
      const declared = doc.match(/\| 详细描述 \|[^\n]*?中约\s*([\d.]+)K\s*\/\s*英约\s*([\d.]+)K/);
      expect(declared, '§0 预算表应记录中英详细描述的码点数').toBeTruthy();
      const measured = [blocksIn('### 1.1', '### 1.2')[2], blocksIn('### 1.2', '### 1.3')[2]].map(
        body => [...body].length / 1000,
      );
      expect(Number(declared![1]), '中文详细描述码点数与 §0 记录不符').toBeCloseTo(measured[0], 1);
      expect(Number(declared![2]), '英文详细描述码点数与 §0 记录不符').toBeCloseTo(measured[1], 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 版本与发布契约
  // ═══════════════════════════════════════════════════════════════════════════

  describe('版本历史与发布契约', () => {
    it('CHANGELOG.md 有当前版本小节（release 工作流靠它生成 Release 说明）', () => {
      const changelog = read('CHANGELOG.md');
      expect(changelog).toMatch(new RegExp(`^## \\[${pkg.version}\\]`, 'm'));
      expect(changelog).toMatch(/^## \[Unreleased\]/m);
    });

    it('商店文档里的包名模板与 wxt zip 的产物命名一致', () => {
      // wxt 默认产物：`<package-name>-<version>-<browser>.zip`
      expect(read('CHROMEWEBSTORE.md')).toContain(`${pkg.name}-<version>-chrome.zip`);
    });

    it('版本号只在 package.json，wxt.config.ts 不得重新声明 manifest.version', () => {
      expect(read('wxt.config.ts')).not.toMatch(/^\s*version:\s*['"]/m);
    });

    /**
     * 凡是**复述「仓库此刻在工作的那个版本」**的地方必须等于 `package.json`。
     *
     * 这条是 `1.1.0 → 1.2.0` 那一次 bump 当场漏出来的：`docs/llms-full.txt` 两句与
     * `.github/ISSUE_TEMPLATE/bug_report.yml` 的示例版本还写着旧号，而 llms-full 是给检索引擎与
     * AI 系统读的公开出口——它假一个版本号，答案里就跟着假一个。判据按**短语**认，只圈这三处
     * 「当前版本」表述，故意不碰说**已发布版本**的那些地方：落地页页脚与 `softwareVersion` 写的是
     * 商店在装的 `1.0.0`（真话，翻它要等 tag 真推出去，见 `CHROMEWEBSTORE.md` §12 ① 第 4 项），
     * `CHROMEWEBSTORE.md` §8 与 `CHANGELOG.md` 按设计留历史行。
     *
     * 每个短语都要求**至少命中一次**：改写了措辞（或删了那半句）同样红，因为那意味着这张清单
     * 与文档脱钩了，而下一次 bump 就没有任何东西会提醒你去翻它。
     */
    it('宣称「仓库当前版本」的每一处都等于 package.json', () => {
      const CURRENT_VERSION_CLAIMS: { file: string; re: RegExp; label: string }[] = [
        {
          file: 'docs/llms-full.txt',
          re: /working version is (\d+\.\d+\.\d+)/g,
          label: 'llms-full.txt 头部 `Last verified` 那行',
        },
        {
          file: 'docs/llms-full.txt',
          re: /the repository is on (\d+\.\d+\.\d+)/g,
          label: 'llms-full.txt 页脚 `Last updated` 那行',
        },
        {
          file: '.github/ISSUE_TEMPLATE/bug_report.yml',
          re: /扩展版本 (\d+\.\d+\.\d+)/g,
          label: 'bug 报告模板的示例版本',
        },
      ];
      for (const { file, re, label } of CURRENT_VERSION_CLAIMS) {
        const found = [...read(file).matchAll(re)].map(m => m[1]);
        expect(
          found.length,
          `${label}（${file}）里找不到宣称当前版本的那句 —— 措辞变了就回来改这张清单`,
        ).toBeGreaterThan(0);
        for (const claimed of found) {
          expect(claimed, `${label} 宣称当前版本 ${claimed}，而 package.json 是 ${pkg.version}`).toBe(pkg.version);
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 工作流关键契约（YAML 无法本机执行，至少守住这些字符串）
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GitHub 工作流关键契约', () => {
    const ci = read('.github/workflows/ci.yml');
    const pages = read('.github/workflows/deploy-pages.yml');
    const release = read('.github/workflows/release.yml');
    const verify = read('.github/actions/verify/action.yml');

    it('CI 与发布共用同一个 verify 复合动作，避免两份清单漂移', () => {
      expect(ci).toContain('uses: ./.github/actions/verify');
      expect(release).toContain('uses: ./.github/actions/verify');
    });

    it('verify 动作覆盖 package.json 里定义的全部检查脚本', () => {
      // 从 scripts 反推而不是手写一份数组：新增 `pnpm check:xxx` 并漏进 verify 动作时，
      // 本用例必须变红。
      const checkScripts = Object.keys(pkg.scripts).filter(key =>
        /^(lint|lint:style|format:check|typecheck|test)$/.test(key),
      );
      expect(checkScripts.length).toBeGreaterThan(0);
      for (const script of checkScripts) {
        expect(verify, `verify 动作缺少 pnpm ${script}`).toContain(`pnpm ${script}`);
      }
    });

    it('Pages 部署有 pages 权限、以 docs/ 为站点根、走 deploy-pages', () => {
      expect(pages).toContain('pages: write');
      expect(pages).toContain('id-token: write');
      expect(pages).toContain('path: docs');
      expect(pages).toContain('actions/deploy-pages@');
      expect(pages).toMatch(/branches:\s*\[main\]/);
    });

    it('发布工作流引用 4 个商店凭据、走 wxt submit、且只在 tag 上触发', () => {
      for (const secret of [
        'CHROME_EXTENSION_ID',
        'CHROME_CLIENT_ID',
        'CHROME_CLIENT_SECRET',
        'CHROME_REFRESH_TOKEN',
      ]) {
        expect(release, `release.yml 未引用 secrets.${secret}`).toContain(`secrets.${secret}`);
      }
      expect(release).toContain('wxt submit');
      expect(release).toContain('tags:');
      expect(release).toContain("'v*'");
      expect(release).toContain('permissions:');
      expect(release).toContain('contents: write');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 面向读者的文档不得留下会误导人的过期结论
  // ═══════════════════════════════════════════════════════════════════════════

  describe('文档过期结论', () => {
    it('没有文档再把 master 当基线分支（默认分支是 main）', () => {
      const offenders = HUMAN_DOCS.filter(file => /(^|[^a-zA-Z])[`'“"]?master[`'”"]?([^a-zA-Z]|$)/.test(read(file)));
      expect(offenders, 'README/CONTRIBUTING 等应统一写 main').toEqual([]);
    });

    it('社区健康文件齐备（GitHub 靠它们渲染贡献与安全提示）', () => {
      for (const file of ['SECURITY.md', 'CONTRIBUTING.md', '.github/PULL_REQUEST_TEMPLATE.md']) {
        expect(exists(file), `缺少 ${file}`).toBe(true);
      }
      for (const tpl of ['bug_report.yml', 'feature_request.yml', 'config.yml']) {
        expect(exists(`.github/ISSUE_TEMPLATE/${tpl}`), `缺少 Issue 模板 ${tpl}`).toBe(true);
      }
    });

    it('GitHub 仓库展示信息清单给出的值本身合法', () => {
      const doc = read('GITHUB.md');
      const description = doc.match(/```[a-z]*\nChrome extension:[^\n]+/)?.[0].replace(/^```[a-z]*\n/, '');
      expect(description, 'GITHUB.md 应包含 About 描述的可粘贴值').toBeTruthy();
      // GitHub About 描述上限 350 个码点
      expect([...(description ?? '')].length).toBeLessThanOrEqual(350);

      const section = doc.match(/## 3\. Topics[\s\S]*?(?=\n## )/)?.[0] ?? '';
      const topics = (section.match(/```\n([\s\S]*?)```/)?.[1] ?? '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
      expect(topics.length).toBeGreaterThan(0);
      expect(topics.length, 'GitHub topics 上限 20').toBeLessThanOrEqual(20);
      expect(
        topics.filter(t => !/^[a-z0-9][a-z0-9-]{0,49}$/.test(t)),
        'topic slug 必须小写连字符',
      ).toEqual([]);
    });
  });
});
