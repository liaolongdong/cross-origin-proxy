<template>
  <el-dialog
    :model-value="visible"
    :title="t('migrateTargetsTitle')"
    width="600px"
    align-center
    @close="handleClose"
  >
    <div class="migrate-dialog dialog-body-scroll">
      <p class="migrate-desc">{{ t('migrateTargetsDesc') }}</p>

      <div class="migrate-inputs">
        <el-input
          v-model="findText"
          :placeholder="t('migrateFindPlaceholder')"
          clearable
          autocomplete="off"
          spellcheck="false"
        >
          <template #prepend>{{ t('migrateFindLabel') }}</template>
        </el-input>
        <el-input
          v-model="replaceText"
          :placeholder="t('migrateReplacePlaceholder')"
          clearable
          autocomplete="off"
          spellcheck="false"
        >
          <template #prepend>{{ t('migrateReplaceLabel') }}</template>
        </el-input>
      </div>

      <el-alert
        v-if="selectedRules.length === 0"
        :title="t('migrateNoSelection')"
        type="info"
        :closable="false"
        show-icon
      />

      <div
        v-else-if="preview.length === 0"
        class="migrate-empty"
      >
        {{ findText ? t('migrateNoMatch') : t('migrateFindRequired') }}
      </div>

      <div
        v-else
        class="migrate-preview"
      >
        <p class="migrate-preview-title">{{ t('migratePreviewCount', [String(preview.length)]) }}</p>
        <div
          v-for="item in preview"
          :key="item.id"
          class="migrate-row"
        >
          <span
            class="migrate-name"
            :title="nameOf(item.id)"
            >{{ nameOf(item.id) }}</span
          >
          <div class="migrate-urls">
            <code class="migrate-old">{{ item.oldUrl }}</code>
            <el-icon class="migrate-arrow"><Right /></el-icon>
            <code class="migrate-new">{{ item.newUrl }}</code>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="handleClose">{{ t('cancel') }}</el-button>
        <el-button
          type="primary"
          :disabled="preview.length === 0"
          @click="handleApply"
        >
          {{ t('migrateApply') }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Right } from '@element-plus/icons-vue';
import type { ProxyRule } from '@/utils/types';
import { useI18n } from '@/composables/useI18n';
import { computeMigratedTargets } from '@/utils/ruleMigration';

const props = defineProps<{
  visible: boolean;
  /** 参与迁移的选中规则（通常为用户在表格中勾选的规则） */
  selectedRules: ProxyRule[];
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  /** 提交变更集，由容器层发送消息并刷新 */
  apply: [updates: { id: string; targetUrl: string }[]];
}>();

const { t } = useI18n();

const findText = ref('');
const replaceText = ref('');

// 每次打开重置输入，避免上次残留的查找/替换串误伤本次选择
watch(
  () => props.visible,
  val => {
    if (val) {
      findText.value = '';
      replaceText.value = '';
    }
  },
);

const selectedIds = computed(() => props.selectedRules.map(r => r.id));

const preview = computed(() =>
  computeMigratedTargets(props.selectedRules, selectedIds.value, findText.value, replaceText.value),
);

function nameOf(id: string): string {
  return props.selectedRules.find(r => r.id === id)?.name ?? id;
}

function handleApply() {
  if (preview.value.length === 0) return;
  emit(
    'apply',
    preview.value.map(item => ({ id: item.id, targetUrl: item.newUrl })),
  );
  emit('update:visible', false);
}

function handleClose() {
  emit('update:visible', false);
}
</script>

<style scoped>
.migrate-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.migrate-desc {
  margin: 0;
  font-size: 13px;
  color: var(--cop-text-color-secondary);
}

.migrate-inputs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.migrate-empty {
  padding: 16px;
  font-size: 13px;
  color: var(--cop-text-color-secondary);
  text-align: center;
  background: var(--cop-bg-color-secondary);
  border-radius: 8px;
}

.migrate-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}

.migrate-preview-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--cop-text-color);
}

.migrate-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color-light);
  border-radius: 6px;
}

.migrate-name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 600;
  color: var(--cop-text-color);
  white-space: nowrap;
}

.migrate-urls {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}

.migrate-old,
.migrate-new {
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--cop-font-mono, monospace);
  white-space: nowrap;
}

.migrate-old {
  max-width: 42%;
  color: var(--cop-text-color-secondary);
  text-decoration: line-through;
}

.migrate-new {
  max-width: 42%;
  color: var(--el-color-success);
}

.migrate-arrow {
  flex: none;
  color: var(--cop-text-color-secondary);
}
</style>
