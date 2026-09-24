<template>
  <div class="rule-table-card">
    <!-- 空状态引导（无任何规则时） -->
    <EmptyGuide
      v-if="rules.length === 0 && !hasAnyRules"
      @add-rule="$emit('add')"
      @import-config="$emit('importConfig')"
      @use-template="data => $emit('useTemplate', data)"
    />

    <!-- 筛选无结果 -->
    <div
      v-else-if="rules.length === 0"
      class="no-match"
    >
      <p>{{ t('noMatch') }}</p>
    </div>

    <!-- 规则表格 -->
    <el-table
      v-else
      ref="tableRef"
      v-loading="loading"
      :data="rules"
      :row-class-name="rowClassName"
      row-key="id"
      class="rule-table"
      @selection-change="(selection: ProxyRule[]) => $emit('selectionChange', selection)"
      @dragover.prevent="onTableDragOver"
      @drop.prevent="onTableDrop"
    >
      <el-table-column
        type="selection"
        width="48"
        :reserve-selection="true"
      />
      <el-table-column
        width="36"
        align="center"
      >
        <template #header>
          <el-tooltip
            :content="t('dragToReorder')"
            placement="top"
          >
            <span class="drag-header-icon">⠿</span>
          </el-tooltip>
        </template>
        <template #default="{ row }">
          <span
            class="drag-handle"
            draggable="true"
            @dragstart="onDragStart($event, row)"
            @dragend="onDragEnd"
            >⠿</span
          >
        </template>
      </el-table-column>
      <el-table-column
        prop="name"
        :label="t('colName')"
        min-width="120"
      >
        <template #default="{ row }">
          <span class="rule-name-cell">
            <HighlightText
              :text="row.name"
              :keyword="searchText"
              :title="row.name"
            />
            <el-tooltip
              v-if="shadowedRuleIds.has(row.id)"
              :content="t('conflictWarningTitle')"
              placement="top"
            >
              <span class="shadowed-indicator">!</span>
            </el-tooltip>
            <el-tooltip
              v-if="dnrSkipReason(row.id)"
              placement="top"
            >
              <template #content>
                <div class="dnr-skip-tip">
                  <p
                    v-for="(line, index) in skipReasonLines(dnrSkipReason(row.id))"
                    :key="index"
                  >
                    {{ line }}
                  </p>
                </div>
              </template>
              <span class="dnr-dead-tag">{{ t('dnrSkippedTag') }}</span>
            </el-tooltip>
            <span class="rule-badges">
              <el-tooltip
                v-if="showsHttpOnlyBadge(row) && row.headerOverrides && Object.keys(row.headerOverrides).length > 0"
                :content="t('hasHeaderOverrides')"
                placement="top"
              >
                <span class="rule-badge rule-badge--h">H</span>
              </el-tooltip>
              <el-tooltip
                v-if="showsHttpOnlyBadge(row) && row.sendCredentials === true"
                :content="t('hasSendCredentials')"
                placement="top"
              >
                <span class="rule-badge rule-badge--c">C</span>
              </el-tooltip>
              <el-tooltip
                v-if="showsHttpOnlyBadge(row) && row.requestBodyOverride"
                :content="t('hasBodyOverride')"
                placement="top"
              >
                <span class="rule-badge rule-badge--b">B</span>
              </el-tooltip>
              <el-tooltip
                v-if="showsHttpOnlyBadge(row) && row.responseOverrides"
                :content="t('hasResponseOverrides')"
                placement="top"
              >
                <span class="rule-badge rule-badge--r">R</span>
              </el-tooltip>
              <el-tooltip
                v-if="showsHttpOnlyBadge(row) && row.mockResponse"
                :content="t('hasMockResponse')"
                placement="top"
              >
                <span class="rule-badge rule-badge--m">M</span>
              </el-tooltip>
              <el-tooltip
                v-if="showsHttpOnlyBadge(row) && row.delayMs"
                :content="t('hasDelay')"
                placement="top"
              >
                <span class="rule-badge rule-badge--d">D</span>
              </el-tooltip>
              <el-tooltip
                v-if="row.blocked"
                :content="t('hasBlocked')"
                placement="top"
              >
                <span class="rule-badge rule-badge--x">X</span>
              </el-tooltip>
              <el-tooltip
                v-if="showsHttpOnlyBadge(row) && row.retryCount"
                :content="t('hasRetry')"
                placement="top"
              >
                <span class="rule-badge rule-badge--re">Re</span>
              </el-tooltip>
              <el-tooltip
                v-if="isWsRule(row)"
                :content="t('wsRuleHint')"
                placement="top"
              >
                <span class="rule-badge rule-badge--ws">WS</span>
              </el-tooltip>
            </span>
          </span>
        </template>
      </el-table-column>
      <el-table-column
        prop="matchPattern"
        :label="t('colMatchPattern')"
        min-width="200"
      >
        <template #default="{ row }">
          <HighlightText
            :text="row.matchPattern"
            :keyword="searchText"
            :title="row.matchPattern"
          />
        </template>
      </el-table-column>
      <el-table-column
        prop="matchType"
        :label="t('colMatchType')"
        width="100"
        align="center"
      >
        <template #default="{ row }">
          <el-tag
            :type="matchTypeTagType(row.matchType)"
            size="small"
          >
            {{ matchTypeLabel(row.matchType) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column
        prop="targetUrl"
        :label="t('colTargetUrl')"
        min-width="200"
      >
        <template #default="{ row }">
          <HighlightText
            :text="row.targetUrl"
            :keyword="searchText"
            :title="row.targetUrl"
          />
        </template>
      </el-table-column>
      <el-table-column
        prop="priority"
        :label="t('colPriority')"
        width="80"
        align="center"
      />
      <el-table-column
        :label="t('hitCountLabel')"
        width="96"
        align="center"
      >
        <template #default="{ row }">
          <span
            v-if="hitCells[row.id]"
            class="hit-stats-pair"
          >
            <el-tooltip
              :content="hitCells[row.id].netTip"
              placement="top"
            >
              <span :class="['hit-count-badge', hitCells[row.id].netUnknown && 'hit-count-unknown']">
                {{ hitCells[row.id].net }}
              </span>
            </el-tooltip>
            <el-tooltip
              :content="hitCells[row.id].extTip"
              placement="top"
            >
              <span
                :class="['hit-count-badge', 'hit-count-badge--ext', hitCells[row.id].extUnknown && 'hit-count-unknown']"
              >
                {{ hitCells[row.id].ext }}
              </span>
            </el-tooltip>
          </span>
          <span
            v-else
            class="hit-count-zero"
            >-</span
          >
        </template>
      </el-table-column>
      <el-table-column
        :label="t('colStatus')"
        width="80"
        align="center"
      >
        <template #default="{ row }">
          <el-switch
            :model-value="row.enabled"
            size="small"
            @change="val => $emit('toggle', row.id, val as boolean)"
          />
        </template>
      </el-table-column>
      <el-table-column
        :label="t('colActions')"
        width="140"
        align="center"
        header-align="center"
        fixed="right"
      >
        <template #default="{ row }">
          <div class="row-actions">
            <el-tooltip
              :content="t('edit')"
              placement="top"
              :show-after="400"
            >
              <el-button
                circle
                size="small"
                :icon="EditPen"
                @click="$emit('edit', row)"
              />
            </el-tooltip>
            <el-tooltip
              :content="t('duplicateRule')"
              placement="top"
              :show-after="400"
            >
              <el-button
                circle
                size="small"
                :icon="CopyDocument"
                @click="$emit('duplicate', row)"
              />
            </el-tooltip>
            <el-popconfirm
              :title="t('confirmDeleteRule')"
              :confirm-button-text="t('confirm')"
              :cancel-button-text="t('cancel')"
              @confirm="handleDelete(row)"
            >
              <template #reference>
                <el-button
                  circle
                  size="small"
                  type="danger"
                  plain
                  :icon="Delete"
                />
              </template>
            </el-popconfirm>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { EditPen, CopyDocument, Delete } from '@element-plus/icons-vue';
import type { ProxyRule } from '@/utils/types';
import type { TableInstance } from 'element-plus';
import type { DnrSkipReason } from '@/utils/dnrSupport';
import type { RuleHitStats } from '@/utils/ruleStats';
import { isDnrCountReadable, type DnrSampleState } from '@/utils/dnrSample';
import { useI18n } from '@/composables/useI18n';
import { useDnrSkipText } from '@/composables/useDnrSupport';
import { isSimpleRule, isWebSocketRule } from '@/utils/urlMatcher';
import EmptyGuide from './EmptyGuide.vue';
import HighlightText from './HighlightText.vue';

/**
 * 规则表格（白色圆角卡片容器）
 *
 * 展示型组件：搜索/筛选已上移到 SearchFilterBar，本组件只接收筛选后的规则。
 * 交互签名：circle 小按钮 + 400ms 延迟 tooltip、新增行下落动画、删除行右滑出屏。
 */
const props = defineProps<{
  /** 筛选后的规则列表 */
  rules: ProxyRule[];
  loading: boolean;
  hasAnyRules: boolean;
  /** 最近新增规则 id（进场动画用） */
  highlightRuleId?: string | null;
  /** 搜索关键字（用于高亮） */
  searchText: string;
  /** 规则命中统计（ruleId → 分通道读数，**不相加**） */
  hitStats: Map<string, RuleHitStats>;
  /** 网络层采样的五态：决定那一格画数字、「—」还是提示「不知道 / 没有这类规则」 */
  dnrStatsState: DnrSampleState;
  /** 被更高优先级同模式规则遮蔽的规则 ID 集合 */
  shadowedRuleIds: Set<string>;
  /** 走 DNR 通道但不会被浏览器应用的规则（ruleId → 原因） */
  dnrSkippedRules: Map<string, DnrSkipReason>;
}>();

const emit = defineEmits<{
  add: [];
  edit: [rule: ProxyRule];
  duplicate: [rule: ProxyRule];
  delete: [ruleId: string];
  toggle: [ruleId: string, enabled: boolean];
  importConfig: [];
  selectionChange: [selection: ProxyRule[]];
  useTemplate: [ruleData: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>];
  reorder: [fromId: string, toId: string];
}>();

const { t } = useI18n();
const { skipReasonLines } = useDnrSkipText();

/**
 * 命中列的两枚读数（分通道，**不相加**：网络层是近 5 分钟滚动窗口，扩展通道是自
 * 上次配置变更或后台重启以来的累计，相加出来的数不属于任何一段时间）。
 *
 * 每格只画属于自己那条通道的数：走网络层的规则，后台那一格永远是 0，而那个 0 不是
 * 「一次都没走后台」，是「这条规则根本不在后台执行」——反向同理。所以两格各自先问
 * 「该不该有读数」，再问「读到了没有」；全局采样状态只决定网络层那一格读没读到。
 * 只收录「至少说得出一个数」的规则：两格都是「—」时维持原来的「-」，避免整列噪音。
 */
const hitCells = computed(() => {
  const state = props.dnrStatsState;
  const readable = isDnrCountReadable(state);
  const netTipByState =
    state === 'notApplicable'
      ? t('statsNotApplicable')
      : state === 'stale'
        ? t('hitStatsStale')
        : readable
          ? t('hitStatsNetTip')
          : t('statsUnavailable');
  const channelById = new Map(props.rules.map(rule => [rule.id, isSimpleRule(rule)] as const));

  const cells: Record<
    string,
    { net: string; ext: string; netTip: string; extTip: string; netUnknown: boolean; extUnknown: boolean }
  > = {};
  for (const [ruleId, stat] of props.hitStats) {
    // 不在当前列表里的规则（已删或被筛掉）不会渲染，判不了通道就按扩展通道处理
    const onNet = channelById.get(ruleId) ?? false;
    const netUnknown = !onNet || !readable;
    const extUnknown = onNet;
    // 三条 `continue` 问的不是同一件事：这条问「这一行说得出话吗」，下面两条问「有没有一个
    // 非零的数可看」。少了这条，网络层规则在采样读不到、后台计数又非零时画出 `— —`——
    // 两个破折号并排，比折叠成的「-」更像故障。
    if (netUnknown && extUnknown) continue;
    if (!readable && stat.ext === 0) continue;
    if (readable && stat.net === 0 && stat.ext === 0) continue;
    cells[ruleId] = {
      net: netUnknown ? '—' : String(stat.net),
      ext: extUnknown ? '—' : String(stat.ext),
      netTip: onNet ? netTipByState : t('hitStatsNetNotApplicable'),
      extTip: onNet ? t('hitStatsExtNotApplicable') : t('hitStatsExtTip'),
      netUnknown,
      extUnknown,
    };
  }
  return cells;
});

/**
 * 表格实例：选择列开了 `reserve-selection`，勾选因此存活在表格内部而不是随 data 重建，
 * 父组件置空 `selectedRules` 并不会清掉保留的勾选。规则集被整体替换（批量删除 /
 * 导入 / 加载环境配置）时必须调用 {@link clearSelection}，否则批量操作会作用在
 * 当前筛选下看不见的规则上。
 */
const tableRef = ref<TableInstance>();

/** 清空全部勾选（含被筛选隐藏的保留项），供父组件在整体替换规则后调用 */
function clearSelection(): void {
  tableRef.value?.clearSelection();
}

defineExpose({ clearSelection });

/**
 * 「筛选无结果」时 `v-else` 会把整个表格卸载，存活在表格内部的保留勾选随之丢失，
 * 而父组件还拿着上一份选中项。表格分支只在 `rules.length > 0` 时存在，故直接监听
 * 这个渲染条件：翻转成「不渲染」后补发一次空选择，避免计数与真实勾选分叉。
 * （`RuleTable` 在 App 里常驻，只靠 `onBeforeUnmount` 守不住筛选这条路径。）
 */
watch(
  () => props.rules.length > 0,
  (rendered, wasRendered) => {
    if (!rendered && wasRendered) emit('selectionChange', []);
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  emit('selectionChange', []);
});

/** 该规则是否会被 DNR 同步跳过（返回原因，undefined 表示可正常应用） */
function dnrSkipReason(ruleId: string): DnrSkipReason | undefined {
  return props.dnrSkippedRules.get(ruleId);
}

/** matchType → el-tag 类型（静态映射，模块级避免逐行重建） */
const MATCH_TYPE_TAG_TYPES: Record<string, 'primary' | 'success' | 'warning' | 'info'> = {
  wildcard: 'primary',
  prefix: 'success',
  regex: 'warning',
};

/** 正在播放删除动画的行 id 集合 */
const leavingIds = ref<Set<string>>(new Set());

/** 拖拽中的行 id */
const dragFromId = ref<string | null>(null);
/** 拖拽悬停的目标行 id（高亮用） */
const dragOverId = ref<string | null>(null);

function onDragStart(e: DragEvent, row: ProxyRule) {
  dragFromId.value = row.id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.id);
  }
}

function onDragEnd() {
  dragFromId.value = null;
  dragOverId.value = null;
}

/** 从拖拽事件目标向上找到所属行数据（事件委托，整行可作为放置目标） */
function findRowFromEvent(e: DragEvent): ProxyRule | null {
  const target = e.target as HTMLElement;
  const tr = target.closest('tr.el-table__row');
  if (tr) {
    const tbody = tr.closest('tbody');
    if (!tbody) return null;
    const rows = Array.from(tbody.querySelectorAll('tr.el-table__row'));
    const index = rows.indexOf(tr);
    return props.rules[index] ?? null;
  }
  // 拖到最后一行下方的空白区域时，回退到最后一行
  const tbody = target.closest('tbody');
  if (tbody && props.rules.length > 0) {
    return props.rules[props.rules.length - 1];
  }
  return null;
}

function onTableDragOver(e: DragEvent) {
  const row = findRowFromEvent(e);
  const newId = row && row.id !== dragFromId.value ? row.id : null;
  if (newId !== dragOverId.value) {
    dragOverId.value = newId;
  }
}

function onTableDrop(e: DragEvent) {
  const toRow = findRowFromEvent(e);
  if (dragFromId.value && toRow && dragFromId.value !== toRow.id) {
    emit('reorder', dragFromId.value, toRow.id);
  }
  dragFromId.value = null;
  dragOverId.value = null;
}

/** 删除：先播放右滑出屏动画，再真正移除 */
function handleDelete(rule: ProxyRule) {
  leavingIds.value.add(rule.id);
  window.setTimeout(() => {
    leavingIds.value.delete(rule.id);
    emit('delete', rule.id);
  }, 280);
}

function rowClassName({ row }: { row: ProxyRule }): string {
  if (leavingIds.value.has(row.id)) return 'row-leaving';
  if (props.highlightRuleId && row.id === props.highlightRuleId) return 'row-entering';
  if (dragOverId.value && row.id === dragOverId.value) return 'row-drag-over';
  return '';
}

function matchTypeTagType(matchType: string) {
  return MATCH_TYPE_TAG_TYPES[matchType] || 'info';
}

function matchTypeLabel(matchType: string) {
  const labelMap: Record<string, string> = {
    wildcard: t('matchTypeWildcard'),
    prefix: t('matchTypePrefix'),
    regex: t('matchTypeRegex'),
  };
  return labelMap[matchType] || matchType;
}

/** WebSocket 规则识别：复用 utils/urlMatcher 共享判定（与分流逻辑单一事实来源） */
function isWsRule(rule: ProxyRule): boolean {
  return isWebSocketRule(rule);
}

/**
 * 长连接的能力面只有「重写地址 / 注入查询参数 / 阻断」三项（同一句 `wsRuleHint` 说的就是它）。
 * 头、体、响应改写、Mock、延迟、重试、携带 Cookie 在握手上一律不生效，所以 WS 规则上
 * 不画这几枚徽章——否则同一行里先承诺七次、再由 WS 那一枚把话收回去。
 */
function showsHttpOnlyBadge(rule: ProxyRule): boolean {
  return !isWsRule(rule);
}
</script>

<style scoped>
.rule-table-card {
  padding: 8px;
  margin: 0 32px 32px;
  background: var(--cop-bg-color);
  border-radius: 8px;
  box-shadow: var(--cop-shadow-md);
}

.no-match {
  padding: 48px 0;
  color: var(--cop-text-color-secondary);
  text-align: center;
}

/* 表头底色跟随主题浅面色 */
.rule-table :deep(.el-table__header th) {
  color: var(--cop-text-color-regular);
  background: var(--cop-surface-2);
}

/* 行 hover 上浮 + 主题色阴影 */
.rule-table :deep(.el-table__row) {
  transition: all 0.2s ease;
}

.rule-table :deep(.el-table__row:hover) {
  box-shadow: 0 4px 12px rgb(var(--cop-primary-rgb) / 12%);
  transform: translateY(-2px);
}

/* circle 操作按钮：hover 着主题色，::after 扩大触控热区 */
.row-actions {
  display: flex;
  gap: 6px;
  justify-content: center;
}

.row-actions .el-button {
  position: relative;
  width: 28px;
  height: 28px;
  margin: 0;
}

.row-actions .el-button::after {
  position: absolute;
  inset: -5px;
  content: '';
}

/* 新增行：下落淡入 + 绿色底边 */
.rule-table :deep(.row-entering) {
  animation: row-drop-in 0.4s ease;
}

.rule-table :deep(.row-entering td) {
  border-bottom: 2px solid var(--el-color-success);
}

@keyframes row-drop-in {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 删除行：右滑出屏淡出 */
.rule-table :deep(.row-leaving) {
  opacity: 0;
  transform: translateX(60px);
  transition: all 0.28s ease;
}

/* 拖拽悬停目标行：主题色上边框提示 */
.rule-table :deep(.row-drag-over) {
  background: var(--cop-primary-bg, #ecf5ff);
}

.rule-table :deep(.row-drag-over td) {
  border-top: 2px solid var(--cop-primary, #409eff);
}

@media (width <= 768px) {
  .rule-table-card {
    margin: 0 20px 20px;
  }
}

:deep(.search-highlight) {
  padding: 0 2px;
  color: var(--cop-primary);
  background: var(--cop-primary-bg);
  border-radius: 2px;
}

/* ─── Drag Handle ─────────────────────────────────────────────────────────── */

.drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 16px;
  color: var(--cop-text-color-placeholder, #c0c4cc);
  cursor: grab;
  user-select: none;
  border-radius: 4px;
  transition: all 0.15s;
}

.drag-handle:hover {
  color: var(--cop-primary, #409eff);
  background: var(--cop-primary-bg, #ecf5ff);
}

.drag-handle:active {
  cursor: grabbing;
}

.drag-header-icon {
  font-size: 14px;
  color: var(--cop-text-color-placeholder, #c0c4cc);
  cursor: help;
}

/* ─── Rule Name Cell with Badges ──────────────────────────────────────────── */

.rule-name-cell {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.rule-badges {
  display: inline-flex;
  flex-shrink: 0;
  gap: 3px;
}

.rule-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  border-radius: 4px;
}

.rule-badge--h {
  color: var(--el-color-primary, #409eff);
  background: var(--el-color-primary-light-9, #ecf5ff);
}

/* 凭据开关是「这条规则会带走你的会话」的提醒，用中性 info 色，不与 X（阻断）抢红 */
.rule-badge--c {
  color: var(--el-color-info, #909399);
  background: var(--el-color-info-light-9, #f4f4f5);
}

.rule-badge--b {
  color: var(--el-color-warning, #e6a23c);
  background: var(--el-color-warning-light-9, #fdf6ec);
}

.rule-badge--r {
  color: var(--el-color-success, #67c23a);
  background: var(--el-color-success-light-9, #f0f9eb);
}

.rule-badge--m {
  color: var(--cop-badge-violet);
  background: var(--cop-badge-violet-bg);
}

.rule-badge--d {
  color: var(--cop-badge-cyan);
  background: var(--cop-badge-cyan-bg);
}

.rule-badge--x {
  color: var(--el-color-danger, #f56c6c);
  background: var(--el-color-danger-light-9, #fef2f2);
}

.rule-badge--re {
  color: var(--cop-badge-amber);
  background: var(--cop-badge-amber-bg);
}

/* 与 M 同色系：两者如今不会同屏出现（WS 规则不再画 M 那七枚），字母也各不一样 */
.rule-badge--ws {
  width: 20px;
  font-size: 8px;
  color: var(--cop-badge-violet);
  background: var(--cop-badge-violet-bg);
}

.hit-count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
  color: var(--el-color-primary, #409eff);
  background: var(--el-color-primary-light-9, #ecf5ff);
  border-radius: 10px;
}

/* 两条通道各一枚：网络层（DNR）用主色，扩展通道（SW）用 warning，与抽屉里的 DNR/SW 标签同色系 */
.hit-stats-pair {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}

.hit-count-badge--ext {
  color: var(--el-color-warning, #e6a23c);
  background: var(--el-color-warning-light-9, #fdf6ec);
}

/* 「不知道」不是「零次」：读不到网络层计数时画灰化的破折号 */
.hit-count-unknown {
  color: var(--el-text-color-placeholder, #c0c4cc);
  background: var(--el-fill-color-light, #f5f7fa);
}

.hit-count-zero {
  font-size: 12px;
  color: var(--el-text-color-placeholder, #c0c4cc);
}

.shadowed-indicator {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  cursor: help;
  background: var(--el-color-warning, #e6a23c);
  border-radius: 50%;
}

/* 「浏览器不会应用该规则」标记：比遮蔽标记更重，用危险色 + 文字而非仅用颜色表达 */
.dnr-dead-tag {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  height: 18px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  color: var(--el-color-danger, #f56c6c);
  cursor: help;
  background: var(--el-color-danger-light-9, #fef2f2);
  border: 1px solid var(--el-color-danger-light-7, #f5cccc);
  border-radius: 4px;
}

.dnr-skip-tip p {
  margin: 0;
  line-height: 1.6;
}

.dnr-skip-tip p + p {
  margin-top: 4px;
}
</style>
