import { defineContentScript } from 'wxt/utils/define-content-script';
import { MessageType } from '@/utils/types';
import type { ProxyConfig } from '@/utils/types';
import { CONTENT_SCRIPT_CHANNEL } from '@/utils/constants';
import { isSimpleRule, isWebSocketRule } from '@/utils/urlMatcher';
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
    rules: (config.rules ?? [])
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
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === MessageType.UPDATE_PROXY_CONFIG) {
        postSyncRules(message.data as ProxyConfig);
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
