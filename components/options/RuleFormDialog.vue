<template>
  <el-dialog
    :model-value="visible"
    :title="rule ? t('editRule') : t('addRule')"
    width="600px"
    align-center
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
            <div
              v-if="enableResponseOverrides"
              class="response-overrides"
            >
              <div class="response-field">
                <label class="response-field-label">{{ t('responseStatusOverride') }}</label>
                <el-input-number
                  v-model="form.responseStatus"
                  :min="200"
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

        <!-- Mock 响应 -->
        <el-form-item :label="t('mockResponseLabel')">
          <div class="override-section">
            <el-switch
              v-model="enableMockResponse"
              :active-text="t('enabled')"
            />
            <div
              v-if="enableMockResponse"
              class="response-overrides"
            >
              <div class="response-field">
                <label class="response-field-label">{{ t('mockStatus') }}</label>
                <el-input-number
                  v-model="form.mockStatus"
                  :min="200"
                  :max="599"
                  controls-position="right"
                  style="width: 160px"
                />
              </div>
              <div class="response-field">
                <label class="response-field-label">{{ t('mockContentType') }}</label>
                <el-select
                  v-model="form.mockContentType"
                  style="width: 220px"
                >
                  <el-option
                    label="application/json"
                    value="application/json"
                  />
                  <el-option
                    label="text/plain"
                    value="text/plain"
                  />
                  <el-option
                    label="text/html"
                    value="text/html"
                  />
                  <el-option
                    label="application/xml"
                    value="application/xml"
                  />
                </el-select>
              </div>
              <div class="response-field">
                <label class="response-field-label">{{ t('mockBody') }}</label>
                <el-input
                  v-model="form.mockBody"
                  type="textarea"
                  :rows="5"
                  :placeholder="t('mockBodyPlaceholder')"
                />
              </div>
              <!-- 条件化 Mock 响应 -->
              <div class="response-field">
                <label class="response-field-label">{{ t('mockConditions') }}</label>
                <div
                  v-for="(cond, index) in mockConditions"
                  :key="index"
                  class="mock-condition-card"
                >
                  <div class="condition-header">
                    <span class="condition-index">#{{ index + 1 }}</span>
                    <el-button
                      type="danger"
                      link
                      @click="mockConditions.splice(index, 1)"
                    >
                      <el-icon><Delete /></el-icon>
                    </el-button>
                  </div>
                  <el-input
                    v-model="cond.matchUrl"
                    :placeholder="t('condMatchUrl')"
                    style="width: 100%"
                  />
                  <el-select
                    v-model="cond.matchMethod"
                    clearable
                    :placeholder="t('condMatchMethod')"
                    style="width: 160px"
                  >
                    <el-option
                      label="GET"
                      value="GET"
                    />
                    <el-option
                      label="POST"
                      value="POST"
                    />
                    <el-option
                      label="PUT"
                      value="PUT"
                    />
                    <el-option
                      label="DELETE"
                      value="DELETE"
                    />
                  </el-select>
                  <div
                    v-for="(qp, qi) in cond.queryPairs"
                    :key="qi"
                    class="header-pair"
                  >
                    <el-input
                      v-model="qp.key"
                      :placeholder="t('queryKeyPlaceholder')"
                      style="width: 40%"
                    />
                    <el-input
                      v-model="qp.value"
                      :placeholder="t('queryValuePlaceholder')"
                      style="width: 40%"
                    />
                    <el-button
                      type="danger"
                      link
                      @click="cond.queryPairs.splice(qi, 1)"
                    >
                      <el-icon><Delete /></el-icon>
                    </el-button>
                  </div>
                  <el-button
                    type="primary"
                    link
                    @click="cond.queryPairs.push({ key: '', value: '' })"
                  >
                    {{ t('addQueryMatch') }}
                  </el-button>
                  <el-input
                    v-model="cond.body"
                    type="textarea"
                    :rows="3"
                    :placeholder="t('condMockBody')"
                  />
                  <div style="display: flex; gap: 8px; align-items: center">
                    <el-input-number
                      v-model="cond.status"
                      :min="200"
                      :max="599"
                      controls-position="right"
                      style="width: 120px"
                    />
                    <el-select
                      v-model="cond.contentType"
                      style="width: 200px"
                    >
                      <el-option
                        label="application/json"
                        value="application/json"
                      />
                      <el-option
                        label="text/plain"
                        value="text/plain"
                      />
                      <el-option
                        label="text/html"
                        value="text/html"
                      />
                    </el-select>
                  </div>
                </div>
                <el-button
                  type="primary"
                  link
                  @click="
                    mockConditions.push({
                      matchUrl: '',
                      matchMethod: '',
                      queryPairs: [],
                      body: '',
                      status: 200,
                      contentType: 'application/json',
                    })
                  "
                >
                  <el-icon><Plus /></el-icon>
                  {{ t('addMockCondition') }}
                </el-button>
              </div>
            </div>
          </div>
        </el-form-item>

        <!-- 请求延迟 -->
        <el-form-item :label="t('delayLabel')">
          <div class="override-section">
            <el-switch
              v-model="enableDelay"
              :active-text="t('enabled')"
            />
            <div
              v-if="enableDelay"
              style="display: flex; gap: 8px; align-items: center"
            >
              <el-input-number
                v-model="form.delayMs"
                :min="0"
                :max="60000"
                :step="100"
                controls-position="right"
                style="width: 160px"
              />
              <span style="font-size: 13px; color: var(--el-text-color-secondary)">ms</span>
            </div>
          </div>
        </el-form-item>

        <!-- 请求重试 -->
        <el-form-item :label="t('retryLabel')">
          <div class="override-section">
            <el-switch
              v-model="enableRetry"
              :active-text="t('enabled')"
            />
            <div
              v-if="enableRetry"
              class="retry-fields"
            >
              <div class="retry-field-row">
                <label class="response-field-label">{{ t('retryCount') }}</label>
                <el-input-number
                  v-model="form.retryCount"
                  :min="1"
                  :max="5"
                  controls-position="right"
                  style="width: 120px"
                />
              </div>
              <div class="retry-field-row">
                <label class="response-field-label">{{ t('retryDelay') }}</label>
                <el-input-number
                  v-model="form.retryDelay"
                  :min="100"
                  :max="30000"
                  :step="500"
                  controls-position="right"
                  style="width: 160px"
                />
                <span style="font-size: 13px; color: var(--el-text-color-secondary)">ms</span>
              </div>
            </div>
          </div>
        </el-form-item>

        <!-- 请求阻断 -->
        <el-form-item :label="t('blockLabel')">
          <el-switch
            v-model="form.blocked"
            :active-text="t('blockActiveText')"
          />
        </el-form-item>

        <el-form-item :label="t('enabledLabel')">
          <el-switch v-model="form.enabled" />
        </el-form-item>
      </el-form>

      <!-- Pattern Match Test Panel -->
      <transition name="el-fade-in">
        <div
          v-if="showTestPanel"
          class="test-panel"
        >
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

            <div
              v-if="testResult !== null"
              class="test-result"
            >
              <div class="test-result-label">{{ t('matchResult') }}</div>
              <div
                v-if="testResult.matched"
                class="test-result-matched"
              >
                <el-tag
                  type="success"
                  effect="dark"
                >
                  ✓ {{ t('matched') }}
                </el-tag>
                <div class="test-result-rewrite">
                  <span class="test-result-rewrite-label">{{ t('rewrittenUrl') }}:</span>
                  <code class="test-result-url">{{ testResult.rewrittenUrl }}</code>
                </div>
              </div>
              <div
                v-else
                class="test-result-no-match"
              >
                <el-tag
                  type="danger"
                  effect="dark"
                >
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
          >{{ t('save') }}</el-button
        >
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
import { matchRule, rewriteUrl } from '@/utils/urlMatcher';

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
  mockStatus: 200,
  mockContentType: 'application/json',
  mockBody: '',
  delayMs: 1000,
  retryCount: 3,
  retryDelay: 1000,
  blocked: false,
};

const form = reactive({ ...defaultForm });
const headerList = ref<{ key: string; value: string }[]>([]);
const responseHeaderList = ref<{ key: string; value: string }[]>([]);
const bodyReplacementList = ref<{ path: string; value: string }[]>([]);
const enableRequestBodyOverride = ref(false);
const enableResponseOverrides = ref(false);
const enableMockResponse = ref(false);
const enableDelay = ref(false);
const enableRetry = ref(false);
const mockConditions = ref<
  {
    matchUrl: string;
    matchMethod: string;
    queryPairs: { key: string; value: string }[];
    body: string;
    status: number;
    contentType: string;
  }[]
>([]);

// Test panel state
const showTestPanel = ref(false);
const testUrl = ref('');
const testResult = ref<{ matched: boolean; rewrittenUrl: string } | null>(null);

// computed 保证语言切换后校验消息实时更新（一次性求值会把 t() 结果固化）
const formRules = computed<FormRules>(() => ({
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
}));

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
          mockStatus: props.rule.mockResponse?.status ?? 200,
          mockContentType: props.rule.mockResponse?.contentType ?? 'application/json',
          mockBody: props.rule.mockResponse?.body ?? '',
          delayMs: props.rule.delayMs ?? 1000,
          retryCount: props.rule.retryCount ?? 3,
          retryDelay: props.rule.retryDelay ?? 1000,
          blocked: props.rule.blocked ?? false,
        });
        headerList.value = props.rule.headerOverrides
          ? Object.entries(props.rule.headerOverrides).map(([key, value]) => ({ key, value }))
          : [];
        enableRequestBodyOverride.value = props.rule.requestBodyOverride !== undefined;
        enableResponseOverrides.value = !!props.rule.responseOverrides;
        enableMockResponse.value = !!props.rule.mockResponse;
        enableDelay.value = !!props.rule.delayMs;
        enableRetry.value = !!props.rule.retryCount;
        responseHeaderList.value = props.rule.responseOverrides?.headers
          ? Object.entries(props.rule.responseOverrides.headers).map(([key, value]) => ({ key, value }))
          : [];
        bodyReplacementList.value = props.rule.responseOverrides?.bodyReplacements
          ? Object.entries(props.rule.responseOverrides.bodyReplacements).map(([path, value]) => ({
              path,
              // 始终 JSON.stringify 保证往返一致：字符串 "123" 若裸显示，下次保存会被 parse 成数字
              value: JSON.stringify(value),
            }))
          : [];
        mockConditions.value =
          props.rule.mockResponse?.conditions?.map(c => ({
            matchUrl: c.matchUrl ?? '',
            matchMethod: c.matchMethod ?? '',
            queryPairs: c.matchQuery ? Object.entries(c.matchQuery).map(([key, value]) => ({ key, value })) : [],
            body: c.body,
            status: c.status ?? 200,
            contentType: c.contentType ?? 'application/json',
          })) ?? [];
      } else {
        const source = props.initialData ?? defaultForm;
        Object.assign(form, source);
        headerList.value = props.initialData?.headerOverrides
          ? Object.entries(props.initialData.headerOverrides).map(([key, value]) => ({ key, value }))
          : [];
        // 预填数据（模板/日志建规则等）可能携带请求体覆盖，按其存在与否初始化开关，
        // 硬编码 false 会让保存逻辑丢弃已赋值的 requestBodyOverride
        enableRequestBodyOverride.value = props.initialData?.requestBodyOverride !== undefined;
        enableResponseOverrides.value = false;
        enableMockResponse.value = false;
        enableDelay.value = false;
        enableRetry.value = false;
        // initialData 不含 blocked，Object.assign 不会重置它，需显式清除上一条规则遗留的拦截状态
        form.blocked = false;
        responseHeaderList.value = [];
        bodyReplacementList.value = [];
        mockConditions.value = [];
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

  if (enableMockResponse.value && form.mockBody) {
    result.mockResponse = {
      body: form.mockBody,
      contentType: form.mockContentType,
      status: form.mockStatus,
    };
    // 条件化 Mock
    const conditions = mockConditions.value
      .filter(c => c.body || c.matchUrl || c.matchMethod || c.queryPairs.some(q => q.key))
      .map(c => {
        const cond: import('@/utils/types').MockCondition = { body: c.body };
        if (c.matchUrl) cond.matchUrl = c.matchUrl;
        if (c.matchMethod) cond.matchMethod = c.matchMethod;
        const queryPairs = c.queryPairs.filter(q => q.key);
        if (queryPairs.length > 0) {
          cond.matchQuery = Object.fromEntries(queryPairs.map(q => [q.key, q.value]));
        }
        if (c.status !== 200) cond.status = c.status;
        if (c.contentType !== 'application/json') cond.contentType = c.contentType;
        return cond;
      });
    if (conditions.length > 0) {
      result.mockResponse.conditions = conditions;
    }
  }

  if (enableDelay.value && form.delayMs > 0) {
    result.delayMs = form.delayMs;
  }

  if (enableRetry.value) {
    result.retryCount = form.retryCount;
    result.retryDelay = form.retryDelay;
  }

  if (form.blocked) {
    result.blocked = true;
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

// ─── Test panel matching logic（直接复用 utils/urlMatcher，与生产通道语义一致）───

function runTest() {
  const url = testUrl.value.trim();
  if (!url || !form.matchPattern || !form.targetUrl) return;

  // 构造临时规则供 matcher 使用（仅用于测试，不写入存储）
  const testRule: ProxyRule = {
    id: '__test__',
    name: '__test__',
    enabled: true,
    matchType: form.matchType,
    matchPattern: form.matchPattern,
    targetUrl: form.targetUrl,
    priority: 1,
    createdAt: 0,
    updatedAt: 0,
  };

  const matched = matchRule(url, testRule);
  const rewrittenUrl = matched ? rewriteUrl(url, testRule) : '';
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
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}

.override-textarea {
  margin-top: 8px;
}

.response-overrides {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 12px;
  margin-top: 8px;
  background: var(--el-fill-color-lighter, #f5f7fa);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 8px;
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
  overflow: hidden;
  background: var(--el-fill-color-lighter, #f5f7fa);
  border: 1px solid var(--el-border-color-light, #e4e7ed);
  border-radius: 8px;
}

.test-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--el-fill-color, #f0f2f5);
  border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5);
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
  padding: 12px;
  margin-top: 16px;
  background: var(--el-bg-color, #fff);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 6px;
}

.test-result-label {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
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
  padding: 6px 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--el-color-primary, #409eff);
  word-break: break-all;
  background: var(--el-fill-color-lighter, #f5f7fa);
  border-radius: 4px;
}

.test-result-no-match {
  display: flex;
  align-items: center;
}

/* ─── Retry Fields ────────────────────────────────────────────────────────── */

.retry-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.retry-field-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* ─── Mock Condition Cards ────────────────────────────────────────────────── */

.mock-condition-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  margin-bottom: 8px;
  background: var(--el-bg-color, #fff);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 6px;
}

.condition-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.condition-index {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary, #909399);
}
</style>
