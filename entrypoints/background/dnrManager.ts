import { getProxyConfig } from '@/utils/storage';
import { buildDnrRules, buildRegexFilter, buildRegexSubstitution, isSubstitutionValid } from '@/utils/dnrRules';
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
 * - 总开关（config.enabled）关闭时编译出空规则集：DNR 不经扩展 JS，
 *   SW 通道的开关判断拦不住它，否则「关掉代理」后简单规则仍在重定向
 * - regex 类型规则先经 isRegexSupported 校验（DNR 使用 RE2 语法，
 *   与 JS 正则不完全兼容），不支持的规则跳过并告警，避免整批同步失败
 * - 配置变化时向所有标签页广播新配置，驱动 MAIN world 拦截器实时同步
 */

/**
 * 过滤掉 DNR 无法应用的规则，避免单条非法规则导致 updateDynamicRules 整批拒绝：
 * - regex 规则的匹配模式需经 RE2 兼容性校验（DNR 与 JS 正则语法不完全一致）
 * - 所有规则的替换串捕获引用不得越界（越界引用是非法值）
 */
async function filterRegexSupported(rules: ProxyRule[]): Promise<ProxyRule[]> {
  const results = await Promise.all(
    rules.map(async rule => {
      if (rule.matchType === 'regex') {
        try {
          const { isSupported } = await chrome.declarativeNetRequest.isRegexSupported({
            regex: rule.matchPattern,
          });
          if (!isSupported) {
            logger.warn(`Rule "${rule.name}" regex not RE2-compatible, skipped in DNR:`, rule.matchPattern);
            return null;
          }
        } catch {
          return null;
        }
      }
      if (!isSubstitutionValid(buildRegexFilter(rule), buildRegexSubstitution(rule))) {
        logger.warn(`Rule "${rule.name}" substitution references missing capture group, skipped in DNR`);
        return null;
      }
      return rule;
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

export function syncDnrRules(config: ProxyConfig): Promise<void> {
  pendingSyncCount++;
  const next = syncQueue.then(
    () =>
      doSyncDnrRules(config).finally(() => {
        pendingSyncCount--;
      }),
    () =>
      doSyncDnrRules(config).finally(() => {
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

async function doSyncDnrRules(config: ProxyConfig): Promise<void> {
  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map(r => r.id);

    const supported = await filterRegexSupported(Array.isArray(config.rules) ? config.rules : []);
    const { rules: newRules, idMap } = buildDnrRules(supported, config.enabled);

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
    await syncDnrRules(config);

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && STORAGE_KEYS.PROXY_CONFIG in changes) {
        const newConfig = changes[STORAGE_KEYS.PROXY_CONFIG].newValue as ProxyConfig | undefined;
        if (newConfig && Array.isArray(newConfig.rules)) {
          invalidateMatcherCache();
          void syncDnrRules(newConfig);
          void broadcastConfigToTabs(newConfig);
        }
      }
    });

    logger.info('DNR manager initialized');
  } catch (error) {
    logger.error('Failed to initialize DNR manager:', error);
  }
}
