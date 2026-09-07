import { ref, onMounted, onUnmounted } from 'vue';
import { MessageType } from '@/utils/types';
import type { RequestLogEntry, DnrHitStat } from '@/utils/types';
import { logger } from '@/utils/logger';

/** 自动刷新频率预设（毫秒） */
export const REFRESH_INTERVAL_PRESETS: readonly { value: number; label: string }[] = [
  { value: 5000, label: '5s' },
  { value: 15000, label: '15s' },
  { value: 30000, label: '30s' },
  { value: 60000, label: '1min' },
  { value: 300000, label: '5min' },
] as const;

/** 默认刷新频率（5s，平衡实时性与 SW 压力） */
const DEFAULT_REFRESH_INTERVAL = 5000;

/** 持久化键：跨会话记住用户选择的刷新频率（`cop_` 前缀与 i18n 的 `cop_locale` 镜像键同族） */
const REFRESH_INTERVAL_STORAGE_KEY = 'cop_log_refresh_interval';

/** 安全读取存储的刷新频率；非预设值或缺失时回退到默认值 */
function loadStoredInterval(): number {
  try {
    const raw = localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY);
    if (!raw) return DEFAULT_REFRESH_INTERVAL;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && REFRESH_INTERVAL_PRESETS.some(p => p.value === parsed)) {
      return parsed;
    }
  } catch {
    // localStorage 不可用（隐私模式/异常环境）静默降级到默认值
  }
  return DEFAULT_REFRESH_INTERVAL;
}

function saveInterval(intervalMs: number) {
  try {
    localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(intervalMs));
  } catch {
    // 写入失败不影响主功能
  }
}

export function useRequestLog() {
  const logs = ref<RequestLogEntry[]>([]);
  const loading = ref(true);
  const autoRefresh = ref(false);
  const refreshInterval = ref<number>(loadStoredInterval());
  const dnrStats = ref<DnrHitStat[]>([]);
  const swStats = ref<DnrHitStat[]>([]);
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  function stopTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function startTimer() {
    stopTimer();
    refreshTimer = setInterval(fetchLogs, refreshInterval.value);
  }

  async function fetchLogs() {
    loading.value = true;
    try {
      const result: RequestLogEntry[] | undefined = await chrome.runtime.sendMessage({
        type: MessageType.GET_REQUEST_LOG,
      });
      // SW 异常时响应可能为非标对象，仅接受数组结构
      logs.value = Array.isArray(result) ? result : [];
    } catch (error) {
      logger.error('Failed to fetch logs:', error);
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

  /** 切换自动刷新；启用时会按当前 refreshInterval 启动定时器，关闭时清理 */
  function toggleAutoRefresh(value: boolean) {
    autoRefresh.value = value;
    if (value) {
      startTimer();
    } else {
      stopTimer();
    }
  }

  /** 修改刷新频率；若自动刷新已开启则重启定时器使变更即时生效 */
  function setRefreshInterval(intervalMs: number) {
    if (!REFRESH_INTERVAL_PRESETS.some(p => p.value === intervalMs)) return;
    refreshInterval.value = intervalMs;
    saveInterval(intervalMs);
    if (autoRefresh.value) {
      startTimer();
    }
  }

  async function fetchDnrStats() {
    try {
      const result: DnrHitStat[] = await chrome.runtime.sendMessage({
        type: MessageType.GET_DNR_STATS,
      });
      dnrStats.value = Array.isArray(result) ? result : [];
    } catch (error) {
      logger.error('Failed to fetch DNR stats:', error);
    }
  }

  async function fetchSwStats() {
    try {
      const result: DnrHitStat[] = await chrome.runtime.sendMessage({
        type: MessageType.GET_SW_STATS,
      });
      swStats.value = Array.isArray(result) ? result : [];
    } catch (error) {
      logger.error('Failed to fetch SW stats:', error);
    }
  }

  onMounted(fetchLogs);

  onUnmounted(stopTimer);

  return {
    logs,
    loading,
    autoRefresh,
    refreshInterval,
    dnrStats,
    swStats,
    fetchLogs,
    clearLogs,
    toggleAutoRefresh,
    setRefreshInterval,
    fetchDnrStats,
    fetchSwStats,
  };
}
