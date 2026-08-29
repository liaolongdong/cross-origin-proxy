import { getProxyConfig } from '@/utils/storage';
import { logger } from '@/utils/logger';

/** 徽章颜色：开启时主题蓝，关闭时中性灰（一眼区分代理状态） */
const BADGE_COLOR_ON = '#409EFF';
const BADGE_COLOR_OFF = '#909399';

/**
 * 更新扩展图标徽章，反映代理总开关与活跃规则数：
 * - 总开关关闭：灰色 "OFF"
 * - 总开关开启：蓝色，显示已启用规则数（无规则时清空文字）
 */
export async function updateBadge(enabled: boolean, ruleCount: number): Promise<void> {
  try {
    if (!enabled) {
      await chrome.action.setBadgeText({ text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_OFF });
      return;
    }
    await chrome.action.setBadgeText({ text: ruleCount > 0 ? String(ruleCount) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_ON });
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
    await updateBadge(config.enabled, activeCount);
    logger.debug('Badge initialized:', config.enabled, 'active rules:', activeCount);
  } catch (error) {
    logger.error('Failed to init badge:', error);
  }
}
