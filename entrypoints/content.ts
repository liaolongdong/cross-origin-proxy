import { defineContentScript } from 'wxt/utils/define-content-script';
import { MessageType } from '@/utils/types';
import type { ProxyConfig } from '@/utils/types';
import { CONTENT_SCRIPT_CHANNEL, PAGE_API_PROBE } from '@/utils/constants';
import { isSimpleRule, isWebSocketRule } from '@/utils/urlMatcher';
import { summarizeApiOrigins } from '@/utils/pageApiOrigins';
import { normalizeProxyResponse } from '@/utils/proxyResponse';
import { logger } from '@/utils/logger';

/**
 * 仅 SW 使用、页面侧从不读取的规则字段。
 * 拦截器只依赖 matchPattern、matchType、targetUrl、methods、blocked、delayMs、
 * retryCount、retryDelay、name、enabled（`queryOverrides` 只有 WS 规则需要，见下）；
 * 代理时 SW 会用 storage 里的完整规则重新应用这些能力，因此它们没有理由出现在发往页面的副本里。
 * `sendCredentials` 同属此类：拦截器不做任何 fetch，带不带 Cookie 完全由 SW 决定，
 * 页侧读到它没有任何作用，只是多一条可被同源脚本监听的规则能力画像。
 */
const PAGE_IRRELEVANT_FIELDS = [
  'headerOverrides',
  'requestBodyOverride',
  'responseOverrides',
  'mockResponse',
  'sendCredentials',
] as const;

/**
 * 双通道分工 + 凭据脱敏：
 *
 * 1. 简单规则（无 headerOverrides 等 SW 专属能力）由 DNR 在网络层重定向，
 *    MAIN world 拦截器只需处理复杂规则，因此下发前先过滤，
 *    避免同一请求被两条通道重复代理。
 * 2. 再剥离仅 SW 使用的凭据字段。配置经 `postMessage` 送达 MAIN world，
 *    而**同页面的任意脚本都能监听这些消息**（入站校验只挡跨窗口，挡不住同源），
 *    留着 `headerOverrides` 等于把「把 token 从代码挪进规则」的凭据
 *    广播给用户访问的每个站点。
 * 3. `queryOverrides` 同理按能力收窄：只有 WS 规则的地址重写在本 world 完成
 *    （`rewriteWsUrl` 要读它），HTTP 侧一律由 SW 追加，因此非 WS 规则不必带。
 *
 * 各步顺序不可颠倒：`isSimpleRule` 依赖这些字段判定分流。
 *
 * 导出仅为可测性（同 `messageRouter` 的 `isTrustedSender`）——桥接层跑在 ISOLATED world，
 * 这条纯函数是页面侧凭据不外泄的唯一出口。
 */
export function toInterceptorConfig(config: ProxyConfig): ProxyConfig {
  return {
    enabled: config.enabled,
    // 数组判据而不是 `?? []`：手改过的 storage 能把 `rules` 变成一个对象，而 `?? ` 只挡空值。
    // 抛出位置有两处，症状不一样：广播路径（`UPDATE_PROXY_CONFIG`）抛在 `sendResponse` 之前，
    // 送达账因此这一页记成未同步，弹窗那句「尚未收到最新配置」说得出；主动拉取路径抛在
    // `.catch(logger.debug)` 里，咽成一行 debug，于是这一页的复杂规则静默按原生路径发出。
    // 后台侧同一判据收在 `utils/storage.ts` 的 `configRules()`，本 world 不能引它（会把存储门面
    // 连带一个用不到的 `chrome.storage.onChanged` 监听拖进每个 frame），故本地写一份，
    // 由 `tests/channel-consistency.test.ts` 与拦截器那侧成对钉住。
    rules: (Array.isArray(config.rules) ? config.rules : [])
      .filter(rule => !isSimpleRule(rule))
      .map(rule => {
        const pageRule = { ...rule };
        for (const field of PAGE_IRRELEVANT_FIELDS) delete pageRule[field];
        if (!isWebSocketRule(rule)) delete pageRule.queryOverrides;
        return pageRule;
      }),
  };
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  // 与 main-interceptor.content.ts 成对声明（两处必须一起改）：少一边就是半份注入——
  // 桥接在 iframe 里收发正常，但对端拦截器不存在，复杂规则静默走原生请求，比「整页不生效」更难查。
  allFrames: true,
  main(ctx) {
    // ISOLATED world: bridge between MAIN world (postMessage) and Background SW (chrome.runtime)
    // NOTE: All postMessage calls use window.location.origin as targetOrigin (not '*')
    // to restrict message delivery to the same origin, preventing cross-origin data leakage.

    /** 最近一次下发的配置缓存（供 MAIN world 主动请求时回放，消除注入时序竞态） */
    let lastConfig: ProxyConfig | null = null;

    function postSyncRules(config: ProxyConfig): void {
      lastConfig = config;
      window.postMessage(
        {
          channel: CONTENT_SCRIPT_CHANNEL,
          type: 'SYNC_RULES',
          data: toInterceptorConfig(config),
        },
        window.location.origin,
      );
    }

    // Listen for proxy requests from MAIN world interceptor
    ctx.addEventListener(window, 'message', async (event: MessageEvent) => {
      // Only accept messages from same window and our channel
      if (event.source !== window) return;
      if (event.data?.channel !== CONTENT_SCRIPT_CHANNEL) return;

      // MAIN world 监听器就绪后主动请求配置：有缓存直接回放，否则向 SW 拉取
      if (event.data?.type === 'REQUEST_CONFIG') {
        if (lastConfig) {
          postSyncRules(lastConfig);
        } else {
          void chrome.runtime
            .sendMessage({ type: MessageType.GET_PROXY_CONFIG })
            .then((config: ProxyConfig | undefined) => {
              if (config) postSyncRules(config);
            })
            .catch(error => logger.debug('Config request on demand failed:', error));
        }
        return;
      }

      // 拦截器自报的本页活动计数：只转发，不写 storage、不改任何状态。
      // 这里只把载荷收窄成四个键（页面给的可能是任意对象），数值合法性留给 SW 判；
      // 伪造防护也不在这一层——同页脚本本来就能发这条消息，所以收端把它当展示数据。
      if (event.data?.type === MessageType.INTERCEPTOR_STATS) {
        const raw = event.data.data as Record<string, unknown> | undefined;
        if (!raw || typeof raw !== 'object') return;
        void chrome.runtime
          .sendMessage({
            type: MessageType.INTERCEPTOR_STATS,
            data: {
              intercepted: raw.intercepted,
              proxied: raw.proxied,
              fellBack: raw.fellBack,
              timedOut: raw.timedOut,
            },
          })
          // SW 回收期本来就送不出去。计数是旁路观测，下一次节流上报会带上累计值，因此不重试、
          // 也不降级成 error——那只会给控制台添一条与用户无关的噪音。
          .catch(() => {});
        return;
      }

      // 页面取消了自己那笔代发（fetch 的 signal / xhr.abort()）：只把 requestId 转给后台，
      // 让它掐断上游连接与后续重试。
      // 载荷刻意收窄成一个键——转发整包 `event.data.data` 会把 URL 等页面数据顺带递给
      // 一个只需要 id 的处理器；回执（有没有掐到）在页面侧没有读者，因此不等、不重试，
      // SW 回收期本来也送不出去。
      if (event.data?.type === MessageType.CANCEL_REQUEST) {
        const requestId = (event.data.data as { requestId?: unknown } | undefined)?.requestId;
        if (typeof requestId !== 'string' || !requestId) return;
        void chrome.runtime.sendMessage({ type: MessageType.CANCEL_REQUEST, data: { requestId } }).catch(() => {});
        return;
      }

      if (event.data?.type !== MessageType.PROXY_REQUEST) return;

      const { data } = event.data;
      logger.debug('Content script received proxy request:', data.requestId);

      try {
        // Forward to Background SW
        const response = await chrome.runtime.sendMessage({
          type: MessageType.PROXY_REQUEST,
          data,
        });

        // Send response back to MAIN world.
        // 后台抛错时回的是无 requestId/无 status 的失败信封，原样转发会让拦截器
        // 无人认领而挂到超时、进而回退原生请求，因此在边界处整形
        window.postMessage(
          {
            channel: CONTENT_SCRIPT_CHANNEL,
            type: MessageType.PROXY_RESPONSE,
            data: normalizeProxyResponse(response, String(data.requestId ?? '')),
          },
          window.location.origin,
        );
      } catch (error) {
        logger.error('Content script proxy error:', error);
        // Send sanitized error response back (don't expose internal error details)
        window.postMessage(
          {
            channel: CONTENT_SCRIPT_CHANNEL,
            type: MessageType.PROXY_RESPONSE,
            data: {
              requestId: data.requestId,
              status: 0,
              statusText: 'Content Script Error',
              headers: {},
              body: 'Proxy request failed',
              isBase64: false,
            },
          },
          window.location.origin,
        );
      }
    });

    // Listen for config sync messages from background (rule updates pushed to content scripts)
    // 必须同步回执：后台靠这条 promise 的 resolve/reject 判断「这个页面接住了新配置」，
    // 而「有监听器但不作答」在 Chrome 那边与「压根没有内容脚本」难以区分。回执只说「收到了」，
    // 不回任何规则内容——页面侧本来就是配置的接收方，多回一份只是多一次外泄面。
    //
    // popup 的接口探测走同一个监听器：`tabs.sendMessage` 到不了网页（页面没有通往内容脚本的
    // runtime 消息通道），所以这一支不需要来源校验，也不需要 `return true`——读资源计时是同步的。
    // 只回 origin 与条数（判据在 `utils/pageApiOrigins.ts`）：路径与查询串常带 id、token，
    // 而预填一条通配符规则用不到它们，少给一份就少一份外泄面（本机内网地址同样敏感）。
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === MessageType.UPDATE_PROXY_CONFIG) {
        postSyncRules(message.data as ProxyConfig);
        sendResponse({ received: true });
        return;
      }
      if (message.type === PAGE_API_PROBE) {
        sendResponse({
          origins: summarizeApiOrigins(performance.getEntriesByType('resource')),
        });
      }
    });

    // Initial sync: MAIN world 拦截器注入后没有规则，主动向 SW 拉取一次配置
    void chrome.runtime
      .sendMessage({ type: MessageType.GET_PROXY_CONFIG })
      .then((config: ProxyConfig | undefined) => {
        if (config) postSyncRules(config);
      })
      .catch(error => logger.debug('Initial config sync failed:', error));

    logger.debug('Content script bridge initialized');
  },
});
