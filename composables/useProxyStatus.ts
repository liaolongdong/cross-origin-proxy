import { ref, onMounted } from 'vue';
import { MessageType, ProxyStatus, RequestLogEntry } from '@/utils/types';
import { useI18n } from '@/composables/useI18n';
import { formatTimeAgo as _formatTimeAgo, getMethodColor, getStatusColor, truncateUrl } from '@/utils/formatters';

export function useProxyStatus() {
  const { t } = useI18n();
  const enabled = ref(false);
  const activeRuleCount = ref(0);
  const todayRequestCount = ref(0);
  const recentLogs = ref<RequestLogEntry[]>([]);
  const rules = ref<{ id: string; name: string; enabled: boolean }[]>([]);
  const loading = ref(true);

  async function fetchStatus() {
    loading.value = true;
    try {
      const status: ProxyStatus = await chrome.runtime.sendMessage({
        type: MessageType.GET_PROXY_STATUS,
      });
      enabled.value = status.enabled;
      activeRuleCount.value = status.activeRuleCount;
      todayRequestCount.value = status.todayRequestCount;
      recentLogs.value = status.recentLogs;
      rules.value = status.rules ?? [];
    } catch (error) {
      console.error('Failed to fetch status:', error);
    } finally {
      loading.value = false;
    }
  }

  async function toggleProxy(value: boolean) {
    await chrome.runtime.sendMessage({
      type: MessageType.TOGGLE_PROXY,
      data: { enabled: value },
    });
    enabled.value = value;
  }

  async function toggleRule(id: string, enabled: boolean) {
    await chrome.runtime.sendMessage({
      type: MessageType.TOGGLE_RULE,
      data: { ruleId: id, enabled },
    });
    await fetchStatus();
  }

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  // 使用 i18n 标签调用 formatters
  function formatTimeAgo(timestamp: number): string {
    return _formatTimeAgo(timestamp, {
      justNow: t('justNow'),
      minutesAgo: n => t('minutesAgo', n),
      hoursAgo: n => t('hoursAgo', n),
      daysAgo: n => t('daysAgo', n),
    });
  }

  onMounted(fetchStatus);

  return {
    enabled,
    activeRuleCount,
    todayRequestCount,
    recentLogs,
    rules,
    loading,
    toggleProxy,
    toggleRule,
    openOptions,
    fetchStatus,
    formatTimeAgo,
    getMethodColor,
    getStatusColor,
    truncateUrl,
  };
}
