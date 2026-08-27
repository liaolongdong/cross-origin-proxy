<template>
  <el-dialog
    :model-value="visible"
    :title="rule ? t('editRule') : t('addRule')"
    width="600px"
    @close="handleClose"
  >
    <div class="dialog-body-scroll">
      <el-form
        ref="formRef"
        :model="form"
        :rules="formRules"
        label-width="100px"
      >
        <el-form-item
          :label="t('ruleName')"
          prop="name"
        >
          <el-input
            v-model="form.name"
            :placeholder="t('ruleNamePlaceholder')"
          />
        </el-form-item>

        <el-form-item
          :label="t('matchTypeLabel')"
          prop="matchType"
        >
          <el-radio-group v-model="form.matchType">
            <el-radio value="wildcard">{{ t('matchTypeWildcardFull') }}</el-radio>
            <el-radio value="prefix">{{ t('matchTypePrefixFull') }}</el-radio>
            <el-radio value="regex">{{ t('matchTypeRegexFull') }}</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item
          :label="t('matchPatternLabel')"
          prop="matchPattern"
        >
          <el-input
            v-model="form.matchPattern"
            :placeholder="matchPatternPlaceholder"
          />
        </el-form-item>

        <el-form-item
          :label="t('targetUrlLabel')"
          prop="targetUrl"
        >
          <el-input
            v-model="form.targetUrl"
            :placeholder="t('targetUrlPlaceholder')"
          />
        </el-form-item>

        <el-form-item
          :label="t('priorityLabel')"
          prop="priority"
        >
          <el-input-number
            v-model="form.priority"
            :min="1"
            :max="999"
          />
        </el-form-item>

        <el-form-item :label="t('headerOverridesLabel')">
          <div class="header-overrides">
            <div
              v-for="(header, index) in headerList"
              :key="index"
              class="header-pair"
            >
              <el-input
                v-model="header.key"
                :placeholder="t('headerNamePlaceholder')"
                style="width: 40%"
              />
              <el-input
                v-model="header.value"
                :placeholder="t('headerValuePlaceholder')"
                style="width: 40%"
              />
              <el-button
                type="danger"
                link
                @click="removeHeader(index)"
              >
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
            <el-button
              type="primary"
              link
              @click="addHeader"
            >
              <el-icon><Plus /></el-icon>
              {{ t('addHeader') }}
            </el-button>
          </div>
        </el-form-item>

        <!-- 请求体覆盖 -->
        <el-form-item :label="t('requestBodyOverrideLabel')">
          <div class="override-section">
            <el-switch
              v-model="enableRequestBodyOverride"
              :active-text="t('enabled')"
            />
            <el-input
              v-if="enableRequestBodyOverride"
              v-model="form.requestBodyOverride"
              type="textarea"
              :rows="3"
              :placeholder="t('requestBodyOverridePlaceholder')"
              class="override-textarea"
            />
          </div>
        </el-form-item>

        <!-- 响应覆盖 -->
        <el-form-item :label="t('responseOverridesLabel')">
          <div class="override-section">
            <el-switch
              v-model="enableResponseOverrides"
              :active-text="t('enabled')"
            />
            <div v-if="enableResponseOverrides" class="response-overrides">
              <div class="response-field">
                <label class="response-field-label">{{ t('responseStatusOverride') }}</label>
                <el-input-number
                  v-model="form.responseStatus"
                  :min="0"
                  :max="599"
                  :placeholder="t('responseStatusPlaceholder')"
                  controls-position="right"
                  style="width: 160px"
                />
              </div>
              <div class="response-field">
                <label class="response-field-label">{{ t('responseHeadersOverride') }}</label>
                <div
                  v-for="(header, index) in responseHeaderList"
                  :key="index"
                  class="header-pair"
                >
                  <el-input
                    v-model="header.key"
                    :placeholder="t('headerNamePlaceholder')"
                    style="width: 40%"
                  />
                  <el-input
                    v-model="header.value"
                    :placeholder="t('headerValuePlaceholder')"
                    style="width: 40%"
                  />
                  <el-button
                    type="danger"
                    link
                    @click="responseHeaderList.splice(index, 1)"
                  >
                    <el-icon><Delete /></el-icon>
                  </el-button>
                </div>
                <el-button
                  type="primary"
                  link
                  @click="responseHeaderList.push({ key: '', value: '' })"
                >
                  <el-icon><Plus /></el-icon>
                  {{ t('addHeader') }}
                </el-button>
              </div>
              <div class="response-field">
                <label class="response-field-label">{{ t('responseBodyReplacements') }}</label>
                <div
                  v-for="(replacement, index) in bodyReplacementList"
                  :key="index"
                  class="header-pair"
                >
                  <el-input
                    v-model="replacement.path"
                    :placeholder="t('jsonPathPlaceholder')"
                    style="width: 30%"
                  />
                  <el-input
                    v-model="replacement.value"
                    :placeholder="t('jsonValuePlaceholder')"
                    style="width: 50%"
                  />
                  <el-button
                    type="danger"
                    link
                    @click="bodyReplacementList.splice(index, 1)"
                  >
                    <el-icon><Delete /></el-icon>
                  </el-button>
                </div>
                <el-button
                  type="primary"
                  link
                  @click="bodyReplacementList.push({ path: '', value: '' })"
                >
                  <el-icon><Plus /></el-icon>
                  {{ t('addReplacement') }}
                </el-button>
              </div>
            </div>
          </div>
        </el-form-item>

        <el-form-item :label="t('enabledLabel')">
          <el-switch v-model="form.enabled" />
        </el-form-item>
      </el-form>

      <!-- Pattern Match Test Panel -->
      <transition name="el-fade-in">
        <div v-if="showTestPanel" class="test-panel">
          <div class="test-panel-header">
            <span class="test-panel-title">{{ t('patternTest') }}</span>
            <el-button
              type="info"
              link
              @click="showTestPanel = false"
            >
              <el-icon><Close /></el-icon>
            </el-button>
          </div>

          <div class="test-panel-body">
            <div class="test-input-row">
              <el-input
                v-model="testUrl"
                :placeholder="t('testUrlPlaceholder')"
                clearable
                @keyup.enter="runTest"
              />
              <el-button
                type="primary"
                :disabled="!testUrl.trim() || !form.matchPattern || !form.targetUrl"
                @click="runTest"
              >
                {{ t('testRule') }}
              </el-button>
            </div>

            <div v-if="testResult !== null" class="test-result">
              <div class="test-result-label">{{ t('matchResult') }}</div>
              <div v-if="testResult.matched" class="test-result-matched">
                <el-tag type="success" effect="dark">
                  ✓ {{ t('matched') }}
                </el-tag>
                <div class="test-result-rewrite">
                  <span class="test-result-rewrite-label">{{ t('rewrittenUrl') }}:</span>
                  <code class="test-result-url">{{ testResult.rewrittenUrl }}</code>
                </div>
              </div>
              <div v-else class="test-result-no-match">
                <el-tag type="danger" effect="dark">
                  ✗ {{ t('noMatch') }}
                </el-tag>
              </div>
            </div>
          </div>
        </div>
      </transition>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="handleClose">{{ t('cancel') }}</el-button>
        <el-button
          :type="showTestPanel ? 'info' : 'default'"
          @click="showTestPanel = !showTestPanel"
        >
          {{ t('testRule') }}
        </el-button>
        <el-button
          type="primary"
          @click="handleSave"
        >{{ t('save') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';
import { Delete, Plus, Close } from '@element-plus/icons-vue';
import type { FormInstance, FormRules } from 'element-plus';
import type { ProxyRule } from '@/utils/types';
import { useI18n } from '@/composables/useI18n';

const props = defineProps<{
  visible: boolean;
  rule: ProxyRule | null;
  /** 模板预填充数据（仅在 rule 为 null 时生效，用于快速模板） */
  initialData?: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'> | null;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  save: [rule: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>];
}>();

const { t } = useI18n();

const formRef = ref<FormInstance>();

const defaultForm = {
  name: '',
  matchType: 'wildcard' as ProxyRule['matchType'],
  matchPattern: '',
  targetUrl: '',
  priority: 10,
  enabled: true,
  requestBodyOverride: '',
  responseStatus: undefined as number | undefined,
};

const form = reactive({ ...defaultForm });
const headerList = ref<{ key: string; value: string }[]>([]);
const responseHeaderList = ref<{ key: string; value: string }[]>([]);
const bodyReplacementList = ref<{ path: string; value: string }[]>([]);
const enableRequestBodyOverride = ref(false);
const enableResponseOverrides = ref(false);

// Test panel state
const showTestPanel = ref(false);
const testUrl = ref('');
const testResult = ref<{ matched: boolean; rewrittenUrl: string } | null>(null);

const formRules: FormRules = {
  name: [{ required: true, message: t('ruleNameRequired'), trigger: 'blur' }],
  matchPattern: [
    { required: true, message: t('matchPatternRequired'), trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (form.matchType === 'regex') {
          try {
            new RegExp(value);
            callback();
          } catch {
            callback(new Error(t('invalidRegex')));
          }
        } else {
          callback();
        }
      },
      trigger: 'blur',
    },
  ],
  targetUrl: [
    { required: true, message: t('targetUrlRequired'), trigger: 'blur' },
    {
      type: 'url',
      message: t('invalidUrl'),
      trigger: 'blur',
    },
  ],
};

const matchPatternPlaceholder = computed(() => {
  const placeholders: Record<string, string> = {
    wildcard: 'https://fat-api.example.com/*',
    prefix: 'https://fat-api.example.com',
    regex: '^https://fat-api\\.example\\.com/(.*)',
  };
  return placeholders[form.matchType] || '';
});

watch(
  () => props.visible,
  val => {
    if (val) {
      if (props.rule) {
        Object.assign(form, {
          name: props.rule.name,
          matchType: props.rule.matchType,
          matchPattern: props.rule.matchPattern,
          targetUrl: props.rule.targetUrl,
          priority: props.rule.priority,
          enabled: props.rule.enabled,
          requestBodyOverride: props.rule.requestBodyOverride ?? '',
          responseStatus: props.rule.responseOverrides?.status,
        });
        headerList.value = props.rule.headerOverrides
          ? Object.entries(props.rule.headerOverrides).map(([key, value]) => ({ key, value }))
          : [];
        enableRequestBodyOverride.value = props.rule.requestBodyOverride !== undefined;
        enableResponseOverrides.value = !!props.rule.responseOverrides;
        responseHeaderList.value = props.rule.responseOverrides?.headers
          ? Object.entries(props.rule.responseOverrides.headers).map(([key, value]) => ({ key, value }))
          : [];
        bodyReplacementList.value = props.rule.responseOverrides?.bodyReplacements
          ? Object.entries(props.rule.responseOverrides.bodyReplacements).map(([path, value]) => ({
              path,
              value: typeof value === 'string' ? value : JSON.stringify(value),
            }))
          : [];
      } else {
        const source = props.initialData ?? defaultForm;
        Object.assign(form, source);
        headerList.value = props.initialData?.headerOverrides
          ? Object.entries(props.initialData.headerOverrides).map(([key, value]) => ({ key, value }))
          : [];
        enableRequestBodyOverride.value = false;
        enableResponseOverrides.value = false;
        responseHeaderList.value = [];
        bodyReplacementList.value = [];
      }
      showTestPanel.value = false;
      testUrl.value = '';
      testResult.value = null;
    }
  },
);

// Reset test result when form pattern/target changes
watch(
  () => [form.matchPattern, form.targetUrl, form.matchType],
  () => {
    testResult.value = null;
  },
);

function addHeader() {
  headerList.value.push({ key: '', value: '' });
}

function removeHeader(index: number) {
  headerList.value.splice(index, 1);
}

function handleClose() {
  formRef.value?.resetFields();
  emit('update:visible', false);
}

async function handleSave() {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;

  const headerOverrides: Record<string, string> = {};
  headerList.value.forEach(({ key, value }) => {
    if (key.trim()) {
      headerOverrides[key.trim()] = value;
    }
  });

  const result: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'> = {
    name: form.name,
    matchType: form.matchType,
    matchPattern: form.matchPattern,
    targetUrl: form.targetUrl,
    priority: form.priority,
    enabled: form.enabled,
    headerOverrides: Object.keys(headerOverrides).length > 0 ? headerOverrides : undefined,
  };

  if (enableRequestBodyOverride.value && form.requestBodyOverride) {
    result.requestBodyOverride = form.requestBodyOverride;
  }

  if (enableResponseOverrides.value) {
    const responseOverrides: ProxyRule['responseOverrides'] = {};
    if (form.responseStatus !== undefined) {
      responseOverrides.status = form.responseStatus;
    }
    const respHeaders: Record<string, string> = {};
    responseHeaderList.value.forEach(({ key, value }) => {
      if (key.trim()) respHeaders[key.trim()] = value;
    });
    if (Object.keys(respHeaders).length > 0) {
      responseOverrides.headers = respHeaders;
    }
    const bodyReplacements: Record<string, unknown> = {};
    bodyReplacementList.value.forEach(({ path, value }) => {
      if (path.trim()) {
        try {
          bodyReplacements[path.trim()] = JSON.parse(value);
        } catch {
          bodyReplacements[path.trim()] = value;
        }
      }
    });
    if (Object.keys(bodyReplacements).length > 0) {
      responseOverrides.bodyReplacements = bodyReplacements;
    }
    if (Object.keys(responseOverrides).length > 0) {
      result.responseOverrides = responseOverrides;
    }
  }

  emit('save', result);
}

// ─── Test panel matching logic (mirrors utils/urlMatcher.ts) ────────────────

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function testMatchRule(url: string, matchType: ProxyRule['matchType'], matchPattern: string): boolean {
  switch (matchType) {
    case 'wildcard': {
      const regex = wildcardToRegex(matchPattern);
      return regex.test(url);
    }
    case 'prefix':
      return url.startsWith(matchPattern);
    case 'regex': {
      try {
        const regex = new RegExp(matchPattern);
        return regex.test(url);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

function testRewriteUrl(url: string, matchType: ProxyRule['matchType'], matchPattern: string, targetUrl: string): string {
  switch (matchType) {
    case 'wildcard': {
      const patternBase = matchPattern.replace(/\*$/, '');
      if (url.startsWith(patternBase)) {
        const rest = url.slice(patternBase.length);
        const target = targetUrl.replace(/\/$/, '');
        const separator = patternBase.endsWith('/') && rest ? '/' : '';
        return target + separator + rest;
      }
      return url;
    }
    case 'prefix': {
      if (url.startsWith(matchPattern)) {
        const rest = url.slice(matchPattern.length);
        const target = targetUrl.replace(/\/$/, '');
        return target + rest;
      }
      return url;
    }
    case 'regex': {
      try {
        const regex = new RegExp(matchPattern);
        return url.replace(regex, targetUrl);
      } catch {
        return url;
      }
    }
    default:
      return url;
  }
}

function runTest() {
  const url = testUrl.value.trim();
  if (!url || !form.matchPattern || !form.targetUrl) return;

  const matched = testMatchRule(url, form.matchType, form.matchPattern);
  const rewrittenUrl = matched ? testRewriteUrl(url, form.matchType, form.matchPattern, form.targetUrl) : '';
  testResult.value = { matched, rewrittenUrl };
}
</script>

<style scoped>
.header-overrides {
  width: 100%;
}

.header-pair {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}

.override-section {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.override-textarea {
  margin-top: 8px;
}

.response-overrides {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 8px;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 8px;
  background: var(--el-fill-color-lighter, #f5f7fa);
}

.response-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.response-field-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--el-text-color-regular, #606266);
}

/* ─── Test Panel ─────────────────────────────────────────────────────────── */
.test-panel {
  margin-top: 16px;
  border: 1px solid var(--el-border-color-light, #e4e7ed);
  border-radius: 8px;
  background: var(--el-fill-color-lighter, #f5f7fa);
  overflow: hidden;
}

.test-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5);
  background: var(--el-fill-color, #f0f2f5);
}

.test-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary, #303133);
}

.test-panel-body {
  padding: 16px;
}

.test-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.test-result {
  margin-top: 16px;
  padding: 12px;
  border-radius: 6px;
  background: var(--el-bg-color, #fff);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
}

.test-result-label {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
  margin-bottom: 8px;
}

.test-result-matched {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.test-result-rewrite {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.test-result-rewrite-label {
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}

.test-result-url {
  font-size: 13px;
  color: var(--el-color-primary, #409eff);
  word-break: break-all;
  background: var(--el-fill-color-lighter, #f5f7fa);
  padding: 6px 10px;
  border-radius: 4px;
  line-height: 1.5;
}

.test-result-no-match {
  display: flex;
  align-items: center;
}
</style>
