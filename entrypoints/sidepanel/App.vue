<template>
  <div class="sidepanel-root">
    <!--
      常驻日志面板：复用配置页的 LogDrawer 全部逻辑（四轴筛选 / 帧续载 / 详情 / 重放），
      embedded 模式铺满侧边栏视口、去掉遮罩与全部关闭路径——这一页的存在本身就是「打开」。
      数据链路与 options 完全同源：useRequestLog 走 runtime 消息，与配置页同开时是两个
      独立的读端（日志读侧没有 storage.onChanged 订阅，不存在双订阅冲突；两边同时开
      自动刷新也只是各自按自己的间隔轮询）。
    -->
    <LogDrawer
      v-model:method-filter="methodFilter"
      v-model:status-filter="statusFilter"
      v-model:rule-filter="ruleFilter"
      v-model:url-filter="urlFilter"
      embedded
      :visible="true"
      :refresh-interval="refreshInterval"
      :logs="logs"
      :loading="loading"
      :logs-read-failed="logsReadFailed"
      :logs-ever-read="logsEverRead"
      :auto-refresh="autoRefresh"
      :dnr-stats="dnrStats"
      :dnr-stats-state="dnrStatsState"
      :sw-stats="swStats"
      :sw-stats-state="swStatsState"
      @clear="handleClearLogs"
      @refresh="toggleAutoRefresh"
      @update:refresh-interval="setRefreshInterval"
      @refresh-dnr-stats="fetchDnrStats"
      @create-rule-from-log="handleCreateRuleFromLog"
      @create-mock-from-log="handleCreateMockFromLog"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { ProxyRule, RequestLogEntry } from '@/utils/types';
import { useI18n } from '@/composables/useI18n';
import { useRequestLog } from '@/composables/useRequestLog';
import { logger } from '@/utils/logger';
import LogDrawer from '@/components/options/LogDrawer.vue';

const { t } = useI18n();

const {
  logs,
  loading,
  autoRefresh,
  refreshInterval,
  dnrStats,
  dnrStatsState,
  swStats,
  swStatsState,
  logsReadFailed,
  logsEverRead,
  clearLogs,
  toggleAutoRefresh,
  setRefreshInterval,
  fetchDnrStats,
  fetchSwStats,
} = useRequestLog();

// 四轴筛选住在容器层（与 options 同一惯例）：抽屉受控，侧边栏合上再开不会丢用户手上的筛选
const methodFilter = ref('');
const statusFilter = ref('');
const ruleFilter = ref('');
const urlFilter = ref('');

onMounted(() => {
  // 日志本体由 useRequestLog 的 onMounted 拉起；两份命中统计在这里补首拉
  void fetchDnrStats();
  void fetchSwStats();
});

async function handleClearLogs() {
  try {
    await clearLogs();
    ElMessage.success(t('logsCleared'));
  } catch (error) {
    ElMessage.error(t('clearFailed'));
    logger.error('Clear logs failed:', error);
  }
}

/** 侧边栏里没有规则表单：建规则跳配置页，复用与 popup 相同的深链格式 */
function handleCreateRuleFromLog(log: RequestLogEntry) {
  openOptionsWithHash(`#add-rule-from-tab=${encodeURIComponent(log.originalUrl)}`);
}

/** 存为 Mock 的草稿要走规则表单确认，hash 传不了对象：跳到日志那格，由用户再点一次 */
function handleCreateMockFromLog(_draft: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>) {
  ElMessage.info(t('sidePanelOpenOptionsForMock'));
  openOptionsWithHash('#logs');
}

function openOptionsWithHash(hash: string) {
  const url = `${chrome.runtime.getURL('/options.html')}${hash}`;
  void chrome.tabs.create({ url }).catch(error => {
    logger.warn('打开配置页失败:', error instanceof Error ? error.name : typeof error);
  });
}
</script>

<style scoped>
.sidepanel-root {
  min-height: 100vh;
  background: var(--cop-bg-color);
}
</style>
