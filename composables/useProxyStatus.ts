import { ref, onMounted } from 'vue';
import { MessageType, ProxyStatus, RequestLogEntry } from '@/utils/types';
import { useI18n } from '@/composables/useI18n';
import { formatTimeAgo as _formatTimeAgo, getMethodColor, getStatusColor, truncateUrl } from '@/utils/formatters';
import { logger } from '@/utils/logger';

export function useProxyStatus() {
  const { t } = useI18n();
  const enabled = ref(false);
  const activeRuleCount = ref(0);
  const todayRequestCount = ref(0);
  const recentLogs = ref<RequestLogEntry[]>([]);
  const rules = ref<{ id: string; name: string; enabled: boolean }[]>([]);
  const loading = ref(true);
  /** 自动关闭时间点（epoch ms），未配置自动关闭时为 undefined */
  const autoOffAt = ref<number | undefined>(undefined);

  async function fetchStatus() {
    loading.value = true;
    try {
      const status: ProxyStatus | undefined = await chrome.runtime.sendMessage({
        type: MessageType.GET_PROXY_STATUS,
      });
      // SW 异常时响应可能为 { success:false } 等非标结构，做防御处理
      if (!status || typeof status.enabled !== 'boolean') return;
      enabled.value = status.enabled;
      activeRuleCount.value = status.activeRuleCount;
      todayRequestCount.value = status.todayRequestCount;
      recentLogs.value = Array.isArray(status.recentLogs) ? status.recentLogs : [];
      rules.value = status.rules ?? [];
      autoOffAt.value = typeof status.autoOffAt === 'number' ? status.autoOffAt : undefined;
    } catch (error) {
      logger.error('Failed to fetch status:', error);
    } finally {
      loading.value = false;
    }
  }

  async function toggleProxy(value: boolean) {
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.TOGGLE_PROXY,
      data: { enabled: value },
    });
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'TOGGLE_PROXY_FAILED');
    }
    enabled.value = value;
    // 总开关变化会创建/清除自动关闭 alarm，重新拉取以保持倒计时一致
    await fetchStatus();
  }

  async function toggleRule(id: string, enabled: boolean) {
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.TOGGLE_RULE,
      data: { ruleId: id, enabled },
    });
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'TOGGLE_RULE_FAILED');
    }
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
    autoOffAt,
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
