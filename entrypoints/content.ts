import { defineContentScript } from 'wxt/utils/define-content-script';
import { MessageType } from '@/utils/types';
import type { ProxyConfig } from '@/utils/types';
import { CONTENT_SCRIPT_CHANNEL } from '@/utils/constants';
import { isSimpleRule } from '@/utils/urlMatcher';
import { logger } from '@/utils/logger';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main(ctx) {
    // ISOLATED world: bridge between MAIN world (postMessage) and Background SW (chrome.runtime)
    // NOTE: All postMessage calls use window.location.origin as targetOrigin (not '*')
    // to restrict message delivery to the same origin, preventing cross-origin data leakage.

    /**
     * 双通道分工：简单规则（无 headerOverrides）由 DNR 在网络层重定向，
     * MAIN world 拦截器只需处理复杂规则，因此下发前先过滤，
     * 避免同一请求被两条通道重复代理。
     */
    function toInterceptorConfig(config: ProxyConfig): ProxyConfig {
      return {
        enabled: config.enabled,
        rules: (config.rules ?? []).filter(rule => !isSimpleRule(rule)),
      };
    }

    function postSyncRules(config: ProxyConfig): void {
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
      if (event.data?.type !== MessageType.PROXY_REQUEST) return;

      const { data } = event.data;
      logger.debug('Content script received proxy request:', data.requestId);

      try {
        // Forward to Background SW
        const response = await chrome.runtime.sendMessage({
          type: MessageType.PROXY_REQUEST,
          data,
        });

        // Send response back to MAIN world
        window.postMessage(
          {
            channel: CONTENT_SCRIPT_CHANNEL,
            type: MessageType.PROXY_RESPONSE,
            data: response,
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
