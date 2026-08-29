import { ref, onMounted, onUnmounted } from 'vue';
import { MessageType } from '@/utils/types';
import type { RequestLogEntry, DnrHitStat } from '@/utils/types';

export function useRequestLog() {
  const logs = ref<RequestLogEntry[]>([]);
  const loading = ref(true);
  const autoRefresh = ref(false);
  const dnrStats = ref<DnrHitStat[]>([]);
  const swStats = ref<DnrHitStat[]>([]);
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  async function fetchLogs() {
    loading.value = true;
    try {
      const result: RequestLogEntry[] | undefined = await chrome.runtime.sendMessage({
        type: MessageType.GET_REQUEST_LOG,
      });
      // SW 异常时响应可能为非标对象，仅接受数组结构
      logs.value = Array.isArray(result) ? result : [];
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    } finally {
      loading.value = false;
    }
  }

  async function clearLogs() {
    const resp: { success: boolean; error?: string } | undefined = await chrome.runtime.sendMessage({
      type: MessageType.CLEAR_REQUEST_LOG,
    });
    if (!resp || resp.success === false) {
      throw new Error(resp?.error || 'CLEAR_LOGS_FAILED');
    }
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

  async function fetchSwStats() {
    try {
      const result: DnrHitStat[] = await chrome.runtime.sendMessage({
        type: MessageType.GET_SW_STATS,
      });
      swStats.value = result ?? [];
    } catch (error) {
      console.error('Failed to fetch SW stats:', error);
    }
  }

  onMounted(fetchLogs);

  onUnmounted(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  return {
    logs,
    loading,
    autoRefresh,
    dnrStats,
    swStats,
    fetchLogs,
    clearLogs,
    toggleAutoRefresh,
    fetchDnrStats,
    fetchSwStats,
  };
}
