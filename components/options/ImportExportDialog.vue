<template>
  <el-dialog
    :model-value="visible"
    :title="t('importExportConfig')"
    width="600px"
    @close="$emit('update:visible', false)"
  >
    <div class="import-export-dialog dialog-body-scroll">
      <!-- 导出配置 -->
      <div class="section">
        <h3>{{ t('exportSectionTitle') }}</h3>
        <p class="section-desc">{{ t('exportDesc') }}</p>
        <el-button
          type="primary"
          :loading="exporting"
          @click="handleExport"
        >
          <el-icon><Download /></el-icon>
          {{ t('exportButton') }}
        </el-button>
      </div>

      <el-divider />

      <!-- 导入配置 -->
      <div class="section">
        <h3>{{ t('importSectionTitle') }}</h3>
        <p class="section-desc">{{ t('importDesc') }}</p>

        <!-- 文件上传 -->
        <el-upload
          ref="uploadRef"
          :auto-upload="false"
          :limit="1"
          accept=".json"
          :on-change="handleFileChange"
          :on-remove="handleFileRemove"
          style="margin-bottom: 16px"
        >
          <el-button type="primary">
            <el-icon><Upload /></el-icon>
            {{ t('selectFile') }}
          </el-button>
          <template #tip>
            <div class="el-upload__tip">{{ t('jsonOnlyTip') }}</div>
          </template>
        </el-upload>

        <!-- 或粘贴 JSON -->
        <div class="paste-section">
          <p>{{ t('pasteJsonLabel') }}</p>
          <el-input
            v-model="jsonInput"
            type="textarea"
            :rows="6"
            :placeholder="t('pasteJsonPlaceholder')"
          />
        </div>

        <el-button
          type="success"
          :loading="importing"
          :disabled="!canImport"
          style="margin-top: 16px"
          @click="handleImport"
        >
          {{ t('importButton') }}
        </el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { Download, Upload } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { UploadFile } from 'element-plus';
import type { ExportData } from '@/utils/types';
import { useI18n } from '@/composables/useI18n';

defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  import: [data: ExportData];
  export: [];
}>();

const { t } = useI18n();

const uploadRef = ref();
const jsonInput = ref('');
const exporting = ref(false);
const importing = ref(false);
const fileContent = ref<string | null>(null);

const canImport = computed(() => {
  return fileContent.value || jsonInput.value.trim();
});

async function handleExport() {
  exporting.value = true;
  try {
    emit('export');
    ElMessage.success(t('exportSuccess'));
  } catch (error) {
    ElMessage.error(t('exportFailed'));
    console.error('Export failed:', error);
  } finally {
    exporting.value = false;
  }
}

function handleFileChange(file: UploadFile) {
  const reader = new FileReader();
  reader.onload = e => {
    fileContent.value = e.target?.result as string;
  };
  reader.readAsText(file.raw!);
}

function handleFileRemove() {
  fileContent.value = null;
}

async function handleImport() {
  const jsonString = fileContent.value || jsonInput.value.trim();
  if (!jsonString) {
    ElMessage.warning(t('selectFileOrPaste'));
    return;
  }

  try {
    await ElMessageBox.confirm(t('confirmImport'), t('confirmImportTitle'), {
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel'),
      type: 'warning',
    });

    importing.value = true;
    const data: ExportData = JSON.parse(jsonString);
    if (!data.config || !Array.isArray(data.config.rules)) {
      throw new Error('Invalid config format');
    }
    emit('import', data);
    jsonInput.value = '';
    fileContent.value = null;
    uploadRef.value?.clearFiles();
    emit('update:visible', false);
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(t('importFailed'));
      console.error('Import failed:', error);
    }
  } finally {
    importing.value = false;
  }
}
</script>

<style scoped>
.import-export-dialog {
  padding: 0 10px;
}

.section {
  margin-bottom: 20px;
}

.section h3 {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--cop-text-color-primary);
}

.section-desc {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--cop-text-color-secondary);
}

.paste-section {
  margin-top: 16px;
}

.paste-section p {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--cop-text-color-regular);
}
</style>
