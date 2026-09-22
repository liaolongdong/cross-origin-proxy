<template>
  <el-dialog
    :model-value="visible"
    :title="t('settingsTitle')"
    width="480px"
    align-center
    @close="$emit('update:visible', false)"
  >
    <div class="settings-body dialog-body-scroll">
      <!-- 显示模式 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('themeMode') }}</div>
        <el-radio-group
          :model-value="themeMode"
          @update:model-value="handleModeChange"
        >
          <el-radio-button
            v-for="opt in THEME_MODE_OPTIONS"
            :key="opt.value"
            :value="opt.value"
          >
            <el-icon class="mode-icon"><component :is="opt.icon" /></el-icon>
            {{ locale === 'en' ? opt.labelEn : opt.label }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <!-- 主题色 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('themeLabel') }}</div>
        <div class="theme-swatches">
          <button
            v-for="opt in THEME_OPTIONS"
            :key="opt.name"
            class="theme-swatch"
            :class="{ active: currentTheme === opt.name }"
            :style="{ background: opt.swatch, color: opt.swatch }"
            :title="locale === 'en' ? opt.labelEn : opt.label"
            :aria-label="locale === 'en' ? opt.labelEn : opt.label"
            @click="$emit('changeTheme', opt.name)"
          />
        </div>
      </div>

      <!-- 界面语言 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('languageLabel') }}</div>
        <el-radio-group
          :model-value="locale"
          @update:model-value="handleLocaleChange"
        >
          <el-radio-button
            v-for="opt in LOCALE_OPTIONS"
            :key="opt.name"
            :value="opt.name"
          >
            {{ opt.label }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <!-- 自动关闭代理 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('autoOffLabel') }}</div>
        <p class="setting-hint">{{ t('autoOffHint') }}</p>
        <el-select
          :model-value="autoOffMinutes"
          style="width: 200px"
          @update:model-value="handleAutoOffChange"
        >
          <el-option
            :label="t('autoOffNever')"
            :value="0"
          />
          <el-option
            :label="t('autoOff30m')"
            :value="30"
          />
          <el-option
            :label="t('autoOff1h')"
            :value="60"
          />
          <el-option
            :label="t('autoOff2h')"
            :value="120"
          />
          <el-option
            :label="t('autoOff4h')"
            :value="240"
          />
        </el-select>
      </div>

      <!-- 凭据变量 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('variablesLabel') }}</div>
        <p class="setting-hint">{{ t('variablesHint') }}</p>

        <p
          v-if="variablesLoadFailed"
          class="variable-load-failed"
        >
          {{ t('variablesLoadFailed') }}
        </p>

        <div
          v-for="(row, index) in variableRows"
          :key="row.uid"
          class="variable-item"
        >
          <div class="variable-line">
            <el-input
              v-model="row.name"
              class="variable-name"
              :placeholder="t('variableNamePlaceholder')"
              :maxlength="MAX_VARIABLE_NAME_LENGTH"
              :aria-label="t('variableNamePlaceholder')"
              @change="commitVariables"
            />
            <span class="variable-usage">{{ t('variableUsedBy', usageCount(row.name)) }}</span>
            <el-button
              type="danger"
              link
              :aria-label="t('delete')"
              @click="removeVariable(index)"
            >
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
          <el-input
            v-model="row.value"
            type="password"
            show-password
            :placeholder="t('variableValuePlaceholder')"
            :maxlength="MAX_VARIABLE_VALUE_LENGTH"
            :aria-label="t('variableValuePlaceholder')"
            @change="commitVariables"
          />
        </div>

        <el-button
          type="primary"
          link
          :disabled="variableRows.length >= MAX_VARIABLES"
          @click="addVariable"
        >
          <el-icon><Plus /></el-icon>
          {{ t('variableAdd') }}
        </el-button>

        <p
          v-if="orphanVariableRefs.length > 0"
          class="variable-orphan"
        >
          {{ t('variablesOrphanWarning', orphanVariableRefs.join(', ')) }}
        </p>
      </div>

      <!-- 配置恢复点 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('restorePointsLabel') }}</div>
        <p class="setting-hint">{{ t('restorePointsHint', MAX_CONFIG_HISTORY) }}</p>

        <p
          v-if="historyLoadFailed"
          class="restore-load-failed"
        >
          {{ t('restorePointsLoadFailed') }}
        </p>
        <p
          v-else-if="history.length === 0"
          class="restore-empty"
        >
          {{ t('restorePointsEmpty') }}
        </p>

        <div
          v-for="entry in history"
          :key="entry.id"
          class="restore-item"
        >
          <span class="restore-time">{{ formatRestoreTime(entry.savedAt) }}</span>
          <span class="restore-meta">
            {{ t(REASON_LABEL_KEYS[entry.reason]) }} · {{ t('restoreRuleCount', entry.ruleCount) }}
          </span>
          <el-button
            type="warning"
            link
            :loading="restoringId === entry.id"
            :aria-label="t('restoreButton')"
            @click="handleRestore(entry)"
          >
            {{ t('restoreButton') }}
          </el-button>
        </div>
      </div>

      <!-- 键盘快捷键 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('keyboardShortcuts') }}</div>
        <div class="shortcut-list">
          <div class="shortcut-item">
            <span class="shortcut-desc">{{ t('shortcutAddRule') }}</span>
            <kbd>N</kbd>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-desc">{{ t('shortcutSearch') }}</span>
            <kbd>/</kbd>
            <span class="shortcut-or">{{ t('or') }}</span>
            <kbd>{{ isMac ? '⌘' : 'Ctrl' }}</kbd>
            <span class="shortcut-plus">+</span>
            <kbd>F</kbd>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-desc">{{ t('shortcutClose') }}</span>
            <kbd>Esc</kbd>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Sunny, Moon, Monitor, Delete, Plus } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { THEME_OPTIONS, THEME_MODE_OPTIONS, type ThemeName } from '@/utils/theme';
import {
  type ThemeMode,
  STORAGE_KEYS,
  MAX_RULES,
  MAX_VARIABLES,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  MAX_CONFIG_HISTORY,
} from '@/utils/constants';
import { LOCALE_OPTIONS, type LocaleName } from '@/utils/i18n';
import type { ConfigHistoryEntry, ConfigHistoryReason, ProxyRule, VariableStore } from '@/utils/types';
import { collectRuleVariableRefs, isVariableName } from '@/utils/variables';
import { formatLocaleDateTime } from '@/utils/formatters';
import { useVariables } from '@/composables/useVariables';
import { useConfigHistory } from '@/composables/useConfigHistory';
import { useI18n } from '@/composables/useI18n';

defineOptions({
  components: { Sunny, Moon, Monitor, Delete, Plus },
});

/**
 * 偏好设置弹窗（替代原设置 Tab）
 *
 * 显示模式切换 + 六色主题圆形色板 + 应用内中英文切换 + 代理自动关闭时长 + 凭据变量表，
 * 均即时生效并跨扩展页同步。
 */
const props = defineProps<{
  visible: boolean;
  /** 当前主题名 */
  currentTheme: ThemeName;
  /** 当前显示模式 */
  themeMode: ThemeMode;
  /** 当前规则集：只用来算「某个变量被几条规则引用」与列出失效引用 */
  rules: ProxyRule[];
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  /** 切换主题 */
  changeTheme: [theme: ThemeName];
  /** 切换显示模式 */
  changeThemeMode: [mode: ThemeMode];
  /** 回退到了某个恢复点：规则集已整体换掉，父组件必须重新拉取配置 */
  restored: [];
}>();

const { t, locale, setLocale } = useI18n();

/** 平台检测：用于快捷键提示展示 ⌘ / Ctrl */
const isMac = ref(navigator.platform.includes('Mac'));

/** 代理自动关闭时长（分钟，0 = 从不） */
const autoOffMinutes = ref(0);

// ─── 凭据变量 ────────────────────────────────────────────────────────────────

/**
 * 变量行。`uid` 只做列表 key——名字本身就是可编辑的，拿它当 key 会在编辑过程中重建输入框、
 * 让焦点从用户手里跑掉。
 */
interface VariableRow {
  uid: number;
  name: string;
  value: string;
}

let rowUidSeed = 0;
const variableRows = ref<VariableRow[]>([]);
const { variables, loadVariables, saveVariables } = useVariables();
/** 变量表没读出来就不能整表覆盖写：空列表一旦被当成现状，用户新填一把凭据就会抹掉已有的全部 */
const variablesLoadFailed = ref(false);

/** 每个变量被多少条规则引用（一次遍历，行内与孤儿引用共用） */
const variableUsage = computed(() => {
  const counts: Record<string, number> = {};
  for (const rule of props.rules ?? []) {
    for (const name of collectRuleVariableRefs(rule)) {
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
});

/** 规则里引用了、但表里已经没有的变量：删掉一把密钥后坏在哪，这里直接说出来 */
const orphanVariableRefs = computed(() => {
  const saved = variables.value;
  const names = new Set<string>();
  for (const rule of props.rules ?? []) {
    for (const name of collectRuleVariableRefs(rule)) {
      if (saved[name] === undefined) names.add(name);
    }
  }
  return [...names];
});

function usageCount(name: string): number {
  return variableUsage.value[name.trim()] ?? 0;
}

// ─── 配置恢复点 ──────────────────────────────────────────────────────────────

/** 成因 → 文案 key：`unknown` 是读侧兜底，不是本版本写下的成因，见 `utils/storage.ts` */
const REASON_LABEL_KEYS: Record<ConfigHistoryReason, string> = {
  'replace-import': 'restoreReasonReplaceImport',
  'load-profile': 'restoreReasonLoadProfile',
  'batch-delete': 'restoreReasonBatchDelete',
  'before-restore': 'restoreReasonBeforeRestore',
  unknown: 'restoreReasonUnknown',
};

const { history, loadHistory, restore } = useConfigHistory();
/** 读失败与「真的没有恢复点」必须分开画：前者是 gate/SW 异常，后者是还没做过成套操作 */
const historyLoadFailed = ref(false);
const restoringId = ref('');

/** `savedAt` 为 0 表示存储里这条没时间（手改或过新），不能渲染成 1970 年 */
function formatRestoreTime(savedAt: number): string {
  return savedAt ? formatLocaleDateTime(savedAt, locale.value) : t('restoreUnknownTime');
}

async function handleRestore(entry: ConfigHistoryEntry) {
  try {
    await ElMessageBox.confirm(t('restoreConfirm', entry.ruleCount), t('restoreConfirmTitle'), {
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel'),
      type: 'warning',
    });
  } catch {
    return; // 用户取消
  }

  restoringId.value = entry.id;
  try {
    const result = await restore(entry.id);
    if (!result.success) {
      ElMessage.error(result.error === 'MAX_RULES_EXCEEDED' ? t('maxRulesReached', MAX_RULES) : t('restoreFailed'));
      return;
    }
    ElMessage.success(t('restoreSuccess', result.restored ?? 0));
    // 回退自己会留下一份 `before-restore`，列表当场跟上；规则集换了，父组件要重新拉配置
    historyLoadFailed.value = !(await loadHistory());
    emit('restored');
  } finally {
    restoringId.value = '';
  }
}

/**
 * 用表里的真值重建行，但保住已有行的 `uid`
 *
 * `uid` 是列表 key，换 key 等于重建输入框。每次提交都重建，用户从上一个框切过来时
 * （blur 触发 change → 提交 → 重建）焦点会被抢走，而 change 正是本弹窗唯一的写入时机。
 * 未填完的空行按对象原样留在尾部，不丢用户的进度。
 */
function refillRows(store: VariableStore): void {
  const blanks = variableRows.value.filter(row => !row.name.trim() && !row.value.trim());
  const uidByName = new Map(variableRows.value.map(row => [row.name.trim(), row.uid]));
  const rows: VariableRow[] = Object.entries(store).map(([name, value]) => ({
    uid: uidByName.get(name) ?? ++rowUidSeed,
    name,
    value,
  }));
  variableRows.value = [...rows, ...blanks];
}

/** 打开弹窗时读取自动关闭配置、变量表与恢复点列表。`immediate` 不可省：本组件是异步分片，可能直到
 * visible 已为 true 才挂载（首次点击时分片尚未取回），那时 watcher 永不触发，倒计时会静默显示为
 * 「不自动关闭」，恢复点列表同样是空的。 */
watch(
  () => props.visible,
  async val => {
    if (!val) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.AUTO_OFF_MINUTES);
      const minutes = result[STORAGE_KEYS.AUTO_OFF_MINUTES];
      autoOffMinutes.value = typeof minutes === 'number' ? minutes : 0;
    } catch {
      autoOffMinutes.value = 0;
    }
    variablesLoadFailed.value = !(await loadVariables());
    if (!variablesLoadFailed.value) {
      refillRows(variables.value);
    }
    historyLoadFailed.value = !(await loadHistory());
  },
  { immediate: true },
);

/**
 * 把界面上的行整表写回
 *
 * 每次改动都整表提交（与规则配置的写入形态一致），因此没有「忘了保存」这个状态。
 * 校验不过就**一个都不写**：只存下一半凭据比全都没存更难发现。
 * 两端空白由后台再裁一次，两侧判据同源（`utils/variables.ts`）。
 */
async function commitVariables() {
  if (variablesLoadFailed.value) {
    ElMessage.error(t('variablesWriteBlocked'));
    return;
  }
  const next: VariableStore = {};
  for (const row of variableRows.value) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name && !value) continue;
    if (!isVariableName(name)) {
      ElMessage.warning(t('variableNameInvalid'));
      return;
    }
    if (!value) {
      ElMessage.warning(t('variableValueRequired', name));
      return;
    }
    if (next[name] !== undefined) {
      ElMessage.warning(t('variableNameDuplicate', name));
      return;
    }
    next[name] = value;
  }

  const result = await saveVariables(next);
  if (!result.success) {
    ElMessage.error(t('variablesSaveFailed'));
    return;
  }
  if (result.dropped > 0) {
    ElMessage.warning(t('variablesDropped', result.dropped));
  }
  // 回填一次：把「两端空白被裁掉」「未填完的行不算存进去」如实反映到界面（判据在后台，
  // 界面只负责说真话），已有行的 key 不变，见 refillRows 的注释
  refillRows(variables.value);
}

function addVariable() {
  variableRows.value.push({ uid: ++rowUidSeed, name: '', value: '' });
}

async function removeVariable(index: number) {
  const row = variableRows.value[index];
  const used = usageCount(row?.name ?? '');
  if (used > 0) {
    try {
      await ElMessageBox.confirm(t('confirmDeleteVariable', used), t('confirmDeleteVariableTitle'), {
        confirmButtonText: t('confirm'),
        cancelButtonText: t('cancel'),
        type: 'warning',
      });
    } catch {
      return; // 用户取消
    }
  }
  variableRows.value.splice(index, 1);
  await commitVariables();
}

async function handleAutoOffChange(val: string | number) {
  const minutes = Number(val) || 0;
  autoOffMinutes.value = minutes;
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.AUTO_OFF_MINUTES]: minutes });
  } catch (error) {
    console.error('Failed to save auto-off setting:', error);
  }
}

function handleModeChange(val: string | number | boolean | undefined) {
  if (val === 'light' || val === 'dark' || val === 'system') {
    emit('changeThemeMode', val as ThemeMode);
  }
}

function handleLocaleChange(val: string | number | boolean | undefined) {
  if (val === 'zh_CN' || val === 'en') {
    void setLocale(val as LocaleName);
  }
}
</script>

<style scoped>
.settings-body {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 0 4px;
}

.setting-label {
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--cop-text-color-primary);
}

.setting-hint {
  margin: -6px 0 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--cop-text-color-secondary);
}

.variable-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color-light);
  border-radius: 8px;
}

.variable-line {
  display: flex;
  gap: 8px;
  align-items: center;
}

.variable-name {
  flex: 1;
  min-width: 0;
}

.variable-usage {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--cop-text-color-secondary);
}

.variable-orphan,
.variable-load-failed {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-color-danger, #f56c6c);
}

.restore-item {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color-light);
  border-radius: 8px;
}

.restore-time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--cop-text-color-regular);
}

.restore-meta {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--cop-text-color-secondary);
}

.restore-empty,
.restore-load-failed {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--cop-text-color-secondary);
}

.restore-load-failed {
  color: var(--el-color-danger, #f56c6c);
}

.mode-icon {
  margin-right: 4px;
  font-size: 14px;
  vertical-align: -2px;
}

.theme-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.theme-swatch {
  width: 32px;
  height: 32px;
  cursor: pointer;
  outline: none;
  border: 2px solid transparent;
  border-radius: 50%;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.theme-swatch:hover {
  box-shadow: 0 2px 8px rgb(var(--cop-primary-rgb) / 25%);
  transform: scale(1.12);
}

.theme-swatch:focus-visible {
  box-shadow: 0 0 0 2px rgb(var(--cop-primary-rgb) / 40%);
}

.theme-swatch.active {
  border-color: var(--cop-bg-color);
  box-shadow:
    0 0 0 2px var(--cop-bg-color),
    0 0 0 4px currentcolor,
    0 2px 8px rgb(var(--cop-primary-rgb) / 30%);
  transform: scale(1.08);
}

.theme-swatch.active:hover {
  transform: scale(1.12);
}

.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.shortcut-item {
  display: flex;
  gap: 8px;
  align-items: center;
}

.shortcut-desc {
  flex: 1;
  font-size: 13px;
  color: var(--cop-text-color-regular);
}

.shortcut-or,
.shortcut-plus {
  font-size: 12px;
  color: var(--cop-text-color-secondary);
}

kbd {
  display: inline-block;
  min-width: 24px;
  padding: 2px 8px;
  font-family: inherit;
  font-size: 12px;
  line-height: 20px;
  color: var(--cop-text-color-regular);
  text-align: center;
  background: var(--cop-bg-color-tertiary);
  border: 1px solid var(--cop-border-color);
  border-radius: 4px;
  box-shadow: 0 1px 0 var(--cop-border-color);
}
</style>
