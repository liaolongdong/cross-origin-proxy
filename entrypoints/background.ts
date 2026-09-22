import { defineBackground } from 'wxt/utils/define-background';
import { setupMessageRouter } from './background/messageRouter';
import { setupKeepalive } from './background/keepalive';
import { setupAutoOff } from './background/autoOff';
import { initDnrManager, syncDnrRules } from './background/dnrManager';
import { invalidateDnrSample } from './background/dnrSampler';
import { setupInterceptorStats } from './background/interceptorStats';
import { initBadge, updateBadge } from './background/badgeManager';
import { resetSwHitStats } from './background/proxyHandler';
import type { ProxyConfig } from '@/utils/types';
import { logger } from '@/utils/logger';
import { STORAGE_KEYS, DEFAULT_PROXY_CONFIG } from '@/utils/constants';
import { flushLogs, toggleProxy } from '@/utils/storage';

export default defineBackground(() => {
  logger.info('Background Service Worker started');

  // 扩展安装/更新时的初始化
  chrome.runtime.onInstalled.addListener(async details => {
    if (details.reason === 'install') {
      // 首次安装：设置默认配置
      await chrome.storage.local.set({
        [STORAGE_KEYS.PROXY_CONFIG]: DEFAULT_PROXY_CONFIG,
      });
      // 显式同步 DNR 规则，确保安装后规则立即生效
      await syncDnrRules(DEFAULT_PROXY_CONFIG);
      logger.info('Extension installed, default config set');
    } else if (details.reason === 'update') {
      logger.info('Extension updated to', chrome.runtime.getManifest().version);
    }
  });

  // 浏览器启动时的初始化
  chrome.runtime.onStartup.addListener(async () => {
    logger.info('Browser startup, DNR rules will be re-initialized by main initDnrManager()');
  });

  // Initialize DNR rules from stored config
  initDnrManager();

  // Setup message routing
  setupMessageRouter();

  // 拦截器自报计数的生命周期（关标签页与导航时清掉读数）
  setupInterceptorStats();

  // Setup keepalive
  setupKeepalive();

  // Setup proxy auto-off countdown
  setupAutoOff();

  // Initialize badge with active rule count
  initBadge();

  // Update badge whenever proxy config changes in storage
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (STORAGE_KEYS.PROXY_CONFIG in changes) {
      const newConfig = changes[STORAGE_KEYS.PROXY_CONFIG].newValue as ProxyConfig | undefined;
      // 配置一变，两份读数同时过期：SW 计数本来就是「自上次配置变更」口径，DNR 采样缓存
      // 也必须作废，否则关闭代理后 popup 还能看到历史命中。刻意放在 rules 守卫之外——
      // `proxy_config` 被整体清掉时 newValue 是 undefined，那时两份读数同样不再成立。
      resetSwHitStats();
      invalidateDnrSample('config-changed');
      if (newConfig?.rules) {
        const activeCount = newConfig.rules.filter(r => r.enabled).length;
        updateBadge(newConfig.enabled, activeCount);
      }
    }
  });

  // Flush pending logs before Service Worker suspends
  chrome.runtime.onSuspend?.addListener(() => {
    void flushLogs();
  });

  // Keyboard shortcut: toggle proxy on/off
  chrome.commands.onCommand.addListener(async command => {
    if (command === 'toggle-proxy') {
      const enabled = await toggleProxy();
      logger.info(`Proxy toggled via keyboard shortcut: ${enabled}`);
    }
  });
});
