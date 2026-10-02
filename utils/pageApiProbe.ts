import { PAGE_API_PROBE, PAGE_API_PROBE_TIMEOUT_MS, PAGE_CORS_PROBE } from '@/utils/constants';
import { parsePageApiOrigins, type PageApiOrigin } from '@/utils/pageApiOrigins';
import { parseCorsSuspects, type CorsSuspect } from '@/utils/corsSuspects';
import { logger } from '@/utils/logger';

/**
 * popup → 桥接层的两次只读探测：「这一页在调谁」与「调了但像是没通」
 *
 * 判据与形状全在 `utils/pageApiOrigins.ts` 与 `utils/corsSuspects.ts`（纯函数），这里只负责
 * **问**与**问不到怎么办**。分两层的理由和 `utils/dnrSupport.ts` 一样：读得到回包与读不到是
 * 两件事，前者要能脱离浏览器单测，后者要能拿着假 `chrome` 测。
 *
 * 走的是 `tabs.sendMessage`（直达页面的桥接层），不经过 SW——所以它们既不在 `MessageType` 里，
 * 也不在 `isTrustedSender` 的分档里，`tests/contentBridge.test.ts` 钉住的那四个出口一个都不加。
 */

/**
 * 问一次，只问顶层 frame，到上限就按「问不到」处理
 *
 * 不带 `frameId` 的 `tabs.sendMessage` 会发给全部 frame，而回包只取第一个应答者——那等于随机
 * 挑一个框架的账，还会让「谁答的」变成界面说不出来的事。
 * 超时那条分支必须与「这一页没有内容脚本」同样落成 `null`：一次点击悬在那里比少一个读数糟得多。
 */
async function askPage(tabId: number, type: string): Promise<unknown | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, { type }, { frameId: 0 }),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), PAGE_API_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probePageApiOrigins(tabId: number | undefined): Promise<PageApiOrigin[]> {
  if (typeof tabId !== 'number') return [];
  try {
    return parsePageApiOrigins(await askPage(tabId, PAGE_API_PROBE));
  } catch (error) {
    // 「Receiving end does not exist」（这一页没有内容脚本：扩展刚安装/刚重载，或站点禁用了它）
    // 是这里的常态而不是故障，因此 debug 级、不重试——一次点击只问一次。
    logger.debug('Page API probe failed:', error);
    return [];
  }
}

/**
 * 探测这一页「像是被 CORS 拦下」的来源
 *
 * 与上面那条同一次点击发出、彼此独立：它读到空不影响接口候选照旧列出，问不到也不影响那一条。
 * 回包是页面自报的（见 `utils/corsSuspects.ts`），所以界面拿它只能加一个「疑似」标记。
 */
export async function probeCorsSuspects(tabId: number | undefined): Promise<CorsSuspect[]> {
  if (typeof tabId !== 'number') return [];
  try {
    return parseCorsSuspects(await askPage(tabId, PAGE_CORS_PROBE));
  } catch (error) {
    logger.debug('Page CORS probe failed:', error);
    return [];
  }
}
