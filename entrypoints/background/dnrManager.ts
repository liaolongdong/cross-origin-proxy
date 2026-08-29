import { getProxyConfig } from '@/utils/storage';
import { buildDnrRules } from '@/utils/dnrRules';
import { logger } from '@/utils/logger';
import { MessageType } from '@/utils/types';
import { STORAGE_KEYS } from '@/utils/constants';
import { invalidateMatcherCache, isSimpleRule } from '@/utils/urlMatcher';
import type { ProxyRule, ProxyConfig } from '@/utils/types';
import { setDnrRuleIdMap } from './dnrStats';

/**
 * DNR 管理器
 *
 * 职责：
 * - 将启用的简单规则（无 headerOverrides）同步为 DNR 动态重定向规则，
 *   由浏览器网络层零开销完成重定向（复杂规则走 SW fetch 通道）
 * - regex 类型规则先经 isRegexSupported 校验（DNR 使用 RE2 语法，
 *   与 JS 正则不完全兼容），不支持的规则跳过并告警，避免整批同步失败
 * - 配置变化时向所有标签页广播新配置，驱动 MAIN world 拦截器实时同步
 */

/**
 * 校验 regex 规则的 RE2 兼容性，过滤掉 DNR 不支持的规则
 */
async function filterRegexSupported(rules: ProxyRule[]): Promise<ProxyRule[]> {
  const results = await Promise.all(
    rules.map(async rule => {
      if (rule.matchType !== 'regex') return rule;
      try {
        const { isSupported } = await chrome.declarativeNetRequest.isRegexSupported({
          regex: rule.matchPattern,
        });
        if (!isSupported) {
          logger.warn(`Rule "${rule.name}" regex not RE2-compatible, skipped in DNR:`, rule.matchPattern);
          return null;
        }
        return rule;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is ProxyRule => r !== null);
}

/**
 * 同步 DNR 动态规则（先移除全部旧规则再重建），并更新命中统计的 id 映射
 *
 * “读旧规则 → 重建”非原子操作，storage 连续变更时并发调用会产生规则 ID 冲突，
 * 因此用 Promise 队列串行化（队列变量仅用于同一 SW 生命周期内的互斥，非持久状态）
 */
let syncQueue: Promise<void> = Promise.resolve();
let pendingSyncCount = 0;

export function syncDnrRules(rules: ProxyRule[]): Promise<void> {
  pendingSyncCount++;
  const next = syncQueue.then(
    () =>
      doSyncDnrRules(rules).finally(() => {
        pendingSyncCount--;
      }),
    () =>
      doSyncDnrRules(rules).finally(() => {
        pendingSyncCount--;
      }),
  );
  syncQueue = next.then(
    () => {},
    () => {},
  );

  // Reset queue when all pending syncs are done to prevent unbounded growth
  next.finally(() => {
    if (pendingSyncCount === 0) {
      syncQueue = Promise.resolve();
    }
  });

  return next;
}

async function doSyncDnrRules(rules: ProxyRule[]): Promise<void> {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map(r => r.id);

    const supported = await filterRegexSupported(rules);
    const { rules: newRules, idMap } = buildDnrRules(supported);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: newRules,
    });
    setDnrRuleIdMap(idMap);

    logger.info(`DNR rules synced: ${newRules.length} rules active`);
  } catch (error) {
    logger.error('Failed to sync DNR rules:', error);
  }
}

/**
 * 向所有标签页广播最新配置（content.ts 收到后转发给 MAIN world 拦截器）
 *
 * 说明：runtime.sendMessage 不会到达内容脚本，必须用 tabs.sendMessage 逐 tab 推送；
 * 未注入内容脚本的页面（chrome://、商店页等）会报错，静默忽略即可。
 */
async function broadcastConfigToTabs(config: ProxyConfig): Promise<void> {
  try {
    if (!Array.isArray(config.rules)) return;
    const tabs = await chrome.tabs.query({});
    const interceptorConfig: ProxyConfig = {
      enabled: config.enabled,
      rules: config.rules.filter(rule => !isSimpleRule(rule)),
    };
    await Promise.allSettled(
      tabs
        .filter(tab => tab.id !== undefined)
        .map(tab =>
          chrome.tabs.sendMessage(tab.id!, {
            type: MessageType.UPDATE_PROXY_CONFIG,
            data: interceptorConfig,
          }),
        ),
    );
  } catch (error) {
    logger.debug('Broadcast config to tabs failed:', error);
  }
}

/**
 * 初始化 DNR 管理器：启动时全量同步，并监听配置变化增量同步 + 广播
 */
export async function initDnrManager(): Promise<void> {
  try {
    const config = await getProxyConfig();
    // 防御存储损坏：rules 非数组时按空集处理
    await syncDnrRules(Array.isArray(config.rules) ? config.rules : []);

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && STORAGE_KEYS.PROXY_CONFIG in changes) {
        const newConfig = changes[STORAGE_KEYS.PROXY_CONFIG].newValue as ProxyConfig | undefined;
        if (newConfig && Array.isArray(newConfig.rules)) {
          invalidateMatcherCache();
          void syncDnrRules(newConfig.rules);
          void broadcastConfigToTabs(newConfig);
        }
      }
    });

    logger.info('DNR manager initialized');
  } catch (error) {
    logger.error('Failed to initialize DNR manager:', error);
  }
}
