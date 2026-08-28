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

  return { logs, loading, autoRefresh, dnrStats, swStats, fetchLogs, clearLogs, toggleAutoRefresh, fetchDnrStats, fetchSwStats };
}
