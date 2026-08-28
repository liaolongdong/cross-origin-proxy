<template>
  <div class="options-page">
    <!-- 渐变通栏头部 -->
    <HeaderBar
      :current-version="currentVersion"
      :proxy-enabled="proxyEnabled"
      @add-rule="handleAddRule"
      @open-logs="openLogs"
      @open-import-export="showImportExport = true"
      @open-settings="showSettings = true"
      @toggle-proxy="handleToggleProxy"
    />

    <!-- 搜索筛选卡片 -->
    <SearchFilterBar
      v-model:search-text="searchText"
      v-model:status-filter="statusFilter"
      :selected-count="selectedRules.length"
      @batch-toggle="handleBatchToggle"
      @batch-delete="handleBatchDelete"
    />

    <!-- 规则计数信息行 -->
    <div class="rules-count-info">
      {{ t('rulesCountInfo', [rules.length, enabledCount]) }}
    </div>

    <!-- 规则表格卡片 -->
    <RuleTable
      :rules="filteredRules"
      :loading="ruleLoading"
      :has-any-rules="rules.length > 0"
      :highlight-rule-id="highlightRuleId"
      :search-text="searchText"
      @add="handleAddRule"
      @edit="handleEditRule"
      @duplicate="handleDuplicateRule"
      @delete="handleDeleteRule"
      @toggle="handleToggleRule"
      @import-config="showImportExport = true"
      @selection-change="handleSelectionChange"
      @use-template="handleUseTemplate"
      @reorder="handleReorder"
    />

    <!-- 弹窗与抽屉（全部异步组件，首屏不加载） -->
    <RuleFormDialog
      v-model:visible="showRuleDialog"
      :rule="editingRule"
      :initial-data="templateInitialData"
      @save="handleSaveRule"
    />
    <ImportExportDialog
      v-model:visible="showImportExport"
      @export="handleExport"
      @import="handleImport"
      @import-har-rules="handleImportHarRules"
    />
    <SettingsDialog
      v-model:visible="showSettings"
      :current-theme="currentTheme"
      :theme-mode="themeMode"
      @change-theme="switchTheme"
      @change-theme-mode="switchThemeMode"
    />
    <LogDrawer
      v-model:visible="showLogs"
      v-model:method-filter="logMethodFilter"
      v-model:status-filter="logStatusFilter"
      :logs="logs"
      :loading="logLoading"
      :auto-refresh="autoRefresh"
      :dnr-stats="dnrStats"
      :sw-stats="swStats"
      @clear="handleClearLogs"
      @refresh="toggleAutoRefresh"
      @refresh-dnr-stats="fetchDnrStats"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, h, defineAsyncComponent } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { ProxyRule, ExportData } from '@/utils/types';
import { MessageType } from '@/utils/types';
import { MAX_RULES } from '@/utils/constants';
import { useRuleManagement } from '@/composables/useRuleManagement';
import { useRequestLog } from '@/composables/useRequestLog';
import { useImportExport } from '@/composables/useImportExport';
import { useI18n } from '@/composables/useI18n';
import { type ThemeName, getStoredTheme, setStoredTheme, applyThemeToRoot, getStoredThemeMode, setStoredThemeMode, applyThemeMode } from '@/utils/theme';
import { type ThemeMode } from '@/utils/constants';
import HeaderBar from './HeaderBar.vue';
import SearchFilterBar from './SearchFilterBar.vue';
import RuleTable from './RuleTable.vue';

/**
 * Options 根组件（容器层，只做编排）
 *
 * 布局：渐变 HeaderBar → 搜索筛选卡片 → 计数信息行 → 规则表格卡片；
 * 设置/导入导出走弹窗，日志走右侧抽屉（支持 URL hash #logs 直达）。
 * 弹窗与抽屉组件全部懒加载，不进首屏关键路径。
 */
const RuleFormDialog = defineAsyncComponent(() => import('./RuleFormDialog.vue'));
const ImportExportDialog = defineAsyncComponent(() => import('./ImportExportDialog.vue'));
const SettingsDialog = defineAsyncComponent(() => import('./SettingsDialog.vue'));
const LogDrawer = defineAsyncComponent(() => import('./LogDrawer.vue'));

const { t } = useI18n();

const currentVersion = chrome.runtime.getManifest().version;

// 规则管理
const {
  rules,
  enabled: proxyEnabled,
  loading: ruleLoading,
  addRule,
  updateRule,
  toggleRule,
  batchToggleRules,
  batchDeleteRules,
  reorderRules,
  toggleProxy,
} = useRuleManagement();

// 请求日志 + DNR 命中统计
const {
  logs,
  loading: logLoading,
  autoRefresh,
  dnrStats,
  swStats,
  fetchLogs,
  clearLogs,
  toggleAutoRefresh,
  fetchDnrStats,
  fetchSwStats,
} = useRequestLog();

// 导入导出
const { exportConfig, importConfig } = useImportExport();

// UI 状态
const showRuleDialog = ref(false);
const showImportExport = ref(false);
const showSettings = ref(false);
const showLogs = ref(false);
const editingRule = ref<ProxyRule | null>(null);
const templateInitialData = ref<Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'> | null>(null);
const highlightRuleId = ref<string | null>(null);

// 搜索与筛选（状态在容器层，SearchFilterBar 为受控组件）
const searchText = ref('');
const statusFilter = ref('');
const selectedRules = ref<ProxyRule[]>([]);

// 日志抽屉过滤器（提升到容器层，避免抽屉关闭后重置）
const logMethodFilter = ref('');
const logStatusFilter = ref('');

// 删除撤销状态
const pendingDeleteRule = ref<ProxyRule | null>(null);
const pendingDeleteTimer = ref<ReturnType<typeof setTimeout> | null>(null);

const filteredRules = computed(() => {
  const keyword = searchText.value.toLowerCase();
  return rules.value.filter(rule => {
    const matchesSearch =
      !keyword ||
      rule.name.toLowerCase().includes(keyword) ||
      rule.matchPattern.toLowerCase().includes(keyword) ||
      rule.targetUrl.toLowerCase().includes(keyword);
    const matchesStatus =
      !statusFilter.value ||
      (statusFilter.value === 'enabled' && rule.enabled) ||
      (statusFilter.value === 'disabled' && !rule.enabled);
    return matchesSearch && matchesStatus;
  });
});

const enabledCount = computed(() => rules.value.filter(r => r.enabled).length);

// 主题状态
const currentTheme = ref<ThemeName>('sky');
const themeMode = ref<ThemeMode>('system');

async function switchTheme(theme: ThemeName) {
  currentTheme.value = theme;
  applyThemeToRoot(theme);
  await setStoredTheme(theme);
}

async function switchThemeMode(mode: ThemeMode) {
  themeMode.value = mode;
  applyThemeMode(mode);
  await setStoredThemeMode(mode);
}

// 日志抽屉：打开时刷新日志与 DNR 统计
function openLogs() {
  showLogs.value = true;
}

watch(showLogs, visible => {
  if (visible) {
    void fetchLogs();
    void fetchDnrStats();
    void fetchSwStats();
  }
});

onMounted(async () => {
  currentTheme.value = await getStoredTheme();
  themeMode.value = await getStoredThemeMode();
  applyThemeMode(themeMode.value);

  // Popup 直达支持：#add-rule 打开添加规则弹窗，#logs 打开日志抽屉，#import-export 打开导入导出；
  // 监听 hashchange：popup 复用已打开的 Options 标签页时通过更新 hash 触发同文档导航
  handleHashNavigation();
  window.addEventListener('hashchange', handleHashNavigation);
  // 全局键盘快捷键
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('hashchange', handleHashNavigation);
  window.removeEventListener('keydown', handleKeydown);
});

/** 全局键盘快捷键处理 */
function handleKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  const isEditable =
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable;

  // 在输入框中仅响应 Escape，其余快捷键跳过
  if (isEditable && e.key !== 'Escape') return;

  const isMac = navigator.platform.includes('Mac');
  const modKey = isMac ? e.metaKey : e.ctrlKey;

  // Ctrl/Cmd + N：打开新增规则弹窗
  if (modKey && e.key === 'n') {
    e.preventDefault();
    handleAddRule();
    return;
  }

  // / 或 Ctrl/Cmd + F：聚焦搜索框
  if (e.key === '/' || (modKey && e.key === 'f')) {
    e.preventDefault();
    const searchInput = document.querySelector('.search-filter-bar input');
    if (searchInput) (searchInput as HTMLInputElement).focus();
    return;
  }

  // Escape：关闭最上层的弹窗/抽屉（优先级：规则弹窗 > 导入导出 > 设置 > 日志）
  if (e.key === 'Escape') {
    if (showRuleDialog.value) {
      showRuleDialog.value = false;
    } else if (showImportExport.value) {
      showImportExport.value = false;
    } else if (showSettings.value) {
      showSettings.value = false;
    } else if (showLogs.value) {
      showLogs.value = false;
    }
  }
}

/** 解析 URL hash 直达对应弹窗/抽屉，处理后清除 hash 避免刷新重复触发 */
function handleHashNavigation() {
  const hash = window.location.hash;
  if (hash === '#add-rule') {
    handleAddRule();
  } else if (hash === '#logs') {
    showLogs.value = true;
  } else if (hash === '#import-export') {
    showImportExport.value = true;
  }
  if (hash) {
    history.replaceState(null, '', window.location.pathname);
  }
}

// 代理总开关
async function handleToggleProxy(val: boolean) {
  await toggleProxy(val);
  ElMessage.success(val ? t('proxyEnabledMsg') : t('proxyDisabledMsg'));
}

// 规则操作
function handleAddRule() {
  editingRule.value = null;
  templateInitialData.value = null;
  showRuleDialog.value = true;
}

/** 使用模板：预填充表单数据并以新增模式打开弹窗 */
function handleUseTemplate(data: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>) {
  editingRule.value = null;
  templateInitialData.value = data;
  showRuleDialog.value = true;
}

function handleEditRule(rule: ProxyRule) {
  editingRule.value = { ...rule };
  templateInitialData.value = null;
  showRuleDialog.value = true;
}

/** 添加类操作的失败提示：规则数达上限时给出明确原因 */
function showAddFailedMessage(error: unknown) {
  if (error instanceof Error && error.message === 'MAX_RULES_EXCEEDED') {
    ElMessage.error(t('maxRulesReached', [MAX_RULES]));
  } else {
    ElMessage.error(t('operationFailed'));
  }
}

async function handleSaveRule(ruleData: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>) {
  try {
    if (editingRule.value) {
      await updateRule(editingRule.value.id, ruleData);
      ElMessage.success(t('ruleUpdated'));
    } else {
      const rule = await addRule(ruleData);
      flashHighlight(rule.id);
      ElMessage.success(t('ruleAdded'));
    }
    showRuleDialog.value = false;
  } catch (error) {
    showAddFailedMessage(error);
    console.error('Save rule failed:', error);
  }
}

/** 复制规则：克隆为停用副本，便于在副本上安全调整 */
async function handleDuplicateRule(rule: ProxyRule) {
  try {
    const copy = await addRule({
      name: `${rule.name}${t('copySuffix')}`,
      matchType: rule.matchType,
      matchPattern: rule.matchPattern,
      targetUrl: rule.targetUrl,
      priority: rule.priority,
      enabled: false,
      headerOverrides: rule.headerOverrides ? { ...rule.headerOverrides } : undefined,
    });
    flashHighlight(copy.id);
    ElMessage.success(t('ruleDuplicated'));
  } catch (error) {
    showAddFailedMessage(error);
    console.error('Duplicate rule failed:', error);
  }
}

/** 新增行进场动画：短暂标记后清除 */
function flashHighlight(ruleId: string) {
  highlightRuleId.value = ruleId;
  window.setTimeout(() => {
    if (highlightRuleId.value === ruleId) highlightRuleId.value = null;
  }, 1200);
}

/**
 * 删除规则（带 5 秒撤销窗口）
 *
 * 点击删除后立即从 UI 移除（乐观更新），同时显示含"撤销"操作的提示；
 * 5 秒后才真正向 background 发送删除消息，期间点击撤销可恢复规则。
 */
function handleDeleteRule(ruleId: string) {
  const rule = rules.value.find(r => r.id === ruleId);
  if (!rule) return;

  // 保存待删除规则，用于撤销恢复或延迟删除
  pendingDeleteRule.value = { ...rule };

  // 乐观更新：立即从 UI 移除
  rules.value = rules.value.filter(r => r.id !== ruleId);

  const capturedRule = pendingDeleteRule.value;

  const message = ElMessage({
    message: h('div', [
      h('span', t('ruleDeleted') + ' '),
      h(
        'a',
        {
          style: 'color: #409EFF; cursor: pointer; text-decoration: underline;',
          onClick: () => {
            // 撤销：取消定时器，恢复规则
            if (pendingDeleteTimer.value) {
              clearTimeout(pendingDeleteTimer.value);
              pendingDeleteTimer.value = null;
            }
            pendingDeleteRule.value = null;
            message.close();
            rules.value.push(capturedRule);
            ElMessage.success(t('undoSuccess'));
          },
        },
        t('undo'),
      ),
    ]),
    duration: 5000,
    showClose: false,
  });

  // 5 秒后真正执行后台删除
  pendingDeleteTimer.value = setTimeout(() => {
    if (pendingDeleteRule.value) {
      chrome.runtime
        .sendMessage({
          type: MessageType.DELETE_RULE,
          data: { ruleId: pendingDeleteRule.value.id },
        })
        .catch(err => console.error('Delete rule failed:', err));
      pendingDeleteRule.value = null;
    }
    pendingDeleteTimer.value = null;
  }, 5000);
}

async function handleToggleRule(ruleId: string, enabled: boolean) {
  try {
    await toggleRule(ruleId, enabled);
  } catch (error) {
    ElMessage.error(t('toggleFailed'));
    console.error('Toggle rule failed:', error);
  }
}

function handleSelectionChange(selection: ProxyRule[]) {
  selectedRules.value = selection;
}

async function handleBatchToggle(enabled: boolean) {
  try {
    await batchToggleRules(
      selectedRules.value.map(r => r.id),
      enabled,
    );
  } catch (error) {
    ElMessage.error(t('toggleFailed'));
    console.error('Batch toggle failed:', error);
  }
}

async function handleBatchDelete() {
  if (selectedRules.value.length === 0) return;
  const ids = selectedRules.value.map(r => r.id);
  const count = ids.length;
  try {
    await ElMessageBox.confirm(
      t('confirmBatchDelete', [count]),
      t('confirmBatchDeleteTitle'),
      {
        confirmButtonText: t('confirm'),
        cancelButtonText: t('cancel'),
        type: 'warning',
      },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await batchDeleteRules(ids);
    ElMessage.success(t('batchDeleteSuccess', [count]));
    selectedRules.value = [];
  } catch (error) {
    ElMessage.error(t('batchDeleteFailed'));
    console.error('Batch delete failed:', error);
  }
}

// 日志操作
async function handleClearLogs() {
  try {
    await clearLogs();
    ElMessage.success(t('logsCleared'));
  } catch (error) {
    ElMessage.error(t('clearFailed'));
    console.error('Clear logs failed:', error);
  }
}

// 导入导出
async function handleExport() {
  await exportConfig();
}

async function handleImport(data: ExportData) {
  try {
    await importConfig(JSON.stringify(data));
    ElMessage.success(t('importSuccess'));
    showImportExport.value = false;
  } catch {
    ElMessage.error(t('importFailed'));
  }
}

async function handleImportHarRules(harRules: import('@/utils/types').ProxyRule[]) {
  try {
    for (const rule of harRules) {
      await addRule(rule);
    }
    showImportExport.value = false;
  } catch {
    ElMessage.error(t('importHarFailed'));
  }
}

async function handleReorder(fromId: string, toId: string) {
  const visibleRules = [...filteredRules.value];
  const fromIdx = visibleRules.findIndex(r => r.id === fromId);
  if (fromIdx < 0) return;
  const [moved] = visibleRules.splice(fromIdx, 1);
  const toIdx = visibleRules.findIndex(r => r.id === toId);
  if (toIdx < 0) return;
  visibleRules.splice(toIdx, 0, moved);

  const visibleIds = new Set(visibleRules.map(r => r.id));
  const hiddenRules = rules.value.filter(r => !visibleIds.has(r.id));
  const oldVisiblePositions = rules.value
    .map((r, i) => (visibleIds.has(r.id) ? i : -1))
    .filter(i => i >= 0);

  const newFull: ProxyRule[] = new Array(rules.value.length);
  for (const [i, rule] of hiddenRules.entries()) {
    newFull[oldVisiblePositions[i]] = rule;
  }
  for (const [i, rule] of visibleRules.entries()) {
    newFull[oldVisiblePositions[i]] = rule;
  }

  try {
    await reorderRules(newFull.map(r => r.id));
  } catch {
    ElMessage.error(t('operationFailed'));
  }
}
</script>

<style scoped>
.rules-count-info {
  margin: 0 32px 10px;
  font-size: 13px;
  color: var(--cop-text-color-secondary);
}

@media (width <= 768px) {
  .rules-count-info {
    margin: 0 20px 10px;
  }
}
</style>
