import { KEEPALIVE_ALARM, KEEPALIVE_INTERVAL_MINUTES } from '@/utils/constants';
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
    }
  });
}
