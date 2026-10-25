/**
 * 商店页面的地址（评分入口与条目页入口用）
 *
 * 两件事都在 Chrome Web Store 的政策与官方文档上核过（2026-10-19）：
 * - 政策禁的是**操纵**评价——激励换评、刷量、自评与关联方评；它没有禁止「征求评价」这件事本身。
 *   真正会撞线的是形态：弹窗拦截、伪装成浏览器警告、反复骚扰。所以本仓的入口是一格常驻的
 *   界面行（见 `components/options/SettingsDialog.vue`），没有自动出现的路径。
 * - 官方文档正面教开发者「在条目 URL 末尾加 `/reviews`」直达评分页。
 *
 * `slug` 刻意不写：条目 URL 只需要 ID。写死 slug 的话，商店名一改（那是商店文案里唯一允许
 * 出现品牌名的地方）这条链接就当场断掉，而且断在用户最想点的那一格上。
 */

/**
 * 商店条目页地址
 *
 * `extensionId` 由调用方给 `chrome.runtime.id`，理由与评分页那一份完全相同：写死 ID 的链接
 * 在解包加载与别的商店的安装下必然 404，而这一格点的偏偏是「想去商店看看」。
 */
export function storeDetailUrl(extensionId: string): string {
  return `https://chromewebstore.google.com/detail/${extensionId}`;
}

/** 商店评分页的直达地址；`extensionId` 由调用方给 `chrome.runtime.id`，不要在这里现取 */
export function storeReviewUrl(extensionId: string): string {
  return `${storeDetailUrl(extensionId)}/reviews`;
}

/**
 * 这份构建是不是从 Chrome 应用商店装的
 *
 * 判据是 `manifest.update_url` **指向 Google 那台 CRX 更新服务器**，不是「这个字段非空」。
 * 差一个字面量的后果正是这一格要避免的那件事：Edge 加载项、厂商自建 XML、企业策略分发都写
 * `update_url`，但那套安装下的扩展 ID 属于另一个商店，`chromewebstore.google.com/detail/<那个 id>`
 * 必然 404——闸门只认「这条链接在这台安装上真的打得到」。
 *
 * 认不出来的新形状按**不出现**处理（宁可少一个入口，也不画一个坏按钮）。
 * 收 `unknown` 而不是 `string`：manifest 是从运行时读来的，形状不该由这里替它保证。
 */
const GOOGLE_CRX_UPDATER = /^https:\/\/clients2\.google(apis|usercontent)?\.com\/service\/update2\/crx\/?$/;

export function isStoreInstalled(updateUrl: unknown): boolean {
  return typeof updateUrl === 'string' && GOOGLE_CRX_UPDATER.test(updateUrl.trim());
}
