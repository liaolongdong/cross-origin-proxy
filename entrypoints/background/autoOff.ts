import { getProxyConfig, toggleProxy } from '@/utils/storage';
import { STORAGE_KEYS, AUTO_OFF_ALARM } from '@/utils/constants';
import { logger } from '@/utils/logger';

/**
 * 代理自动关闭
 *
 * 跨环境调试场景下忘记关代理可能把线上流量引到错误环境，
 * 此模块在总开关开启且设置了时长时用 chrome.alarms 倒计时，
 * 到期自动关闭总开关。alarm 由浏览器持久化，SW 休眠/重启不丢倒计时。
 */

async function getAutoOffMinutes(): Promise<number> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.AUTO_OFF_MINUTES);
  const minutes = result[STORAGE_KEYS.AUTO_OFF_MINUTES];
  return typeof minutes === 'number' && minutes > 0 ? minutes : 0;
}

/**
 * 重新评估自动关闭 alarm：
 * - 代理开启 + 已配置时长：确保倒计时存在（已存在时不重置，除非强制重建）
 * - 代理关闭或时长为 0：清除倒计时
 * @param force 时长配置刚被修改时为 true，按新时长重建倒计时
 */
export async function reevaluateAutoOff(force = false): Promise<void> {
  try {
    const [config, minutes] = await Promise.all([getProxyConfig(), getAutoOffMinutes()]);

    if (!config.enabled || minutes <= 0) {
      await chrome.alarms.clear(AUTO_OFF_ALARM);
      return;
    }

    const existing = await chrome.alarms.get(AUTO_OFF_ALARM);
    if (existing && !force) return;
    if (existing) await chrome.alarms.clear(AUTO_OFF_ALARM);
    await chrome.alarms.create(AUTO_OFF_ALARM, { delayInMinutes: minutes });
    logger.info(`Auto-off armed: proxy will disable after ${minutes} min`);
  } catch (error) {
    logger.error('Failed to reevaluate auto-off:', error);
  }
}

/**
 * 初始化：监听 alarm 到期与相关存储变化
 */
export function setupAutoOff(): void {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== AUTO_OFF_ALARM) return;
    toggleProxy(false)
      .then(() => logger.info('Proxy auto-disabled by countdown'))
      .catch(error => logger.error('Auto-disable failed:', error));
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const durationChanged = STORAGE_KEYS.AUTO_OFF_MINUTES in changes;
    if (STORAGE_KEYS.PROXY_CONFIG in changes || durationChanged) {
      // 时长刚被修改时按新时长重建倒计时
      void reevaluateAutoOff(durationChanged);
    }
  });

  // SW 重启后恢复状态一致性（alarm 本身持久化，这里只做兜底校验）
  void reevaluateAutoOff();
}
