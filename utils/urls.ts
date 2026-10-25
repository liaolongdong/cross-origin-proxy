/**
 * 项目对外链接的唯一真源
 *
 * 抽这一份不是因为「地址该放一起」，而是断链的代价不对称：仓库名、Pages 路径基与说明页地址
 * 一旦在界面里各写一遍，将来改名或换 Pages 基时只有其中一处会跟着改，剩下那几处指向 404——
 * 而扩展界面里的 404 只有用户点下去才发现。`tests/projectLinks.test.ts` 按
 * 「界面侧不得出现外链字面量」守住这一面，与本仓「同一个判据只住一个出口」同一条纪律。
 *
 * 商店条目页刻意不在这里：它必须由 `chrome.runtime.id` 现拼（见 `utils/storePage.ts`）。
 * 写死扩展 ID 的那份链接在解包加载、Edge 加载项与企业策略分发下必然 404——那些安装的 ID
 * 属于别的商店，而这一格点的偏偏是「想去商店看看」的那一刻。
 */

/** GitHub 仓库首页（开源代码、README 与 Issues 入口都从这里派生） */
export const REPO_GITHUB_URL = 'https://github.com/liaolongdong/cross-origin-proxy';

/** Releases 页：每个 `v*` tag 附带构建好的 zip，顶栏版本徽标与「看最新版本」都指这里 */
export const GITHUB_RELEASES_PAGE_URL = `${REPO_GITHUB_URL}/releases`;

/** Issues 页：缺陷与功能请求优先开在这里（带上请求日志与规则导出，比截图好定位） */
export const GITHUB_ISSUES_URL = `${REPO_GITHUB_URL}/issues`;

/** 产品使用说明（中文）：能力、快速上手与 FAQ */
export const PRODUCT_DOCS_URL = 'https://liaolongdong.github.io/cross-origin-proxy/';

/** 产品使用说明（英文）：与中文页条目对等，见 `tests/docs-consistency.test.ts` */
export const PRODUCT_DOCS_URL_EN = `${PRODUCT_DOCS_URL}en.html`;

/**
 * 按界面语言取说明文档地址
 *
 * 未知语言按**英文页**处理：英文是这份站点的兜底档（术语与命令名原样），
 * 把未知语言画成中文页，等于给一个读不懂中文的用户递上中文说明书。
 */
export function productDocsUrl(locale: string): string {
  return locale === 'en' ? PRODUCT_DOCS_URL_EN : PRODUCT_DOCS_URL;
}
