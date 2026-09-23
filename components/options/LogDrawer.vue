<template>
  <el-drawer
    :model-value="visible"
    :title="t('tabLogs')"
    direction="rtl"
    size="720px"
    class="log-drawer"
    @close="handleDrawerClose"
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
            <!-- 与规则表单的方法下拉同源（HTTP_METHODS）：写死四项会让 PATCH / OPTIONS / HEAD
                 的请求在列表里看得见却筛不出来，而这三类恰是预检与探活的高频方法 -->
            <el-option
              v-for="method in HTTP_METHODS"
              :key="method"
              :label="method"
              :value="method"
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
            <el-option
              :label="t('statusFailed')"
              value="error"
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
        <div class="toolbar-right">
          <el-select
            v-if="autoRefresh"
            :model-value="refreshInterval"
            :placeholder="t('refreshInterval')"
            style="width: 110px"
            @update:model-value="
              (val: string | number | undefined) =>
                emit('update:refreshInterval', Number(val ?? REFRESH_INTERVAL_PRESETS[0].value))
            "
          >
            <el-option
              v-for="preset in REFRESH_INTERVAL_PRESETS"
              :key="preset.value"
              :label="preset.label"
              :value="preset.value"
            />
          </el-select>
          <el-switch
            :model-value="autoRefresh"
            :active-text="t('autoRefresh')"
            @change="val => $emit('refresh', val as boolean)"
          />
        </div>
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
          {{ dnrStatsEmptyText }}
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
            <el-tag
              v-else-if="row.error"
              type="danger"
              size="small"
            >
              {{ t('statusFailed') }}
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
              <!-- 只在真有凭据头时出现，且关掉抽屉就回到打码态 -->
              <el-switch
                v-if="hasSensitiveHeaders"
                v-model="revealSensitive"
                size="small"
                :active-text="t('revealSensitive')"
              />
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
            <el-tag
              v-else-if="selectedLog.error"
              type="danger"
              size="small"
              >{{ t('statusFailed') }}</el-tag
            >
            <span class="log-detail-rule">{{ selectedLog.ruleName }}</span>
            <span
              v-if="selectedLog.duration"
              class="log-detail-duration"
              >{{ selectedLog.duration }}ms</span
            >
          </div>

          <!-- 失败原因提到标签页之外：它此前只出现在「响应」页，而行点击会把
               detailTab 重置回「请求」，导致真正的原因永远要点一次才看得到 -->
          <div
            v-if="selectedLog.error"
            class="detail-section detail-section--error"
          >
            <div class="detail-section-label detail-error-label">{{ t('detailError') }}</div>
            <code class="detail-error-msg">{{ selectedLog.error }}</code>
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
                    <span class="detail-header-val">{{ displayHeaderValue(key, value) }}</span>
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
                v-if="selectedLog.responseHeaders && Object.keys(selectedLog.responseHeaders).length > 0"
                class="detail-section"
              >
                <div class="detail-section-label">{{ t('detailResponseHeaders') }}</div>
                <div class="detail-headers">
                  <div
                    v-for="(value, key) in selectedLog.responseHeaders"
                    :key="key"
                    class="detail-header-row"
                  >
                    <span class="detail-header-key">{{ key }}</span>
                    <span class="detail-header-val">{{ displayHeaderValue(key, value) }}</span>
                  </div>
                </div>
              </div>
              <div
                v-if="selectedLog.responseBody"
                class="detail-section"
              >
                <div class="detail-section-label">{{ t('detailResponseBody') }}</div>
                <pre class="detail-body-content">{{ formatBody(selectedLog.responseBody) }}</pre>
              </div>
              <div
                v-if="selectedLog.responseIsBase64"
                class="detail-empty"
              >
                {{ t('detailBodyBinary') }}
              </div>
              <div
                v-if="!selectedLog.responseHeaders && !selectedLog.responseBody && !selectedLog.responseIsBase64"
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
import { computed, ref, watch, onUnmounted } from 'vue';
import { Delete, Document, CopyDocument, Refresh, Close, Plus } from '@element-plus/icons-vue';
import { ElMessageBox, ElMessage } from 'element-plus';
import type { RequestLogEntry, DnrHitStat } from '@/utils/types';
import { HTTP_METHODS } from '@/utils/types';
import type { DnrSampleState } from '@/utils/dnrSample';
import { useI18n } from '@/composables/useI18n';
import { computeLogStats } from '@/utils/ruleStats';
import { isSensitiveHeaderName } from '@/utils/exportSanitize';
import { resolveHeaderDisplayValue } from '@/utils/headerMask';
import { REFRESH_INTERVAL_PRESETS } from '@/composables/useRequestLog';
import { formatLocaleDateTime } from '@/utils/formatters';

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
  refreshInterval: number;
  dnrStats: DnrHitStat[];
  /** 最近一次网络层采样的状态：空列表要分成「零命中」「没有读数」「无生效规则」三句话说 */
  dnrStatsState: DnrSampleState;
  swStats: DnrHitStat[];
  methodFilter: string;
  statusFilter: string;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  'update:methodFilter': [value: string];
  'update:statusFilter': [value: string];
  'update:refreshInterval': [value: number];
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

/**
 * 命中列表为空时该说哪一句。
 *
 * 四条文案对应四种事实：真的没人命中、这一批根本没有网络层规则、读不到、
 * 以及拿到的是退避期沿用的上次样本——最后这种「0」只是上次那一批里没有，
 * 不能和 `fresh` 共用一句有把握的「近 5 分钟无 DNR 命中」。
 * 只靠 `dnrStats.length === 0` 会把后三种都说成「无命中」。
 * `statsNotApplicable` / `statsUnavailable` / `statsMayLag` 住在 popup 命名空间：i18n 构建期把
 * 三个命名空间扁平合并，同一件事全仓用同一个词（同 `dnrSkippedTag` 的先例）。
 * 陈旧那句之所以不带窗口口径，是因为 `dnrStatsEmpty` 自己已经写了「近 5 分钟」。
 */
const dnrStatsEmptyText = computed(() => {
  if (props.dnrStatsState === 'notApplicable') return t('statsNotApplicable');
  if (props.dnrStatsState === 'pending' || props.dnrStatsState === 'unavailable') return t('statsUnavailable');
  if (props.dnrStatsState === 'stale') return `${t('dnrStatsEmpty')} · ${t('statsMayLag')}`;
  return t('dnrStatsEmpty');
});

const filteredLogs = computed(() => {
  const keyword = urlKeyword.value.toLowerCase();
  return props.logs.filter(log => {
    const matchesMethod = !props.methodFilter || log.method === props.methodFilter;
    const matchesStatus =
      !props.statusFilter ||
      (props.statusFilter === '2xx' && log.status! >= 200 && log.status! < 300) ||
      (props.statusFilter === '4xx' && log.status! >= 400 && log.status! < 500) ||
      (props.statusFilter === '5xx' && log.status! >= 500) ||
      // 代理失败不带状态码，三档数字区间都圈不住它，单列一档按 error 判定
      (props.statusFilter === 'error' && !!log.error);
    const matchesRule = !ruleFilter.value || log.ruleName === ruleFilter.value;
    const matchesUrl =
      !keyword || log.originalUrl.toLowerCase().includes(keyword) || log.proxiedUrl.toLowerCase().includes(keyword);
    return matchesMethod && matchesStatus && matchesRule && matchesUrl;
  });
});

// 统计（基于筛选后的数据，单次遍历）
const logStats = computed(() => computeLogStats(filteredLogs.value));

// ─── 新到日志的落位提示 ──────────────────────────────────────────────────────

/**
 * 抽屉**开着**的时候刚落进来的那几条日志 id（用于给行加一次性强调）
 *
 * 自动刷新把新行加在表格顶部（`storage.ts` 的 unshift 已保证同批不倒序），但行数在变、
 * 眼睛未必跟得上，这一闪说的是「就是这一条」。两种刻意不动的时候：
 * - 抽屉没开：那一屏没人在看。所以这份账在关着的时候也照记不误，开抽屉那一刻屏幕上的
 *   每一条都已经是「旧数据」，不会补闪一堆；
 * - 这一批里没有新 id：只数数组长度会把「换了筛选」「同一批被重新推来」都算成新增，
 *   而 id 是每条请求独有的（`generateId`），差出来的一定是刚发生的那一笔。
 * 判据按 id 集合做差而不是监听 `props.visible`：这个文件被 `tests/full-verification.test.ts`
 * 钉为「纯受控组件、不得有 visible watcher」（它的数据由 App.vue 拉），别绕着正则改写法躲守卫。
 * 减弱动效下这一闪被 `tokens.css` 的降级段落压成 0.01ms，而信息不会丢：最新那条本来就在最上面。
 */
const freshLogIds = ref<Set<string>>(new Set());
/** 上一次看到的这一屏日志 id；只在 watcher 里换，不参与渲染 */
let knownIds = new Set<string>();
/** 这一屏的第一份账只对齐、不点亮：初始加载会让整列「全都是新的」，那不是刚刚发生 */
let primed = false;
let freshTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.logs,
  logs => {
    const current = new Set(logs.map(log => log.id));
    if (!props.visible) {
      knownIds = current;
      primed = false;
      return;
    }
    const arrived = primed ? [...current].filter(id => !knownIds.has(id)) : [];
    knownIds = current;
    primed = true;
    if (arrived.length === 0) return;
    // 并集而不是覆盖：上一批还在闪的，不必被这一批提前掐掉
    freshLogIds.value = new Set([...freshLogIds.value, ...arrived]);
    if (freshTimer) clearTimeout(freshTimer);
    // 到点摘掉类名：el-table 之后因排序/筛选重建行时，不该把旧行再点亮一遍
    freshTimer = setTimeout(() => {
      freshLogIds.value = new Set();
      freshTimer = null;
    }, 900);
  },
);

onUnmounted(() => {
  if (freshTimer) clearTimeout(freshTimer);
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

/** 时间格式随界面语言切换（判据收在 `utils/formatters`，与快照列表、恢复点同一路） */
function formatTime(ts: number): string {
  return formatLocaleDateTime(ts, locale.value);
}

function truncateUrl(url: string, maxLen = 50): string {
  if (!url) return '-';
  return url.length > maxLen ? url.substring(0, maxLen) + '...' : url;
}

/** HTTP 方法 → el-tag 类型（静态映射，模块级避免逐行重建） */
const METHOD_TAG_TYPES: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
  GET: 'primary',
  POST: 'success',
  PUT: 'warning',
  DELETE: 'danger',
};

function methodTagType(method: string) {
  return METHOD_TAG_TYPES[method] || 'info';
}

function statusTagType(status: number) {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 400 && status < 500) return 'warning';
  if (status >= 500) return 'danger';
  return 'info';
}

function rowClassName({ row }: { row: RequestLogEntry }): string {
  // 两个类各说一件事：`error-row` 是这一笔的结果，`log-row-new` 是「它刚刚才到」
  return [row.error ? 'error-row' : '', freshLogIds.value.has(row.id) ? 'log-row-new' : ''].filter(Boolean).join(' ');
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

/**
 * 「本次会话显示凭据原值」开关，默认关。
 *
 * 只活在组件实例上，不落 storage：详情面板画的是**真实站点的** Cookie / Authorization，
 * 投屏、录屏、贴截图都会把它带出去，所以默认打码；而排障时确实要对一眼 token 尾号，
 * 于是给一个显式、临时、关掉抽屉就失效的出口。刻意不提供「永久显示」——那种开关会被忘掉。
 */
const revealSensitive = ref(false);

/** 当前这条日志里是否有需要打码的头；没有就不把开关画出来吓人 */
const hasSensitiveHeaders = computed(() => {
  const log = selectedLog.value;
  if (!log) return false;
  const names = [...Object.keys(log.requestHeaders ?? {}), ...Object.keys(log.responseHeaders ?? {})];
  return names.some(name => isSensitiveHeaderName(name));
});

function displayHeaderValue(name: string, value: string): string {
  return resolveHeaderDisplayValue(name, value, revealSensitive.value);
}

// 关抽屉即收回原值：下次打开是打码态，而不是「上次为了排障打开过」。
// 挂在 el-drawer 的 `close`（Element Plus 在 `beforeLeave` 里 emit，父组件把 model-value
// 置 false 那条路径同样会走）而不是 `props.visible` 的 watcher 上——本组件在
// tests/full-verification.test.ts 的「无 visible watcher」清单里，那个契约不许它长出一个。
function handleDrawerClose() {
  revealSensitive.value = false;
  emit('update:visible', false);
}

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

/**
 * 复制为可运行的 cURL
 *
 * 这里**刻意用原值**、不受面板打码影响：一条 `-H 'Authorization: ••••'` 的命令没有意义，
 * 而这个动作是用户点了「复制为 cURL」才发生的本机剪贴板写入，与「屏幕上一打开就是明文」
 * 不是同一件事。要跨人分享请走 HAR 的分享模式（那里才会整条摘掉凭据头）。
 */
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

.toolbar-right {
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

/* 刚落进来的那一行闪一下：只动背景，不加边框也不改行高，表格布局纹丝不动。
   900ms 后类名被摘掉，所以这一出只会播一次，滚动回看旧行时不会被重新点亮。 */
.log-table :deep(.log-row-new) {
  animation: log-row-arrive 0.7s ease-out;
}

@keyframes log-row-arrive {
  from {
    background-color: rgb(var(--cop-primary-rgb) / 16%);
  }
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

/* 错误区块位于摘要行与标签页之间：只需要与上方摘要的间距，下方由标签页 own */
.detail-section--error {
  margin-top: 10px;
  margin-bottom: 0;
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
