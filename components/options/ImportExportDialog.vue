<template>
  <el-dialog
    :model-value="visible"
    :title="t('importExportConfig')"
    width="600px"
    align-center
    @close="$emit('update:visible', false)"
    @closed="resetDerivedPicks"
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

        <div class="import-mode-row">
          <label class="import-mode-label">{{ t('importMode') }}</label>
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
          :disabled="!curlInput.trim() || busy"
          class="section-action"
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
        <el-input
          v-model="harTarget.raw"
          :class="['target-env-input', { 'target-env-input--invalid': harTarget.invalid }]"
          :placeholder="t('importHarTargetPlaceholder')"
          :aria-invalid="harTarget.invalid ? 'true' : undefined"
          :aria-describedby="harTarget.invalid ? 'har-target-error' : undefined"
          clearable
          autocomplete="off"
          spellcheck="false"
          @change="harTarget.normalize"
        >
          <template #prepend>{{ t('importHarTargetLabel') }}</template>
        </el-input>
        <p class="section-desc target-env-desc">{{ t('importHarTargetDesc') }}</p>
        <p
          v-if="harTarget.invalid"
          id="har-target-error"
          class="target-env-error"
        >
          {{ t('importHarTargetInvalid') }}
        </p>
        <!-- 只在读得出目标时出现：没换环境就默认启用这批规则，等于凭空把整站的流量指走 -->
        <el-checkbox
          v-if="harTarget.valid"
          v-model="harTarget.enableOnImport"
          class="target-env-enable"
        >
          {{ t('importHarEnableOnImport') }}
        </el-checkbox>
        <!-- 默认不勾：勾上才会把抓到的凭据头搬进变量表、规则里只留 `{{名称}}` 引用。
             不勾时的产出与这个选项存在之前逐字节相同（原值进 `headerOverrides`）。 -->
        <el-checkbox
          v-model="harRelocateCredentials"
          class="har-relocate"
        >
          {{ t('importHarRelocateCredentials') }}
        </el-checkbox>
        <p
          v-if="harRelocateCredentials"
          class="section-desc target-env-desc"
        >
          {{ t('importHarRelocateCredentialsDesc') }}
        </p>
        <el-button
          v-if="harFileContent"
          type="success"
          :loading="harImporting || busy"
          :disabled="busy"
          class="section-action"
          @click="handleImportHar"
        >
          {{ t('importHarCreateRules') }}
        </el-button>
      </div>

      <el-divider />

      <!-- OpenAPI / Swagger 导入：按文档声明的接口来源逐条建规则 -->
      <div class="section">
        <h3>{{ t('importOpenApiTitle') }}</h3>
        <p class="section-desc">{{ t('importOpenApiDesc') }}</p>
        <el-upload
          ref="openApiUploadRef"
          :auto-upload="false"
          :limit="1"
          accept=".json"
          :on-change="handleOpenApiFileChange"
          :on-remove="handleOpenApiFileRemove"
        >
          <el-button type="warning">
            <el-icon><Upload /></el-icon>
            {{ t('importOpenApiPick') }}
          </el-button>
          <template #tip>
            <div class="el-upload__tip">{{ t('importOpenApiTip') }}</div>
          </template>
        </el-upload>
        <el-input
          v-model="openApiTarget.raw"
          :class="['target-env-input', { 'target-env-input--invalid': openApiTarget.invalid }]"
          :placeholder="t('importOpenApiTargetPlaceholder')"
          :aria-invalid="openApiTarget.invalid ? 'true' : undefined"
          :aria-describedby="openApiTarget.invalid ? 'openapi-target-error' : undefined"
          clearable
          autocomplete="off"
          spellcheck="false"
          @change="openApiTarget.normalize"
        >
          <template #prepend>{{ t('importHarTargetLabel') }}</template>
        </el-input>
        <p class="section-desc target-env-desc">{{ t('importHarTargetDesc') }}</p>
        <p
          v-if="openApiTarget.invalid"
          id="openapi-target-error"
          class="target-env-error"
        >
          {{ t('importHarTargetInvalid') }}
        </p>
        <!-- 与 HAR 那格同一条不变量：复选框不出现就等于没勾，判据见 `composables/useTargetEnv.ts` -->
        <el-checkbox
          v-if="openApiTarget.valid"
          v-model="openApiTarget.enableOnImport"
          class="target-env-enable"
        >
          {{ t('importHarEnableOnImport') }}
        </el-checkbox>
        <el-button
          v-if="openApiFileContent"
          type="success"
          :loading="openApiImporting || busy"
          :disabled="busy"
          class="section-action"
          @click="handleImportOpenApi"
        >
          {{ t('importOpenApiCreateRules') }}
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
import type {
  HarImportPayload,
  ImportHarResult,
  ImportMode,
  ImportPlan,
  ImportResultStats,
  ProxyRule,
} from '@/utils/types';
import { MessageType } from '@/utils/types';
import { MAX_IMPORT_FILE_SIZE, MAX_RULES } from '@/utils/constants';
import { distinctHarOrigins, harEntriesOverLimit } from '@/utils/har';
import { useTargetEnv } from '@/composables/useTargetEnv';
import { openApiSpecToRules, parseOpenApiSpec } from '@/utils/openapi';
import { parseCurlCommand } from '@/utils/curlParser';
import type { ParsedCurl } from '@/utils/curlParser';
import { useI18n } from '@/composables/useI18n';
import { isFailureEnvelope } from '@/utils/messageResult';
import { logger } from '@/utils/logger';
import { useImportExport } from '@/composables/useImportExport';

defineProps<{
  visible: boolean;
  /** 父组件正在把派生规则批量写入存储：期间锁住所有「一键生成规则」出口，避免连点写两份 */
  busy?: boolean;
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
  /**
   * HAR 导入产出的规则交给父组件写入（emit 是同步的，成功提示由父组件在它落盘后才发）
   *
   * `targetOrigin` 是这一批被指过去的那个环境，空串表示没填——父组件据此选一句成功提示，
   * 免得「创建了 N 条规则」这句话在用户刚刚换了环境时听起来像什么都没发生。
   */
  importHarRules: [rules: ProxyRule[], targetOrigin: string, relocated: number, keptRaw: number];
  /** OpenAPI / Swagger 文档产出的规则同样交给父组件写入；`skipped` 是读不出来源而被跳过的 server 条数 */
  importOpenApiRules: [rules: ProxyRule[], targetOrigin: string, skipped: number];
  importCurl: [data: ParsedCurl];
}>();

const { t } = useI18n();

// 导入由弹窗自己发起并等待结果：只有拿到成败才知道要不要清空输入、要不要关窗。
// 以前是「emit 给父组件 → 立刻清空并关窗」，父组件的异步失败到达时输入早已没了。
const { importing, importConfig, fetchImportPlan } = useImportExport();

const uploadRef = ref();
const harUploadRef = ref();
const openApiUploadRef = ref();
/** 选中但尚未导入的文档正文：与 `harFileContent` 同一族——读到了才出现那颗确认按钮 */
const openApiFileContent = ref<string | null>(null);
const openApiImporting = ref(false);
const jsonInput = ref('');
const curlInput = ref('');
const fileContent = ref<string | null>(null);
const harExporting = ref(false);
const harImporting = ref(false);
const harFileContent = ref<string | null>(null);
/** HAR 导入的目标环境：留空 = 与本功能存在之前一样，产出自映射、默认停用的规则 */
const harTarget = useTargetEnv();
/** 抓包里的凭据头是否搬进变量表；默认关，关着时后台产出的形状与本选项存在之前逐字节相同 */
const harRelocateCredentials = ref(false);
/** OpenAPI / Swagger 文档的目标环境：判据与 HAR 那格同一份（见 `composables/useTargetEnv.ts`） */
const openApiTarget = useTargetEnv();
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

/**
 * 把选择器里那个文件读成文本（配置 JSON 与 HAR 两条通道共用）
 *
 * `onerror` 必须有接手人：读失败（文件选完后被移走或删掉、磁盘与权限问题）时 `onload` 永不触发，
 * 而界面上那一行已经是刚选的新文件名——上一次的内容还留在 `fileContent` 里等着被导入。
 * 用户以为自己换了文件，实际按下的是旧那一份，且没有任何地方说过这件事。
 * 失败时清空目标（回到「请选择文件或粘贴 JSON」的口径）并点名，绝不让旧内容冒充新文件。
 *
 * 体积闸门排在读之前（M-10）：整份文本随后要 `JSON.parse`、要过 cURL 分词、还要序列化进
 * `sendMessage`，全在配置页主线程上同步跑（本机 node 22 实测：24MB 的 HAR 文本 parse 51ms、parse 后再序列化 88ms）。
 * 超上限的文件几乎不可能是用户想导的那份配置，所以是「拒 + 说清楚」，不是「读进来再说」。
 */
function readFileAsText(file: File, apply: (text: string) => void): void {
  if (file.size > MAX_IMPORT_FILE_SIZE) {
    apply('');
    ElMessage.error(t('fileTooLarge', [formatBytes(file.size), formatBytes(MAX_IMPORT_FILE_SIZE)]));
    return;
  }
  const reader = new FileReader();
  reader.onload = e => apply(typeof e.target?.result === 'string' ? e.target.result : '');
  reader.onerror = () => {
    apply('');
    ElMessage.error(t('fileReadFailed'));
  };
  reader.readAsText(file);
}

/** 提示里点名体积用的极简格式化（只有这一处要它，MB 一位小数、KB 取整） */
function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
}

function handleFileChange(file: UploadFile) {
  if (!file.raw) return;
  readFileAsText(file.raw, text => {
    fileContent.value = text;
  });
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
      logger.error('Import failed:', error);
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
    const har = (await chrome.runtime.sendMessage({
      type: MessageType.EXPORT_HAR,
      data: { sanitize: sanitizeExport.value },
    })) as { log?: unknown; success?: boolean; error?: string } | undefined;
    // 后台失败回的是 resolved 的信封；少了这一判，错误体会被当成 .har 下载走，
    // 界面还有一句「导出成功」
    if (!har || isFailureEnvelope(har) || !har.log) {
      throw new Error((har && 'error' in har && har.error) || 'EXPORT_HAR_FAILED');
    }
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
    logger.error('HAR export failed:', error);
  } finally {
    harExporting.value = false;
  }
}

function handleHarFileChange(file: UploadFile) {
  if (!file.raw) return;
  readFileAsText(file.raw, text => {
    harFileContent.value = text;
  });
}

function handleHarFileRemove() {
  harFileContent.value = null;
}

/**
 * 弹窗关闭动画结束后收起已选中的 HAR：成功由父组件关窗、失败与取消保持打开（输入留着才能重试）。
 * 分片不会随关闭销毁，残留的 `harFileContent` 与上传列表会让「再点一次导入」把同一批请求
 * 原样导入两遍——HAR 通道没有去重，只有 JSON 导入会跳过重复规则。
 */
function resetDerivedPicks(): void {
  harFileContent.value = null;
  harTarget.reset();
  harRelocateCredentials.value = false;
  harUploadRef.value?.clearFiles();
  openApiFileContent.value = null;
  openApiTarget.reset();
  openApiUploadRef.value?.clearFiles();
}

/** 选中文档：与配置/HAR 共用 `readFileAsText`（体积闸门与「读失败不许留着旧内容」都在那一处） */
function handleOpenApiFileChange(file: UploadFile) {
  if (!file.raw) return;
  readFileAsText(file.raw, text => {
    openApiFileContent.value = text;
  });
}

function handleOpenApiFileRemove() {
  openApiFileContent.value = null;
}

/**
 * 把文档转成规则并交给父组件写入
 *
 * 全程在界面侧完成（不像 HAR 那样要过后台）：这里没有「逐条建规则」的重活，只有一次
 * `JSON.parse` 与几次 URL 解析，而 parse 失败的点名本来也只能由读到文件的那一侧发。
 * 三类失败各说一句——不是 JSON（多半是粘了 YAML）、不是接口文档、文档里没有可用地址，
 * 用户下一步的动作完全不同，合成一句「导入失败」就等于让人去翻一个不存在的问题。
 * 体积不在这道：`readFileAsText` 那侧的 2MB 闸门永远先响，这里再加一道更宽的只会成为死分支。
 */
function handleImportOpenApi() {
  const text = openApiFileContent.value;
  if (!text) return;
  openApiImporting.value = true;
  try {
    const parsed = parseOpenApiSpec(text);
    if (!parsed.ok) {
      ElMessage.error(
        parsed.reason === 'notJson'
          ? t('importOpenApiNotJson')
          : parsed.reason === 'noServers'
            ? t('importOpenApiNoServers')
            : t('importOpenApiUnsupported'),
      );
      return;
    }
    const rules = openApiSpecToRules(parsed.spec, {
      targetOrigin: openApiTarget.parsed || undefined,
      enabled: openApiTarget.enableOnImportFlag,
    });
    emit('importOpenApiRules', rules, openApiTarget.parsed, parsed.spec.skipped);
  } finally {
    openApiImporting.value = false;
  }
}

async function handleImportHar() {
  if (!harFileContent.value) return;
  harImporting.value = true;
  try {
    const harData: HarImportPayload = JSON.parse(harFileContent.value);
    if (!harData.log || !Array.isArray(harData.log.entries)) {
      throw new Error('Invalid HAR format');
    }
    // 条数闸门排在发消息之前（M-10）：`MAX_RULES=200` 挡得住最终写入，挡不住这一次整包序列化
    // + 后台整表遍历。判据与后台那道复核共用 `harEntriesOverLimit`，两边不会给出不同的答案。
    const overflow = harEntriesOverLimit(harData.log.entries);
    if (overflow) {
      ElMessage.error(t('importHarTooManyEntries', [String(overflow.actual), String(overflow.limit)]));
      return;
    }
    const origins = distinctHarOrigins(harData.log.entries);
    if (harTarget.parsed && origins.length > 1) {
      const preview = origins.slice(0, 5).join('\n');
      try {
        await ElMessageBox.confirm(
          t('importHarMultiOriginConfirm', [String(origins.length), preview]),
          t('importHarMultiOriginTitle'),
          { confirmButtonText: t('confirm'), cancelButtonText: t('cancel'), type: 'warning' },
        );
      } catch {
        return;
      }
    }
    const result = (await chrome.runtime.sendMessage({
      type: MessageType.IMPORT_HAR,
      // 目标环境随消息进后台，由后台按同一份 origin 判据再核一遍（载荷属不可信输入）
      data: {
        ...harData,
        targetOrigin: harTarget.parsed || undefined,
        enableOnImport: harTarget.enableOnImportFlag,
        relocateCredentials: harRelocateCredentials.value,
      },
    })) as ImportHarResult | undefined;
    // `?.` 是必需的：SW 刚被回收时 `sendMessage` 会 resolve `undefined`（与 `importConfig`
    // 同一件事）。少了它，这一行抛的 TypeError 会被下面的 catch 收成「文件不合法」——
    // 用户的 HAR 明明没问题，却被指着格式说事，重试多少次都是同一句话。
    if (result?.success && result.rules) {
      // 只负责把规则交给父组件写入：emit 是同步的，此处弹「成功」会在达上限时
      // 与父组件的失败提示同时出现，输入也会被提前清掉、无法重试
      emit('importHarRules', result.rules, harTarget.parsed, result.relocated ?? 0, result.keptRaw ?? 0);
    } else {
      ElMessage.error(t('importHarFailed'));
    }
  } catch (error) {
    ElMessage.error(t('importHarInvalid'));
    logger.error('HAR import failed:', error);
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

.section-action {
  margin-top: 12px;
}

.section-desc {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--cop-text-color-secondary);
}

.import-mode-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
  margin-top: 12px;
}

.import-mode-label {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

/* HAR 的目标环境那一格：输入框、说明、报错行与「立即启用」复选框各占一段 */
.target-env-input {
  margin-bottom: 6px;
}

.target-env-input--invalid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

.target-env-desc {
  margin: 0 0 8px;
}

.target-env-error {
  margin: -4px 0 8px;
  font-size: 12px;
  color: var(--el-color-danger);
}

.target-env-enable,
.har-relocate {
  margin-top: 2px;
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
  animation: preview-slide-in var(--cop-duration-base) var(--cop-ease-enter);
}

.preview-warn {
  color: var(--el-color-warning, #e6a23c);
  animation: preview-drop-in var(--cop-duration-base) var(--cop-ease-enter);
}

.preview-error {
  color: var(--el-color-danger, #f56c6c);
  animation: preview-drop-in var(--cop-duration-base) var(--cop-ease-enter);
}

/* 入场方向按「这一条说的是哪一家」分开，而不是只靠颜色分家：
   `info` 是这次的净结果（预计新增几条、被折叠的冲突还有一批），自左侧滑进栏位；
   `warn` / `error` 全都在说「现网要被改动」或「这次做不成」（跳过、同键条目算新增、
   冲突明细、超出上限），从上往下压进来。合并模式下最容易读错的那件事恰好是
   「改了 targetUrl 的同名规则是新增、不是更新」，它属于下面那一族，方向替它先站好队。
   进场只写 `from`：`to` 取元素自身的计算值，暗色档位与奇偶行都不用关心。 */
@keyframes preview-slide-in {
  from {
    opacity: 0;
    transform: translateX(-8px);
  }
}

@keyframes preview-drop-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
}

.preview-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
}

.preview-actions :deep(.el-button + .el-button) {
  margin-left: 0;
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
