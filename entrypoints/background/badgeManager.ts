import { getProxyConfig } from '@/utils/storage';
import { logger } from '@/utils/logger';

/**
 * 更新扩展图标徽章，显示当前活跃（已启用）规则数量
 */
export async function updateBadge(ruleCount: number): Promise<void> {
  try {
    const text = ruleCount > 0 ? String(ruleCount) : '';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#409EFF' });
  } catch (error) {
    logger.error('Failed to update badge:', error);
  }
}

/**
 * 初始化徽章：读取当前配置并设置初始徽章
 */
export async function initBadge(): Promise<void> {
  try {
    const config = await getProxyConfig();
    const activeCount = config.rules.filter(r => r.enabled).length;
    await updateBadge(activeCount);
    logger.debug('Badge initialized with active rule count:', activeCount);
  } catch (error) {
    logger.error('Failed to init badge:', error);
  }
}
