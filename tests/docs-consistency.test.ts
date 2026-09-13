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
  'README.zh-CN.md',
  'CHROMEWEBSTORE.md',
  'GITHUB.md',
  'docs/index.html',
  'docs/zh.html',
  'docs/alternatives.html',
  'docs/zh-alternatives.html',
  'docs/privacy.html',
  'docs/llms.txt',
  'docs/llms-full.txt',
  'docs/sitemap.xml',
  'docs/robots.txt',
];

/** 面向读者的仓库根文档；用于「过期结论」扫描。 */
const HUMAN_DOCS = [
  'README.md',
  'README.zh-CN.md',
  'CONTRIBUTING.md',
  'CHROMEWEBSTORE.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'RELEASING.md',
  'GITHUB.md',
  'AGENTS.md',
];

/** 需要成对守卫的中英页面（左英右中）；新增双语页面只改这一处。 */
const BILINGUAL_PAIRS: Array<[string, string]> = [
  ['docs/index.html', 'docs/zh.html'],
  ['docs/alternatives.html', 'docs/zh-alternatives.html'],
];

describe('[Docs] 仓库自动化与文档一致性', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // Pages URL：产品站与隐私政策的可达性
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Pages URL 必须落到 docs/ 下真实文件', () => {
    /**
     * Pages 以 `docs/` 为站点根，所以 `/zh.html` 对应 `docs/zh.html`、`/` 对应
     * `docs/index.html`。商店详细描述里的隐私政策 URL 打不开是首审最常见拒审理由，
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

    it('GitHub Releases 入口在文档里指向 /releases（发版链路的产物落点）', () => {
      expect(read('docs/llms.txt')).toContain(`${REPO_BASE}/releases`);
      expect(read('README.md')).toContain(`${REPO_BASE}/releases`);
      expect(read('README.zh-CN.md')).toContain(`${REPO_BASE}/releases`);
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

    it.each(['index.html', 'zh.html', 'alternatives.html', 'zh-alternatives.html', 'privacy.html'])(
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
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 中英落地页对等（AGENTS 的硬要求，此前只靠人工）
  // ═══════════════════════════════════════════════════════════════════════════

  describe('中英落地页条目必须一一对应', () => {
    /** 统计某文件中正则的全部命中。 */
    const countIn = (file: string, re: RegExp): number => [...read(file).matchAll(re)].length;

    /** 页面可见的 `<summary>` 文本（去标签、归一空白），保持文档顺序。 */
    const summaries = (file: string): string[] =>
      [...read(file).matchAll(/<summary>([\s\S]*?)<\/summary>/g)]
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

    it.each(BILINGUAL_PAIRS)('%s / %s 的 FAQPage 结构化数据条数相同且非空', (en, zh) => {
      const enCount = countIn(en, /"@type":\s*"Question"/g);
      expect(enCount).toBeGreaterThan(0);
      expect(countIn(zh, /"@type":\s*"Question"/g)).toBe(enCount);
    });

    it.each(BILINGUAL_PAIRS)('%s / %s 的页面可见折叠条数与 schema 条数一致', (en, zh) => {
      const enCount = countIn(en, /<details\b/g);
      expect(enCount).toBeGreaterThan(0);
      expect(countIn(zh, /<details\b/g)).toBe(enCount);
    });

    /**
     * AGENTS.md 要求“`FAQPage` 的问答需与页面 `<details>` 文本一致”，而且只比条数
     * 是弱守卫——两边同数但讲不同问题照样能绿。这里逐条逐序比对。
     */
    it.each([...BILINGUAL_PAIRS.flat()])('%s 的 schema 问答与页面折叠文本逐条同序一致', file => {
      expect(summaries(file).length, `${file} 应有 FAQ 折叠项`).toBeGreaterThan(0);
      expect(faqNames(file)).toEqual(summaries(file));
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
     * hreflang 的三条硬规则：每页自指、中英互指、声明 x-default。head 与 sitemap
     * 两处标注不一致时 Google 会整对丢弃，所以下面两条用例分别守两边。
     */
    it.each(BILINGUAL_PAIRS)('%s / %s 的 hreflang 自指、互指且声明 x-default', (en, zh) => {
      const urlOf = (file: string) => `${PAGES_BASE}/${path.basename(file)}`.replace('index.html', '');
      const [enMap, zhMap] = [hreflangMap(en), hreflangMap(zh)];

      expect(enMap.en, `${en} 缺少指向自己的 hreflang="en"`).toBe(urlOf(en));
      expect(enMap.zh, `${en} 缺少 hreflang="zh"`).toBe(urlOf(zh));
      expect(enMap['x-default'], `${en} 缺少 x-default`).toBe(urlOf(en));

      expect(zhMap.zh, `${zh} 缺少指向自己的 hreflang="zh"`).toBe(urlOf(zh));
      expect(zhMap.en, `${zh} 缺少 hreflang="en"`).toBe(urlOf(en));
      expect(zhMap['x-default'], `${zh} 缺少 x-default`).toBe(urlOf(en));
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
    const SITE_PAGES = ['index.html', 'zh.html', 'alternatives.html', 'zh-alternatives.html', 'privacy.html'];

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

    /**
     * 统计条是页面读者看到的第一个数字，README 的能力清单是他真正会去核对的地方；
     * 两边各自数过一遍就已经错过一次（11 对 12），所以只允许它们引用同一个来源。
     */
    it('落地页统计条的「每规则能力数」与中英 README 的能力清单条目数一致', () => {
      const capabilityBullets = (file: string): number => {
        const list = read(file).match(/### (?:Request proxy & modification|代理与请求改写)\n([\s\S]*?)\n### /)?.[1];
        expect(list, `${file} 缺少「请求代理与改写」能力清单`).toBeTruthy();
        return [...(list ?? '').matchAll(/^- \*\*/gm)].length;
      };

      const en = capabilityBullets('README.md');
      expect(en, 'README 能力清单为空').toBeGreaterThan(0);
      expect(capabilityBullets('README.zh-CN.md'), '中英 README 能力清单条目数必须一致').toBe(en);

      for (const [file, label] of [
        ['docs/index.html', /per-rule capabilities/],
        ['docs/zh.html', /规则能力/],
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
