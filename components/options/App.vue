<template>
  <div class="options-page">
    <!-- 渐变通栏头部 -->
    <HeaderBar
      :current-version="currentVersion"
      :proxy-enabled="proxyEnabled"
      @add-rule="handleAddRule"
      @open-logs="openLogs"
      @open-url-test="showUrlTest = true"
      @open-import-export="showImportExport = true"
      @open-profiles="showProfiles = true"
      @open-settings="showSettings = true"
      @toggle-proxy="handleToggleProxy"
    />

    <!-- 搜索筛选卡片 -->
    <SearchFilterBar
      v-model:search-text="searchText"
      v-model:status-filter="statusFilter"
      v-model:match-type-filter="matchTypeFilter"
      :selected-count="selectedRules.length"
      :total-rules="rules.length"
      @batch-toggle="handleBatchToggle"
      @batch-delete="handleBatchDelete"
      @batch-migrate="showMigrate = true"
      @toggle-all="handleToggleAll"
    />

    <!-- 规则计数信息行 -->
    <div class="rules-count-info">
      {{ t('rulesCountInfo', [rules.length, enabledCount]) }}
      <span
        v-if="dnrSkippedRules.size > 0"
        class="dnr-skipped-summary"
        >{{ t('dnrSkippedSummary', [dnrSkippedRules.size]) }}</span
      >
      <span
        v-if="dnrStatsStale"
        class="hit-stats-stale"
        >{{ t('hitStatsStale') }}</span
      >
    </div>

    <!-- 规则表格卡片 -->
    <RuleTable
      ref="ruleTableRef"
      :rules="filteredRules"
      :loading="ruleLoading"
      :has-any-rules="rules.length > 0"
      :highlight-rule-id="highlightRuleId"
      :search-text="searchText"
      :hit-stats="hitStatsByRule"
      :dnr-stats-state="dnrStatsState"
      :shadowed-rule-ids="shadowedRuleIds"
      :dnr-skipped-rules="dnrSkippedRules"
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
      @imported="handleImported"
      @import-har-rules="handleImportHarRules"
      @import-curl="handleImportCurl"
    />
    <ProfilesDialog
      v-model:visible="showProfiles"
      @loaded="handleProfilesLoaded"
    />
    <UrlTestDialog
      v-model:visible="showUrlTest"
      :rules="rules"
      :dnr-skipped-rules="dnrSkippedRules"
      :proxy-enabled="proxyEnabled"
    />
    <MigrateTargetsDialog
      v-model:visible="showMigrate"
      :selected-rules="selectedRules"
      @apply="handleMigrateApply"
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
      :refresh-interval="logRefreshInterval"
      :logs="logs"
      :loading="logLoading"
      :auto-refresh="autoRefresh"
      :dnr-stats="dnrStats"
      :dnr-stats-state="dnrStatsState"
      :sw-stats="swStats"
      @clear="handleClearLogs"
      @refresh="toggleAutoRefresh"
      @update:refresh-interval="setRefreshInterval"
      @refresh-dnr-stats="fetchDnrStats"
      @create-rule-from-log="handleCreateRuleFromLog"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, h, defineAsyncComponent } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { ProxyRule } from '@/utils/types';
import { MessageType } from '@/utils/types';
import { MAX_RULES } from '@/utils/constants';
import { useRuleManagement } from '@/composables/useRuleManagement';
import { useDnrSupport, useDnrSkipText } from '@/composables/useDnrSupport';
import { checkDnrRule } from '@/utils/dnrSupport';
import { useRequestLog } from '@/composables/useRequestLog';
import { useImportExport } from '@/composables/useImportExport';
import { useI18n } from '@/composables/useI18n';
import {
  type ThemeName,
  getStoredTheme,
  setStoredTheme,
  applyThemeToRoot,
  getStoredThemeMode,
  setStoredThemeMode,
  applyThemeMode,
} from '@/utils/theme';
import { type ThemeMode } from '@/utils/constants';
import { logger } from '@/utils/logger';
import { groupHitStatsByRule } from '@/utils/ruleStats';
import { buildDuplicateRuleData } from '@/utils/ruleDuplicate';
import { mergeReorderedVisible } from '@/utils/ruleOrder';
import { resolveSelectedRules } from '@/utils/ruleSelection';
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
const ProfilesDialog = defineAsyncComponent(() => import('./ProfilesDialog.vue'));
const SettingsDialog = defineAsyncComponent(() => import('./SettingsDialog.vue'));
const UrlTestDialog = defineAsyncComponent(() => import('./UrlTestDialog.vue'));
const LogDrawer = defineAsyncComponent(() => import('./LogDrawer.vue'));
const MigrateTargetsDialog = defineAsyncComponent(() => import('./MigrateTargetsDialog.vue'));

const { t } = useI18n();

const currentVersion = chrome.runtime.getManifest().version;

/** 批量操作（启用/禁用/删除）涉及超过此条数时弹出二次确认，避免误操作 */
const BATCH_CONFIRM_THRESHOLD = 5;

// 规则管理
const {
  rules,
  enabled: proxyEnabled,
  loading: ruleLoading,
  shadowedRuleIds,
  fetchConfig,
  addRule,
  batchAddRules,
  updateRule,
  toggleRule,
  batchToggleRules,
  toggleAllRules,
  batchDeleteRules,
  batchUpdateTargets,
  reorderRules,
  toggleProxy,
  findConflictingRule,
  beginPendingDelete,
  endPendingDelete,
} = useRuleManagement();

// 请求日志 + DNR 命中统计
const {
  logs,
  loading: logLoading,
  autoRefresh,
  refreshInterval: logRefreshInterval,
  dnrStats,
  dnrStatsStale,
  dnrStatsState,
  swStats,
  fetchLogs,
  clearLogs,
  toggleAutoRefresh,
  setRefreshInterval,
  fetchDnrStats,
  fetchSwStats,
} = useRequestLog();

// 导入导出
const { exportConfig } = useImportExport();

// 「DNR 不会应用」的规则（RE2 不兼容 / 捕获引用越界）：这类规则界面显示已启用，实际零作用
const { dnrSkippedRules } = useDnrSupport(rules);
const { skipReasonText } = useDnrSkipText();

// UI 状态
const showRuleDialog = ref(false);
const showImportExport = ref(false);
const showProfiles = ref(false);
const showSettings = ref(false);
const showUrlTest = ref(false);
const showLogs = ref(false);
const showMigrate = ref(false);
const editingRule = ref<ProxyRule | null>(null);
const templateInitialData = ref<Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'> | null>(null);
const highlightRuleId = ref<string | null>(null);

// 搜索与筛选（状态在容器层，SearchFilterBar 为受控组件）
const searchText = ref('');
const statusFilter = ref('');
const matchTypeFilter = ref('');
/** 表格上报的原始勾选（reserve-selection 下跨筛选、跨删除都会保留） */
const tableSelection = ref<ProxyRule[]>([]);
/** 计数与批量操作只认它：剔除已不存在的规则，并换回列表里的最新对象 */
const selectedRules = computed(() => resolveSelectedRules(tableSelection.value, rules.value));
/** 表格实例：只用到 clearSelection（reserve-selection 的勾选存活在表格内部） */
const ruleTableRef = ref<{ clearSelection: () => void } | null>(null);

/** 规则集整体变化后重置选择：两边的状态都要清，否则批量操作会作用在不可见的规则上 */
function clearRuleSelection() {
  tableSelection.value = [];
  ruleTableRef.value?.clearSelection();
}

// 日志抽屉过滤器（提升到容器层，避免抽屉关闭后重置）
const logMethodFilter = ref('');
const logStatusFilter = ref('');

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
    const matchesMatchType = !matchTypeFilter.value || rule.matchType === matchTypeFilter.value;
    return matchesSearch && matchesStatus && matchesMatchType;
  });
});

const enabledCount = computed(() => rules.value.filter(r => r.enabled).length);

/** 规则列表命中列：两条通道分开读，不相加（窗口不同，相加的数字不属于任何一段时间） */
const hitStatsByRule = computed(() => groupHitStatsByRule(dnrStats.value, swStats.value));

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

/**
 * 配置页回到前台时重新采样命中数
 *
 * 常开的配置页此前只在挂载与打开日志抽屉时各读一次，用户切回去看到的还是几分钟前的计数，
 * 据此判断「代理没生效」。这里不加定时器：刷新与「用户真的在看」成正比，配额才够花。
 */
function handleVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  void fetchDnrStats();
  void fetchSwStats();
}

onMounted(async () => {
  currentTheme.value = await getStoredTheme();
  themeMode.value = await getStoredThemeMode();
  applyThemeMode(themeMode.value);

  void fetchDnrStats();
  void fetchSwStats();

  // Popup 直达支持：#add-rule 打开添加规则弹窗，#logs 打开日志抽屉，#import-export 打开导入导出，
  // #profiles 打开环境配置，#url-test 打开 URL 匹配预演，
  // #add-rule-from-tab=<url> 按当前标签页地址预填通配符规则；
  // 监听 hashchange：popup 复用已打开的 Options 标签页时通过更新 hash 触发同文档导航
  handleHashNavigation();
  window.addEventListener('hashchange', handleHashNavigation);
  // 全局键盘快捷键
  window.addEventListener('keydown', handleKeydown);
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

onUnmounted(() => {
  window.removeEventListener('hashchange', handleHashNavigation);
  window.removeEventListener('keydown', handleKeydown);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});

/** 全局键盘快捷键处理 */
function handleKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  const isEditable = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

  // 在输入框中仅响应 Escape，其余快捷键跳过
  if (isEditable && e.key !== 'Escape') return;

  const isMac = navigator.platform.includes('Mac');
  const modKey = isMac ? e.metaKey : e.ctrlKey;

  // N（或 Ctrl/Cmd + N）：打开新增规则弹窗。
  // 注意 Ctrl/Cmd+N 在多数平台是浏览器保留快捷键（新窗口），页面无法捕获，
  // 因此以单键 N 为主（同 Gmail 风格的单键快捷操作）
  // 规则弹窗打开时忽略 N 键：避免编辑中的弹窗被静默重置为新增模式丢失修改
  if (e.key === 'n' || e.key === 'N' || (modKey && e.key === 'n')) {
    if (showRuleDialog.value) return;
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

  // Escape：关闭最上层的弹窗/抽屉（优先级：规则弹窗 > 导入导出 > 环境配置 > 设置 > URL 测试 > 日志）
  if (e.key === 'Escape') {
    if (showRuleDialog.value) {
      showRuleDialog.value = false;
    } else if (showImportExport.value) {
      showImportExport.value = false;
    } else if (showProfiles.value) {
      showProfiles.value = false;
    } else if (showSettings.value) {
      showSettings.value = false;
    } else if (showUrlTest.value) {
      showUrlTest.value = false;
    } else if (showMigrate.value) {
      showMigrate.value = false;
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
  } else if (hash === '#profiles') {
    showProfiles.value = true;
  } else if (hash === '#url-test') {
    showUrlTest.value = true;
  } else if (hash.startsWith('#add-rule-from-tab=')) {
    // popup 传入的地址经 encodeURIComponent 编码，此处解码后校验（视为不可信输入）
    handleCreateRuleFromUrl(decodeURIComponent(hash.slice('#add-rule-from-tab='.length)));
  }
  if (hash) {
    history.replaceState(null, '', window.location.pathname);
  }
}

// 代理总开关
async function handleToggleProxy(val: boolean) {
  try {
    await toggleProxy(val);
    ElMessage.success(val ? t('proxyEnabledMsg') : t('proxyDisabledMsg'));
  } catch (error) {
    ElMessage.error(t('toggleFailed'));
    logger.error('Toggle proxy failed:', error);
  }
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
  const editingId = editingRule.value?.id;
  try {
    const conflict = findConflictingRule(ruleData, editingId);
    if (conflict) {
      ElMessage.warning(t('conflictWarningMsg', [conflict.name]));
    }

    // addRule / updateRule 成功后会同步更新 rules.value，故可直接按 id 回查刚保存的规则
    let savedId: string;
    if (editingId) {
      await updateRule(editingId, ruleData);
      savedId = editingId;
    } else {
      const rule = await addRule(ruleData);
      savedId = rule.id;
      flashHighlight(rule.id);
    }
    showRuleDialog.value = false;

    // 「保存成功」不等于「会被应用」：走 DNR 通道的规则可能因 RE2 不兼容或捕获引用越界被跳过，
    // 此时给一条可行动的提示，而不是让用户回头去猜为什么流量没被代理
    const savedRule = rules.value.find(r => r.id === savedId);
    const skipReason = savedRule ? await checkDnrRule(savedRule) : null;
    if (skipReason) {
      ElMessage.warning(t('dnrSkippedMsg', [skipReasonText(skipReason)]));
    } else {
      ElMessage.success(editingId ? t('ruleUpdated') : t('ruleAdded'));
    }
  } catch (error) {
    showAddFailedMessage(error);
    logger.error('Save rule failed:', error);
  }
}

/** 复制规则：克隆为停用副本，便于在副本上安全调整。完整保留所有字段（含 mock/override/delay/block/retry）。 */
async function handleDuplicateRule(rule: ProxyRule) {
  try {
    const copy = await addRule(buildDuplicateRuleData(rule, t('copySuffix')));
    flashHighlight(copy.id);
    ElMessage.success(t('ruleDuplicated'));
  } catch (error) {
    showAddFailedMessage(error);
    logger.error('Duplicate rule failed:', error);
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
 * 每次删除用独立闭包持有规则与定时器，连续删除多条时互不干扰
 * （单例状态会被后续删除覆盖，导致规则漏删或误删）。
 *
 * `committed` 是唯一的提交点标志：定时器触发即置位并先关闭提示，之后的撤销
 * 一律拒绝（存储已删，本地插回只会得到一行随后被 storage.onChanged 抹掉的幽灵数据）。
 *
 * 窗口期内规则仍存在于 `storage.local`，因此 id 会登记到 `pendingDeleteIds`，
 * 由 fetchConfig 过滤掉——否则其他标签页的改动、导入或加载环境配置会把这行捞回来，
 * 用户再点撤销就 splice 出第二份重复行。撤销与提交两条出口都要注销登记。
 */
function handleDeleteRule(ruleId: string) {
  const index = rules.value.findIndex(r => r.id === ruleId);
  if (index === -1) return;
  // structuredClone：嵌套的 headerOverrides / queryOverrides / mockResponse 等
  // 不能与原规则共享引用，否则撤销回来的会是被人改过的对象
  const capturedRule = structuredClone(rules.value[index]);
  const originalIndex = index;

  // 乐观更新：立即从 UI 移除，并登记进撤销窗口，
  // 避免窗口内的 fetchConfig（其他标签页改动、导入、加载环境配置）把这行捞回来
  beginPendingDelete(ruleId);
  rules.value = rules.value.filter(r => r.id !== ruleId);

  let committed = false;
  let deleteTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    committed = true;
    deleteTimer = null;
    // 先收起撤销入口，再发出删除：两者之间不留可点击的窗口
    message.close();
    chrome.runtime
      .sendMessage({
        type: MessageType.DELETE_RULE,
        data: { ruleId: capturedRule.id },
      })
      .catch(err => logger.error('Delete rule failed:', err))
      .finally(() => endPendingDelete(capturedRule.id));
  }, 5000);

  const message = ElMessage({
    message: h('div', [
      h('span', t('ruleDeleted') + ' '),
      h(
        'a',
        {
          style: 'color: var(--cop-primary, #409EFF); cursor: pointer; text-decoration: underline;',
          onClick: () => {
            // 提示的离场动画期间链接仍可能被点到，此时删除已落库，不能再假装恢复
            if (committed) {
              ElMessage.warning(t('undoExpired'));
              return;
            }
            // 撤销：取消定时器，恢复规则到原位置
            if (deleteTimer) {
              clearTimeout(deleteTimer);
              deleteTimer = null;
            }
            message.close();
            endPendingDelete(capturedRule.id);
            rules.value.splice(Math.min(originalIndex, rules.value.length), 0, capturedRule);
            ElMessage.success(t('undoSuccess'));
          },
        },
        t('undo'),
      ),
    ]),
    duration: 5000,
    showClose: false,
  });
}

async function handleToggleRule(ruleId: string, enabled: boolean) {
  try {
    await toggleRule(ruleId, enabled);
  } catch (error) {
    ElMessage.error(t('toggleFailed'));
    logger.error('Toggle rule failed:', error);
  }
}

function handleSelectionChange(selection: ProxyRule[]) {
  tableSelection.value = selection;
}

async function handleBatchToggle(enabled: boolean) {
  const ids = selectedRules.value.map(r => r.id);
  const count = ids.length;
  if (count === 0) return;
  if (count > BATCH_CONFIRM_THRESHOLD) {
    try {
      const action = enabled ? t('toggleAllEnabled') : t('toggleAllDisabled');
      await ElMessageBox.confirm(t('confirmBatchToggle', [action, count]), t('confirmBatchToggleTitle', [action]), {
        confirmButtonText: t('confirm'),
        cancelButtonText: t('cancel'),
        type: 'warning',
      });
    } catch {
      return; // 用户取消
    }
  }
  try {
    await batchToggleRules(ids, enabled);
  } catch (error) {
    ElMessage.error(t('toggleFailed'));
    logger.error('Batch toggle failed:', error);
  }
}

async function handleToggleAll(enabled: boolean) {
  if (rules.value.length > BATCH_CONFIRM_THRESHOLD) {
    try {
      const action = enabled ? t('toggleAllEnabled') : t('toggleAllDisabled');
      await ElMessageBox.confirm(
        t('confirmToggleAll', [action, rules.value.length]),
        t('confirmToggleAllTitle', [action]),
        {
          confirmButtonText: t('confirm'),
          cancelButtonText: t('cancel'),
          type: 'warning',
        },
      );
    } catch {
      return; // 用户取消
    }
  }
  try {
    await toggleAllRules(enabled);
    ElMessage.success(t('toggleAllSuccess', [enabled ? t('toggleAllEnabled') : t('toggleAllDisabled')]));
  } catch (error) {
    ElMessage.error(t('toggleFailed'));
    logger.error('Toggle all failed:', error);
  }
}

async function handleBatchDelete() {
  if (selectedRules.value.length === 0) return;
  const ids = selectedRules.value.map(r => r.id);
  const count = ids.length;
  try {
    await ElMessageBox.confirm(t('confirmBatchDelete', [count]), t('confirmBatchDeleteTitle'), {
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel'),
      type: 'warning',
    });
  } catch {
    return; // 用户取消
  }
  try {
    await batchDeleteRules(ids);
    ElMessage.success(t('batchDeleteSuccess', [count]));
    clearRuleSelection();
  } catch (error) {
    ElMessage.error(t('batchDeleteFailed'));
    logger.error('Batch delete failed:', error);
  }
}

/** 批量迁移目标 URL：接收弹窗预览的变更集，一次写入并提示结果 */
async function handleMigrateApply(updates: { id: string; targetUrl: string }[]) {
  if (updates.length === 0) return;
  try {
    await batchUpdateTargets(updates);
    ElMessage.success(t('migrateSuccess', [updates.length]));
    clearRuleSelection();
  } catch (error) {
    ElMessage.error(t('migrateFailed'));
    logger.error('Batch migrate targets failed:', error);
  }
}

// 日志操作
async function handleClearLogs() {
  try {
    await clearLogs();
    ElMessage.success(t('logsCleared'));
  } catch (error) {
    ElMessage.error(t('clearFailed'));
    logger.error('Clear logs failed:', error);
  }
}

// 导入导出：exportConfig 的成功/失败反馈统一由本组件发出（子弹窗的 emit 不携带异步结果）
async function handleExport(sanitize: boolean) {
  try {
    const { removedCount } = await exportConfig(sanitize);
    ElMessage.success(removedCount > 0 ? t('exportSuccessSanitized', [removedCount]) : t('exportSuccess'));
  } catch (error) {
    ElMessage.error(t('exportFailed'));
    logger.error('Export failed:', error);
  }
}

/** 导入成功由弹窗确认后才发出通知：这里只需刷新列表并收窗（失败时输入保留、弹窗不关） */
async function handleImported() {
  // 导入由后台整体替换/合并规则，重新拉取配置保持 UI 与存储一致
  await fetchConfig();
  clearRuleSelection();
  ElMessage.success(t('importSuccess'));
  showImportExport.value = false;
}

async function handleImportHarRules(harRules: import('@/utils/types').ProxyRule[]) {
  try {
    // 批量一次写入，避免逐条 sendMessage 触发 N 次 DNR 重建
    await batchAddRules(harRules);
    ElMessage.success(t('importHarSuccess', [harRules.length]));
    showImportExport.value = false;
  } catch (error) {
    // 失败时不关窗：达上限时用户删几条即可重试，不必重新选文件
    showAddFailedMessage(error);
  }
}

/** cURL 导入：按请求 origin 预填通配符规则，头/体进入对应覆盖项，交由表单确认保存 */
function handleImportCurl(parsed: import('@/utils/curlParser').ParsedCurl) {
  let url: URL;
  try {
    url = new URL(parsed.url);
  } catch {
    ElMessage.error(t('importCurlFailed'));
    return;
  }
  showImportExport.value = false;

  // 规则不按方法匹配，因此把 cURL 的方法写进名字：否则 `curl -X DELETE` 与 GET 会生成同名规则，
  // 用户无从知道这条草稿原本对应的是写操作
  const prefill = buildOriginWildcardDraft(url, `cURL: ${parsed.method} ${url.hostname}`);
  if (Object.keys(parsed.headers).length > 0) {
    prefill.headerOverrides = { ...parsed.headers };
  }
  if (parsed.body !== undefined) {
    prefill.requestBodyOverride = parsed.body;
  }
  handleUseTemplate(prefill);
}

/** 环境配置加载成功后：后台已整体替换规则集，刷新本地列表保持一致 */
async function handleProfilesLoaded() {
  await fetchConfig();
  clearRuleSelection();
}

/** 按 origin 预填通配符规则草稿：cURL 导入 / 日志转规则 / Popup 当前页直达共用 */
function buildOriginWildcardDraft(url: URL, name: string): Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name,
    enabled: true,
    matchType: 'wildcard',
    matchPattern: `${url.origin}/*`,
    targetUrl: url.origin,
    priority: 100,
  };
}

/**
 * 从 URL 快速建规则（日志转规则 / Popup 当前页直达共用）：
 * 校验 http/https 后以请求 origin 预填通配符草稿，交由表单确认保存。
 * @returns 是否成功打开预填弹窗
 */
function handleCreateRuleFromUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    ElMessage.error(t('createRuleFromLogFailed'));
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) {
    ElMessage.error(t('createRuleFromLogFailed'));
    return false;
  }
  handleUseTemplate(buildOriginWildcardDraft(url, `${t('createRuleFromLogPrefix')} ${url.hostname}`));
  return true;
}

/** 从日志详情快速建规则：以请求 URL 的 origin 预填充通配符规则 */
function handleCreateRuleFromLog(log: import('@/utils/types').RequestLogEntry) {
  if (handleCreateRuleFromUrl(log.originalUrl)) {
    showLogs.value = false;
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

  // 筛选态下隐藏规则原地保留，可见规则按拖拽后的新顺序填入原本可见规则的位置
  const newFull = mergeReorderedVisible(rules.value, visibleRules);

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

/* 两条都是 v-if 的追加句：分隔符写在 CSS 里，任何一条单独出现时都不会留下孤点 */
.dnr-skipped-summary::before,
.hit-stats-stale::before {
  margin-right: 5px;
  content: '·';
}

.dnr-skipped-summary {
  color: var(--el-color-danger, #f56c6c);
}

.hit-stats-stale {
  color: var(--cop-text-color-secondary);
}

@media (width <= 768px) {
  .rules-count-info {
    margin: 0 20px 10px;
  }
}
</style>
