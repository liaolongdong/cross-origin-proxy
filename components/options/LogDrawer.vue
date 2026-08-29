<template>
  <el-drawer
    :model-value="visible"
    :title="t('tabLogs')"
    direction="rtl"
    size="720px"
    class="log-drawer"
    @close="$emit('update:visible', false)"
  >
    <div class="log-drawer-body">
      <!-- 工具栏 -->
      <div class="toolbar">
        <div class="toolbar-left">
          <el-button
            type="danger"
            plain
            :icon="Delete"
            @click="handleClear"
          >
            {{ t('clearLogs') }}
          </el-button>
          <el-select
            :model-value="methodFilter"
            :placeholder="t('filterMethod')"
            clearable
            style="width: 120px"
            @update:model-value="
              (val: string | number | undefined) => emit('update:methodFilter', (val as string) ?? '')
            "
          >
            <el-option
              :label="t('allMethods')"
              value=""
            />
            <el-option
              label="GET"
              value="GET"
            />
            <el-option
              label="POST"
              value="POST"
            />
            <el-option
              label="PUT"
              value="PUT"
            />
            <el-option
              label="DELETE"
              value="DELETE"
            />
          </el-select>
          <el-select
            :model-value="statusFilter"
            :placeholder="t('filterStatus')"
            clearable
            style="width: 140px"
            @update:model-value="
              (val: string | number | undefined) => emit('update:statusFilter', (val as string) ?? '')
            "
          >
            <el-option
              :label="t('allStatus')"
              value=""
            />
            <el-option
              :label="t('status2xx')"
              value="2xx"
            />
            <el-option
              :label="t('status4xx')"
              value="4xx"
            />
            <el-option
              :label="t('status5xx')"
              value="5xx"
            />
          </el-select>
          <el-select
            v-model="ruleFilter"
            :placeholder="t('filterByRule')"
            clearable
            style="width: 150px"
          >
            <el-option
              :label="t('allRules')"
              value=""
            />
            <el-option
              v-for="name in uniqueRuleNames"
              :key="name"
              :label="name"
              :value="name"
            />
          </el-select>
          <el-input
            v-model="urlKeyword"
            :placeholder="t('filterByUrl')"
            clearable
            style="width: 180px"
          />
        </div>
        <el-switch
          :model-value="autoRefresh"
          :active-text="t('autoRefresh')"
          @change="val => $emit('refresh', val as boolean)"
        />
      </div>

      <!-- 统计条 -->
      <div class="stats-bar">
        <div class="stats-item">
          <span class="stats-label">{{ t('statsTotal') }}</span>
          <span class="stats-value">{{ logStats.total }}</span>
        </div>
        <div class="stats-item stats-item--success">
          <span class="stats-label">{{ t('statsSuccess') }}</span>
          <span class="stats-value">{{ logStats.success }}</span>
        </div>
        <div class="stats-item stats-item--error">
          <span class="stats-label">{{ t('statsError') }}</span>
          <span class="stats-value">{{ logStats.error }}</span>
        </div>
      </div>

      <!-- DNR 命中统计（简单规则无逐条日志，展示规则级计数） -->
      <div class="dnr-stats">
        <div class="dnr-stats-header">
          <span class="dnr-stats-title">{{ t('dnrStatsTitle') }}</span>
          <el-button
            link
            type="primary"
            size="small"
            :icon="Refresh"
            @click="$emit('refreshDnrStats')"
          >
            {{ t('refresh') }}
          </el-button>
        </div>
        <p class="dnr-stats-hint">{{ t('dnrStatsHint') }}</p>
        <div
          v-if="dnrStats.length === 0"
          class="dnr-stats-empty"
        >
          {{ t('dnrStatsEmpty') }}
        </div>
        <ul
          v-else
          class="dnr-stats-list"
        >
          <li
            v-for="stat in dnrStats"
            :key="stat.ruleId"
            class="dnr-stats-item"
          >
            <el-tag
              size="small"
              type="success"
              >DNR</el-tag
            >
            <span class="dnr-stats-name">{{ stat.ruleName }}</span>
            <span class="dnr-stats-count">{{ t('dnrHitCount', stat.hitCount) }}</span>
          </li>
        </ul>
      </div>

      <!-- SW 通道命中统计 -->
      <div class="dnr-stats">
        <div class="dnr-stats-header">
          <span class="dnr-stats-title">{{ t('swStatsTitle') }}</span>
        </div>
        <p class="dnr-stats-hint">{{ t('swStatsHint') }}</p>
        <div
          v-if="swStats.length === 0"
          class="dnr-stats-empty"
        >
          {{ t('swStatsEmpty') }}
        </div>
        <ul
          v-else
          class="dnr-stats-list"
        >
          <li
            v-for="stat in swStats"
            :key="stat.ruleId"
            class="dnr-stats-item"
          >
            <el-tag
              size="small"
              type="warning"
              >SW</el-tag
            >
            <span class="dnr-stats-name">{{ stat.ruleName }}</span>
            <span class="dnr-stats-count">{{ t('dnrHitCount', stat.hitCount) }}</span>
          </li>
        </ul>
      </div>

      <!-- 日志表格（SW 通道逐条日志） -->
      <el-table
        v-loading="loading"
        :data="filteredLogs"
        :row-class-name="rowClassName"
        class="log-table"
        highlight-current-row
        @row-click="handleRowClick"
      >
        <el-table-column
          :label="t('colTime')"
          width="150"
        >
          <template #default="{ row }">
            {{ formatTime(row.timestamp) }}
          </template>
        </el-table-column>
        <el-table-column
          prop="ruleName"
          :label="t('colRule')"
          min-width="100"
          show-overflow-tooltip
        />
        <el-table-column
          prop="method"
          :label="t('colMethod')"
          width="80"
          align="center"
        >
          <template #default="{ row }">
            <el-tag
              :type="methodTagType(row.method)"
              size="small"
              >{{ row.method }}</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column
          :label="t('colOriginalUrl')"
          min-width="180"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <span class="url-cell">
              <el-tooltip
                :content="row.originalUrl"
                placement="top"
                :show-after="400"
              >
                <span class="url-text">{{ truncateUrl(row.originalUrl) }}</span>
              </el-tooltip>
              <el-icon
                class="copy-btn"
                @click.stop="copyUrl(row.originalUrl)"
              >
                <CopyDocument />
              </el-icon>
            </span>
          </template>
        </el-table-column>
        <el-table-column
          :label="t('colProxiedUrl')"
          min-width="180"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <span class="url-cell">
              <el-tooltip
                :content="row.proxiedUrl"
                placement="top"
                :show-after="400"
              >
                <span class="url-text">{{ truncateUrl(row.proxiedUrl) }}</span>
              </el-tooltip>
              <el-icon
                class="copy-btn"
                @click.stop="copyUrl(row.proxiedUrl)"
              >
                <CopyDocument />
              </el-icon>
            </span>
          </template>
        </el-table-column>
        <el-table-column
          prop="status"
          :label="t('colStatus')"
          width="76"
          align="center"
        >
          <template #default="{ row }">
            <el-tag
              v-if="row.status"
              :type="statusTagType(row.status)"
              size="small"
            >
              {{ row.status }}
            </el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="duration"
          :label="t('colDuration')"
          width="80"
          align="center"
        >
          <template #default="{ row }">
            {{ row.duration ? `${row.duration}ms` : '-' }}
          </template>
        </el-table-column>

        <!-- 空状态 -->
        <template #empty>
          <div class="empty-state">
            <el-icon
              :size="48"
              :color="'var(--cop-text-color-placeholder)'"
              ><Document
            /></el-icon>
            <p>{{ t('noLogs') }}</p>
          </div>
        </template>
      </el-table>

      <!-- 日志详情面板 -->
      <transition name="el-fade-in">
        <div
          v-if="selectedLog"
          class="log-detail-panel"
        >
          <div class="log-detail-header">
            <span class="log-detail-title">{{ t('logDetail') }}</span>
            <div class="log-detail-actions">
              <el-button
                size="small"
                type="success"
                plain
                @click="handleCreateRuleFromLog"
              >
                <el-icon style="margin-right: 4px"><Plus /></el-icon>
                {{ t('createRuleFromLog') }}
              </el-button>
              <el-button
                size="small"
                type="primary"
                plain
                @click="copyAsCurl"
              >
                {{ t('copyAsCurl') }}
              </el-button>
              <el-button
                size="small"
                @click="selectedLog = null"
              >
                <el-icon><Close /></el-icon>
              </el-button>
            </div>
          </div>

          <div class="log-detail-summary">
            <el-tag
              :type="methodTagType(selectedLog.method)"
              size="small"
              >{{ selectedLog.method }}</el-tag
            >
            <el-tag
              v-if="selectedLog.status"
              :type="statusTagType(selectedLog.status)"
              size="small"
              >{{ selectedLog.status }}</el-tag
            >
            <span class="log-detail-rule">{{ selectedLog.ruleName }}</span>
            <span
              v-if="selectedLog.duration"
              class="log-detail-duration"
              >{{ selectedLog.duration }}ms</span
            >
          </div>

          <el-tabs
            v-model="detailTab"
            class="log-detail-tabs"
          >
            <el-tab-pane
              :label="t('detailRequest')"
              name="request"
            >
              <div class="detail-section">
                <div class="detail-section-label">{{ t('detailUrl') }}</div>
                <code class="detail-url">{{ selectedLog.originalUrl }}</code>
                <div
                  v-if="selectedLog.proxiedUrl && selectedLog.proxiedUrl !== selectedLog.originalUrl"
                  class="detail-section-label"
                  style="margin-top: 8px"
                >
                  {{ t('detailProxiedUrl') }}
                </div>
                <code
                  v-if="selectedLog.proxiedUrl && selectedLog.proxiedUrl !== selectedLog.originalUrl"
                  class="detail-url detail-url--proxied"
                  >{{ selectedLog.proxiedUrl }}</code
                >
              </div>
              <div
                v-if="selectedLog.requestHeaders && Object.keys(selectedLog.requestHeaders).length > 0"
                class="detail-section"
              >
                <div class="detail-section-label">{{ t('detailHeaders') }}</div>
                <div class="detail-headers">
                  <div
                    v-for="(value, key) in selectedLog.requestHeaders"
                    :key="key"
                    class="detail-header-row"
                  >
                    <span class="detail-header-key">{{ key }}</span>
                    <span class="detail-header-val">{{ value }}</span>
                  </div>
                </div>
              </div>
              <div
                v-if="selectedLog.requestBody"
                class="detail-section"
              >
                <div class="detail-section-label">{{ t('detailBody') }}</div>
                <pre class="detail-body-content">{{ formatBody(selectedLog.requestBody) }}</pre>
              </div>
              <div
                v-if="!selectedLog.requestHeaders && !selectedLog.requestBody"
                class="detail-empty"
              >
                {{ t('detailNoData') }}
              </div>
            </el-tab-pane>

            <el-tab-pane
              :label="t('detailResponse')"
              name="response"
            >
              <div
                v-if="selectedLog.error"
                class="detail-section"
              >
                <div class="detail-section-label detail-error-label">{{ t('detailError') }}</div>
                <code class="detail-error-msg">{{ selectedLog.error }}</code>
              </div>
              <div
                v-if="selectedLog.responseHeaders && Object.keys(selectedLog.responseHeaders).length > 0"
                class="detail-section"
              >
                <div class="detail-section-label">{{ t('detailHeaders') }}</div>
                <div class="detail-headers">
                  <div
                    v-for="(value, key) in selectedLog.responseHeaders"
                    :key="key"
                    class="detail-header-row"
                  >
                    <span class="detail-header-key">{{ key }}</span>
                    <span class="detail-header-val">{{ value }}</span>
                  </div>
                </div>
              </div>
              <div
                v-if="selectedLog.responseBody"
                class="detail-section"
              >
                <div class="detail-section-label">{{ t('detailBody') }}</div>
                <pre class="detail-body-content">{{ formatBody(selectedLog.responseBody) }}</pre>
              </div>
              <div
                v-if="!selectedLog.responseHeaders && !selectedLog.responseBody && !selectedLog.error"
                class="detail-empty"
              >
                {{ t('detailNoData') }}
              </div>
            </el-tab-pane>
          </el-tabs>
        </div>
      </transition>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Delete, Document, CopyDocument, Refresh, Close, Plus } from '@element-plus/icons-vue';
import { ElMessageBox, ElMessage } from 'element-plus';
import type { RequestLogEntry, DnrHitStat } from '@/utils/types';
import { useI18n } from '@/composables/useI18n';

/**
 * 请求日志抽屉（由原 RequestLogPanel 标签页改造）
 *
 * 顶部为 SW 通道统计条与 DNR 规则级命中统计区块，
 * 主体为 SW 通道逐条日志表格（方法/状态筛选 + 自动刷新 + URL 悬浮复制）。
 */
const props = defineProps<{
  visible: boolean;
  logs: RequestLogEntry[];
  loading: boolean;
  autoRefresh: boolean;
  dnrStats: DnrHitStat[];
  swStats: DnrHitStat[];
  methodFilter: string;
  statusFilter: string;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  'update:methodFilter': [value: string];
  'update:statusFilter': [value: string];
  clear: [];
  refresh: [value: boolean];
  refreshDnrStats: [];
  /** 基于某条日志快速创建规则（父组件预填充规则表单） */
  createRuleFromLog: [log: RequestLogEntry];
}>();

const { t, locale } = useI18n();

// 筛选
const ruleFilter = ref('');
const urlKeyword = ref('');

/** 从日志中提取的唯一规则名称列表（用于规则名称下拉） */
const uniqueRuleNames = computed(() => {
  const names = new Set<string>();
  for (const log of props.logs) {
    if (log.ruleName) names.add(log.ruleName);
  }
  return Array.from(names).sort();
});

const filteredLogs = computed(() => {
  const keyword = urlKeyword.value.toLowerCase();
  return props.logs.filter(log => {
    const matchesMethod = !props.methodFilter || log.method === props.methodFilter;
    const matchesStatus =
      !props.statusFilter ||
      (props.statusFilter === '2xx' && log.status! >= 200 && log.status! < 300) ||
      (props.statusFilter === '4xx' && log.status! >= 400 && log.status! < 500) ||
      (props.statusFilter === '5xx' && log.status! >= 500);
    const matchesRule = !ruleFilter.value || log.ruleName === ruleFilter.value;
    const matchesUrl =
      !keyword || log.originalUrl.toLowerCase().includes(keyword) || log.proxiedUrl.toLowerCase().includes(keyword);
    return matchesMethod && matchesStatus && matchesRule && matchesUrl;
  });
});

// 统计（基于筛选后的数据，单次遍历）
const logStats = computed(() => {
  const logs = filteredLogs.value;
  let success = 0;
  let error = 0;
  for (const log of logs) {
    const status = log.status ?? 0;
    if (status >= 200 && status < 400) {
      success++;
    } else {
      error++;
    }
  }
  return { total: logs.length, success, error };
});

// URL 复制
const copyUrl = async (url: string) => {
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success(t('urlCopied'));
  } catch {
    ElMessage.error(t('copyFailed'));
  }
};

/** 时间格式随界面语言切换（修复原实现硬编码 zh-CN） */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(locale.value === 'en' ? 'en-US' : 'zh-CN');
}

function truncateUrl(url: string, maxLen = 50): string {
  if (!url) return '-';
  return url.length > maxLen ? url.substring(0, maxLen) + '...' : url;
}

function methodTagType(method: string) {
  const typeMap: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
    GET: 'primary',
    POST: 'success',
    PUT: 'warning',
    DELETE: 'danger',
  };
  return typeMap[method] || 'info';
}

function statusTagType(status: number) {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 400 && status < 500) return 'warning';
  if (status >= 500) return 'danger';
  return 'info';
}

function rowClassName({ row }: { row: RequestLogEntry }): string {
  return row.error ? 'error-row' : '';
}

async function handleClear() {
  try {
    await ElMessageBox.confirm(t('confirmClearLogs'), t('confirm'), {
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel'),
      type: 'warning',
    });
    emit('clear');
  } catch {
    // 用户取消
  }
}

// ─── Log Detail Viewer ───────────────────────────────────────────────────────

const selectedLog = ref<RequestLogEntry | null>(null);
const detailTab = ref('request');

function handleRowClick(row: RequestLogEntry) {
  selectedLog.value = selectedLog.value?.id === row.id ? null : row;
  detailTab.value = 'request';
}

/** 基于当前日志创建规则：交由父组件解析 URL 并预填充规则表单 */
function handleCreateRuleFromLog() {
  if (!selectedLog.value) return;
  emit('createRuleFromLog', selectedLog.value);
}

function formatBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** shell 单引号包裹：内部单引号转为 '\'' ，防止命令断裂或注入 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function copyAsCurl() {
  if (!selectedLog.value) return;
  const log = selectedLog.value;
  const parts = [`curl -X ${log.method}`];
  parts.push(shellQuote(log.originalUrl));
  if (log.requestHeaders) {
    for (const [key, value] of Object.entries(log.requestHeaders)) {
      parts.push(`-H ${shellQuote(`${key}: ${value}`)}`);
    }
  }
  if (log.requestBody) {
    parts.push(`-d ${shellQuote(log.requestBody)}`);
  }
  const curl = parts.join(' \\\n  ');
  navigator.clipboard.writeText(curl).then(
    () => ElMessage.success(t('urlCopied')),
    () => ElMessage.error(t('copyFailed')),
  );
}
</script>

<style scoped>
.log-drawer-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.toolbar-left {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

/* 统计条 */
.stats-bar {
  display: flex;
  gap: 16px;
  padding: 10px 16px;
  background: var(--cop-surface-2);
  border: 1px solid var(--cop-surface-line);
  border-radius: 8px;
}

.stats-item {
  display: flex;
  gap: 6px;
  align-items: center;
}

.stats-label {
  font-size: 13px;
  color: var(--cop-text-color-secondary);
}

.stats-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--cop-text-color-primary);
}

.stats-item--success .stats-value {
  color: var(--el-color-success);
}

.stats-item--error .stats-value {
  color: var(--el-color-danger);
}

/* DNR 命中统计 */
.dnr-stats {
  padding: 12px 16px;
  background: var(--cop-primary-bg);
  border: 1px solid var(--cop-primary-border);
  border-radius: 8px;
}

.dnr-stats-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dnr-stats-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--cop-text-color-primary);
}

.dnr-stats-hint {
  margin: 4px 0 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--cop-text-color-secondary);
}

.dnr-stats-empty {
  font-size: 12px;
  color: var(--cop-text-color-secondary);
}

.dnr-stats-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.dnr-stats-item {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
}

.dnr-stats-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--cop-text-color-primary);
  white-space: nowrap;
}

.dnr-stats-count {
  flex-shrink: 0;
  font-weight: 500;
  color: var(--cop-primary);
}

/* URL 复制按钮 */
.url-cell {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}

.url-text {
  display: inline-block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-btn {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--cop-text-color-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}

.copy-btn:hover {
  color: var(--cop-primary);
}

.log-table :deep(.el-table__row:hover .copy-btn) {
  opacity: 1;
}

.log-table :deep(.el-table__row:hover) {
  background-color: var(--cop-surface-hover) !important;
}

.log-table :deep(.error-row) {
  background-color: var(--el-color-danger-light-9, #fef0f0);
}

.empty-state {
  padding: 40px 0;
  color: var(--cop-text-color-secondary);
  text-align: center;
}

.empty-state p {
  margin-top: 12px;
  font-size: 14px;
}

/* ─── Log Detail Panel ────────────────────────────────────────────────────── */

.log-table :deep(.el-table__body tr) {
  cursor: pointer;
}

.log-detail-panel {
  overflow: hidden;
  background: var(--cop-bg-color-secondary, var(--el-fill-color-lighter, #f5f7fa));
  border: 1px solid var(--cop-border-color, var(--el-border-color-light, #e4e7ed));
  border-radius: 10px;
}

.log-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--cop-bg-color, var(--el-fill-color, #f0f2f5));
  border-bottom: 1px solid var(--cop-border-color, var(--el-border-color-lighter, #ebeef5));
}

.log-detail-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--cop-text-color-primary, var(--el-text-color-primary, #303133));
}

.log-detail-actions {
  display: flex;
  gap: 6px;
}

.log-detail-summary {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--cop-border-color, var(--el-border-color-lighter, #ebeef5));
}

.log-detail-rule {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--cop-text-color-primary, #303133);
}

.log-detail-duration {
  font-size: 12px;
  color: var(--cop-text-color-secondary, #909399);
}

.log-detail-tabs {
  padding: 0 16px 12px;
}

.detail-section {
  margin-bottom: 14px;
}

.detail-section-label {
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--cop-text-color-secondary, #909399);
}

.detail-url {
  display: block;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--cop-primary, var(--el-color-primary, #409eff));
  word-break: break-all;
  background: var(--cop-bg-color, #fff);
  border: 1px solid var(--cop-border-color, var(--el-border-color-lighter, #ebeef5));
  border-radius: 4px;
}

.detail-url--proxied {
  color: var(--el-color-success, #67c23a);
}

.detail-headers {
  overflow: hidden;
  background: var(--cop-bg-color, #fff);
  border: 1px solid var(--cop-border-color, var(--el-border-color-lighter, #ebeef5));
  border-radius: 6px;
}

.detail-header-row {
  display: flex;
  gap: 12px;
  padding: 5px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--el-border-color-extra-light, #f2f6fc);
}

.detail-header-row:last-child {
  border-bottom: none;
}

.detail-header-key {
  flex-shrink: 0;
  width: 160px;
  font-weight: 500;
  color: var(--cop-text-color-primary, #303133);
  word-break: break-all;
}

.detail-header-val {
  flex: 1;
  color: var(--cop-text-color-regular, #606266);
  word-break: break-all;
}

.detail-body-content {
  display: block;
  max-height: 300px;
  padding: 10px 12px;
  margin: 0;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  color: var(--cop-text-color-regular, #606266);
  word-break: break-all;
  white-space: pre-wrap;
  background: var(--cop-bg-color, #fff);
  border: 1px solid var(--cop-border-color, var(--el-border-color-lighter, #ebeef5));
  border-radius: 6px;
}

.detail-error-label {
  color: var(--el-color-danger, #f56c6c);
}

.detail-error-msg {
  display: block;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--el-color-danger, #f56c6c);
  background: var(--el-color-danger-light-9, #fef0f0);
  border-radius: 6px;
}

.detail-empty {
  padding: 24px 0;
  font-size: 13px;
  color: var(--cop-text-color-placeholder, #c0c4cc);
  text-align: center;
}
</style>
