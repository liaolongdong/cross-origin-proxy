/**
 * 可代发协议的白名单
 *
 * 唯一出口：SW 代发（`entrypoints/background/proxyHandler.ts`）与日志重放
 * （`utils/requestReplay.ts`）读同一份，不各写一把尺。
 *
 * 为什么这条必须在「真正出门那一刻」守住，而不是靠规则匹配兜住：
 * `PROXY_REQUEST` 里的 `url` 是页面给的，而同页任意脚本都能往桥接层那个频道发消息
 * （`postMessage` 的 targetOrigin 挡不住同页脚本，这是本仓写在册的前提）。一条
 * `{matchType:'wildcard', matchPattern:'*', targetUrl:''}` 的规则形状合法、
 * `isSimpleRule` 因空目标强制把它交给 SW、`rewriteUrl` 对空目标原样返回 URL
 * ——三件事各自都对，叠在一起就是页面可以点名让扩展去取任意地址，并由扩展的
 * `<all_urls>` 权限把响应正文送回它手里。内网端点与云元数据地址不需要任何额外开关；
 * `file://` 那一档只在用户勾了「允许访问文件网址」时才走得通。
 *
 * 反向的取舍也说清楚：这里**不**放 `ws:` / `wss:`。长连接的握手由 MAIN world 在页面侧
 * 重建（见 AGENTS.md「长连接的能力面只有三件事」），从来不走这一次 `fetch`，
 * 把它列进来等于给一条根本不存在的路放行。
 */
export const PROXYABLE_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/**
 * 这个地址能不能由扩展代发
 *
 * 判据是「读得出协议、且协议在白名单上」。非字符串、空串、解析不出（相对路径、畸形百分号）
 * 一律算**不可代发**——不是「先放行再看」：这一格站在出网之前，默认方向只能朝保守。
 */
export function isProxyableUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  try {
    return PROXYABLE_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * 读出一串地址的协议，读不出给空串
 *
 * 存在的理由只有一个：日志里不许出现整条 URL 的原文（被拒的那一串可能是页面凭空编的本地路径），
 * 但「它试的是哪个协议」这句必须说得出——否则排查时只看得见一句「没代发」，看不见为什么。
 */
export function protocolOf(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}
