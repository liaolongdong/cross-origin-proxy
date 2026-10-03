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
    const verify = read('.github/actions/verify/action.yml');

    it('CI 与发布共用同一个 verify 复合动作，避免两份清单漂移', () => {
      expect(ci).toContain('uses: ./.github/actions/verify');
      expect(release).toContain('uses: ./.github/actions/verify');
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
     */
    it('Release 说明的切片器认两种 CHANGELOG 小节标题', () => {
      expect(release, '切片器不再按行首小节标题分割，改 awk 时这条要一起看').toContain('awk -v version=');
      expect(release, '只认 `## [` 会漏掉机器人写的裸 `## x.y.z` 小节').toContain('/^## (\\[|[0-9])/');
      expect(release).toContain('CHANGELOG.md > notes.md');
      expect(release, '切不到小节时的兜底被删掉了，会发一份空说明的 Release').toContain('if [ -s notes.md ]');
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
