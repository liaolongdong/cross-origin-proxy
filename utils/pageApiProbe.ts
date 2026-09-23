import { PAGE_API_PROBE, PAGE_API_PROBE_TIMEOUT_MS } from '@/utils/constants';
import { parsePageApiOrigins, type PageApiOrigin } from '@/utils/pageApiOrigins';
import { logger } from '@/utils/logger';

/**
 * 问一次「这一页在调哪些接口」：popup → 桥接层的只读探测
 *
 * 判据与形状全在 `utils/pageApiOrigins.ts`（纯函数），这里只负责**问**与**问不到怎么办**。
 * 分两层的理由和 `utils/dnrSupport.ts` 一样：读得到回包与读不到是两件事，
 * 前者要能脱离浏览器单测，后者要能拿着假 `chrome` 测。
 *
 * 走的是 `tabs.sendMessage`（直达页面的桥接层），不经过 SW——所以它既不在 `MessageType` 里，
 * 也不在 `isTrustedSender` 的分档里，`tests/contentBridge.test.ts` 钉住的那四个出口一个都不加。
 */
export async function probePageApiOrigins(tabId: number | undefined): Promise<PageApiOrigin[]> {
  if (typeof tabId !== 'number') return [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const reply: unknown = await Promise.race([
      // 只问顶层 frame：不带 `frameId` 的 `tabs.sendMessage` 会发给全部 frame，而回包只取
      // 第一个应答者——那等于随机挑一个框架的账，还会让「谁答的」变成界面说不出来的事。
      chrome.tabs.sendMessage(tabId, { type: PAGE_API_PROBE }, { frameId: 0 }),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), PAGE_API_PROBE_TIMEOUT_MS);
      }),
    ]);
    return parsePageApiOrigins(reply);
  } catch (error) {
    // 「Receiving end does not exist」（这一页没有内容脚本：扩展刚安装/刚重载，或站点禁用了它）
    // 是这里的常态而不是故障，因此 debug 级、不重试——一次点击只问一次。
    logger.debug('Page API probe failed:', error);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
