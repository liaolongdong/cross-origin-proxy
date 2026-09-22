import { CONFIG_SYNC_TAB_CACHE_SIZE } from '@/utils/constants';

/**
 * 配置广播的送达账 —— 回答「这一页拿到最新配置了吗」
 *
 * 复杂规则靠 `tabs.sendMessage` 推给已打开的页面（见 `dnrManager.broadcastConfigToTabs`）。
 * 推不到的标签页过去被 `Promise.allSettled` 静默丢掉，于是「改完规则这个页没反应」只剩两种解释：
 * 用户怀疑自己没改对，或者去逐条排查规则。这里把**确实没收到的 http(s) 标签页**记一笔账，
 * 让弹窗能说一句话；其余标签页保持沉默。
 *
 * 记账方向刻意是「只记已知的问题」：没有这笔账就是「已同步」。启动时、导航后、新开的标签页
 * 都会由内容脚本自己拉一次配置（`entrypoints/content.ts` 的初始同步），那本来就是同步路径，
 * 不需要额外记账——反过来记就会把「不知道」画成「有问题」。也正因为它一拉就说明「我拿到新配置了」，
 * 那次拉取会把这一页**已经记下**的账清掉（见 `messageRouter` 的 `GET_PROXY_CONFIG`）：上一次广播
 * 留下的失败标记，在页面自己取到配置的这一刻就作废。它管不到**晚于**这次拉取才落下的回绝，
 * 那一格的成因与代价写在 `dnrManager.broadcastConfigToTabs` 的注释里。
 *
 * 与 `interceptorStats.ts` 一样，全部状态都是模块级的，**SW 回收即清零**：
 * 这笔账的有效期只有「本次配置变更到该页下一次导航」之间，持久化它毫无意义
 * （而且重启后页面早已自己拉过配置，留下旧账就是一句过期的警告）。
 */

/** 已知的「没收到最新配置」的标签页；插入序即「记下的先后」，超出上限时逐出最早那条 */
const unsyncedTabs = new Set<number>();

/**
 * 记下一笔「这个标签页没接到配置广播」
 *
 * 幂等：同一标签页重复记不叠加（`Set` 天然如此），因为连续两次失败的广播对用户仍然是同一件事。
 */
export function markConfigUnsynced(tabId: number): void {
  unsyncedTabs.add(tabId);
  while (unsyncedTabs.size > CONFIG_SYNC_TAB_CACHE_SIZE) {
    const oldest = unsyncedTabs.values().next().value;
    if (oldest === undefined) break;
    unsyncedTabs.delete(oldest);
  }
}

/** 这个标签页接住了配置（或换了新文档、被关闭）：清账，弹窗那一句随之消失 */
export function clearConfigUnsynced(tabId: number): void {
  unsyncedTabs.delete(tabId);
}

/**
 * 这个标签页最近一次广播有没有收到
 *
 * @returns `true` = 确实没收到；`false` = 收到了，或从来没有过这笔账（两者对用户同样是「不用提醒」）
 */
export function isConfigUnsynced(tabId: number): boolean {
  return unsyncedTabs.has(tabId);
}

/**
 * 注册生命周期钩子：关标签页与整页导航都清账
 *
 * `onUpdated` 只认 `loading`——那是「新文档开始、它自己会去拉配置」的信号。刻意不认 `complete`：
 * 它每次加载完都会触发，把「本次会话里一直没同步」的事实抹掉，而真正需要这句提醒的场景
 * （扩展重载后用户改配置、页面却还开着旧规则）恰恰是页面早已 `complete` 的那些。
 * 除了这里，内容脚本主动拉配置（`GET_PROXY_CONFIG`）也会清账：它下一秒用的就是这份配置。
 *
 * 已知边界是标签页粒度，两个方向都要如实说：任意一个 frame 回执就抹掉整页的账，所以这句话
 * 说的是「这一页有没有在跑最新配置的 frame」，不是「每个 frame 都在跑」；而 iframe 单独换文档
 * 不会触发主框架的 `loading`，那一页的旧账因此留着。分开两个方向需要 `webNavigation`
 * 级别的定位，刻意不为它加权限。
 */
export function setupConfigSyncState(): void {
  chrome.tabs.onRemoved.addListener(tabId => clearConfigUnsynced(tabId));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') clearConfigUnsynced(tabId);
  });
}
