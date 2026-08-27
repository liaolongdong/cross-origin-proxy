<template>
  <div class="search-filter-bar">
    <el-input
      v-model="localSearchText"
      :placeholder="t('searchRules')"
      clearable
      class="search-input"
    >
      <template #prefix>
        <el-icon><Search /></el-icon>
      </template>
    </el-input>

    <el-select
      :model-value="statusFilter"
      :placeholder="t('filterAll')"
      class="status-select"
      @update:model-value="$emit('update:statusFilter', $event)"
    >
      <el-option
        :label="t('filterAll')"
        value=""
      />
      <el-option
        :label="t('filterEnabled')"
        value="enabled"
      />
      <el-option
        :label="t('filterDisabled')"
        value="disabled"
      />
    </el-select>

    <!-- 有勾选时出现的批量操作 -->
    <template v-if="selectedCount > 0">
      <el-button @click="$emit('batchToggle', true)"> {{ t('batchEnable') }} ({{ selectedCount }}) </el-button>
      <el-button @click="$emit('batchToggle', false)"> {{ t('batchDisable') }} ({{ selectedCount }}) </el-button>
      <el-button
        type="danger"
        plain
        @click="$emit('batchDelete')"
      >
        {{ t('batchDelete') }} ({{ selectedCount }})
      </el-button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { Search } from '@element-plus/icons-vue';
import { useI18n } from '@/composables/useI18n';

/**
 * 规则搜索筛选栏（白色圆角卡片）
 *
 * 搜索/筛选状态由父组件持有（v-model 双绑），批量按钮在有勾选行时条件显示。
 */
const props = defineProps<{
  /** 搜索关键字（名称/模式/目标 URL） */
  searchText: string;
  /** 状态筛选：'' | 'enabled' | 'disabled' */
  statusFilter: string;
  /** 表格勾选数量（>0 时显示批量按钮） */
  selectedCount: number;
}>();

const emit = defineEmits<{
  'update:searchText': [value: string];
  'update:statusFilter': [value: string];
  /** 批量启用/停用勾选规则 */
  batchToggle: [enabled: boolean];
  /** 批量删除勾选规则 */
  batchDelete: [];
}>();

const { t } = useI18n();

// 本地搜索输入值 + 200ms 防抖
const localSearchText = ref(props.searchText || '');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(localSearchText, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    emit('update:searchText', val);
  }, 200);
});

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<style scoped>
.search-filter-bar {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 16px 20px;
  margin: 0 32px 16px;
  background: var(--cop-bg-color);
  border-radius: 8px;
  box-shadow: var(--cop-shadow-md);
}

.search-input {
  flex: 1;
}

.status-select {
  flex-shrink: 0;
  width: 130px;
}

@media (width <= 768px) {
  .search-filter-bar {
    flex-wrap: wrap;
    margin: 0 20px 16px;
  }

  .search-input {
    flex-basis: 100%;
  }
}
</style>
