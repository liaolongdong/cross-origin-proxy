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
            v-for="preset in AUTO_OFF_PRESETS"
            :key="preset.minutes"
            :label="t(preset.labelKey)"
            :value="preset.minutes"
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
          <el-button
            type="primary"
            link
            :loading="variablesLoading"
            @click="retryLoadVariables"
          >
            {{ t('variablesRetry') }}
          </el-button>
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
              :disabled="variablesLocked"
              @change="commitVariables"
            />
            <span class="variable-usage">{{ t('variableUsedBy', usageCount(row.name)) }}</span>
            <el-button
              type="danger"
              link
              :aria-label="t('removeVariableA11y', row.name.trim() || index + 1)"
              :disabled="variablesLocked"
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
            :disabled="variablesLocked"
            @change="commitVariables"
          />
        </div>

        <el-button
          type="primary"
          link
          :disabled="variablesLocked || variableRows.length >= MAX_VARIABLES"
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

      <!-- 站点生效范围：弹窗那颗开关管「这一台」，这一节管整份名单（含删与换档） -->
      <div class="setting-section">
        <div class="setting-label">{{ t('siteScopeManageTitle') }}</div>
        <p
          v-if="siteScopeUnreadable"
          class="site-scope-warning"
        >
          {{ t('siteScopeUnreadable') }}
        </p>
        <template v-else>
          <div class="site-scope-modes">
            <el-radio-group
              :model-value="siteState.mode"
              size="small"
              @change="changeSiteMode($event as SiteScopeMode)"
            >
              <el-radio value="all">{{ t('siteScopeModeAll') }}</el-radio>
              <el-radio value="site-off">{{ t('siteScopeModeOff') }}</el-radio>
              <el-radio value="site-only">{{ t('siteScopeModeOnly') }}</el-radio>
            </el-radio-group>
          </div>
          <ul
            v-if="siteState.hosts.length"
            class="site-scope-list"
          >
            <li
              v-for="host in siteState.hosts"
              :key="host"
              class="site-scope-item"
            >
              <code :title="host">{{ host }}</code>
              <el-button
                type="danger"
                link
                size="small"
                :aria-label="t('siteScopeRemoveA11y', host)"
                @click="removeSiteHost(host)"
              >
                <el-icon><Delete /></el-icon>
              </el-button>
            </li>
          </ul>
          <p
            v-else
            class="site-scope-empty"
          >
            {{ t('siteScopeEmpty') }}
          </p>
          <p class="site-scope-hint">{{ t('siteScopeListHint') }}</p>
        </template>
      </div>

      <!-- 评分入口：一格常驻的设置项，只在从 Chrome 商店装的构建上出现（解包加载、Edge 那一族
           的 `update_url` 都不算，那条链接在它们身上必然 404；判据见 utils/storePage.ts）。
           形态是这里唯一承重的选择：Chrome Web Store 的政策禁的是
           操纵评价（激励换评、刷量、自评），并不禁止征求评价，而 Google 自己的文档就写着
           「条目 URL 末尾加 /reviews」；会撞线的是弹窗拦截、伪装成浏览器警告、反复骚扰那三类。
           所以这一格不自动出现、不拦任何操作、不给奖励、不读数——点一下只是开一个标签页。 -->
      <div
        v-if="reviewUrl"
        class="setting-section"
      >
        <div class="setting-label">{{ t('ratingTitle') }}</div>
        <p class="rating-desc">{{ t('ratingDesc') }}</p>
        <el-button
          size="small"
          @click="openReviewPage"
        >
          {{ t('ratingAction') }}
        </el-button>
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
  MAX_RULES,
  MAX_VARIABLES,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  MAX_CONFIG_HISTORY,
} from '@/utils/constants';
import { AUTO_OFF_PRESETS, readAutoOffMinutes, writeAutoOffMinutes } from '@/utils/autoOff';
import { LOCALE_OPTIONS, type LocaleName } from '@/utils/i18n';
import { DEFAULT_SITE_STATE, sanitizeSiteState, withoutHost } from '@/utils/siteScope';
import { isStoreInstalled, storeReviewUrl } from '@/utils/storePage';
import type {
  ConfigHistoryEntry,
  ConfigHistoryReason,
  ProxyRule,
  SiteScopeMode,
  SiteState,
  VariableStore,
} from '@/utils/types';
import { collectRuleVariableRefs, findUndefinedVariableRefs, isVariableName } from '@/utils/variables';
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
/**
 * 这一次打开弹窗的变量读取还在路上。
 *
 * 与上面那一格是同一件事的两面：闸门要说的是「还没有成功读到」，而不是「读失败了」——在途期间
 * `variableRows` 也可能是空的，而这一段窗口比想象的长（前面还排着自动关闭配置那一次往返，
 * 后台 SW 冷启动时更久）。所以这里既拦提交，也把那一行的输入框与「新建变量」按钮一并禁掉：
 * 只拦提交会留下一段「用户填进去的行马上被 `refillRows` 盖掉」的窗口，那比填不进更让人摸不着头脑。
 */
const variablesLoading = ref(false);

/**
 * 凭据变量这一节此刻不可写：在读（`variablesLoading`）或没读到（`variablesLoadFailed`）都算
 *
 * 合成一个出口给模板：两档各漏一处，界面上就会出现「行改得动、整表却不会写」的假象——
 * 读失败时那几行不代表现状，改完一提交就是拿它覆盖真凭据。删除同样归这一格管。
 */
const variablesLocked = computed(() => variablesLoading.value || variablesLoadFailed.value);

/**
 * 变量名 → 被多少条规则引用（行内「被 N 条规则使用」与删除确认里的次数都读它）
 *
 * 用 `Map` 而不是对象：`constructor` / `toString` 都是合法变量名（`isVariableName` 只约束字法），
 * 对象下标会顺原型链摸到函数，那一格就把函数源码当次数画出来。
 */
const variableUsage = computed(() => {
  const counts = new Map<string, number>();
  for (const rule of props.rules ?? []) {
    for (const name of collectRuleVariableRefs(rule)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
});

/**
 * 规则里引用了、但表里已经没有的变量：删掉一把密钥后坏在哪，这里直接说出来
 *
 * 「表里有没有」这句话只由 `findUndefinedVariableRefs` 说一次（表单保存侧用的是同一个出口）——
 * 在这里再写一遍按名字取值的判据，就是两处口径分叉的开始。
 */
const orphanVariableRefs = computed(() => {
  const names = new Set<string>();
  for (const rule of props.rules ?? []) {
    for (const name of findUndefinedVariableRefs(rule, variables.value)) names.add(name);
  }
  return [...names];
});

function usageCount(name: string): number {
  return variableUsage.value.get(name.trim()) ?? 0;
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

/** 变量表读取的轮次：关掉再打开会让上一轮的往返晚到，晚到的答案必须整包作废 */
let variablesRound = 0;
/** 恢复点列表读取的轮次（与变量表分开：就地重试变量不该连带吞掉恢复点那一轮的读数） */
let historyRound = 0;

/**
 * 读一张变量表进界面
 *
 * 轮次对不上就整包作废：晚到的回包会把新一轮刚读到的表、刚放下的闸门又改回去，
 * 界面上却只表现为「列表闪了一下」。
 *
 * @returns 这一轮是否仍然有效且读成功
 */
async function loadVariablesInto(round: number): Promise<boolean> {
  const ok = await loadVariables();
  if (round !== variablesRound) return false;
  variablesLoadFailed.value = !ok;
  if (ok) refillRows(variables.value);
  return ok;
}

/** 就地把变量表再读一次：读失败时那行提示旁边的「重试」走这里，不必关掉弹窗再打开 */
async function retryLoadVariables(): Promise<void> {
  const round = ++variablesRound;
  variablesLoading.value = true;
  try {
    await loadVariablesInto(round);
  } finally {
    if (round === variablesRound) variablesLoading.value = false;
  }
}

/** 打开弹窗时读取自动关闭配置、变量表与恢复点列表。`immediate` 不可省：本组件是异步分片，可能直到
 * visible 已为 true 才挂载（首次点击时分片尚未取回），那时 watcher 永不触发，倒计时会静默显示为
 * 「不自动关闭」，恢复点列表同样是空的。 */
watch(
  () => props.visible,
  async val => {
    if (!val) return;
    const round = ++variablesRound;
    const historyRoundAt = ++historyRound;
    // 从这一次打开起变量节就不可写：它前面还排着自动关闭配置那一次往返，而那段窗口里
    // `variableRows` 同样是「还没读到」的空列表——闸门要盖住整段在途，不只是 `loadVariables()` 那一句
    variablesLoading.value = true;
    void loadSiteScope();
    try {
      let minutes = 0;
      try {
        minutes = await readAutoOffMinutes();
      } catch {
        minutes = 0;
      }
      if (round !== variablesRound) return;
      autoOffMinutes.value = minutes;
      await loadVariablesInto(round);
      if (round !== variablesRound) return;
    } finally {
      // 旗标必须落下：卡在 true 就把这一节永远变成只读，比那一次覆盖写更难发现。
      // 只落自己那一轮：晚到的那一轮若清掉新一轮在途的闸门，界面就会在真正读到之前允许提交
      if (round === variablesRound) variablesLoading.value = false;
    }
    const historyOk = await loadHistory();
    if (historyRoundAt !== historyRound) return;
    historyLoadFailed.value = !historyOk;
  },
  { immediate: true },
);

/**
 * 把界面上的行整表写回
 *
 * 每次改动都整表提交（与规则配置的写入形态一致），因此没有「忘了保存」这个状态。
 * 校验不过就**一个都不写**：只存下一半凭据比全都没存更难发现。
 * 两端空白由后台再裁一次，两侧判据同源（`utils/variables.ts`）。
 *
 * @returns 这一笔是否真的落盘（删除方据此决定要不要把行放回去）
 */
async function commitVariables(): Promise<boolean> {
  // 闸门说的是「还没有成功读到」：读失败与还在路上是同一件事的两面，整表覆盖写在这两种情况下
  // 都会把用户已有的凭据抹掉。界面上这一节整体禁写，这里再兜一次——这条路径丢的是凭据
  if (variablesLocked.value) {
    ElMessage.error(t('variablesWriteBlocked'));
    return false;
  }
  const next: VariableStore = {};
  for (const row of variableRows.value) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name && !value) continue;
    if (!isVariableName(name)) {
      ElMessage.warning(t('variableNameInvalid'));
      return false;
    }
    if (!value) {
      ElMessage.warning(t('variableValueRequired', name));
      return false;
    }
    // 「重名」只问这张表自己的键：`constructor` 是合法变量名，裸下标会顺原型链在**第一行**
    // 就判成重复，于是这个名字永远存不进去
    if (Object.prototype.hasOwnProperty.call(next, name)) {
      ElMessage.warning(t('variableNameDuplicate', name));
      return false;
    }
    next[name] = value;
  }

  const result = await saveVariables(next);
  if (!result.success) {
    ElMessage.error(t('variablesSaveFailed'));
    return false;
  }
  if (result.dropped > 0) {
    ElMessage.warning(t('variablesDropped', result.dropped));
    // 后台丢掉了条目，此刻 `variables` 只是界面的 `next`，不是后台的真值：回读一次再回填，
    // 否则被丢的那几行会一直画成「已保存」；读不到就把闸门重新落下，下一次提交不许再拿它覆盖写
    if (await loadVariables()) {
      refillRows(variables.value);
    } else {
      variablesLoadFailed.value = true;
    }
    return true;
  }
  // 回填一次：把「两端空白被裁掉」「未填完的行不算存进去」如实反映到界面（判据在后台，
  // 界面只负责说真话），已有行的 key 不变，见 refillRows 的注释
  refillRows(variables.value);
  return true;
}

// ─── 站点生效范围（名单与档位；判据在 `utils/siteScope.ts`） ────────────────────
/**
 * 与凭据变量表同一族纪律：这一节也是**整包覆盖写**，所以「还没读到」与「读失败」都要挡住写入。
 * 空名单不等于「用户没有站点要排除」——它可能是这一次没读到；在没有读数的时候写回空名单，
 * 就是替用户把他在弹窗里一台台关掉的设置抹掉。
 */
const siteState = ref<SiteState>({ ...DEFAULT_SITE_STATE });
const siteScopeUnreadable = ref(true);

async function loadSiteScope() {
  try {
    const state: unknown = await chrome.runtime.sendMessage({ type: 'GET_SITE_STATE' });
    if (!state || typeof state !== 'object') {
      siteScopeUnreadable.value = true;
      return;
    }
    siteState.value = sanitizeSiteState(state);
    siteScopeUnreadable.value = false;
  } catch {
    siteScopeUnreadable.value = true;
  }
}

/** 写完一律回读：storage 里现在是什么，界面就画什么，不拿「我刚提交的那份」当真值 */
async function writeSiteScope(next: SiteState) {
  if (siteScopeUnreadable.value) return;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'SET_SITE_STATE',
      data: { mode: next.mode, hosts: next.hosts },
    })) as { success?: boolean } | undefined;
    if (!response?.success) ElMessage.error(t('siteScopeSaveFailed'));
  } catch {
    ElMessage.error(t('siteScopeSaveFailed'));
  }
  await loadSiteScope();
}

function changeSiteMode(mode: SiteScopeMode) {
  // 选「仅列出的站点」而名单是空的：那是一台都不代理，几乎不可能是用户的意思，界面不替他按下去
  if (mode === 'site-only' && siteState.value.hosts.length === 0) {
    ElMessage.warning(t('siteScopeEmpty'));
    return;
  }
  void writeSiteScope({ mode, hosts: siteState.value.hosts });
}

function removeSiteHost(host: string) {
  void writeSiteScope(withoutHost(siteState.value, host));
}

/**
 * 商店评分页地址；不是从 Chrome 商店装的构建就是空串，那一格整个不出现
 *
 * 解包加载（开发者模式、把 zip 拖进扩展页）没有 `update_url`；Edge 加载项、自建 XML、企业策略
 * 那种虽然也有，但 ID 属于别的商店。两种情况下那条链接都是 404——与其画一个点开了错误页的按钮，
 * 不如什么都不画。判据与 URL 形状都在 `utils/storePage.ts`。
 */
const reviewUrl = isStoreInstalled(chrome.runtime.getManifest().update_url) ? storeReviewUrl(chrome.runtime.id) : '';

/** 只开一个标签页：不写 storage、不发任何消息、也不知道用户点没点（本扩展没有任何遥测） */
function openReviewPage() {
  if (!reviewUrl) return;
  void chrome.tabs.create({ url: reviewUrl });
}

function addVariable() {
  variableRows.value.push({ uid: ++rowUidSeed, name: '', value: '' });
}

async function removeVariable(index: number) {
  const row = variableRows.value[index];
  if (!row) return;
  const used = usageCount(row.name);
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
  // 行先摘掉，整表写才是「删掉之后的样子」；写没成就要放回原位——界面说「已删除」
  // 而存储里那把凭据还在，比删不掉更糟（以后每次请求仍在用一把用户以为没了的凭据）
  if (!(await commitVariables())) {
    variableRows.value.splice(Math.min(index, variableRows.value.length), 0, row);
  }
}

/**
 * 下拉换档：只写 storage，重建倒计时由后台的 `storage.onChanged` 接手（`utils/autoOff.ts` 文件头）。
 * 这一屏没有倒计时读数，所以不必像弹窗那样把落点轮询回来。
 *
 * 从前这里写失败只记日志——用户看见下拉停在新值上，存储里却还是旧的时长，到期时间照旧。
 * 现在回滚选中项并报错，与本页凭据表那一份「失败就说失败」同一条规矩。
 */
async function handleAutoOffChange(val: string | number) {
  const minutes = Number(val) || 0;
  const previous = autoOffMinutes.value;
  autoOffMinutes.value = minutes;
  if (await writeAutoOffMinutes(minutes)) return;
  autoOffMinutes.value = previous;
  ElMessage.error(t('autoOffSaveFailed'));
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
/* 站点名单：与快捷键那一节同宽，条目按行排，主机名可选中复制 */
.site-scope-modes {
  margin-top: 4px;
}

.site-scope-list {
  padding: 0;
  margin: 8px 0 0;
  list-style: none;
}

.site-scope-item {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0;
  font-size: 13px;
}

.site-scope-item code {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--cop-text-color-primary);
  white-space: nowrap;
}

.site-scope-empty,
.site-scope-hint,
.site-scope-warning,
.rating-desc {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--cop-text-color-secondary);
}

.rating-desc {
  margin-bottom: 10px;
}

.site-scope-warning {
  color: var(--el-color-warning, #e6a23c);
}

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
  border: 2px solid transparent;
  border-radius: 50%;

  /* 悬停抬升与描边：与空态卡片、档案卡同一档、同一对缓动——这一格正是触发整页换肤淡入的那个
     按钮，它自己的反馈如果还停在 `0.2s ease`，就和这一屏其余走令牌的悬浮控件差着一档。 */
  transition:
    transform var(--cop-duration-fast) var(--cop-ease-enter),
    box-shadow var(--cop-duration-fast) var(--cop-ease-standard);
}

.theme-swatch:hover {
  box-shadow: 0 2px 8px rgb(var(--cop-primary-rgb) / 25%);
  transform: scale(1.12);
}

/* 焦点环走 outline，不走 box-shadow：`.theme-swatch.active` 与 `.theme-swatch:focus-visible`
   的特异度相同（都是两个类级选择器），而 `.active` 写在后面，于是它那条 box-shadow 把焦点环
   整条盖掉——键盘用户打开设置框时焦点恰好停在「当前主题」那一格，焦点就此完全看不见
   （WCAG 2.4.7）。outline 是「焦点」这件事自己的属性，选中态不会来抢，也就与源码顺序无关；
   基础规则里那句 `outline: none`（正是它连 UA 默认环一起关掉的）也一并删了。
   偏移给到 5px 而不是 2px：`.active` 那圈的外沿正落在 2–4px，而它的颜色就是这一格自己的主题色
   （`color: opt.swatch`），焦点环压在同一圈上等于用同一种颜色画同一条线——默认主题那一格当场看不见。 */
.theme-swatch:focus-visible {
  outline: 2px solid var(--cop-primary);
  outline-offset: 5px;
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
