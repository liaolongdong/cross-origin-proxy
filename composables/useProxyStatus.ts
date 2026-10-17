import { ref, onMounted } from 'vue';
import { MessageType, ProxyStatus, RequestLogEntry } from '@/utils/types';
import { useI18n } from '@/composables/useI18n';
import { formatTimeAgo as _formatTimeAgo, getMethodColor, getStatusColor, truncateUrl } from '@/utils/formatters';
import { logger } from '@/utils/logger';

export function useProxyStatus() {
  const { t } = useI18n();
  const enabled = ref(false);
  const activeRuleCount = ref(0);
  const swRequestCount = ref(0);
  const recentLogs = ref<RequestLogEntry[]>([]);
  const rules = ref<{ id: string; name: string; enabled: boolean }[]>([]);
  const loading = ref(true);
  /** 自动关闭时间点（epoch ms），未配置自动关闭时为 undefined */
  const autoOffAt = ref<number | undefined>(undefined);
  /**
   * 至少成功采纳过一份状态读数
   *
   * 弹窗首屏那三个数（总开关位置、活跃规则、经扩展请求）在第一次读取回话之前全是默认值，
   * 而默认值画出来就是「关着 / 0 / 0」——把「还没读到」说成一条读数，正是这套界面在
   * `dnrSample`、`interceptorStats`、`configSync` 三处分别消灭过的那类谎报。后面几轮读不到时
   * `fetchStatus()` 维持上一份采纳过的读数（那是最近一次的事实），所以界面上只有这一格
   * 「从来没有过读数」需要一句话；它由 `fetchStatus()` 在采纳成功的那一刻置真，此后不再回落。
   */
  const statusEverRead = ref(false);

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
      swRequestCount.value = status.swRequestCount;
      recentLogs.value = Array.isArray(status.recentLogs) ? status.recentLogs : [];
      rules.value = status.rules ?? [];
      autoOffAt.value = typeof status.autoOffAt === 'number' ? status.autoOffAt : undefined;
      statusEverRead.value = true;
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
    swRequestCount,
    recentLogs,
    rules,
    loading,
    autoOffAt,
    statusEverRead,
    toggleProxy,
    toggleRule,
    fetchStatus,
    formatTimeAgo,
    getMethodColor,
    getStatusColor,
    truncateUrl,
  };
}
