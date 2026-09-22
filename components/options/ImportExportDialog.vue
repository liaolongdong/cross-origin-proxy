<template>
  <el-dialog
    :model-value="visible"
    :title="t('importExportConfig')"
    width="600px"
    align-center
    @close="$emit('update:visible', false)"
    @closed="resetHarPick"
  >
    <div class="import-export-dialog dialog-body-scroll">
      <!-- 导出配置 -->
      <div class="section">
        <h3>{{ t('exportSectionTitle') }}</h3>
        <p class="section-desc">{{ t('exportDesc') }}</p>
        <el-checkbox v-model="sanitizeExport">{{ t('exportSanitizeLabel') }}</el-checkbox>
        <p class="section-desc export-sanitize-tip">{{ t('exportSanitizeTip') }}</p>
        <el-button
          type="primary"
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

        <div style="margin-top: 12px">
          <label style="margin-right: 12px; font-size: 13px; color: var(--el-text-color-regular)">{{
            t('importMode')
          }}</label>
          <el-radio-group v-model="importMode">
            <el-radio value="replace">{{ t('importModeReplace') }}</el-radio>
            <el-radio value="merge">{{ t('importModeMerge') }}</el-radio>
          </el-radio-group>
        </div>

        <!-- 导入前预览：条数变化由后台用「写入那同一套判据」算出来，预览不做二次实现 -->
        <ul
          v-if="previewLines.length > 0"
          class="import-preview"
        >
          <li
            v-for="(line, index) in previewLines"
            :key="index"
            :class="`preview-${line.tone}`"
          >
            {{ line.text }}
          </li>
        </ul>

        <div class="preview-actions">
          <el-button
            type="primary"
            link
            :loading="previewing"
            :disabled="!canImport"
            @click="handlePreview"
          >
            {{ t('importPreviewButton') }}
          </el-button>
          <el-button
            type="success"
            :loading="importing"
            :disabled="!canImport"
            @click="handleImport"
          >
            {{ t('importButton') }}
          </el-button>
        </div>
      </div>

      <el-divider />

      <!-- cURL 导入 -->
      <div class="section">
        <h3>{{ t('importCurlTitle') }}</h3>
        <p class="section-desc">{{ t('importCurlDesc') }}</p>
        <el-input
          v-model="curlInput"
          type="textarea"
          :rows="5"
          class="curl-input"
          spellcheck="false"
          :placeholder="t('importCurlPlaceholder')"
        />
        <el-button
          type="success"
          :disabled="!curlInput.trim()"
          style="margin-top: 12px"
          @click="handleImportCurl"
        >
          {{ t('importCurlButton') }}
        </el-button>
      </div>

      <el-divider />

      <!-- HAR 报文导出 -->
      <div class="section">
        <h3>{{ t('exportHar') }}</h3>
        <p class="section-desc">{{ t('exportHarDesc') }}</p>
        <p class="section-desc export-sanitize-tip">
          {{ sanitizeExport ? t('exportHarRedacted') : t('exportHarFull') }}
        </p>
        <el-button
          type="warning"
          :loading="harExporting"
          @click="handleExportHar"
        >
          <el-icon><Download /></el-icon>
          {{ t('exportHar') }}
        </el-button>
      </div>

      <el-divider />

      <!-- HAR 报文导入 -->
      <div class="section">
        <h3>{{ t('importHar') }}</h3>
        <p class="section-desc">{{ t('importHarDesc') }}</p>
        <el-upload
          ref="harUploadRef"
          :auto-upload="false"
          :limit="1"
          accept=".har,.json"
          :on-change="handleHarFileChange"
          :on-remove="handleHarFileRemove"
        >
          <el-button type="warning">
            <el-icon><Upload /></el-icon>
            {{ t('importHar') }}
          </el-button>
          <template #tip>
            <div class="el-upload__tip">.har / .json</div>
          </template>
        </el-upload>
        <el-button
          v-if="harFileContent"
          type="success"
          :loading="harImporting"
          style="margin-top: 12px"
          @click="handleImportHar"
        >
          {{ t('importButton') }}
        </el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { Download, Upload } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { UploadFile } from 'element-plus';
import type { HarImportPayload, ImportMode, ImportPlan, ImportResultStats, ProxyRule } from '@/utils/types';
import { MessageType } from '@/utils/types';
import { MAX_RULES } from '@/utils/constants';
import { parseCurlCommand } from '@/utils/curlParser';
import type { ParsedCurl } from '@/utils/curlParser';
import { useI18n } from '@/composables/useI18n';
import { useImportExport } from '@/composables/useImportExport';

defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  /**
   * 导入成功后通知父组件刷新列表并关闭弹窗（失败时不发，输入原样保留）
   *
   * 带回后台**实际**写入的条数：只报一句「导入成功」会把「合并没改任何东西」这种结果
   * 说成成功，而它恰恰是用户最需要知道的那件事。
   */
  imported: [stats: ImportResultStats];
  /** 请求导出：`sanitize` 为弹窗里的「分享模式」勾选值，由父组件执行下载与提示 */
  export: [sanitize: boolean];
  importHarRules: [rules: ProxyRule[]];
  importCurl: [data: ParsedCurl];
}>();

const { t } = useI18n();

// 导入由弹窗自己发起并等待结果：只有拿到成败才知道要不要清空输入、要不要关窗。
// 以前是「emit 给父组件 → 立刻清空并关窗」，父组件的异步失败到达时输入早已没了。
const { importing, importConfig, fetchImportPlan } = useImportExport();

const uploadRef = ref();
const harUploadRef = ref();
const jsonInput = ref('');
const curlInput = ref('');
const fileContent = ref<string | null>(null);
const harExporting = ref(false);
const harImporting = ref(false);
const harFileContent = ref<string | null>(null);
const importMode = ref<ImportMode>('replace');
/** 分享模式：默认开启——导出的 JSON 常被直接贴进群里，凭据一旦外泄收不回，本机备份少勾一下即可 */
const sanitizeExport = ref(true);

const canImport = computed(() => {
  return fileContent.value || jsonInput.value.trim();
});

// ─── 导入前预览 ──────────────────────────────────────────────────────────────

const previewing = ref(false);
const plan = ref<ImportPlan | null>(null);
/** 预览失败与「没有预览」必须分开说：前者要提示这次没法预告，后者只是还没点 */
const planUnavailable = ref(false);

/** 冲突明细最多摊开几行：一份大文件能有上百条同键规则，全列出来等于把弹窗变成日志 */
const CONFLICT_ROWS_SHOWN = 5;

/** 预览结果摊平成行：模板里只留一次 v-for，语气（正常/提醒/危险）由判据侧决定 */
const previewLines = computed<Array<{ text: string; tone: 'info' | 'warn' | 'error' }>>(() => {
  if (planUnavailable.value) return [{ text: t('importPreviewFailed'), tone: 'warn' }];
  const current = plan.value;
  if (!current) return [];

  const lines: Array<{ text: string; tone: 'info' | 'warn' | 'error' }> = [
    { text: t('importPreviewAdded', [current.added, MAX_RULES]), tone: 'info' },
  ];
  if (current.skipped > 0) lines.push({ text: t('importPreviewSkipped', current.skipped), tone: 'warn' });
  if (current.replaces > 0) lines.push({ text: t('importPreviewReplaces', current.replaces), tone: 'warn' });
  // 文件内自重复会被一并写入（去重只比对现网），这是既有语义，但用户几乎一定会以为被去重了
  if (current.duplicatesWithinFile > 0) {
    lines.push({ text: t('importPreviewDuplicates', current.duplicatesWithinFile), tone: 'warn' });
  }
  let shownConflicts = 0;
  let hiddenConflicts = 0;
  for (const conflict of current.conflicts) {
    if (conflict.currentTargetUrl === conflict.incomingTargetUrl) continue;
    if (shownConflicts >= CONFLICT_ROWS_SHOWN) {
      hiddenConflicts++;
      continue;
    }
    shownConflicts++;
    lines.push({
      text: t('importPreviewConflictItem', [conflict.name, conflict.currentTargetUrl, conflict.incomingTargetUrl]),
      tone: 'warn',
    });
  }
  if (hiddenConflicts > 0) lines.push({ text: t('importPreviewConflictMore', hiddenConflicts), tone: 'info' });
  if (shownConflicts > 0) lines.push({ text: t('importPreviewConflictHint'), tone: 'info' });
  if (current.exceedsLimit) lines.push({ text: t('importPreviewExceedsLimit', MAX_RULES), tone: 'error' });
  return lines;
});

/** 输入或模式一变，旧预览就作废：留着会比没有更容易误导（用户会按上一个模式的数字点确认） */
let previewSeq = 0;
watch([jsonInput, fileContent, importMode], () => {
  previewSeq++;
  plan.value = null;
  planUnavailable.value = false;
});

async function handlePreview() {
  const jsonString = fileContent.value || jsonInput.value.trim();
  if (!jsonString) {
    ElMessage.warning(t('selectFileOrPaste'));
    return;
  }
  // 这一次预览的编号：await 期间用户改了输入或切了模式，回包再填回界面就是拿旧算式配新数据
  const seq = ++previewSeq;
  previewing.value = true;
  try {
    const result = await fetchImportPlan(jsonString, importMode.value);
    if (seq !== previewSeq) return;
    if (!result.success || !result.plan) {
      plan.value = null;
      planUnavailable.value = true;
      // 格式/版本问题点不出来，必须点名，否则用户以为「预览显示无变化」
      if (result.error === 'INVALID_CONFIG') ElMessage.error(t('importFailed'));
      else if (result.error === 'SCHEMA_TOO_NEW') ElMessage.error(t('importSchemaTooNew'));
      return;
    }
    plan.value = result.plan;
    planUnavailable.value = false;
  } finally {
    if (seq === previewSeq) previewing.value = false;
  }
}

// 成功/失败反馈由父组件在异步导出完成后发出：emit 是同步调用，
// 此处的 try/catch 拿不到父组件异步导出的结果，toast 会在导出实际完成前弹出
function handleExport() {
  emit('export', sanitizeExport.value);
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
    const confirmMsg = importMode.value === 'merge' ? t('confirmImportMerge') : t('confirmImport');
    await ElMessageBox.confirm(confirmMsg, t('confirmImportTitle'), {
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel'),
      type: 'warning',
    });

    const result = await importConfig(jsonString, importMode.value);
    if (!result.success) {
      // 失败时不清空输入、不关窗：用户改完 JSON 可以直接重试，不必重新粘贴
      if (result.error === 'MAX_RULES_EXCEEDED') {
        ElMessage.error(t('maxRulesReached', [MAX_RULES]));
      } else if (result.error === 'INVALID_CONFIG') {
        ElMessage.error(t('importFailed'));
      } else if (result.error === 'SCHEMA_TOO_NEW') {
        ElMessage.error(t('importSchemaTooNew'));
      } else {
        ElMessage.error(t('importConfigFailed'));
      }
      return;
    }

    jsonInput.value = '';
    fileContent.value = null;
    uploadRef.value?.clearFiles();
    // 计数由执行写入的一侧带回，成功提示才有资格说「新增几条、跳过几条」
    emit('imported', { added: result.added ?? 0, skipped: result.skipped ?? 0, invalid: result.invalid ?? 0 });
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(t('importConfigFailed'));
      console.error('Import failed:', error);
    }
  }
}

function handleImportCurl() {
  const parsed = parseCurlCommand(curlInput.value);
  if (!parsed) {
    ElMessage.error(t('importCurlFailed'));
    return;
  }
  emit('importCurl', parsed);
  ElMessage.success(t('importCurlSuccess'));
  curlInput.value = '';
  emit('update:visible', false);
}

async function handleExportHar() {
  harExporting.value = true;
  try {
    const har = await chrome.runtime.sendMessage({
      type: MessageType.EXPORT_HAR,
      data: { sanitize: sanitizeExport.value },
    });
    const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cross-origin-proxy-${Date.now()}.har`;
    a.click();
    URL.revokeObjectURL(url);
    ElMessage.success(t('exportHarSuccess'));
  } catch (error) {
    ElMessage.error(t('exportFailed'));
    console.error('HAR export failed:', error);
  } finally {
    harExporting.value = false;
  }
}

function handleHarFileChange(file: UploadFile) {
  const reader = new FileReader();
  reader.onload = e => {
    harFileContent.value = e.target?.result as string;
  };
  reader.readAsText(file.raw!);
}

function handleHarFileRemove() {
  harFileContent.value = null;
}

/**
 * 弹窗关闭动画结束后收起已选中的 HAR：成功由父组件关窗、失败与取消保持打开（输入留着才能重试）。
 * 分片不会随关闭销毁，残留的 `harFileContent` 与上传列表会让「再点一次导入」把同一批请求
 * 原样导入两遍——HAR 通道没有去重，只有 JSON 导入会跳过重复规则。
 */
function resetHarPick(): void {
  harFileContent.value = null;
  harUploadRef.value?.clearFiles();
}

async function handleImportHar() {
  if (!harFileContent.value) return;
  harImporting.value = true;
  try {
    const harData: HarImportPayload = JSON.parse(harFileContent.value);
    if (!harData.log || !Array.isArray(harData.log.entries)) {
      throw new Error('Invalid HAR format');
    }
    const result = await chrome.runtime.sendMessage({
      type: MessageType.IMPORT_HAR,
      data: harData,
    });
    if (result.success && result.rules) {
      // 只负责把规则交给父组件写入：emit 是同步的，此处弹「成功」会在达上限时
      // 与父组件的失败提示同时出现，输入也会被提前清掉、无法重试
      emit('importHarRules', result.rules);
    } else {
      ElMessage.error(t('importHarFailed'));
    }
  } catch (error) {
    ElMessage.error(t('importHarInvalid'));
    console.error('HAR import failed:', error);
  } finally {
    harImporting.value = false;
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

.export-sanitize-tip {
  margin-top: 0;
  font-size: 12px;
}

.paste-section {
  margin-top: 16px;
}

.import-preview {
  padding: 8px 12px 8px 28px;
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.6;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color-light);
  border-radius: 6px;
}

.preview-info {
  color: var(--cop-text-color-regular);
}

.preview-warn {
  color: var(--el-color-warning, #e6a23c);
}

.preview-error {
  color: var(--el-color-danger, #f56c6c);
}

.preview-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
}

.curl-input :deep(textarea) {
  font-family: SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
}

.paste-section p {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--cop-text-color-regular);
}
</style>
