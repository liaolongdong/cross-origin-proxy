import { getProxyConfig } from '@/utils/storage';
import { buildDnrRules } from '@/utils/dnrRules';
import { checkDnrRule, usesDnrChannel } from '@/utils/dnrSupport';
import { logger } from '@/utils/logger';
import { MessageType } from '@/utils/types';
import { STORAGE_KEYS } from '@/utils/constants';
import { invalidateMatcherCache, isSimpleRule } from '@/utils/urlMatcher';
import type { ProxyRule, ProxyConfig } from '@/utils/types';
import { setDnrRuleIdMap } from './dnrStats';
import { invalidateDnrSample } from './dnrSampler';
import { clearConfigUnsynced, markConfigUnsynced } from './configSyncState';

/**
 * DNR 管理器
 *
 * 职责：
 * - 将启用的简单规则（无 headerOverrides）同步为 DNR 动态重定向规则，
 *   由浏览器网络层零开销完成重定向（复杂规则走 SW fetch 通道）
 * - 总开关（config.enabled）关闭时编译出空规则集：DNR 不经扩展 JS，
 *   SW 通道的开关判断拦不住它，否则「关掉代理」后简单规则仍在重定向
 * - regex 类型规则先经 RE2 兼容性校验（DNR 使用 RE2 语法，与 JS 正则不完全兼容），
 *   不支持的规则跳过并告警，避免整批同步失败；判定与前端告警共用 utils/dnrSupport
 * - 配置变化时向所有标签页广播新配置，驱动 MAIN world 拦截器实时同步
 */

/**
 * 过滤掉 DNR 无法应用的规则，避免单条非法规则导致 updateDynamicRules 整批拒绝：
 * - regex 规则的匹配模式需经 RE2 兼容性校验（DNR 与 JS 正则语法不完全一致）
 * - 所有规则的替换串捕获引用不得越界（越界引用是非法值）
 *
 * 判定与前端告警共用 `utils/dnrSupport` 的 `checkDnrRule`，两侧口径不会分叉；
 * 非 DNR 候选（复杂规则/停用规则）由 `buildDnrRules` 过滤，无需校验。
 */
async function filterDnrApplicableRules(rules: ProxyRule[]): Promise<ProxyRule[]> {
  const results = await Promise.all(
    rules.map(async rule => {
      if (!usesDnrChannel(rule)) return rule;
      const reason = await checkDnrRule(rule);
      if (!reason) return rule;
      logger.warn(
        reason === 'regexUnsupported'
          ? `Rule "${rule.name}" regex not RE2-compatible, skipped in DNR:`
          : `Rule "${rule.name}" substitution references missing capture group, skipped in DNR`,
        rule.matchPattern,
      );
      return null;
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

    const supported = await filterDnrApplicableRules(Array.isArray(config.rules) ? config.rules : []);
    const { rules: newRules, idMap } = buildDnrRules(supported, config.enabled);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: newRules,
    });
    setDnrRuleIdMap(idMap);
    // 规则集是全量重建的，旧窗口里的计数可能已指向别的规则 id；id 映射也换了，采样缓存必须一起丢
    invalidateDnrSample('dnr-synced');

    logger.info(`DNR rules synced: ${newRules.length} rules active`);
  } catch (error) {
    logger.error('Failed to sync DNR rules:', error);
  }
}

/** 能收到配置广播的标签页：http(s) 页面，且文档已经加载完 */
function isBroadcastTarget(tab: chrome.tabs.Tab): boolean {
  return tab.status === 'complete' && /^https?:/i.test(tab.url ?? '');
}

/**
 * 向所有标签页广播最新配置（content.ts 收到后转发给 MAIN world 拦截器），并记下没送达的页面
 *
 * 说明：runtime.sendMessage 不会到达内容脚本，必须用 tabs.sendMessage 逐 tab 推送。
 * 只有 http(s) 且已加载完的页面参与：chrome://、商店页、扩展页**永远**收不到推送，
 * 刷新也救不回来，给它们记一笔就是句假警告；正在加载的页面处在「新文档自己去拉配置」的
 * 窗口期（`content.ts` 注入时主动 `GET_PROXY_CONFIG`），此时记同样是误报，
 * 而它落到 `loading` 时账已被 `setupConfigSyncState` 清过，无需在这里补。
 *
 * 回执的粒度是标签页：`tabs.sendMessage` 不带 frameId 会发给全部 frame，Promise 只告诉我们
 * 「有没有人接住」，不区分是哪一个 frame。所以这一笔账说的是「这个页面有没有在跑最新配置」，
 * 不是「每个 frame 都拿到了」——后者需要 `webNavigation` 级别的定位，收益不匹配代价。
 *
 * 导出仅为可测性（同 `messageRouter` 的 `isTrustedSender`）：这条「静默丢失败」的路径
 * 是本次要修的东西，行为必须在 SW 之外钉住。
 */
export async function broadcastConfigToTabs(config: ProxyConfig): Promise<void> {
  try {
    if (!Array.isArray(config.rules)) return;
    const tabs = await chrome.tabs.query({});
    const interceptorConfig: ProxyConfig = {
      enabled: config.enabled,
      rules: config.rules.filter(rule => !isSimpleRule(rule)),
    };
    const targets = tabs.filter(tab => tab.id !== undefined && isBroadcastTarget(tab));
    const results = await Promise.allSettled(
      targets.map(tab =>
        chrome.tabs.sendMessage(tab.id!, {
          type: MessageType.UPDATE_PROXY_CONFIG,
          data: interceptorConfig,
        }),
      ),
    );
    results.forEach((result, index) => {
      const tabId = targets[index].id!;
      if (result.status === 'fulfilled') clearConfigUnsynced(tabId);
      else markConfigUnsynced(tabId);
    });
  } catch (error) {
    logger.debug('Broadcast config to tabs failed:', error);
  }
}

/**
 * 初始化 DNR 管理器：注册配置变化监听，并做一次启动时全量同步
 *
 * 监听必须在函数最前面**同步**注册：Service Worker 很可能就是被这次
 * `storage.onChanged` 唤醒的，而 Chrome 只把事件投递给同步启动阶段就注册好的监听器，
 * 放到 `await` 之后再注册会漏掉这一次，表现为「改完规则没生效，直到下一次改动才同步」。
 * 全量同步因此挪到监听之后异步执行。
 */
export function initDnrManager(): void {
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

  void initialSync();
}

/** 启动时按存储里的配置全量重建一次 DNR 规则 */
async function initialSync(): Promise<void> {
  try {
    const config = await getProxyConfig();
    await syncDnrRules(config);
    logger.info('DNR manager initialized');
  } catch (error) {
    logger.error('Failed to initialize DNR manager:', error);
  }
}
