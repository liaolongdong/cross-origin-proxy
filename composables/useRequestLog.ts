import { ref, onMounted, onUnmounted } from 'vue';
import { MessageType } from '@/utils/types';
import type { RequestLogEntry, DnrHitStat } from '@/utils/types';

export function useRequestLog() {
  const logs = ref<RequestLogEntry[]>([]);
  const loading = ref(true);
  const autoRefresh = ref(false);
  const dnrStats = ref<DnrHitStat[]>([]);
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  async function fetchLogs() {
    loading.value = true;
    try {
      const result: RequestLogEntry[] = await chrome.runtime.sendMessage({
        type: MessageType.GET_REQUEST_LOG,
      });
      logs.value = result;
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    } finally {
      loading.value = false;
    }
  }

  async function clearLogs() {
    await chrome.runtime.sendMessage({ type: MessageType.CLEAR_REQUEST_LOG });
    logs.value = [];
  }

  function toggleAutoRefresh(value: boolean) {
    autoRefresh.value = value;
    if (value) {
      refreshTimer = setInterval(fetchLogs, 3000);
    } else if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  /** 拉取 DNR 规则级命中统计（getMatchedRules 有配额，由用户手动刷新触发） */
  async function fetchDnrStats() {
    try {
      const result: DnrHitStat[] = await chrome.runtime.sendMessage({
        type: MessageType.GET_DNR_STATS,
      });
      dnrStats.value = result ?? [];
    } catch (error) {
      console.error('Failed to fetch DNR stats:', error);
    }
  }

  onMounted(fetchLogs);

  onUnmounted(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  return { logs, loading, autoRefresh, dnrStats, fetchLogs, clearLogs, toggleAutoRefresh, fetchDnrStats };
}
