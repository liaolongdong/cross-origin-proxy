<!-- eslint-disable vue/no-v-html -->
<template>
  <div class="rule-table-card">
    <!-- 空状态引导（无任何规则时） -->
    <EmptyGuide
      v-if="rules.length === 0 && !hasAnyRules"
      @add-rule="$emit('add')"
      @import-config="$emit('importConfig')"
      @use-template="(data) => $emit('useTemplate', data)"
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
      v-loading="loading"
      :data="rules"
      :row-class-name="rowClassName"
      row-key="id"
      class="rule-table"
      @selection-change="(selection: ProxyRule[]) => $emit('selectionChange', selection)"
    >
      <el-table-column
        type="selection"
        width="48"
      />
      <el-table-column
        width="36"
        align="center"
      >
        <template #header>
          <el-tooltip :content="t('dragToReorder')" placement="top">
            <span class="drag-header-icon">⠿</span>
          </el-tooltip>
        </template>
        <template #default="{ row }">
          <span
            class="drag-handle"
            draggable="true"
            @dragstart="onDragStart($event, row)"
            @dragend="onDragEnd"
            @dragover.prevent
            @drop="onDrop($event, row)"
          >⠿</span>
        </template>
      </el-table-column>
      <el-table-column
        prop="name"
        :label="t('colName')"
        min-width="120"
      >
        <template #default="{ row }">
          <span class="rule-name-cell">
            <span
              :title="row.name"
              v-html="highlightText(row.name, searchText)"
            />
            <span class="rule-badges">
              <el-tooltip v-if="row.headerOverrides && Object.keys(row.headerOverrides).length > 0" :content="t('hasHeaderOverrides')" placement="top">
                <span class="rule-badge rule-badge--h">H</span>
              </el-tooltip>
              <el-tooltip v-if="row.requestBodyOverride" :content="t('hasBodyOverride')" placement="top">
                <span class="rule-badge rule-badge--b">B</span>
              </el-tooltip>
              <el-tooltip v-if="row.responseOverrides" :content="t('hasResponseOverrides')" placement="top">
                <span class="rule-badge rule-badge--r">R</span>
              </el-tooltip>
              <el-tooltip v-if="row.mockResponse" :content="t('hasMockResponse')" placement="top">
                <span class="rule-badge rule-badge--m">M</span>
              </el-tooltip>
              <el-tooltip v-if="row.delayMs" :content="t('hasDelay')" placement="top">
                <span class="rule-badge rule-badge--d">D</span>
              </el-tooltip>
              <el-tooltip v-if="row.blocked" :content="t('hasBlocked')" placement="top">
                <span class="rule-badge rule-badge--x">X</span>
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
          <span
            :title="row.matchPattern"
            v-html="highlightText(row.matchPattern, searchText)"
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
          <span
            :title="row.targetUrl"
            v-html="highlightText(row.targetUrl, searchText)"
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
import { ref } from 'vue';
import { EditPen, CopyDocument, Delete } from '@element-plus/icons-vue';
import type { ProxyRule } from '@/utils/types';
import { useI18n } from '@/composables/useI18n';
import EmptyGuide from './EmptyGuide.vue';

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

/** 正在播放删除动画的行 id 集合 */
const leavingIds = ref<Set<string>>(new Set());

/** 拖拽中的行 id */
const dragFromId = ref<string | null>(null);

function onDragStart(_e: DragEvent, row: ProxyRule) {
  dragFromId.value = row.id;
}

function onDragEnd() {
  dragFromId.value = null;
}

function onDrop(_e: DragEvent, toRow: ProxyRule) {
  if (dragFromId.value && dragFromId.value !== toRow.id) {
    emit('reorder', dragFromId.value, toRow.id);
  }
  dragFromId.value = null;
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
  return '';
}

function matchTypeTagType(matchType: string) {
  const typeMap: Record<string, 'primary' | 'success' | 'warning' | 'info'> = {
    wildcard: 'primary',
    prefix: 'success',
    regex: 'warning',
  };
  return typeMap[matchType] || 'info';
}

function matchTypeLabel(matchType: string) {
  const labelMap: Record<string, string> = {
    wildcard: t('matchTypeWildcard'),
    prefix: t('matchTypePrefix'),
    regex: t('matchTypeRegex'),
  };
  return labelMap[matchType] || matchType;
}

/** 缓存高亮正则，避免每次 highlightText 调用都 new RegExp */
let cachedHighlightPattern = '';
let cachedHighlightRegex: RegExp | null = null;

function getHighlightRegex(pattern: string): RegExp | null {
  if (pattern === cachedHighlightPattern) return cachedHighlightRegex;
  cachedHighlightPattern = pattern;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  cachedHighlightRegex = pattern ? new RegExp(`(${escaped})`, 'gi') : null;
  return cachedHighlightRegex;
}

/** 将匹配的关键字用 <mark> 包裹（先转义 HTML 防止 XSS） */
function highlightText(text: string, keyword: string): string {
  if (!keyword || !text) return text;
  // 先转义 HTML 实体，防止 XSS
  const escaped = text.replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
  const regex = getHighlightRegex(keyword);
  if (!regex) return escaped;
  return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
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

@media (width <= 768px) {
  .rule-table-card {
    margin: 0 20px 20px;
  }
}

:deep(.search-highlight) {
  background: var(--cop-primary-bg);
  color: var(--cop-primary);
  padding: 0 2px;
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
  border-radius: 4px;
  transition: all 0.15s;
  user-select: none;
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
  gap: 3px;
  flex-shrink: 0;
}

.rule-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  font-size: 10px;
  font-weight: 700;
  border-radius: 4px;
  line-height: 1;
}

.rule-badge--h {
  color: var(--el-color-primary, #409eff);
  background: var(--el-color-primary-light-9, #ecf5ff);
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
  color: #8b5cf6;
  background: #f5f3ff;
}

.rule-badge--d {
  color: #06b6d4;
  background: #ecfeff;
}

.rule-badge--x {
  color: var(--el-color-danger, #f56c6c);
  background: var(--el-color-danger-light-9, #fef2f2);
}
</style>
