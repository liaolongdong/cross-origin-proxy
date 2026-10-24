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

/**
 * `git` 索引里的路径集合（NUL 分隔，避免文件名转义歧义），整轮只读一次
 *
 * 「磁盘上有」与「站点上有」不是一回事：Pages 部署的是**仓库**，所以一张只在开发机磁盘上、
 * 忘了 `git add` 的图，本地 `fs.existsSync` 永远为真，线上却是 404。
 * 2026-09 落地页新增的两张图（`config-import.jpg` / `credential-variables.jpg`）正是这样漏掉的。
 * 同理，「全仓还有谁写着这个数」也只能按索引问，不能扫磁盘——本地留着的可再生文件多的是。
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

const pkg = JSON.parse(read('package.json')) as {
  version: string;
  name: string;
  homepage?: string;
  scripts: Record<string, string>;
};

/**
 * 三份仓库侧运维文档的落点（2026-09-28 从仓库根移入 `.github/docs/`）
 *
 * 搬家的判据是「谁在根上找不到它」：`README`/`CHANGELOG`/`LICENSE`/`AGENTS` 由 GitHub、
 * release-please 与 agent 工具按根路径取用，动不了；这三份只被仓内 prose 与工作流引用，
 * 放到所描述的自动化旁边更贴合职责，也不再把 87KB 的商店文案台账堆在仓库首页。
 *
 * 路径在这里写一次：下面四份清单与各处 `read()` 都取这些常量，将来再搬家只改这一处。
 * 注意 `docs/` 是 Pages 站点根，所以这三份**不能**放进去——放进去就是往公开产品站上
 * 挂运维手册，还会让 `deploy-pages.yml` 的 `paths: docs/**` 白白起跑一次站点部署。
 */
const STORE_DOC = '.github/docs/CHROMEWEBSTORE.md';
const GITHUB_DOC = '.github/docs/GITHUB.md';
const RELEASING_DOC = '.github/docs/RELEASING.md';

/** 会引用 Pages URL 的文档；新增此类文档时要加进来看得到守卫。 */
const PAGES_URL_SOURCES = [
  'README.md',
  'README.en.md',
  STORE_DOC,
  GITHUB_DOC,
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

/** 面向读者的仓库文档（含 `.github/docs/` 那三份）；用于「过期结论」扫描。 */
const HUMAN_DOCS = [
  'README.md',
  'README.en.md',
  'CONTRIBUTING.md',
  STORE_DOC,
  'SECURITY.md',
  'CHANGELOG.md',
  RELEASING_DOC,
  GITHUB_DOC,
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
  STORE_DOC,
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
      expect(read(GITHUB_DOC)).toContain(PAGES_BASE);
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
     * `git` 索引里的路径集合见文件顶部的 `trackedFiles()`——Pages 部署的是仓库，不是开发机磁盘。
     */

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
      for (const file of ['docs/alternatives.html', 'docs/en-alternatives.html', 'docs/privacy.html', STORE_DOC]) {
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

      /**
       * 每张卡左上角必须是**那款产品自己的**品牌图标，而不是首字母占位：读者在 Chrome 工具栏、
       * `chrome://extensions` 与商店列表里认的就是这张脸，「AP / TF」是个哪里都见不到的第二形象。
       * 判据从卡片自己的主链接里取出产品站 slug，再要求 `src` 的文件名与它对齐——两张贴反、
       * 或有人退回字母占位，当场红；而这两种错在浏览器里都只是「看着挺正常」。
       * `alt=""` 与页脚那张品牌图标同一口径：产品名就写在下面一行的标题里，给了 alt 等于让
       * 读屏机把同一个名字念两遍。`width`/`height` 挡住图标加载前后那一下跳动。
       */
      for (const [file, cards] of [
        [landingZh, zhCards],
        [landingEn, enCards],
      ] as const) {
        const section = sectionOf(file);
        const marks = [...section.matchAll(/<img\b(?=[^>]*class="tool-mark")[^>]*>/g)].map(m => m[0]);
        expect(marks.length, `${file} 的品牌图标张数与互链卡片数不一致`).toBe(cards.length);
        for (const [index, mark] of marks.entries()) {
          const slug = new URL(cards[index][0]).pathname.split('/').filter(Boolean)[0];
          expect(mark, `${file} 第 ${index + 1} 张卡的图标与它指向的产品不是同一款`).toContain(
            `src="assets/img/tool-${slug}.svg"`,
          );
          expect(mark, `${file} 第 ${index + 1} 张卡的图标缺了空 alt（读屏机会把产品名念两遍）`).toContain('alt=""');
          expect(mark, `${file} 第 ${index + 1} 张卡的图标缺 width/height（加载时会顶一下版面）`).toMatch(
            /width="40"[\s\S]*height="40"/,
          );
        }
        expect(section, `${file} 不该再有字母占位形式的 tool-mark`).not.toMatch(/<span\b[^>]*class="tool-mark"/);
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

      for (const file of ['docs/alternatives.html', 'docs/en-alternatives.html', 'docs/privacy.html', STORE_DOC]) {
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

    /**
     * 分享卡上那两句从前**一条守卫都没有**：五页十串全靠人工数，而 `en-alternatives.html`
     * 的 `og:description` 正是这样一路漂到 172 的（2026-10-02 收回 157）。判据与上面
     * `meta description` 同一套口径——平台按可见宽度截断那一句，不是按码点，所以中英文串
     * 不能互相顶替，也不能拿 `.length` 估。
     */
    it.each(SITE_PAGES)('%s 的 og 与 twitter 描述收在分享卡可见宽度以内', file => {
      for (const key of ['og:description', 'twitter:description'] as const) {
        const text = visible(metaContent(file, key));
        expect(text, `${file} 缺少 ${key}`).not.toBe('');
        expect(
          displayWidth(text),
          `${file} 的 ${key} 宽 ${displayWidth(text)} 单位，>160 会在分享卡上被截断`,
        ).toBeLessThanOrEqual(160);
      }
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

    /**
     * 偏好回调的登记必须排在「没有 `IntersectionObserver`」那道早退**之前**。
     * 2026-10-03 抓到的正是反的那一份：这句原本写在早退之后，于是那种运行时里巡航只登记了一次
     * 闸门、`syncLive` 永远收不到偏好翻转——JSDoc 承诺的「中途翻回来当场就能续上」恰好落在
     * 唯一需要它的老引擎上（样式侧的媒体查询只负责「关」，帮不上「重新开」）。
     * node 环境既没有 `IntersectionObserver` 也没有布局，这条除了按源码钉没有别的出路。
     * 三处登记里只有这一处所在的函数自己会早退（另两处的分支是「整段不绑定」，不是早退），
     * 所以把张数一起钉住：将来多出第四处，就得回来重判它排在哪个分支之前。
     */
    it('巡航的偏好回调排在无 IntersectionObserver 的早退之前', () => {
      expect(
        js.match(/onMotionChange\(/g) ?? [],
        'onMotionChange 的登记点张数变了，请回来重判每一处排在哪个早退之前',
      ).toHaveLength(3);

      const body = /const cruiseWhenVisible = target => \{([\s\S]*?)\n {2}\};/.exec(js)?.[1];
      expect(body, 'cruiseWhenVisible 的函数体形状变了（收尾缩进不再是两格），这条守卫形同空转').toBeTruthy();

      const registerAt = body!.indexOf('onMotionChange(syncLive)');
      const earlyReturnAt = body!.indexOf("if (!('IntersectionObserver' in window))");
      expect(registerAt, '巡航不再登记偏好回调——减弱动效中途翻回来时无人续上').toBeGreaterThanOrEqual(0);
      expect(earlyReturnAt, '无 IntersectionObserver 的降级分支不见了').toBeGreaterThanOrEqual(0);
      expect(
        registerAt,
        '偏好回调排在早退之后：没有 IntersectionObserver 的运行时永远登记不到它，首屏巡航只能等刷新',
      ).toBeLessThan(earlyReturnAt);

      // 早退那半不是「什么都不做」：它自己要把巡航放到终态，否则降级态下首屏压根不动。
      expect(flat(body!.slice(earlyReturnAt)), '降级分支不再调用 syncLive 收尾').toContain(
        'inView = true; syncLive(); return;',
      );
    });

    /**
     * 「试一试」那个入口是预演面板唯一的门，而门的位置就是它有没有人用。
     * 2026-09-30 按 headless Chrome 在 1440×900（`innerHeight` 757）量过：链接写在示例卡尾部时，
     * 卡片是中文页 616→860、英文页 665→910，整个入口落在折叠线以下；挪进 `.hero-example-head`
     * 之后读到 633→655 与 682→705，两页都在折叠线之内。位置本身钉不住（node 环境没有布局），
     * 所以钉它的**结构代理**：入口必须待在卡头那个容器里。把它挪回 `</dl>` 后面，
     * 这条就红——没有测试会因为「一个链接掉到屏幕外」而失败，只有这一条会。
     * 边界一并记着，别让这句话读起来像无条件成立：1280×800 与 1440 同值，但 1152×720 下
     * 上面的 `.stat-strip` 折成两行、整张卡让到 705 / 727 起，入口又掉回折叠线以下。
     */
    it('预演面板的唯一入口住在示例卡的卡头', () => {
      for (const page of ['docs/index.html', 'docs/en.html']) {
        const html = read(page);
        const anchors = [...html.matchAll(/href="#try"/g)];
        expect(anchors.length, `${page} 指向 #try 的入口应恰好一处`).toBe(1);

        const head = /<div class="hero-example-head">([\s\S]*?)<\/div>/.exec(html);
        expect(head, `${page} 示例卡缺了 .hero-example-head 那一行`).toBeTruthy();
        expect(head![1], `${page} 的 #try 入口不在卡头——它掉回卡尾就又在折叠线以下`).toContain('href="#try"');
        const tail = html.slice(html.indexOf('</dl>', html.indexOf('hero-example')));
        expect(tail.slice(0, tail.indexOf('</article>')), `${page} 卡尾不该再有一份入口`).not.toContain('#try');
      }

      // 渐进增强的前提没变：入口默认不存在，只有面板真的装配好了才出现。
      expect(withoutComments).toMatch(/\.hero-example-cta\s*\{\s*display: none;/);
      expect(withoutComments).toMatch(/html\.js\.try-ready \.hero-example-cta\s*\{\s*display: inline-block;/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 落地页汉堡面板：绝对定位在吸顶头之下，比视口高时没有任何人替它滚
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 面板是绝对定位、包含块是吸顶的 `.site-header`，因此它超过视口高度时既不会被页面滚动
   * 带走、也没有任何东西替它滚——手机横屏（实测视口高 232px）下面板 552px、底边 610px，
   * 面板底部「English / GitHub / 完整对比」这三个出口怎么滚都够不到。修法是给它一个
   * 「视口 − 页头」的上限并让它自己滚。
   *
   * node 环境没有布局，几何读数只能记在 CHANGELOG；这里钉的是那三项声明本身。
   */
  describe('落地页汉堡面板不越出视口', () => {
    it('面板按「视口 − 页头」封顶并自己滚，滚到尽头不带走整页', () => {
      const css = read('docs/assets/landing.css').replace(/\/\*[\s\S]*?\*\//g, '');
      const block = /\.nav-menu-panel\s*\{([^}]*)\}/.exec(css)?.[1];
      expect(block, 'landing.css 里找不到 .nav-menu-panel 规则，守卫形同空转').toBeTruthy();
      const body = block!.replace(/\s+/g, ' ');

      // `100%` 解析的是包含块（页头）的高度，正好等于 `top: 100%` 那段偏移。
      expect(body, '面板少了视口上限：比视口高时底部入口永远够不到').toContain('max-height: calc(100dvh - 100%)');
      expect(body, '面板不能自己滚，上限只是把底部内容裁掉').toContain('overflow-y: auto');
      expect(body, '面板滚到尽头会把整页一起带着滚').toContain('overscroll-behavior: contain');
      // 写死像素会在页头变高时重新出界。
      expect(body, '上限不该是固定像素：页头一变高就又出界了').not.toMatch(/max-height:\s*\d+px/);

      // 面板成了滚动容器（overflow-y: auto 会把另一轴也变成 auto），满宽链接的焦点环
      // 若还画在盒外，左右各会被切掉 5px（3px 环 + 2px 偏移）——必须向内画。
      const focusRule = /\.nav-menu-panel a:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1];
      expect(focusRule, '面板链接没有专属的焦点环规则，满宽行在滚动容器里会被切边').toBeTruthy();
      expect(
        focusRule!.replace(/\s+/g, ' '),
        '焦点环要向内画（负 outline-offset），否则被面板这个滚动容器裁掉左右两边',
      ).toMatch(/outline-offset:\s*-\d+px/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 落地页特性区的三列门槛：不能比它自己的单卡下限还窄
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 基准规则是 `repeat(auto-fit, minmax(300px, 1fr))`——300px 是这张版式自己给
   * 单卡定的下限。而旧的三列断点写在 900px：那时内容宽 860px，三列每张只剩
   * 274.7px，比下限还窄一截，恰好是「断点一过卡片反而变窄」那种跳变。
   * 2026-10-23 在 CFT 155 里量过中英两页：900px 时特性区 3678.8 / 5245.5px 高，
   * 英文页单卡被压到 2240.7px；同样宽度改回两列后是 3584.7 / 4841.8px，单卡最高
   * 1330.2px。所以门槛按「三列都还不窄于下限」反算：3×300 + 2×18 间距 + 40 内边距
   * 得 976，取整到 1000。
   *
   * node 环境没有布局，这里钉的是这条算术：门槛、内边距、间距、下限四处任一改动
   * 只要让单卡重新掉到 300px 以下，这条就红。
   */
  describe('落地页特性区的三列门槛守得住单卡下限', () => {
    it('断点处算回来的单卡宽度不低于 auto-fit 那条 300px 下限', () => {
      const css = read('docs/assets/landing.css').replace(/\/\*[\s\S]*?\*\//g, '');

      const gridRule = /\.feature-grid\s*\{([^}]*)\}/.exec(css)?.[1];
      expect(gridRule, '落地页找不到 .feature-grid 基准规则，这条守卫形同空转').toBeTruthy();

      const floor = /minmax\(\s*(\d+)px\s*,\s*1fr\s*\)/.exec(gridRule!)?.[1];
      expect(floor, '基准规则不再是 auto-fit + minmax(Npx, 1fr)：单卡下限没有出处了').toBeTruthy();
      expect(gridRule!, '基准规则不再是 auto-fit：门槛以下就没有列数了').toContain('repeat(auto-fit');
      const gap = Number(/gap:\s*(\d+)px/.exec(gridRule!)?.[1]);
      expect(Number.isFinite(gap) && gap > 0, '特性区的 gap 读不出来，下面的减法算不出单卡宽度').toBe(true);

      const wrapRule = /\.wrap\s*\{([^}]*)\}/.exec(css)?.[1];
      expect(wrapRule, '落地页找不到 .wrap 规则').toBeTruthy();
      const pad = Number(/padding:\s*0\s+(\d+)px/.exec(wrapRule!)?.[1]);
      expect(Number.isFinite(pad) && pad > 0, '.wrap 的左右内边距读不出来，下面的减法算不出内容宽').toBe(true);

      // 三列那一档：找到写 repeat(6, 1fr) 的那条 `width >= Npx` 媒体查询。
      const threeUp = [...css.matchAll(/@media \(width >= (\d+)px\)\s*\{([\s\S]*?)\n\}/g)].find(m =>
        m[2].includes('repeat(6, 1fr)'),
      );
      expect(threeUp, '找不到把 .feature-grid 切成六列（每卡跨两列）的那条媒体查询').toBeTruthy();

      const threshold = Number(threeUp![1]);
      const cardAtThreshold = (threshold - 2 * pad - 2 * gap) / 3;
      expect(
        cardAtThreshold,
        `三列门槛 ${threshold}px 处单卡只有 ${cardAtThreshold.toFixed(1)}px，低于版式自己给的 ${floor}px 下限——` +
          '门槛一过卡片反而更窄、内容被压高，这正是这条守卫要拦的跳变',
      ).toBeGreaterThanOrEqual(Number(floor));
    });
  });

  /**
   * 两张整宽的卡各占满一行，剩下 10 张三列卡正好排出 3+3+3+1，最后一行只落一张、
   * 靠左悬着，右边空出三分之二。把它摆进中间那一格（`grid-column: 3 / span 2`）
   * 这一行才读成收尾。中英两页在 1000px 与 1280px 处量过：左右两侧留白逐像素相等
   * （326 / 326 与 379 / 379），行数仍是 5。
   *
   * 这条声明只在「余 1」时说得通，所以这里钉的是前提而不是像素：真机布局在 node
   * 环境里没有对应物，而卡数一变，居中就会从「收尾」变成「空两格」。同一条声明还
   * 有一个更隐蔽的破坏面——`:last-child` 的权重（0,2,0）压得过 `.feature-card-lg`
   * （0,1,0），最后一张若换成整宽卡，那半行就会被拽进中间两列。
   */
  describe('三列下最后一行那张孤卡摆在中间', () => {
    it('前提成立（余 1、末张不是整宽）且声明就在三列那一档里', () => {
      const css = read('docs/assets/landing.css').replace(/\/\*[\s\S]*?\*\//g, '');
      const threeUp = [...css.matchAll(/@media \(width >= (\d+)px\)\s*\{([\s\S]*?)\n\}/g)].find(m =>
        m[2].includes('repeat(6, 1fr)'),
      );
      expect(threeUp, '找不到把 .feature-grid 切成三列那一档媒体查询').toBeTruthy();
      expect(
        threeUp![2],
        '三列那一档里找不到 `.feature-card:last-child { grid-column: 3 / span 2 }`——孤卡又挂回左边了',
      ).toMatch(/\.feature-card:last-child\s*\{[^}]*grid-column:\s*3\s*\/\s*span\s*2/);

      for (const page of ['docs/index.html', 'docs/en.html']) {
        const classes = [...read(page).matchAll(/<article class="(feature-card[^"]*)"/g)].map(m => m[1]);
        expect(classes.length, `${page} 一张特性卡都没读到，下面的余数就成了空话`).toBeGreaterThan(0);
        const regular = classes.filter(c => !c.includes('feature-card-lg')).length;
        expect(
          regular % 3,
          `${page} 的三分之一宽卡片有 ${regular} 张（${classes.length} 张里 ${classes.length - regular} 张整宽），` +
            '除以 3 的余数已不是 1——最后一行要么排满、要么落两张，居中这一格不再说得通，请重新决定排版',
        ).toBe(1);
        expect(
          classes[classes.length - 1],
          `${page} 的最后一张是整宽卡：\`:last-child\` 的权重压得过 \`.feature-card-lg\`，会把它从 1 / -1 拽进中间两列`,
        ).not.toContain('feature-card-lg');
      }
    });
  });

  describe('页头锚点条溢出时只滚动自己，不压住出口簇', () => {
    /* 2026-10-24 用真 Chrome 量到的原形：英文页 1280 视口下 8 个锚点要 541px，
       而 1160 的容器只给得出 444px，链接直接画到 `.nav-actions` 上面——截图里读得出
       「CompareAlternativesFAQ」「Alternatives 压在 Use cases 上」这种叠字。
       五件事缺一件就退回原形（或退成一个新原形）：① 锚点条自己是横向滚动容器；
       ② 它按 padding box 裁切，所以落在盒外的东西都需要内边距垫底——`.site-nav > a::after`
       那根下划条是其一；②' 键盘焦点环是其二，而且这一条是改版之后**新长出来的**回归：
       `outline` 画在元素盒外，滚动容器一样照裁，真机读到「ring 7 / 上下各余 6 / 左余 0」，
       Tab 到第一个锚点时环的左半边整个不存在；③ 被截断的是哪一侧由 `data-edge` 分档
       （固定的右侧渐隐滚到底之后还在，看起来像永远还有更多）；④ 页头宽屏比正文宽——
       英文那一行要 1188px，`--lp-max` 的 1160 给不出。 */
    const css = (): string => read('docs/assets/landing.css').replace(/\/\*[\s\S]*?\*\//g, '');

    /** 取一个顶格选择器的声明块（够这几条判据用）。 */
    const block = (source: string, selector: string): string =>
      new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ??
      '';

    const px = (value: string | undefined): number => Number(value?.replace(/px$/, ''));

    /** 锚点条上那圈键盘焦点环的半径：全局 `outline` 线宽 + 本条自己的 `outline-offset`。 */
    const focusRingPx = (source: string): number => {
      const width = px(/(?:^|\n):focus-visible\s*\{[^}]*outline:\s*(\d+(?:\.\d+)?)px/.exec(source)?.[1]);
      const offset = px(
        /outline-offset:\s*(-?\d+(?:\.\d+)?)px/.exec(block(source, '.site-nav > a:focus-visible'))?.[1],
      );
      return width + offset;
    };

    /** 把 `.site-nav` 上的 padding 声明折成两个轴的可用余量（`padding` 简写 + 两轴长写）。
     *  两条长写都按声明边界锚定：不锚定时 `padding-inline` 会命中 `scroll-padding-inline`，
     *  于是「摘掉 padding 只留 scroll-padding」这种变异照样读出一个好看的余量。 */
    const padAxes = (navBlock: string): { block: number; inline: number } => {
      let blockPad = 0;
      let inlinePad = 0;
      const shorthand = /(?:^|;)\s*padding:\s*([^;]+)/.exec(navBlock)?.[1];
      if (shorthand) {
        const parts = shorthand.trim().split(/\s+/).map(px);
        if (parts.length === 1) [blockPad, inlinePad] = [parts[0], parts[0]];
        else if (parts.length === 2) [blockPad, inlinePad] = [parts[0], parts[1]];
        else [blockPad, inlinePad] = [Math.min(parts[0], parts[2]), Math.min(parts[1], parts[3])];
      }
      const pb = /(?:^|;)\s*padding-block:\s*(\d+(?:\.\d+)?)px/.exec(navBlock)?.[1];
      if (pb) blockPad = px(pb);
      const pi = /(?:^|;)\s*padding-inline:\s*(\d+(?:\.\d+)?)px/.exec(navBlock)?.[1];
      if (pi) inlinePad = px(pi);
      return { block: blockPad, inline: inlinePad };
    };

    /** 判据本体：一份样式表是否把锚点条做成了「自己滚动 + 三档渐隐 + 下划条与焦点环都在 padding 内」。 */
    const navIsOverflowSafe = (source: string): boolean => {
      const nav = block(source, '.site-nav');
      const after = block(source, '.site-nav > a::after');
      const bottom = Number(/bottom:\s*(-?\d+(?:\.\d+)?)px/.exec(after)?.[1]);
      const ring = focusRingPx(source);
      const pad = padAxes(nav);
      return (
        /overflow-x:\s*auto/.test(nav) &&
        /scrollbar-width:\s*none/.test(nav) &&
        Number.isFinite(bottom) &&
        Number.isFinite(ring) &&
        pad.block >= Math.max(ring, -bottom) &&
        pad.inline >= ring &&
        ['start', 'end', 'both'].every(edge =>
          new RegExp(`\\.site-nav\\[data-edge='${edge}'\\][^{]*\\{[^}]*mask-image:\\s*linear-gradient`).test(source),
        )
      );
    };

    /** 焦点环这一格单独长牙的写法：除了 `padding-inline`，其余判据全都在。
     *  两份对照都必须顶格写——`block()` 与焦点环那条按行首锚定，缩进会让它们读成空。 */
    const WITHOUT_INLINE_ROOM = `
:focus-visible { outline: 3px solid var(--lp-primary); outline-offset: 2px; }
.site-nav { display: flex; flex: 1; gap: 12px; min-width: 0; padding-block: 8px;
  overflow-x: auto; scrollbar-width: none; }
.site-nav > a::after { position: absolute; bottom: -5px; height: 2px; }
.site-nav > a:focus-visible { outline-offset: 4px; border-radius: 6px; }
.site-nav[data-edge='start'] { mask-image: linear-gradient(90deg, #000 calc(100% - 32px), transparent); }
.site-nav[data-edge='end'] { mask-image: linear-gradient(90deg, transparent, #000 32px); }
.site-nav[data-edge='both'] { mask-image: linear-gradient(90deg, transparent, #000 32px, #000 calc(100% - 32px), transparent); }
`;

    it('阳性对照：判据对改版前的写法、以及对「只留上下不留左右」都不点头', () => {
      const legacy = `
.site-nav { display: flex; flex: 1; gap: 18px; align-items: center; min-width: 0; font-size: 15px; }
.site-nav > a::after { position: absolute; bottom: -6px; height: 2px; }
@media (width <= 900px) {
  .site-nav { padding-right: 28px; padding-bottom: 4px; overflow-x: auto; scrollbar-width: none;
    mask-image: linear-gradient(90deg, #000 calc(100% - 26px), transparent); }
}
`;
      expect(navIsOverflowSafe(legacy), '判据对「链接画到出口簇上」的老写法也点头，等于什么都没守着').toBe(false);
      expect(
        focusRingPx(WITHOUT_INLINE_ROOM),
        '焦点环半径没从样式表里读出来（读成 0 或 NaN 时，下面那条对照就是空话）',
      ).toBe(7);
      expect(
        padAxes(block(WITHOUT_INLINE_ROOM, '.site-nav')),
        '对照样本里的 `padding-block` 没被读出来，那下面这条红就是假红',
      ).toEqual({ block: 8, inline: 0 });
      expect(
        navIsOverflowSafe(WITHOUT_INLINE_ROOM),
        '判据对「上下留了 8px、左右一分没留」点头——那正是 79dccc3 那一版的形状，Tab 到第一个锚点时环的左半边被裁掉',
      ).toBe(false);
    });

    it('锚点条自己滚动、下划条与键盘焦点环都落在 padding 内、渐隐按 data-edge 三档', () => {
      const source = css();
      expect(navIsOverflowSafe(source)).toBe(true);

      const ring = focusRingPx(source);
      const pad = padAxes(block(source, '.site-nav'));
      expect(ring, '焦点环半径读不出来').toBeGreaterThan(0);
      expect(
        pad.inline,
        `\`padding-inline\` 收掉了：滚动容器按 padding box 裁切，第一个锚点的焦点环左半边当场不存在（真机读到 ring ${ring} / 左余 0）`,
      ).toBeGreaterThanOrEqual(ring);
      expect(
        pad.block,
        `\`padding-block\` 收掉了：环的上下各 ${ring}px 会被裁，下划条也一起没了`,
      ).toBeGreaterThanOrEqual(ring);

      const wide = /@media \(width >= 1200px\)\s*\{\s*\.site-header \.wrap\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
      expect(wide, '页头在宽屏没有放宽 `.wrap`：英文那排 8 个锚点加三个出口要 1188px，1160 的容器放不下').toMatch(
        /max-width:\s*1360px/,
      );

      const bodyWidth = Number(/--lp-max:\s*(\d+)px/.exec(source)?.[1]);
      expect(bodyWidth, '正文宽度 `--lp-max` 读不出来，下面的比较就成了空话').toBe(1160);
      expect(Number(/max-width:\s*(\d+)px/.exec(wide)?.[1])).toBeGreaterThan(bodyWidth);
    });

    it('landing.js：三档按滚动位置算，滚轮到头就交还页面，高亮项沿用减弱动效的设置', () => {
      const js = read('docs/assets/landing.js');
      expect(js, '锚点条的溢出/截断判据不见了：`data-edge` 三档是把「还有更多」和「到头了」分开的唯一出口').toMatch(
        /const edge = atStart \? 'start' : atEnd \? 'end' : 'both';/,
      );
      expect(js, '只在值变了时才写属性，否则滚一下就让整条样式反复失效').toMatch(
        /getAttribute\('data-edge'\) !== edge/,
      );
      expect(js, '滚轮到头仍然 preventDefault 的话，指针停在页头上就再也滚不动页面').toMatch(
        /if \(next === navStrip\.scrollLeft\) return;\s*event\.preventDefault\(\);/,
      );
      expect(js, '高亮项没有被滚进视野：英文 1000 下读到最后几节时选中态落在条外').toMatch(
        /revealNavLink\(current\.find/,
      );
      expect(js, '高亮项自动跟进必须沿用 `scrollBehavior()`，减弱动效时不能硬滑').toMatch(
        /navStrip\.scrollTo\(\{\s*left:[^}]*behavior: scrollBehavior\(\)/,
      );
    });
  });

  describe('FAQ 每一问都可直达、可分享', () => {
    /* 2026-10-24 之前，52 条问题没有一条带 `id`：搜索结果与 AI 回答只能链到整节，
       同事之间也没法说「看第三问」。更深的一层是——就算有人手写了 `#faq-mock-2`，
       浏览器滚过去看到的仍是一条**折叠着**的问题，得再点一次才知道链接给对了没有。
       所以这一格要同时钉住四件事：id 存在、中英同序同集合、锚点指向自己、
       以及深链进来那一问是展开的。 */
    const FAQ_PAGES: Array<[string, string]> = [
      ['docs/en.html', 'docs/index.html'],
      ['docs/en-alternatives.html', 'docs/alternatives.html'],
    ];

    const faqSection = (file: string): string =>
      read(file).match(/<section\b[^>]*\bid="faq"[\s\S]*?<\/section>/)?.[0] ?? '';

    /** 按文档顺序读出每条问题的 `id` 与它那条 permalink 的 `href`。
     *  属性之间允许换行：prettier 会把这一长串折开，按「同一行」匹配就成了假红。 */
    const faqItems = (file: string): Array<{ id: string; href: string; anchors: number }> =>
      [...faqSection(file).matchAll(/<details id="([^"]+)">([\s\S]*?)<\/summary>/g)].map(m => {
        const tags = [...m[2].matchAll(/<a\b[^>]*class="faq-permalink"[^>]*>/g)];
        return {
          id: m[1],
          href: tags.length ? (/href="#([^"]+)"/.exec(tags[0][0])?.[1] ?? '') : '',
          anchors: tags.length,
        };
      });

    it('四条 FAQ 页每条都带 id，且锚点恰好一条、指向自己', () => {
      for (const [en, zh] of FAQ_PAGES) {
        for (const file of [en, zh]) {
          const items = faqItems(file);
          const bare = [...faqSection(file).matchAll(/<details>/g)].length;
          expect(items.length, `${file} 的 FAQ 小节一条问题都没读到，下面的断言就成了空话`).toBeGreaterThan(0);
          expect(bare, `${file} 里有 ${bare} 条没带 id 的 <details>：那一问谁也链不到`).toBe(0);
          for (const item of items) {
            expect(item.anchors, `${file} 的 #${item.id} 应当恰好一枚 permalink`).toBe(1);
            expect(item.href, `${file} 的 #${item.id} 那枚锚点指向了别处`).toBe(item.id);
          }
          expect(new Set(items.map(i => i.id)).size, `${file} 出现重复 id`).toBe(items.length);
        }
      }
    });

    it('中英两页同一序号的问题拿到同一个 id，深链不会在两语之间指错', () => {
      for (const [en, zh] of FAQ_PAGES) {
        const enIds = faqItems(en).map(i => i.id);
        const zhIds = faqItems(zh).map(i => i.id);
        expect(zhIds.length, `${en} / ${zh} 的条目数不等，id 的对应关系无从谈起`).toBe(enIds.length);
        expect(zhIds, '同一序号在中英两页指向了不同的问题（id 是按分类与顺序算出来的）').toEqual(enIds);
      }
    });

    it('landing.js 按 hash 展开那一问，样式在没有 JS 时把锚点整枚藏掉', () => {
      const js = read('docs/assets/landing.js');
      const openFn = /const openFromHash = \(\) => \{[\s\S]*?\n {4}\};/.exec(js)?.[0] ?? '';
      expect(openFn, 'openFromHash 读不出来（函数被改走了？），下面三条就成了空话').not.toBe('');
      expect(openFn, '深链进来不再展开那一问：折叠着的问题等于把答案藏回原来的位置').toMatch(
        /target\.tagName !== 'DETAILS' \|\| target\.open/,
      );
      expect(openFn, '只认 `<details>`：hash 指向小节标题或分类时不该有任何动作').toMatch(/getElementById/);
      expect(
        openFn,
        '落点归样式那条 scroll-margin-top 管，脚本这边只展开：实测补一次 scrollIntoView 是多余的接手（摘掉后真机 26 项读数逐位不变），而 behavior 写成 auto 还会跟随 html { scroll-behavior: smooth } 变成第二段动画',
      ).not.toMatch(/\.scrollIntoView\(/);
      expect(js, '只在 hashchange 时判一次的话，第一次点进来那一问仍是折叠的').toMatch(
        /window\.addEventListener\('hashchange', openFromHash\);\s*openFromHash\(\);/,
      );
      expect(js, '复制链接不该顺手把这一条开合掉').toMatch(/event\.preventDefault\(\);/);

      const css = read('docs/assets/landing.css').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css, '没有 JS 时这枚锚点会露出来：它点下去只会顺手开合这一条，复制那件事根本做不到').toMatch(
        /(?:^|\n)\.faq-permalink\s*\{\s*display: none;/,
      );
      expect(css, '深链落点没躲开吸顶页头：把这一问纠正到视口顶之后，问题正好压在页头底下，等于白滚').toMatch(
        /(?:^|\n)\.faq-list details\s*\{\s*scroll-margin-top:\s*88px;/,
      );
      expect(css, '复制成功那一下的弹跳在减弱动效档必须停，且 `html.js` 那一层要照抄（少写就压不住正文那条）').toMatch(
        /@media \(prefers-reduced-motion: reduce\)[\s\S]*?html\.js \.faq-permalink\.is-copied\s*\{\s*animation: none;/,
      );
    });
  });

  describe('FAQ 关键词筛选', () => {
    /* 「找答案」不该靠滚 21 条折叠项。这一格要钉住的是它的降级口径与实现边界：
       ① 没有 JS 时整块不出现（一个不会生效的输入框比没有更糟），问答照旧全部可读；
       ② 筛选用 `hidden` 属性而不是删节点——上面那三条 FAQ 守卫数的是源码里的条目数与顺序，
          而「第 3 问是 #faq-basics-3」这件事不能因为读者打了两个字就变；
       ③ 那句结果读数的**措辞住在 HTML**，脚本只挑 `data-*`（与预演面板同一条规矩），
          否则中英两页的话就有一份是脚本里写死的。 */
    const FILTER_PAGES = ['docs/index.html', 'docs/en.html', 'docs/alternatives.html', 'docs/en-alternatives.html'];

    const faqSectionOf = (file: string): string =>
      read(file).match(/<section\b[^>]*\bid="faq"[\s\S]*?<\/section>/)?.[0] ?? '';

    it('四页各有一个带标签的筛选框与一处结果读数', () => {
      for (const file of FILTER_PAGES) {
        const section = faqSectionOf(file);
        expect(section, `${file} 读不到 FAQ 小节`).not.toBe('');
        expect([...section.matchAll(/class="faq-filter"/g)].length, `${file} 的筛选项应当恰好一处`).toBe(1);
        const forId = /for="([^"]+)"/.exec(section)?.[1];
        expect(forId, `${file} 的筛选框标签没有 for，读屏念不出这格是干什么的`).toBeTruthy();
        expect(new RegExp(`id="${forId}"`).test(section), `${file} 的标签 for="${forId}" 指不到任何元素`).toBe(true);
        expect(/type="search"/.test(section), `${file} 的筛选框不是 type=search`).toBe(true);
        const status = /<p\b[^>]*class="faq-filter-status"[\s\S]*?>/.exec(section)?.[0] ?? '';
        expect(status, `${file} 读不到那句结果读数`).not.toBe('');
        expect(/role="status"/.test(status), `${file} 的结果读数不是 role=status`).toBe(true);
        expect(/aria-describedby="[^"]*"/.test(section), `${file} 的输入框没有 aria-describedby 指向读数`).toBe(true);
        const template = /data-count="([^"]*)"/.exec(status)?.[1] ?? '';
        expect(template, `${file} 的读数模板读不出来`).toContain('{n}');
        expect(template).toContain('{total}');
        expect(/data-empty="[^"]{4,}"/.test(status), `${file} 少了「没有匹配」那一句`).toBe(true);
      }
    });

    /**
     * 上面那条只验「标签指得到输入框」，没管标签**里那个数**。它写的是「筛选这 21 问」，
     * 而 21 是这条小节里 `<details id="faq-` 的条数——加一条问答却不改这句话，界面就当着读者
     * 说错自己有几条，且没有任何一处会红（本仓「散文里写一次版本号就假一次」同一族）。
     */
    it('标签里写给读者看的那个条数，等于这一页真的有的问答条数', () => {
      for (const file of FILTER_PAGES) {
        const section = faqSectionOf(file);
        const label = /class="faq-filter-label"[\s\S]*?>([\s\S]*?)</.exec(section)?.[1] ?? '';
        const claimed = Number((label.replace(/\s+/g, ' ').match(/\d+/) ?? [])[0]);
        const actual = [...section.matchAll(/<details id="faq-/g)].length;
        expect(
          Number.isInteger(claimed),
          `${file} 的筛选标签没写给读者看的条数（这一句是「这 N 问」的口径，缺了它读者不知道筛的是多大一堆）`,
        ).toBe(true);
        expect(claimed, `${file} 的筛选标签写着「${claimed} 问」，可这一页的小节里实际有 ${actual} 条`).toBe(actual);
      }
    });

    it('筛选靠 hidden 属性，不靠删节点；措辞全在 HTML 的 data-* 里', () => {
      const js = read('docs/assets/landing.js');
      expect(js, '筛掉一条改用移除节点的话，源码里的条目数与 id 顺序就与屏幕上不一致了').toMatch(/item\.hidden = !hit/);
      expect(js, '空掉的分类标题也要跟着收，否则底下空空的标题读起来像「这一节没有问答」').toMatch(
        /heading\.hidden = !anyVisible/,
      );
      expect(js, 'Esc 清空是这格的退路，读者打完字得能一把回到全部').toMatch(
        /event\.key !== 'Escape' \|\| !faqFilter\.value/,
      );
      expect(
        js,
        '筛选挡在深链前面时深链赢——而且让位之后要把它滚进视野：那一问刚从 display:none 出来，浏览器那一次滚的是空（真机量到停在原地 1691px）',
      ).toMatch(
        /faqFilter\.value = '';\s*apply\(\);\s*target\.scrollIntoView\(\{ behavior: scrollBehavior\(\), block: 'start' \}\)/,
      );
      expect(js, '读数模板从 HTML 挑，脚本里不该出现任何一句语言').not.toMatch(/问匹配|questions match/);
      expect(js, '「没有匹配」那句也只能住在 HTML：脚本的兜底必须留空，否则中英两页共享同一句写死的语言').toMatch(
        /data-empty'\)\) \|\| '';/,
      );
      expect(js, '总条数从条目自己数，别在脚本里写死 21').not.toMatch(/haystacks\.length \+ 21|total = 21/);

      const css = read('docs/assets/landing.css').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css, '没有 JS 时筛选框会露出来，可它什么都不会做').toMatch(/(?:^|\n)\.faq-filter\s*\{\s*display: none;/);
      expect(css, 'JS 在场时得真的画出来，光有上面那条负判据就是整块消失').toMatch(
        /html\.js \.faq-filter\s*\{\s*display: grid;/,
      );
      expect(css, '`details` 自带 display:list-item，只靠 UA 的 [hidden] 在个别引擎上压不住').toMatch(
        /html\.js \.faq-list details\[hidden\][^{]*\{\s*display: none;/,
      );
    });
  });

  /**
   * FAQ 卡片展开时的「长高」过渡。这里守的不是审美而是四件会静默坏掉的事：
   * ① 整层包在 `@supports selector(::details-content)` 里——不支持的引擎一条都不沾，
   *    行为与这层不存在时相同（真机 A/B 量过：摘掉两处 @supports 后，`block-size` 的
   *    中间像素读数为 0 个，盒高第一帧就是终值）；
   * ② 时长与曲线**必须**跟加减号、卡边、答案淡入是同一档（240ms + 签名曲线）——
   *    这四样说的是同一个动作，其中任何一件改了数，动作就裂成前后错位；
   * ③ `interpolate-size` 只许挂在 `.faq-list details` 上。它是可继承属性，
   *    写到 `:root` 会把站内**所有** `height: auto` 的过渡一并改成可插值，
   *    包括移动端菜单面板那两处与这一格无关的声明；
   * ④ reduce 档要把这层一起摘掉——只停答案淡入、留高度过渡，读起来仍是「跳一下」。
   * 动画对象本身在 Chrome 155 的 `getAnimations()` 里读不到（实测整表 85 条，挂在 DETAILS
   * 上的只有 border-*-color 与 box-shadow），所以这一格只能按源码契约钉，运行时那一面
   * 由逐帧盒高与 `::details-content` 的 used value 作证。
   */
  describe('FAQ 卡片展开时的高度过渡', () => {
    const css = () => read('docs/assets/landing.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const CURVE = 'cubic-bezier(0.16, 1, 0.3, 1)';

    const block = (needle: string): string => {
      const s = css();
      const at = s.indexOf(needle);
      if (at === -1) return '';
      const open = s.indexOf('{', at);
      let depth = 0;
      for (let i = open; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) return s.slice(open + 1, i);
        }
      }
      return '';
    };

    it('整层包在能力判定里，且四个面用的是同一条时长与曲线', () => {
      const s = css();
      expect(s, '这层没有包在 @supports 能力判定里：不支持的引擎会拿到一份说不清行为的 CSS').toMatch(
        /@supports selector\(::details-content\)/,
      );
      const guard = block('@supports selector(::details-content)');
      expect(guard, '能力判定那块是空的').not.toBe('');
      expect(guard).toMatch(/\.faq-list details\s*\{\s*interpolate-size:\s*allow-keywords;/);
      expect(guard).toMatch(/\.faq-list details::details-content\s*\{/);
      expect(guard).toMatch(/\.faq-list details\[open\]::details-content\s*\{\s*block-size:\s*auto;/);
      expect(guard, '收起时 content-visibility 那一刀要在动画末尾落下，不然读者看到「先空后长」').toMatch(
        /transition-behavior:\s*allow-discrete;/,
      );
      expect(guard, '过渡必须同时管着 block-size 与 content-visibility，只写一个就是半截动画').toMatch(
        /transition:\s*block-size\s+0\.24s\s+cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\),\s*content-visibility\s+0\.24s;/,
      );
      expect(guard, '长高途中要裁掉溢出，否则答案会从还矮的盒子里漏出去').toMatch(/overflow:\s*clip;/);
      expect(guard).not.toMatch(/transition:\s*all/);

      /* 同一个动作的另外三面：答案淡入、卡边、加减号，读数必须与上面那一档逐字相同。 */
      expect(s, '答案淡入与卡片长高不同档了——它们说的是同一个动作').toMatch(
        new RegExp(`details\\[open\\] > p \\{\\s*animation: lp-answer 0\\.24s ${CURVE.replace(/[.()]/g, '\\$&')}`),
      );
      expect(s, '卡片描边/阴影的过渡与长高不同档了').toContain(
        `transition:\n    border-color 0.24s ${CURVE},\n    box-shadow 0.24s ${CURVE};`,
      );
    });

    it('interpolate-size 只挂在 FAQ 的 details 上，不挂到根元素', () => {
      const s = css();
      const hits = [...s.matchAll(/interpolate-size:/g)].length;
      expect(hits, 'interpolate-size 出现的次数与守卫预期不符——回来把这一条的口径一起重判').toBe(1);
      const rootish =
        /(?:^|\n)\s*:root\s*\{[^}]*interpolate-size/.test(s) || /(?:^|\n)\s*html\s*\{[^}]*interpolate-size/.test(s);
      expect(
        rootish,
        '写到 :root/html 上会把站内所有 height:auto 的过渡改成可插值（含移动端菜单面板那两处），这一格的范围是 FAQ 卡片',
      ).toBe(false);
    });

    it('reduce 档把这层一起摘掉', () => {
      const s = css();
      const at = s.indexOf('@media (prefers-reduced-motion: reduce)');
      expect(at, '读不到 reduce 那一段').toBeGreaterThan(-1);
      const open = s.indexOf('{', at);
      let depth = 0;
      let end = -1;
      for (let i = open; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const reduce = s.slice(open, end);
      expect(reduce, 'reduce 段里没有 ::details-content 这一条：只停淡入、留高度过渡，读起来仍是「跳一下」').toMatch(
        /\.faq-list details::details-content\s*\{\s*transition:\s*none;/,
      );
      expect(reduce, 'reduce 段里的这一条也得包在能力判定里，否则不支持的引擎拿到一条永远不匹配的声明').toContain(
        '@supports selector(::details-content)',
      );
    });
  });

  describe('llms 文件承诺的问答锚点真的对得上页面', () => {
    /* 面向 AI 的那两份文件现在写了一句可核对的话：「每一条问题都有锚点，中英同一序号
       指同一问」。这句话一旦与页面脱钩，被引用的锚点就是 404 级别的东西——所以它必须
       是被查过的，而不是写下去就永远成立。 */
    const ANCHOR_RE = /#(faq-[a-z]+-\d+|faq-\d+)\b/g;

    const idsOn = (file: string): string[] => [...read(file).matchAll(/<details id="([^"]+)"/g)].map(m => m[1]);

    const categoryIdsOn = (file: string): string[] =>
      [...read(file).matchAll(/class="faq-category"[\s\S]{0,80}?id="(faq-[a-z-]+)"/g)].map(m => m[1]);

    it('两份 llms 文件都还在说锚点这件事', () => {
      const full = read('docs/llms-full.txt');
      const index = read('docs/llms.txt');
      expect(full, 'llms-full 少了那一节：AI 系统就不知道该引用某一问而不是整页').toMatch(
        /Citable anchors for every FAQ question/,
      );
      expect(full).toMatch(/cites?|cite the fragment|引用锚点|请引用锚点/);
      expect(index, 'llms.txt 那份简明索引没跟上').toMatch(/锚点/);
      expect(index, 'llms.txt 只留了中文那半句：这份索引是双语一行的，英文半边也要在').toMatch(/citable fragment/i);
    });

    it('文中举例的每一个锚点，在中英两页都查得到对应的条目', () => {
      const cited = new Set<string>();
      for (const file of ['docs/llms-full.txt', 'docs/llms.txt']) {
        for (const m of read(file).matchAll(ANCHOR_RE)) cited.add(m[1]);
      }
      expect(cited.size, '两份 llms 文件里一个锚点例子都没读到，这条断言就成了空话').toBeGreaterThan(0);
      const zh = idsOn('docs/index.html');
      const en = idsOn('docs/en.html');
      for (const anchor of cited) {
        expect(zh, `llms 文件举例用了 #${anchor}，中文页查不到这一问`).toContain(anchor);
        expect(en, `llms 文件举例用了 #${anchor}，英文页查不到这一问`).toContain(anchor);
      }
    });

    it('列出的分类清单与页面实际的分类标题一一对应', () => {
      const listed = [...read('docs/llms-full.txt').matchAll(/`(faq-[a-z]+)`/g)].map(m => m[1]);
      const unique = [...new Set(listed)];
      expect(unique.length, 'llms-full 里一个分类 id 都没列出来，下面的比较就是空话').toBeGreaterThan(0);
      for (const file of ['docs/index.html', 'docs/en.html']) {
        const actual = categoryIdsOn(file);
        expect(actual.length, `${file} 读不到分类标题的 id`).toBeGreaterThan(0);
        expect(unique.sort(), `llms 文件列的分类与 ${file} 实际的分类标题不一致`).toEqual([...actual].sort());
      }
    });
  });

  describe('落地页菜单顺序跟随正文', () => {
    /**
     * 菜单是滚动的目录，不是「动作项收尾」的排版偏好：读者照着菜单往下走，
     * 顺序反了就会被从最后一节拽回上面一节。2026-09-27 中英两页都把「常见问题」
     * 写在「安装」之前，而正文里 `#install` 本来就在 `#faq` 前面。
     *
     * 这条判据在实现侧没有任何运行时对应物——`landing.js` 的区块高亮按 DOM 现算、
     * 不认菜单顺序，所以排反了界面照样亮得起来，只有读者察觉得到。
     */
    const LANDING_PAGES = ['docs/index.html', 'docs/en.html'];

    /** 桌面横条 `.site-nav` 里的锚点，按出现顺序。 */
    const desktopNav = (html: string): string[] => {
      const block = /<nav[^>]*class="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
      return [...(block?.[1] ?? '').matchAll(/href="#([a-z0-9-]+)"/g)].map(m => m[1]);
    };
    /** ≤760px 汉堡面板里的锚点（同批锚点的第二簇），排掉面板尾部的站外出口。 */
    const panelNav = (html: string, known: Set<string>): string[] => {
      const block = /<div class="nav-menu-panel">([\s\S]*?)<\/details>/.exec(html);
      return [...(block?.[1] ?? '').matchAll(/href="#([a-z0-9-]+)"/g)].map(m => m[1]).filter(id => known.has(id));
    };
    /** 正文里带 id 的顶层小节，按文档顺序——也就是滚动顺序。 */
    const documentOrder = (html: string): string[] =>
      [...html.matchAll(/<section[^>]*\bid="([a-z0-9-]+)"/g)].map(m => m[1]);
    /** `wanted` 是否按序嵌在 `order` 里（允许正文里有菜单没列的小节）。 */
    const isSubsequence = (wanted: string[], order: string[]): boolean => {
      let i = 0;
      for (const id of order) if (i < wanted.length && wanted[i] === id) i += 1;
      return i === wanted.length;
    };

    it('阳性对照：判据真的认得出反序', () => {
      const order = ['problem', 'features', 'install', 'faq'];
      expect(isSubsequence(['install', 'faq'], order), '按正文顺序应当放行').toBe(true);
      expect(isSubsequence(['faq', 'install'], order), '把相邻两枚调个位必须判红').toBe(false);
      expect(isSubsequence(['features', 'problem'], order), '跨枚调序同样必须判红').toBe(false);
    });

    it('两簇菜单同序，且顺序等于正文小节的滚动顺序', () => {
      for (const file of LANDING_PAGES) {
        const html = read(file);
        const nav = desktopNav(html);
        expect(nav.length, `${file} 的 .site-nav 一条锚点都没解析到，守卫失效`).toBeGreaterThanOrEqual(6);
        const sections = documentOrder(html);
        expect(sections.length, `${file} 解析不到带 id 的小节，守卫失效`).toBeGreaterThan(nav.length);

        const panel = panelNav(html, new Set(nav));
        expect(panel, `${file} 的汉堡面板一条锚点都没解析到，守卫失效`).not.toHaveLength(0);
        expect(panel, `${file} 汉堡面板与桌面横条不同序`).toEqual(nav);

        const missing = nav.filter(id => !sections.includes(id));
        expect(missing, `${file} 菜单指向了正文里不存在的小节：${missing.join(', ')}`).toEqual([]);
        expect(
          isSubsequence(nav, sections),
          `${file} 菜单顺序与正文滚动顺序不符：菜单 ${nav.join(' → ')}｜正文 ${sections.join(' → ')}`,
        ).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 商店提审素材：CHROMEWEBSTORE.md 是商店表单的唯一素材源
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Chrome 商店提审素材', () => {
    const doc = read(STORE_DOC);

    /**
     * 全仓库的商店链接必须共用同一个扩展 ID，真值取 `CHROMEWEBSTORE.md` 的 Store URL 行。
     *
     * 只匹配「`detail/` 后紧跟一段无连字符的 slug」，因此对比页里引用的竞品链接
     * （`detail/<slug>/<id>` 形式，slug 含连字符）不会被误计。此前实测存在三种写法
     * （30 位漏字、32 位换字、真值），JSON-LD 的那两份正是错的。
     *
     * 同一个判据也覆盖 `img.shields.io/chrome-web-store/v/<id>.json`：那三本手册与两份
     * README 用它量「商店在装哪个版本」，抄错一位就打出一个 `not found`，而 `not found`
     * 在那个端点上同时是「ID 不存在」与「shields 抓不到商店页」两种说法的落点——写错的
     * 那个人恰恰是最容易把它读成「条目被下架」的人。2026-10-07 就是这么漏进去过一次（§12
     * 那段记录里的 URL 少打两个字符，32 位写成 30 位，第二天照它复算才撞上）。`GITHUB.md`
     * §7 用的是 `<id>` 占位写法，这个字符类匹配不到它，也不会误报。
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

      const badgeSources = [...new Set([...STORE_URL_SOURCES, RELEASING_DOC, GITHUB_DOC])].filter(exists);
      const badges = badgeSources.flatMap(file => [
        ...read(file)
          .matchAll(/img\.shields\.io\/chrome-web-store\/v\/([a-z0-9]{8,})(?![a-z0-9])/g)
          .map(m => ({ file, id: m[1] })),
      ]);
      expect(badges.length, '文档里应当出现 shields 商店版本徽章').toBeGreaterThan(0);
      const wrongBadges = badges
        .filter(row => row.id !== truth)
        .map(row => `${row.file}: ${row.id}（${row.id.length} 位，真值 ${truth?.length ?? 0} 位）`);
      expect([...new Set(wrongBadges)].sort(), 'shields 徽章 URL 里的扩展 ID 与商店链接不是同一个').toEqual([]);
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

    /**
     * 可再生的本地产物根，一份都不许进 git 索引。
     *
     * 判据取 `git ls-files` 而不是 `git check-ignore`：后者默认跳过已跟踪路径，
     * 恰好放过这里要防的那一件事（有人真的把片子 `git add` 了进去）。2026-09 那次是
     * `.test-tmp/` 里的 Chrome for Testing 把 `.git` 撑到 195MB，重写历史才清掉；
     * `store-assets/` 现在又多了一对 13MB 量级的宣传视频（`pnpm promo` 的产物），
     * 是同一件事的第二条路，所以按前缀钉住，不靠人记得 `.gitignore` 还在。
     */
    it('可再生的本地产物不进 git 索引', () => {
      const LOCAL_ONLY_ROOTS = ['.test-tmp/', 'store-assets/', 'marketing/'];
      const LOCAL_ONLY_FILES = ['.env.submit'];
      const tracked = [...trackedFiles()];
      const leaked = tracked.filter(
        file => LOCAL_ONLY_ROOTS.some(root => file.startsWith(root)) || LOCAL_ONLY_FILES.includes(file),
      );
      expect(leaked, '这些路径可再生、且单个文件就是十几 MB，入库就是把仓库撑爆的那一步').toEqual([]);
      // 空索引会让上面那句永远绿，所以把量具自己钉一下。
      expect(tracked.length, 'git ls-files 一条路径都没读到，这条守卫等于空转').toBeGreaterThan(100);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 版本与发布契约
  // ═══════════════════════════════════════════════════════════════════════════

  describe('版本历史与发布契约', () => {
    /**
     * `release.yml` 用 awk 从 `CHANGELOG.md` 里切出 `## [<tag 版本>]` 那一小节当 GitHub Release
     * 的说明，而 tag 版本来自 `package.json`——所以「顶部第一个版本小节 == `package.json`」就是
     * 发布说明对不对的那条契约本身。release-please 在同一个 PR 里同时写这两处（版本号进
     * `package.json` 与 `.release-please-manifest.json`，小节进 `CHANGELOG.md`），人在合并前
     * 往那个小节里补中英长文。
     *
     * 从前这里的第二条断言是「必须存在 `## [Unreleased]`」，那是手工 bump 时代的暂存区约定。
     * 换成机器人写小节之后它**有害**：release-please 找插入点用的正则是 `\n###? v?[0-9[]`，
     * `## [Unreleased]` 里那个 `[` 恰好命中，于是新生成的 `## [1.4.0]` 会插在它**上面**，
     * 整个已发布历史被推到「Unreleased」这个标题下面，读起来像上一版还没发布。
     */
    it('CHANGELOG.md 顶部版本小节等于 package.json', () => {
      const sections = [...read('CHANGELOG.md').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(m => m[1]);
      expect(sections.length, 'CHANGELOG.md 里找不到任何 `## [x.y.z]` 小节').toBeGreaterThan(0);
      expect(sections[0], `顶部小节是 ${sections[0]}，而 package.json 是 ${pkg.version}`).toBe(pkg.version);
      /**
       * 与上面那条同一个正则事实的另一半：草稿区标题**行首**不得写成 `## [Unreleased]`。
       * 行中出现是允许的（文件顶部那段说明就得把那个写法点名给后来的人看），
       * 因为机器人的锚点要求 `\n` 紧贴 `#`，只有行首那一种写法会真的把插入点抢走。
       */
      expect(read('CHANGELOG.md'), '`## [Unreleased]` 写在行首会抢走 release-please 的插入点').not.toMatch(
        /^## \[Unreleased\]/m,
      );
    });

    /**
     * 版本号写在 `package.json`，机器人算下一级的基准在 `.release-please-manifest.json`；
     * 其余被跟踪的文本文件**不许复述当前那个号**——一次 bump 只动它自己那两份文件，
     * 被抄进句子里的那些地方就从「真话」变成「没人会想起来改的假话」。
     *
     * 这条以前是反过来的：`docs/llms-full.txt` 两句与 `.github/ISSUE_TEMPLATE/bug_report.yml`
     * 的示例版本必须等于 `package.json`，于是每次 bump 都得人肉跟三处——`1.1.0 → 1.2.0`
     * 那一次就当场漏了两处。更重要的是它在机器人时代必红：release-please 在同一个 PR 里把
     * `package.json` 抬一级，那三处散文里的号它还写不了（写号要改正文，不是行内替换）。
     * 判据因此换成「这些句子不许带号」：会假的地方从三处变成零处。
     *
     * 判据是「整仓减去一份清单」而不是「只查某几个文件」，因为想写号的地方事先不知道。
     * 清单里每一项都得说得出它为什么必须写号：
     *
     * - `package.json`、`.release-please-manifest.json`：写号就是它们的职责。
     * - `CHANGELOG.md`、`.github/docs/CHROMEWEBSTORE.md`：版本历史与商店文案台账，按设计一行一个号。
     *   后者按**整条路径**匹配，不是按目录：`.github/docs/` 里的另两份（GITHUB、RELEASING）
     *   本来就不该写开发中的版本号，把整个目录放进清单等于悄悄放弃对它们的扫描。
     * - `docs/`（前缀匹配）：产品页说的是**商店在装的已发布版本**，而 `CHROMEWEBSTORE.md` §12
     *   那份翻牌清单会把它翻成**刚发布的那个号**——那一刻它和 `package.json` 恰好相等。
     *     这一项不是通融，是「整仓扫」这个前提本身的错：仓库里带过版本号的文件有十五个，
     *     逐处改措辞改不完，而照着 §12 翻完牌的那一次提交必然让这条断言当场变红。
     * - `utils/har.ts`、`tests/exportSanitize.test.ts`：那儿的 `1.0.0` 是 **HAR 规范的
     *   `log.version`**，与产品版本无关，纯属两个号长一样的巧合。
     * - 本测试文件：它得点名上面这些文件，写不出一份「不含自己的清单」。
     * - `pnpm-lock.yaml`：包管理器生成的，人不编辑。
     *
     * 以后想在别处写号：先把句子改成指针（「见 `CHANGELOG.md` 顶部小节」），改不动再把那个
     * 文件连同它必须写号的理由加进这份清单。
     */
    it('当前版本号只出现在职责所在的那几份文件里', () => {
      const VERSION_EXEMPT = [
        'package.json',
        '.release-please-manifest.json',
        'CHANGELOG.md',
        STORE_DOC,
        'docs/',
        'utils/har.ts',
        'tests/exportSanitize.test.ts',
        'tests/docs-consistency.test.ts',
        'pnpm-lock.yaml',
      ];
      const isExempt = (file: string): boolean =>
        VERSION_EXEMPT.some(holder => (holder.endsWith('/') ? file.startsWith(holder) : file === holder));
      const TEXT_EXT = /\.(md|txt|json|ya?ml|ts|tsx|js|mjs|cjs|vue|css|html|xml)$/i;
      const claimed = [...trackedFiles()]
        .filter(file => exists(file) && TEXT_EXT.test(file) && !isExempt(file))
        .filter(file => new RegExp(`(?<![\\d.])${pkg.version.split('.').join('\\.')}(?![\\d.])`).test(read(file)));
      expect(
        claimed,
        `这些文件复述了开发中的版本号 ${pkg.version}——版本号由 release-please 维护，散文里写一次就假一次`,
      ).toEqual([]);
    });

    /**
     * 上面那条只说「不许写号」，容易被理解成「把那句删掉就干净了」——那会让面向 AI 的公开出口
     * 从此不告诉读者去哪里看开发版本。所以这三处**指针式措辞**必须还在：改写措辞同样红，
     * 因为那意味着这份清单与文档脱钩了。
     */
    it('不复述版本号的那三处仍然指向 CHANGELOG，而不是被整句删掉', () => {
      const VERSION_POINTERS: { file: string; phrase: string; label: string }[] = [
        {
          file: 'docs/llms-full.txt',
          phrase: 'The version under development is the newest section of CHANGELOG.md',
          label: 'llms-full.txt 头部 `Last verified` 那行',
        },
        {
          file: 'docs/llms-full.txt',
          phrase: 'for the version under development see the newest section of CHANGELOG.md',
          label: 'llms-full.txt 页脚 `Last updated` 那行',
        },
        {
          file: '.github/ISSUE_TEMPLATE/bug_report.yml',
          phrase: '扩展版本 X.Y.Z',
          label: 'bug 报告模板里那行占位示例',
        },
      ];
      for (const { file, phrase, label } of VERSION_POINTERS) {
        expect(read(file), `${label}（${file}）里那句指向 CHANGELOG 的话不见了`).toContain(phrase);
      }
    });

    it('商店文档里的包名模板与 wxt zip 的产物命名一致', () => {
      // wxt 默认产物：`<package-name>-<version>-<browser>.zip`
      expect(read(STORE_DOC)).toContain(`${pkg.name}-<version>-chrome.zip`);
    });

    it('pnpm build 单次构建同时产出解压目录与商店 zip，图标与 prepare 自动跟进', () => {
      // 与 account-password-helper 的命令面保持一致：`pnpm build` 一次产出两者，
      // `build:zip` 只是既有发布脚本仍在用的别名；图标与 WXT 类型都在构建/安装时自动生成。
      expect(pkg.scripts.build).toBe('wxt zip');
      expect(pkg.scripts['build:zip']).toBe('pnpm run build');
      expect(pkg.scripts.prebuild).toBe('pnpm run icons:build');
      expect(pkg.scripts['icons:build']).toBe('node scripts/generate-icons.mjs');
      expect(pkg.scripts.postinstall).toBe('wxt prepare');
      expect(pkg.scripts.analyze).toContain('--analyze');
    });

    it('版本号只在 package.json，wxt.config.ts 不得重新声明 manifest.version', () => {
      expect(read('wxt.config.ts')).not.toMatch(/^\s*version:\s*['"]/m);
    });

    /**
     * `.release-please-manifest.json` 是机器人算下一个版本号的**基准**（`Manifest` 直接
     * `Version.parse(manifest[path])`，格式是 `{"."： "<版本字符串>"}`，写成对象会当场抛）。
     * 它落后于 `package.json` 时机器人会算出一个已经发过的号，领先时它会跳过本该发的那一级。
     * 两者只在「合并 release PR」那一个提交里同时前进，所以对账是恒等式，不是「不得大于」。
     */
    it('release-please 的版本基准等于 package.json', () => {
      const manifest = JSON.parse(read('.release-please-manifest.json')) as Record<string, unknown>;
      expect(typeof manifest['.'], 'manifest 的 `.` 必须是版本字符串（v4 的格式，不是对象）').toBe('string');
      expect(manifest['.'], `机器人以为已发布 ${String(manifest['.'])}，而 package.json 是 ${pkg.version}`).toBe(
        pkg.version,
      );
    });

    /**
     * 配置文件里有四条是**装上去才知道错**的，每条都对应一个静默失效：
     *
     * - `include-component-in-tag` 必须为 `false`：单包仓库默认也是 `true` 的话 tag 会变成
     *   `cross-origin-proxy-1.4.0`，而 `release.yml` 的触发条件是 `v*`，发布链路整个不响。
     * - `skip-github-release` 必须为 `true`：发版是「人推 tag」那一下（推 tag 即向商店提审，
     *   不可撤回且有配额），不能是「合并 PR」的副作用。而且机器人用默认 `GITHUB_TOKEN`
     *   打的 tag 根本不会触发 `release.yml`——GitHub 不再由该令牌产生的事件起跑新工作流。
     * - `changelog-sections` 不许收 `chore`：release-please 合并 PR 自己那一条就是
     *   `chore: release 1.4.0`，收了它就是把机器人的提交写进用户看的 Release 说明。
     *   顺带，未列出的类型既不进小节也**不参与 bump**（`changelogEmpty` 直接跳过整个 PR），
     *   所以「只发文档」的那次合并不会挤出一个人人得看的空版本。
     * - 小节名彼此唯一：`conventional-changelog-writer` 按 type 逐个渲染标题，两个 type 撞同名
     *   标题会在小节里出现两次 `### Changed`。
     */
    it('release-please 配置守住发版链路的四个静默失效点', () => {
      const config = JSON.parse(read('release-please-config.json')) as {
        'release-type'?: string;
        'include-component-in-tag'?: boolean;
        'skip-github-release'?: boolean;
        'changelog-sections'?: { type: string; section: string; hidden?: boolean }[];
        'extra-files'?: unknown;
        packages?: Record<string, unknown>;
      };
      expect(config['release-type'], 'release-type 必须是 node，才会写 package.json 的版本').toBe('node');
      expect(config['include-component-in-tag']).toBe(false);
      expect(config['skip-github-release']).toBe(true);
      expect(config.packages?.['.'], '`.` 必须列在 packages 下，否则机器人找不到这个包').toBeTruthy();

      const sections = config['changelog-sections'] ?? [];
      expect(sections.length, 'changelog-sections 为空就是所有提交都不发版').toBeGreaterThan(0);
      const types = sections.map(s => s.type);
      expect(types, 'chore 会把机器人自己的合并提交写进 Release 说明').not.toContain('chore');
      expect(
        sections.some(s => s.type === 'feat' && s.section),
        'feat 必须可见，否则加功能不发版',
      ).toBe(true);
      expect(
        sections.some(s => s.type === 'fix' && s.section),
        'fix 必须可见，否则修 bug 不发版',
      ).toBe(true);
      const headings = sections.map(s => s.section);
      expect(new Set(headings).size, '两个 type 撞同名小节会渲染出两条一样的标题').toBe(headings.length);
    });

    /**
     * 机器人找「上一次发布在哪」的两步可能同时落空：本仓库一个 GitHub Release 都没有
     * （`skip-github-release`），而 §2 那条「先推 tag、后推 main」没做到时远程也没有 tag。
     * 那一刻它认定仓库需要 bootstrap，于是往回一路收提交，上限
     * `DEFAULT_COMMIT_SEARCH_DEPTH = 500`——本仓库全部历史都不到这个数，结果是第一份发布 PR
     * 把已经发布过的提交从头再列一遍。`bootstrap-sha` 就是给这条路径设的地板。
     *
     * 只校验形状（40 位十六进制），不校验「解析得到提交」：CI 的 `actions/checkout` 默认
     * `fetch-depth: 1`，浅克隆里那个 sha 本来就查不到，按可解析判会把这条守卫变成只在
     * 本机绿、在 CI 必红的东西。（本机核过它确实是一个存在的提交。）
     */
    it('release-please 配置钉了 bootstrap 地板', () => {
      const config = JSON.parse(read('release-please-config.json')) as { 'bootstrap-sha'?: string };
      expect(config['bootstrap-sha'], '缺 bootstrap-sha：tag 未落地的那一次首跑会把历史重新列一遍').toMatch(
        /^[0-9a-f]{40}$/,
      );
    });

    /**
     * 「先推 tag、再推 main」写在两份文档里，而它对抗的是那条 bootstrap 陷阱：合成一条
     * `git push origin main vX.Y.Z` 看着省事，GitHub 却不保证两个 ref 谁先落地。main 先落地、
     * tag 还在途时，机器人按 `.release-please-manifest.json` 找的那个 tag 不存在，于是认定
     * 仓库需要 bootstrap，把已经发布过的提交从头再列一遍（配置里的 `bootstrap-sha` 是那一幕
     * 的兜底，不是拿来替代顺序的）。`--tags` 同罪：它推的是本机所有 tag，多打一个就多发一版。
     */
    it('发版文档分两条命令推：先 tag、后 main', () => {
      // `(?:-u\s+)?` 不是装饰：`git push -u origin --tags` 是新手最顺手的那条命令，
      // 而它推的是本机**所有** tag，多打一个就多发一版。少了这个可选段，正则只拦得住
      // 不带 -u 的写法，这条恰好从缝里过去。
      const combined = /git push\s+(?:-u\s+)?origin\s+(?:main\s+v|--tags)/;
      for (const file of [RELEASING_DOC, 'AGENTS.md', 'CONTRIBUTING.md', 'release-please-config.json']) {
        expect(read(file), `${file} 里又出现了「一条命令同时推 main 与 tag」的写法`).not.toMatch(combined);
      }
      expect(read(RELEASING_DOC), '§2 第 4 步那两条分开的 push 不见了').toContain('git push origin vX.Y.Z');
      expect(read('AGENTS.md'), '速查表不再说顺序').toContain('先推 tag');
    });

    /**
     * `extra-files`（行内标记替换）留在这里的唯一理由是「把版本号抄进散文」。既然那三处
     * 已经改成不带号，留着标记就是留着一条「机器人会悄悄改你的正文」的路——而它在 `.txt`
     * 里只能写成看得见的 `<!-- -->`。所以这条守的是「别把这条通道再开回去」。
     */
    it('没有第二份需要机器人代抄的版本号', () => {
      const config = JSON.parse(read('release-please-config.json')) as { 'extra-files'?: unknown[] };
      expect(config['extra-files'] ?? [], 'extra-files 里的每一处都是一份手抄的版本号').toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 工作流关键契约（YAML 无法本机执行，至少守住这些字符串）
  // ═══════════════════════════════════════════════════════════════════════════

  describe('GitHub 工作流关键契约', () => {
    const ci = read('.github/workflows/ci.yml');
    const pages = read('.github/workflows/deploy-pages.yml');
    const release = read('.github/workflows/release.yml');
    const releasePlease = read('.github/workflows/release-please.yml');
    const storePublish = read('.github/workflows/store-publish.yml');
    const verify = read('.github/actions/verify/action.yml');
    const notesAction = read('.github/actions/release-notes/action.yml');
    const gateScript = read('scripts/release-gate.mjs');
    const preflightScript = read('scripts/store-preflight.mjs');

    /**
     * 作业级切分：YAML 在这里只按「两个空格缩进的就是作业名」拆，不引解析器（见文件头那句
     * 「只依赖 fs 与正则」）。拆出来是为了把断言**绑到具体那一格**——整文件 grep 一次
     * `approval-state == 'configured'` 拦不住「把它从 confirm 挪到 prepare 上」这种改法，
     * 而那一挪正好让审批闸门失效。
     */
    const jobsOf = (yaml: string): Record<string, string> => {
      const body = yaml.split(/^jobs:$/m)[1] ?? '';
      const marks = [...body.matchAll(/^ {2}([a-z][\w-]*):$/gm)];
      const out: Record<string, string> = {};
      marks.forEach((mark, index) => {
        out[String(mark[1])] = body.slice(
          Number(mark.index) + mark[0].length,
          index + 1 < marks.length ? Number(marks[index + 1].index) : body.length,
        );
      });
      return out;
    };
    const publishJobs = jobsOf(storePublish);

    /**
     * 把 `on.workflow_call` 那一块里的 `type:` 值按缩进切出来。
     *
     * 存在的理由是一条 GitHub 的硬规则：**被调用的工作流只认 `boolean` / `number` / `string`
     * 三种输入类型**，`choice` 与 `environment` 是 `workflow_dispatch` 专属。写错的代价不是
     * 「那个字段少了下拉框」，而是**整份工作流文件解析失败**：GitHub 把这条链路判成 failure、
     * 一个作业都不起跑，Run 页面只显示文件名，日志是空的（2026-10-09 首次开 PR 就是撞在这里，
     * `release.yml` 与 `store-publish.yml` 两格同时零作业红，本机 YAML 却解析得好好的）。
     */
    const workflowCallTypes = (yaml: string): string[] => {
      const lines = yaml.split('\n');
      const start = lines.findIndex(line => /^ {2}workflow_call:\s*(#.*)?$/.test(line));
      if (start < 0) return [];
      const out: string[] = [];
      for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[Number(index)];
        if (line.trim() === '' || /^\s*#/.test(line)) continue;
        // 缩进退回 ≤2 个空格 = `workflow_call` 这一块结束（下一个 `on:` 平级键，比如 dispatch）。
        if (!/^ {3,}\S/.test(line)) break;
        const type = line.match(/^ +type:\s*(\S+)\s*$/);
        if (type) out.push(String(type[1]));
      }
      return out;
    };
    const CALL_TYPES = ['boolean', 'number', 'string'];

    /**
     * 把一份 YAML 里的步骤按文件顺序切成「步名 + 那一步的原文」。
     *
     * 不引 YAML 解析器（文件头那句「只依赖 fs 与正则」在这条上同样成立），按 `- name:` 的缩进
     * 切：`release.yml` 里是 6 个空格，`actions/verify` 里是 4 个，两者共用一套口径。
     * 切步是为了把断言绑到**具体那一步**——整文件 grep 一次 `pnpm exec wxt` 拦不住
     * 「装载挪到了别的档」或「新加一格跑 pnpm 却落在没装载的档上」。
     */
    const stepsOf = (yaml: string): Array<{ name: string; body: string }> => {
      const lines = yaml.split('\n');
      const starts: number[] = [];
      lines.forEach((line, index) => {
        if (/^ {4,}- name: \S/.test(line)) starts.push(index);
      });
      return starts.map((start, index) => ({
        name: String(lines[Number(start)].match(/- name: (.+)$/)?.[1]).trim(),
        body: lines.slice(start, index + 1 < starts.length ? starts[Number(index) + 1] : lines.length).join('\n'),
      }));
    };

    /** 取出某一步里 `if:`、`run:` 或 `with:` 的完整值——三者都可能折成多行（`>-`、`|`）。 */
    const stepField = (body: string, key: string): string => {
      const lines = body.split('\n');
      const pattern = new RegExp(`^ +${key}: ?(.*)$`);
      const start = lines.findIndex(line => pattern.test(line));
      if (start < 0) return '';
      const inline = String(lines[Number(start)].match(pattern)?.[1]).trim();
      if (inline !== '' && !/^[>|][-+0-9]*$/.test(inline)) return inline;
      const headIndent = (lines[Number(start)].match(/^ +/)?.[0] ?? '').length;
      const collected: string[] = [];
      for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[Number(index)];
        if (line.trim() === '') continue;
        if ((line.match(/^ +/)?.[0] ?? '').length <= headIndent) break;
        collected.push(line.trim());
      }
      return collected.join(' ');
    };

    /**
     * 「跑 `pnpm` 的那一步，必须落在装载过 `pnpm` 的那一档」。
     *
     * 这条判据是被一次真跑逼出来的：`mode=status` 不落 `builds`，于是 `Verify` 整个不跑，
     * 而 pnpm、Node 与 `node_modules` 全住在 `Verify` 里面——那一档的
     * `pnpm exec wxt submit status` 以 **exit 127** 收场（2026-10-18 首跑现量），红字里
     * 没有任何一行提到装载。`uses: pnpm/action-setup` 与 `cache: pnpm` 刻意不算「跑 pnpm」，
     * 它们本身就是装载。
     */
    const pnpmStepsOutsideLoad = (yaml: string, loaded: string[]): string[] => {
      const violations: string[] = [];
      for (const step of stepsOf(yaml)) {
        if (!/(^|\s)pnpm(\s|$)/.test(stepField(step.body, 'run'))) continue;
        const gate = stepField(step.body, 'if');
        const modes = [...gate.matchAll(/mode == '([\w-]+)'/g)].map(match => String(match[1]));
        if (modes.length === 0) {
          if (!gate.includes("builds == 'true'")) violations.push(step.name);
          continue;
        }
        if (modes.some(mode => !loaded.includes(mode))) violations.push(step.name);
      }
      return violations;
    };

    it('被调用的工作流只声明 boolean / number / string 三种输入类型', () => {
      const types = workflowCallTypes(release);
      // 先证明这一块里真的数得到东西：整体失配时（比如 `workflow_call:` 的缩进或写法变了，
      // 于是这一格切出空数组）断言会静默假通过，所以把「非空」本身钉住。
      expect(types.length, '没从 workflow_call 块里数到任何 type——提取口径坏了').toBeGreaterThan(0);
      for (const type of types) {
        expect(CALL_TYPES, `workflow_call 的输入类型 ${type} 会让整份工作流解析失败`).toContain(type);
      }
      // 切块的下界也得有人管：dispatch 那份下拉框（`choice`）是**故意留着**的，人手补跑时靠它挡错。
      // 若块边界算错，`choice` 会同时出现在「被调用」这一侧，上面的断言立刻红；反过来若有人把
      // dispatch 的下拉框一并删了，这条红——两边都不许悄悄动。
      expect(release, 'workflow_dispatch 的 mode 不再是下拉框').toContain('type: choice');
      // 少了一种取值就没人挡着传给 `wxt submit`：`mode` 从 `choice` 降级成自由字符串之后
      // （`workflow_call` 只认 string，闸门链路传进来的就是自由字符串），那份白名单必须住在
      // 作业里，而不是消失。判据与旗标同源：下游每一格的 `if:` 比的都是那个已判过的 output。
      expect(release).toContain('Validate release inputs');
      expect(release).toMatch(/case "\$MODE" in[\s\S]*preflight \| status \| publish-dry \| publish/);
      expect(release).toMatch(/RAW_MODE: \$\{\{ inputs\.mode/);
      // v1.1 那个「发布分组」旋钮必须真的从链路上消失。剥掉整行注释再查——文件头与那三步上方
      // 的注释正是在解释「为什么撤掉它」，连着注释一起查会在纯粹的设计说明上红。
      const releaseCode = [...release.split('\n')].filter(line => !/^\s*#/.test(line)).join('\n');
      expect(releaseCode, 'release.yml 又把 v1.1 的发布分组旋钮接回来了').not.toMatch(
        /--chrome-publish-target|trustedTesters/,
      );
      // 私钥只走环境变量，这一条有实测承重：把它作为 `--chrome-service-account-private-key` 的
      // 实参交给 CLI 时，进程打印 help 后 exit 0，上传与提审一次都没发生——那一格绿得和成功一模一样。
      expect(releaseCode, '私钥又被铺上了 argv').not.toContain('--chrome-service-account-private-key');
      expect(releaseCode).toContain(
        'CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: ${{ secrets.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY }}',
      );
      // API 版本钉在作业级 env，且与预检脚本里的那个常量是同一个值——两处不一致时预检说的是
      // 「v2 没问题」，跑的却是 v1.1 客户端。
      expect(releaseCode).toContain("CHROME_API_VERSION: 'v2'");
      expect(preflightScript).toContain("export const REQUIRED_API_VERSION = 'v2'");

      // 阳性对照：这一格自己的牙。同一份提取函数遇到 `choice` 必须把它数出来，
      // 否则「全绿」只说明我没看见那个错。
      const poisoned = [
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      publish-target:',
        '        type: choice',
        '        default: default',
        '  workflow_dispatch:',
        '    inputs:',
        '      x:',
        '        type: string',
      ].join('\n');
      expect(workflowCallTypes(poisoned), '提取函数没抓到被注入的 choice').toEqual(['choice']);
      // `workflow_call:` 缺席时必须返回空数组，而不是把 dispatch 那一侧的类型误报进来。
      expect(workflowCallTypes('on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: choice\n')).toEqual([]);
    });

    it('CI、发布、以及审批前的校验，共用同一个 verify 复合动作', () => {
      expect(ci).toContain('uses: ./.github/actions/verify');
      expect(release).toContain('uses: ./.github/actions/verify');
      // 点头之前那一格也必须走同一份清单，否则「CI 绿」与「审批人看到的绿」是两件事。
      expect(publishJobs.prepare ?? '').toContain('uses: ./.github/actions/verify');
      expect(publishJobs.prepare ?? '').toContain('build-mode: zip');
    });

    it('status 档自带那份工具链装载副本，且与 verify 那一侧逐项对齐', () => {
      // 装载过 pnpm 与 `node_modules` 的档位只有这三档：`publish-dry` / `publish` 经 `Verify`
      // （那一格的门是 `builds == 'true'`，而 `builds` 恰好只给这两个值置真），`status` 经
      // 下面这三步。第四档 `preflight` 谁都不装——它跑的是 `node scripts/store-preflight.mjs`，
      // Node 在 runner 镜像里，这正是它 2026-10-18 能绿、`status` 却 127 的唯一区别。
      expect(release).toContain('publish-dry | publish) echo "builds=true"');
      const LOADED = ['status', 'publish-dry', 'publish'];

      const names = ['Setup pnpm', 'Setup Node.js', 'Install dependencies'];
      const source = stepsOf(verify).filter(step => names.includes(step.name));
      expect(
        source.map(step => step.name),
        'verify 那三步的名字或顺序动了',
      ).toEqual(names);

      const copy = stepsOf(release).filter(step => step.name.endsWith('(status)'));
      expect(copy.map(step => step.name)).toEqual(names.map(name => `${name} (status)`));

      // 顺序也得管：`pnpm/action-setup` 排在 `setup-node` 之后就拿不到 pnpm 缓存目录，
      // 那一侧的注释写着这条，副本这一侧同样成立。
      copy.forEach((step, index) => {
        const origin = source[Number(index)];
        expect(origin, `verify 那一侧少了 ${step.name.replace(' (status)', '')}`).toBeDefined();
        expect(stepField(step.body, 'if'), `${step.name} 的门没收拢在 status 档`).toBe(
          "steps.inputs.outputs.mode == 'status'",
        );
        expect(step.body.match(/uses: (\S+)/)?.[1], `${step.name} 换的动作与 verify 那一侧不同源`).toBe(
          origin.body.match(/uses: (\S+)/)?.[1],
        );
        expect(stepField(step.body, 'run'), `${step.name} 的命令与 verify 那一侧不同源`).toBe(
          stepField(origin.body, 'run'),
        );
      });

      // Node 版本这一处**不能**同源到字面量：`Verify` 收的是 `inputs.node-version`（默认 '22'），
      // 而 status 这一侧没有输入可传，只能写死。写死就意味着会漂，所以拿默认值当基准现比。
      const declared = stepField(copy[Number(1)].body, 'with');
      expect(declared).toContain('cache: pnpm');
      expect(stepField(source[Number(1)].body, 'with')).toContain('cache: pnpm');
      const nodeDefault = verify.match(/node-version:\s*\n(?:.*\n)*?\s*default: '?([\d.]+)'?/)?.[1];
      expect(nodeDefault, '读不到 verify 动作的 node-version 默认值——那段 inputs 动了').toBeTruthy();
      expect(declared, `status 档的 Node 版本仍写死 '${nodeDefault}' 之外的值`).toContain(
        `node-version: '${nodeDefault}'`,
      );

      // 三步必须排在 `Query store status` **之前**：127 那一次的形状就是「命令在，装载没跑」。
      const order = stepsOf(release).map(step => step.name);
      const query = order.indexOf('Query store status');
      expect(query, 'Query store status 那一格不见了').toBeGreaterThan(-1);
      copy.forEach(step => {
        expect(order.indexOf(step.name), `${step.name} 排到了 status 那一步之后`).toBeLessThan(query);
      });

      // 泛化那条判据本身：跑 pnpm 的步骤一个都不许落在没装载的档上。
      expect(pnpmStepsOutsideLoad(release, LOADED), '这几步跑 pnpm 却没有装载').toEqual([]);
      // 提取口径的自检——整文件真的数得到跑 pnpm 的步骤，否则上面那句「空数组」是假绿。
      const pnpmStepCount = stepsOf(release).filter(step =>
        /(^|\s)pnpm(\s|$)/.test(stepField(step.body, 'run')),
      ).length;
      expect(pnpmStepCount, '一条跑 pnpm 的步骤都没抓到——提取口径坏了').toBeGreaterThanOrEqual(4);

      // 阳性对照：把一格「只在 preflight 跑 pnpm」的步骤喂给同一个判据，它必须点名。
      const poisoned = [
        'jobs:',
        '  release:',
        '    steps:',
        '      - name: Query store status',
        "        if: steps.inputs.outputs.mode == 'status'",
        '        run: pnpm install --frozen-lockfile',
        '      - name: Sneaky preflight CLI',
        "        if: steps.inputs.outputs.mode == 'preflight'",
        '        run: pnpm exec wxt submit status',
      ].join('\n');
      expect(pnpmStepsOutsideLoad(poisoned, LOADED), '判据放过了没装载的那一档').toEqual(['Sneaky preflight CLI']);
      // 另一侧的对照：`builds` 那两档由 Verify 装载，判据不许把它们误报。
      expect(
        pnpmStepsOutsideLoad(
          [
            '      - name: Submit to Chrome Web Store',
            "        if: steps.inputs.outputs.mode == 'publish' && steps.credentials.outputs.ready == 'true'",
            '        run: pnpm exec wxt submit',
          ].join('\n'),
          LOADED,
        ),
      ).toEqual([]);
    });

    it('verify 动作覆盖 package.json 里定义的全部检查脚本', () => {
      // 从 scripts 反推而不是手写一份数组：新增 `pnpm check:xxx` 并漏进 verify 动作时，
      // 本用例必须变红。`typecheck:vue` 必须显式列进这条交替式——它和 `typecheck` 只差一个
      // 后缀，`^typecheck$` 那种锚点收不住它，漏掉就等于新加的门禁谁都不管它在不在 CI 里。
      const checkScripts = Object.keys(pkg.scripts).filter(key =>
        /^(lint|lint:style|format:check|typecheck|typecheck:vue|test)$/.test(key),
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

    /**
     * 「谁能把包交到 Google 手上」必须只有一个出口。
     *
     * `release.yml` 现在有**三个**入口（人推的 `v*` tag、被 `store-publish.yml` 调用、手动补跑），
     * 所以旧那句「只在 tag 上触发」已经不是它的边界了。边界换成了两条更硬的：
     * ① 商店凭据只被这一个文件引用——闸门那条链路一个 `secrets.CHROME_*` 都不碰，它只负责
     *    「批准」和「打 tag」；② `wxt submit` 全仓只出现一次。谁哪天在别的链路里再写一次
     *    `wxt submit`，就等于开出第二条提审通道，而配额有限与不可撤回这两件事从此没有单一守门人。
     */
    it('向商店提审的出口只有 release.yml，它有三个入口但没有第四个', () => {
      // 服务账号那四条，一条都不能少、也不能换成 v1.1 的 OAuth 三件套：
      // `CHROME_CLIENT_ID` / `CHROME_CLIENT_SECRET` / `CHROME_REFRESH_TOKEN` 在 v2 下没有读者，
      // 让它们回来的最快路径就是有人照着旧文档补进这个数组。
      for (const secret of [
        'CHROME_EXTENSION_ID',
        'CHROME_PUBLISHER_ID',
        'CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL',
        'CHROME_SERVICE_ACCOUNT_PRIVATE_KEY',
      ]) {
        expect(release, `release.yml 未引用 secrets.${secret}`).toContain(`secrets.${secret}`);
      }
      expect(release).toContain('wxt submit');
      expect(release).toContain('tags:');
      expect(release).toContain("'v*'");
      expect(release).toContain('permissions:');
      expect(release).toContain('contents: write');
      // 三个入口都得在文件里声明；缺 `workflow_call` 就是闸门链路调不到它，
      // 而那个失败是「审批点了、tag 打了、商店没动」——Release 那一侧看着一切正常。
      expect(release).toMatch(/^ {2}workflow_call:$/m);
      expect(release).toMatch(/^ {2}workflow_dispatch:$/m);

      for (const other of [ci, releasePlease, storePublish]) {
        expect(other, '出现了第二份提审实现').not.toContain('wxt submit');
      }
      expect(storePublish, '闸门链路不该直接引用商店凭据').not.toContain('secrets.CHROME_');
    });

    /**
     * 闸门链路的全部静默失败都长得同一副样子：**某一格的条件被挪走**，于是它要么永远不跑，
     * 要么在没人点头的时候跑了。所以这里的每条断言都按作业名取那一格来看，而不是整文件 grep 一次
     * ——全文搜 `approval-state == 'configured'` 拦不住「把它从 confirm 挪到 prepare 上」，
     * 而那一挪恰好让这道闸门当场失效（环境仍然会等批准吗？不会——`prepare` 不带环境）。
     */
    it('闸门链路的六格齐在，且各判各的', () => {
      expect(Object.keys(publishJobs).length, '作业一格都没切出来——YAML 缩进或本用例的正则变了').toBe(6);
      expect(Object.keys(publishJobs).sort()).toEqual(
        ['confirm', 'decide', 'prepare', 'publish', 'release-tag', 'hold'].sort(),
      );
    });

    it('confirm 那一格就是人工确认：它带环境，且只在实测过「闸门已配」时才可达', () => {
      const confirm = publishJobs.confirm ?? '';
      // 环境名必须逐字等于判据脚本里 `DEFAULT_ENVIRONMENT` 那一个，也等于手册教人去建的那一个。
      const environment = /(?:^|\n) {4}environment:\s*(\S+)/.exec(confirm)?.[1];
      expect(environment, 'confirm 那一格不带 environment，人工确认根本不存在').toBeTruthy();
      expect(environment).toBe(/const DEFAULT_ENVIRONMENT = '([^']+)'/.exec(gateScript)?.[1]);
      expect(storePublish).toContain(`environments/${environment}`);
      /**
       * 手册必须**教人建这一个环境**。判据要求环境名出现在反引号里（那是文中指认一个
       * 字面量的写法），而不是子串命中：§2 那条翻牌清单里有一整条 shields 徽章 URL，
       * 路径里就带着 `chrome-web-store` 这五个词，按子串查时它替文档答了「教过了」——
       * 而读者照着那份手册做完，环境仍然是空的。
       */
      const releasing = read(RELEASING_DOC);
      expect(
        releasing,
        `手册里没有把环境名写成待创建的那个字面量 \`${environment}\`（工作流按这个名字等审批）`,
      ).toContain('`' + String(environment) + '`');
      expect(releasing, '手册里没有那条链路的这一格，读者不知道审批发生在哪').toContain('store-publish.yml');
      expect(releasing, '手册里没有 Required reviewers 那一步——环境建了但没人能点头，闸门等于直接通过').toContain(
        'Required reviewers',
      );
      // 这一条是整件事的核心：环境**存在**与**有人能点头**是两件事，隐式创建的裸环境会让
      // 这一格直接成功通过，「合并即发版」当场变成真的，而流水线全绿。
      expect(confirm).toContain("needs.decide.outputs.approval-state == 'configured'");
      expect(confirm).toContain("github.event_name != 'pull_request'");
    });

    it('批准之后的三格对 PR 不可达，判定与校验两格可达', () => {
      // 补跑与手动起跑靠的是「不是 PR」，而 PR 必须能跑到 `decide`/`prepare`——那两格只读不写，
      // 是这条链路唯一能在 PR 上被 GitHub 真实起跑的部分（改动它的判据时先看它跑过没有）。
      for (const name of ['confirm', 'release-tag', 'publish']) {
        expect(publishJobs[name], `${name} 不再排除 pull_request——PR 上就能一路走到发布`).toMatch(
          /github\.event_name != 'pull_request'/,
        );
      }
      for (const name of ['decide', 'prepare']) {
        expect(publishJobs[name], `${name} 被排除了，PR 上就演不出「这一版会不会被发」`).not.toMatch(
          /github\.event_name != 'pull_request'/,
        );
      }
    });

    /**
     * 「已配闸门」这道判据必须出现在**每一个**批准之后才该跑的作业上（confirm / release-tag /
     * publish 三处），一处都不能少：少的是 `release-tag` 或 `publish`，那 `confirm` 自己那格
     * 即使被裸环境秒过，后面照样会把 tag 推出去。判据取「按作业切出来的那一格里有没有这一句」，
     * 所以它既拦得住「把某一格的条件挪走」，也拦得住「新增一格没带闸门」。
     *
     * 锚必须是行首的表达式而不是子串：文件头与 `confirm` 上方都**引用**过这一句来解释设计，
     * 按子串数处数时那两句注释会一起进账，于是「三处」这种写法当场红在一次解释性注释上。
     */
    it('闸门判据在三处承重，一处不多一处不少', () => {
      const gated = Object.entries(publishJobs)
        .filter(([, body]) => /^\s+needs\.decide\.outputs\.approval-state == 'configured'/m.test(body))
        .map(([name]) => name)
        .sort();
      expect(
        gated,
        "带 `approval-state == 'configured'` 的作业集合变了：新增作业要重判它的闸门归属，删一处就是开了后门",
      ).toEqual(['confirm', 'publish', 'release-tag']);
    });

    it('批准之后打 tag 之前先重查一次，读不到也不打', () => {
      const tagJob = publishJobs['release-tag'] ?? '';
      expect(tagJob).toContain('contents: write');
      // 形状再钉一次：上游那格的 output 是跨作业的文本，这里一个进 URL 路径、一个进请求体。
      // 正则停在形状本身，不追 ` ]]` ——shell 里 `$ ]]` 之间那个空格是 prettier 之外的一切写法都改得动的。
      expect(tagJob).toMatch(/\[\[ "\$TAG" =~ \^v\[0-9\]/);
      expect(tagJob).toMatch(/\[\[ "\$SHA" =~ \^\[0-9a-f\]\{40\}\$/);
      // 审批可以挂很久（上限 30 天）。期间人若自己推过 tag，再打一次轻则 422、
      // 重则把已经发布的东西再向 Google 提审一遍。
      expect(tagJob).toContain('在等待期间已被打出');
      expect(tagJob).toContain('!= "404"');
      // 浅克隆里 `git push` 标签会被 git 拒，所以用 API 建轻量 ref。
      expect(tagJob).toContain('/git/refs');
    });

    /**
     * 发布实现只有 `release.yml` 那一份，靠 `workflow_call` 接力——而不是把 120 行抄第二遍。
     * 抄第二遍的代价不是维护量，是两份会漂移的提审实现。
     *
     * `secrets: inherit` 有一个不能写进 YAML 的前提：**四个 `CHROME_*` 只能放仓库级**。
     * 环境级 Secrets 不会随 `inherit` 进被调用的工作流（带环境的是上一格，发布那一格不带），
     * 挪上去的结果是「审批通过、构建完成、商店静默跳过」，而 GitHub Release 照样建好。
     */
    it('发布那一格是调用 release.yml，自己不带环境也不带凭据', () => {
      const publish = publishJobs.publish ?? '';
      expect(publish).toContain('uses: ./.github/workflows/release.yml');
      expect(exists('.github/workflows/release.yml'), '被调用的工作流不在仓库里，这一格永远红').toBe(true);
      expect(publish).toContain('secrets: inherit');
      expect(publish).toContain('tag: ${{ needs.decide.outputs.tag }}');
      expect(publish, '发布作业带环境等于把凭据挪到环境级的诱因').not.toMatch(/^ {4}environment:/m);
      expect(publish).toContain('contents: write');
      expect(publish).toContain('pull-requests: write');
    });

    it('拦下来那一格是红的，不是安静跳过', () => {
      const hold = publishJobs.hold ?? '';
      expect(hold).toContain('needs.decide.outputs.hold');
      expect(hold, '只写摘要不 exit 1，等于把「没人能点头」降级成一条容易被划过去的注释').toContain('exit 1');
    });

    /**
     * 判据住在脚本里、YAML 只搬运读数，这件事本身也要有人守：一旦有人图省事把比较写回 shell，
     * 它就脱离了 `tests/releaseGate.test.ts` 的覆盖，而那是这条链路唯一能在本机真跑的部分
     * （工作流 YAML 本机跑不了）。
     */
    it('闸门判据只有 scripts/release-gate.mjs 一份，且它被单测覆盖', () => {
      expect(storePublish).toContain('node scripts/release-gate.mjs');
      expect(gateScript).toContain('export function decide');
      const gateTest = read('tests/releaseGate.test.ts');
      expect(gateTest).toContain('@/scripts/release-gate.mjs');
      for (const fn of [
        'isValidVersion',
        'tagStateOf',
        'approvalStateOf',
        'secretPresenceOf',
        'decide',
        'renderSummary',
      ]) {
        expect(gateTest, `${fn} 没有对应用例——判据必须全部可单测`).toContain(`${fn}(`);
      }
      // YAML 里不许自己比对 HTTP 状态码形状以外的东西：判定一律交给脚本。
      // 只剥整行注释再查——文件头那段解释「环境存在 ≠ 有人能点头」的注释正好点过这两个字段名，
      // 连着注释一起查，会在一次纯粹的设计说明上红。
      const code = [...storePublish.split('\n')].filter(line => !/^\s*#/.test(line)).join('\n');
      expect(
        code.match(/protection_rules|required_reviewers|fromjson|\bjq\b/g)?.length ?? 0,
        'YAML 里开始自己读环境的保护规则了——那份判据没有单测',
      ).toBe(0);
    });

    /**
     * 离线预检与闸门同一档：判据住在 `scripts/store-preflight.mjs`（有单测），YAML 只调用它。
     * 这一格存在的全部理由是「凭据缺或形状错的包在 Google 那边是静默的」，所以守住四件事：
     * ① `release.yml` 真的跑它；② 它有自己的运行时单测；③ 它排在构建**之前**（构建六七分钟，
     * 一条读不出的私钥在那六七分钟里一点动静都没有）；④ 审批链路不许另写一份判据、也不许
     * 靠被调用方的输入默认值来决定执行深度。
     */
    it('商店凭据的离线预检只有一份判据，且它排在构建之前', () => {
      expect(release).toContain('node scripts/store-preflight.mjs');
      expect(read('tests/storePreflight.test.ts')).toContain('@/scripts/store-preflight.mjs');
      // 顺序按**出现次序**判，不是「文件里两处都在」：预检落到构建之后就是白烧六七分钟，
      // 而那一挪在这条 grep 上照样全绿。
      const preflightAt = release.indexOf('node scripts/store-preflight.mjs');
      const verifyAt = release.indexOf('uses: ./.github/actions/verify');
      expect(preflightAt).toBeGreaterThan(-1);
      expect(verifyAt).toBeGreaterThan(-1);
      expect(preflightAt, '离线预检排到了构建之后').toBeLessThan(verifyAt);

      const code = [...release.split('\n')].filter(line => !/^\s*#/.test(line)).join('\n');
      // v1.1 的 OAuth 三条不许以 `secrets.X` 的形式回来。只查这个形状：注释里点名它们是为了
      // 告诉读的人「该删」，连着注释一起查会在说明文字上红。
      for (const retired of ['CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN']) {
        expect(code, `release.yml 又去读 v1.1 的 secrets.${retired}`).not.toContain(`secrets.${retired}`);
      }
      // 闸门链路把执行深度显式交棒：`mode` 的默认值属于被调用方，靠它猜就是两处事实源。
      expect(storePublish).toContain('mode: publish');
    });

    it('store-publish 里每个调 GitHub API 的步骤都自己声明 GH_TOKEN', () => {
      const steps = storePublish.split(/^ {6}- name:/m).slice(1);
      const apiSteps = steps.filter(step => /\$GH_TOKEN|gh\s+(?:api|release|pr)\b/.test(step));
      expect(apiSteps.length, '一个调用 API 的步骤都没匹配到——判据已失效').toBeGreaterThanOrEqual(2);
      for (const step of apiSteps) {
        expect(step, '有步骤在用 GH_TOKEN 却没声明它，探测会把「读不到」当成常态').toContain('GH_TOKEN:');
      }
    });

    /**
     * `gh` 在 Actions 里只认显式声明的 `GH_TOKEN`——GitHub 不会把 `GITHUB_TOKEN` 注入 `run`
     * 步骤的环境。2026-09-30 首次发版就是在这里红的：Verify / Guard / Locate zip / Notes
     * 四步全绿，Publish 那步报 `gh: To use GitHub CLI in a GitHub Actions workflow, set the
     * GH_TOKEN environment variable`（exit 4），Release 没建成，下游「清标签」与商店提审
     * 一起被 skip——看起来只差最后一步，实际什么都没发出去。
     *
     * 判据必须按**步骤**绑而不是全文 grep 一次：漏在哪个步骤上，就正好是那个步骤红。
     */
    it('release.yml 每个调用 gh 的步骤都自己声明 GH_TOKEN', () => {
      const steps = release.split(/^ {6}- name:/m).slice(1);
      const ghSteps = steps.filter(step => /(?:^|\s)gh\s+(?:release|pr|api)\b/m.test(step));
      expect(
        ghSteps.length,
        '一个调用 gh 的步骤都没匹配到——判据已失效，gh 的用法或本用例的正则变了',
      ).toBeGreaterThanOrEqual(2);
      for (const step of ghSteps) {
        expect(step, '有步骤在用 gh 却没声明 GH_TOKEN，发版会停在 Publish 那一步').toContain('GH_TOKEN:');
      }
    });

    /**
     * 起草版本的那条链路与发布的那条必须**互不越界**，这里的判据全是「越界会长什么样」：
     *
     * - 只在 main 上跑。在 PR 上跑会先给每个 PR 生成一份版本猜测，而机器人的对账基准
     *   （`.release-please-manifest.json`）只在合并之后才为真。
     * - 只要 `contents` 与 `pull-requests` 两个写权限。它要推自己的分支并开 PR，两样都够；
     *   `pages` / `id-token` / `security-events` 出现即扩大权限面。
     * - 不引用任何 `secrets.*`：它不碰商店凭据，也不该碰。**商店提审的入口只有 `release.yml`**，
     *   而它由人推的 `v*` tag 触发。这条边界是「合并 PR 不会直接把包交到 Google 手上」的全部内容。
     * - 它引用的两个文件名必须真实存在：改名只会在 GitHub 上红，本机跑不了工作流。
     */
    it('release-please 只起草版本、只在 main 跑、且拿不到商店凭据', () => {
      expect(releasePlease).toContain('googleapis/release-please-action@v4');
      expect(releasePlease).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
      expect(releasePlease).toContain('contents: write');
      expect(releasePlease).toContain('pull-requests: write');
      for (const overreach of ['id-token', 'pages:', 'deploy-keys', 'security-events']) {
        expect(releasePlease, `release-please.yml 出现了 ${overreach}，权限面被扩大`).not.toContain(overreach);
      }
      expect(releasePlease, '它不该拿到任何 secrets——发商店包只在 release.yml').not.toContain('secrets.');

      for (const input of ['config-file', 'manifest-file']) {
        const file = new RegExp(`${input}:\\s*(\\S+)`).exec(releasePlease)?.[1];
        expect(file, `release-please.yml 缺少 ${input}`).toBeTruthy();
        expect(exists(file!), `${input} 指向的 ${file} 不在仓库里`).toBe(true);
      }
    });

    /**
     * 机器人给发布 PR 打的标签是 `autorelease: pending`，而把它换成 `tagged` 的那一步
     * 只存在于它自己「建 GitHub Release + 打 tag」的流程里——本仓库刻意 `skip-github-release`，
     * 那一换就**永远不发生**。后果不是报错而是从此安静：它下次起草时只要看到任何已合并、
     * 仍带 pending 的 PR 就直接放弃开新 PR（日志那句是
     * `There are untagged, merged release PRs outstanding - aborting`，而那条 run 全绿），
     * 于是「没有新的发布 PR」看起来跟「没有要发的东西」一模一样。
     *
     * 所以换标签这件事必须有人在发版那一下替它做，做它的是 `release.yml` 里那一步。
     * 这里守三样：那一步在、两个标签名写对了（拼错就是**摘掉了旧标签也没换上新标签**，
     * 下一次起草照样 abort），以及 job 真有 `pull-requests: write`（没有它整步只是把
     * 一条 403 打进日志）。那一步的失败分支刻意不 `exit 1`——Release 已经建成，
     * 把发布判红只会让人以为商店包没出门；它失败时在 Job Summary 留一段手工指引。
     */
    it('release.yml 替机器人把 autorelease: pending 换成 tagged', () => {
      expect(release).toContain('Clear release-please pending label');
      expect(release).toContain("'autorelease: pending'");
      expect(release).toContain('--add-label');
      expect(release, '换标签那一步没有 pull-requests: write，只会拿到 403').toContain('pull-requests: write');
    });

    /**
     * Release 说明是从 `CHANGELOG.md` 里切出来的，而小节标题有**两种**写法：机器人拿到了
     * 上一个 tag 时写 `## [x.y.z](compare) (日期)`，拿不到（首跑、或 `bootstrap-sha` 那段之前）
     * 时写裸的 `## x.y.z (日期)`——两种都发得出去，所以切片器必须两种都认。
     * 只认带方括号那一种的后果是静默降级：切不到小节就退回 GitHub 自动生成的提交流水账，
     * 而商店用户看到的那份说明里没有了人补的中英长文。
     *
     * 判据从 `release.yml` 挪进了 `.github/actions/release-notes`，因为现在有两个消费者：
     * 发布那一条，以及审批页那句「这一版要发什么」。**两份必须同源**——预览另算一份差集，
     * 点头时看到的正文就不是商店真正拿到的正文。
     */
    it('Release 说明的切片器认两种 CHANGELOG 小节标题，且审批预览与发布共用它', () => {
      expect(notesAction, '切片器不再按行首小节标题分割，改 awk 时这条要一起看').toContain('awk -v version=');
      expect(notesAction, '只认 `## [` 会漏掉机器人写的裸 `## x.y.z` 小节').toContain('/^## (\\[|[0-9])/');
      expect(notesAction).toContain('CHANGELOG.md > notes.md');
      expect(notesAction, '切不到小节时的兜底被删掉了，会发一份空说明的 Release').toContain('if [ -s notes.md ]');

      // 两个入口，一份判据。
      expect(release, '发布不再走那份共用的切片器，审批预览与 Release 正文就分家了').toContain(
        'uses: ./.github/actions/release-notes',
      );
      expect(storePublish, '审批页不再预览 Release 说明，点头时看到的就是未经验证的内容').toContain(
        'uses: ./.github/actions/release-notes',
      );
      // 切片结果经 `notes.md`（工作区文件）交给 `gh --notes-file`，两侧都读 `source` 输出决定兜底。
      expect(release).toContain('--notes-file notes.md');
      expect(release, '兜底不再由切片器的结论决定，切不到小节时会发布空白说明').toContain(
        'NOTES_SOURCE: ${{ steps.notes.outputs.source }}',
      );

      /**
       * 复合动作的文件取自**工作流所在 ref**，而它读的 `CHANGELOG.md` 取自 checkout 出来的树。
       * 于是「让切片器去 import 仓库脚本」会静默坏在 §3 那条恢复路径上：用 main 修好的链路补跑
       * 一个旧 tag 时，旧树里可能还没有那个脚本，而表现是切片器整体失败、说明回落成流水账。
       */
      expect(notesAction, '切片器开始读仓库里的脚本文件了——旧 tag 的树里可能没有它').not.toContain('scripts/');
    });

    /**
     * 从 `.output/` 挂产物的 `upload-artifact@v4`，必须显式写 `include-hidden-files: true`。
     *
     * 这条是被一次真红逼出来的：v4 默认把「路径里任何一段以 `.` 开头」的匹配全部丢掉（它把这一步
     * 翻成 @actions/glob 的 `excludeHiddenFiles`），而 WXT 的产物恰好住在 `.output/` 下——整条
     * glob 因此命中零个文件。它在 `if-no-files-found: warn` 的那几个月里就是这么静默挂着零产物：
     * CI run 68 的 artifacts 列表是空的，而同一次运行的构建日志里那句
     * `└─ .output/cross-origin-proxy-1.5.1-chrome.zip  357.95 kB` 照样打得好好的。改成 error 才红出来。
     *
     * 判据按「步」走而不是整文件 grep：把 `include-hidden-files` 从那一格挪到别处必须红。
     * `path` 用子串匹配，因此 `${{ steps.zip.outputs.path }}` 这种**间接**的也算——store-publish
     * 那一格收的就是两步之前现算出来的 `.output/<name>-<version>-chrome.zip`。多要求一格无害的
     * `include-hidden-files: true` 是这条口径的代价，比漏掉一格静默零产物轻得多。
     */
    it('从 .output/ 挂产物的 upload-artifact 步骤，都显式打开了 include-hidden-files', () => {
      const workflows: Array<[string, string]> = [
        ['ci.yml', ci],
        ['deploy-pages.yml', pages],
        ['release.yml', release],
        ['release-please.yml', releasePlease],
        ['store-publish.yml', storePublish],
      ];
      let checked = 0;
      for (const [file, yaml] of workflows) {
        for (const step of stepsOf(yaml)) {
          if (!/uses: actions\/upload-artifact@/.test(step.body)) continue;
          if (!stepField(step.body, 'path').includes('.output')) continue;
          checked += 1;
          expect(
            step.body,
            `${file} 的「${step.name}」从 .output/ 挂产物却没打开 include-hidden-files——它会静默挂一个空产物`,
          ).toContain('include-hidden-files: true');
        }
      }
      expect(checked, '一格从 .output/ 挂产物的步骤都没数到：产物搬家了，要么就是提取口径坏了').toBeGreaterThan(0);
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

    /**
     * 「弹窗真实宽度」在 AGENTS.md 里是三个数（内容宽 / 渲染宽 / 真机视口），此前只写了
     * 一个 352px，于是「CSS 里明明是 320px」看着就像文档过期。三个数其实彼此推得出来，
     * 前提有三条：`width`、`padding` 各是多少，以及**没有全局 `box-sizing: border-box`**——
     * 扩展自己的 CSS 一条 `box-sizing` 都不写（下面那条逐文件断言钉住），Element Plus 只在
     * 各组件自己的规则里逐条声明（`element-plus/theme-chalk/base.css` 里连一个全局重置都没有，
     * 那份 117 处数的是它的整包 `dist/index.css`，本仓库按需引入、根本不加载整包）。
     * 这里把算式与文档对账——改任一头的数，另一头不跟着改就红。
     */
    it('AGENTS.md 里那三个弹窗宽度彼此推得出来，不是三条独立断言', () => {
      const css = read('entrypoints/popup/App.vue');
      const block = /\.popup-container\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
      const width = Number(/(?<![\w-])width:\s*(\d+)px/.exec(block)?.[1]);
      const padding = Number(/padding:\s*(\d+)px/.exec(block)?.[1]);
      expect(width, '读不到 .popup-container 的 width（形状变了，本条要跟着改）').toBeGreaterThan(0);
      expect(padding, '读不到 .popup-container 的 padding').toBeGreaterThan(0);
      expect(block, '本条成立的前提是 content-box；给这一格加 border-box 要连文档一起改').not.toMatch(
        /box-sizing:\s*border-box/,
      );
      /**
       * 只查 `.popup-container` 那一格是**不够**的：弹窗加载的是 `tokens.css` 整份，
       * 那里若出现 `* { box-sizing: border-box }`，渲染宽就从 352 变回 320，而这一格
       * 一个字都没改——三个数的算式当场失效，且界面上没有任何东西会说这件事。
       * 所以按「popup 实际加载的那几份样式里根本不存在 box-sizing」逐文件过一遍。
       */
      for (const file of ['entrypoints/popup/index.html', 'entrypoints/popup/App.vue', 'assets/theme/tokens.css']) {
        expect(read(file), `${file} 里出现了 box-sizing 声明，content-box 这个前提不再成立`).not.toMatch(/box-sizing/);
      }
      // 真机视口再多 8px×2：popup 没有重置 body 默认边距（`entrypoints/popup/index.html` 里无 style）
      const rendered = width + padding * 2;
      const viewport = rendered + 16;
      // 只认「元素选择器 body」：`\b` 在连字符后面也算词边界，`.rules-section-body {` 会被误伤
      const noBodyReset = /(?<![\w.#-])body\s*\{[^}]*\bmargin/;
      for (const file of ['entrypoints/popup/index.html', 'entrypoints/popup/App.vue', 'assets/theme/tokens.css']) {
        expect(read(file), `${file} 里出现了 body 边距重置，视口那个数不再等于渲染宽 +16`).not.toMatch(noBodyReset);
      }
      // 按「内容 A / 渲染 B / 视口 C」这一句的**形状**对账，而不是「文档里出现过这个数字」：
      // `toContain('320px')` 那种判法连 `px` 两个字都能过，等于没有判。
      const sentence = /内容宽 (\d+)px、渲染宽 (\d+)px、真机视口 (\d+)px/.exec(read('AGENTS.md'));
      expect(sentence, 'AGENTS.md 里那句「内容宽 / 渲染宽 / 视口」的形状变了，本条要跟着改').not.toBeNull();
      expect([Number(sentence?.[1]), Number(sentence?.[2]), Number(sentence?.[3])], '三个数与 CSS 对不上').toEqual([
        width,
        rendered,
        viewport,
      ]);
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
      const doc = read(GITHUB_DOC);
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
