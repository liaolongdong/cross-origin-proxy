import { KEEPALIVE_ALARM, KEEPALIVE_INTERVAL_MINUTES } from '@/utils/constants';
import { flushLogs } from '@/utils/storage';
import { logger } from '@/utils/logger';

/**
 * Setup Service Worker keepalive
 */
export function setupKeepalive(): void {
  // Create periodic alarm to keep SW alive
  chrome.alarms.create(KEEPALIVE_ALARM, {
    periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
  });

  // Listen for alarm to do periodic tasks
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === KEEPALIVE_ALARM) {
      logger.debug('Keepalive ping');
      // 缓冲区里可能躺着「刷写失败后回灌」的日志：此后既没有新请求触发阈值，
      // 防抖定时器也已在取走快照时被摘掉，不补一次就只能等 SW 被回收时那一下
      // 大概率来不及的 onSuspend。空缓冲区会在 doFlushLogs 里直接返回，不写存储。
      // 刻意挂在这条已有的一分钟心跳上而不是自建重试定时器：配额持续失败时后者会越滚越密。
      void flushLogs();
    }
  });
}
