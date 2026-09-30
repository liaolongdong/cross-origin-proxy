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
          <div class="field-hint">
            {{ t('targetUrlHint') }}
          </div>
          <!-- 正则的「捕获组 ↔ 引用」对照条
               判据全部取自 `utils/dnrRules.ts`（`captureGroupOffsets` / `buildRegexSubstitution` /
               `MAX_DNR_SUBSTITUTION_REF`），这里不写第二份括号语法：规则列表里那个「未生效」标记
               走的也是同一条 `isSubstitutionValid`，两处一旦各算各的，表单说「没问题」而列表标红的
               就是本条铁律里最贵的那类分歧。只诊断、不改分流，也不拦保存。 -->
          <div
            v-if="regexRefs"
            class="regex-refs"
          >
            <div class="regex-refs-head">
              <span class="regex-refs-title">{{ t('regexRefsTitle') }}</span>
              <span
                v-if="regexRefs.groupCount > 0"
                class="regex-refs-count"
                >{{ t('regexRefCount', [regexRefs.groupCount]) }}</span
              >
              <span
                v-else
                class="regex-refs-count"
                >{{ t('regexRefCountNone') }}</span
              >
            </div>
            <div
              v-if="regexRefs.groups.length"
              class="capture-chips"
            >
              <span
                v-for="group in regexRefs.groups"
                :key="group.number"
                :class="group.className"
              >
                <b>{{ group.label }}</b>
                <code>{{ group.snippet }}</code>
              </span>
            </div>
            <p
              v-for="item in regexRefs.refChecks"
              :key="item.text"
              :class="item.className"
            >
              <code>{{ item.text }}</code>
              <span>{{ item.message }}</span>
            </p>
            <p
              v-if="regexRefs.unusedMessage"
              class="capture-ref is-warn"
            >
              {{ regexRefs.unusedMessage }}
            </p>
            <p :class="regexRefs.summary.className">
              {{ regexRefs.summary.message }}
            </p>
            <p class="regex-refs-note">
              {{ regexRefs.syntaxNote }}
            </p>
            <p class="regex-refs-note">
              {{ regexRefs.channelNote }}
            </p>
          </div>
        </el-form-item>

        <el-form-item
          :label="t('priorityLabel')"
          prop="priority"
        >
          <el-input-number
            v-model="form.priority"
            :min="1"
            :max="999"
            :step="1"
            :precision="0"
            step-strictly
          />
        </el-form-item>

        <el-form-item :label="t('methodsLabel')">
          <div class="header-overrides">
            <el-select
              v-model="methodsList"
              multiple
              clearable
              collapse-tags
              collapse-tags-tooltip
              :placeholder="t('methodsPlaceholder')"
              style="width: 100%"
            >
              <el-option
                v-for="method in HTTP_METHODS"
                :key="method"
                :label="method"
                :value="method"
              />
            </el-select>
            <div class="field-hint">{{ t('methodsHint') }}</div>
          </div>
        </el-form-item>

        <el-form-item :label="t('queryOverridesLabel')">
          <div class="header-overrides">
            <div
              v-for="(query, index) in queryList"
              :key="query.uid"
              class="header-pair"
            >
              <el-input
                v-model="query.key"
                :placeholder="t('queryKeyPlaceholder')"
                style="width: 40%"
              />
              <el-input
                v-model="query.value"
                :placeholder="t('queryValuePlaceholder')"
                style="width: 40%"
              />
              <el-button
                type="danger"
                link
                @click="removeQuery(index)"
              >
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
            <el-button
              type="primary"
              link
              @click="addQuery"
            >
              <el-icon><Plus /></el-icon>
              {{ t('addQueryParam') }}
            </el-button>
            <div class="field-hint">{{ t('queryOverridesHint') }}</div>
          </div>
        </el-form-item>

        <el-form-item :label="t('headerOverridesLabel')">
          <div class="header-overrides">
            <div
              v-for="(header, index) in headerList"
              :key="header.uid"
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
            <div class="field-hint">{{ t('headerOverridesHint') }}</div>
          </div>
        </el-form-item>

        <!-- 携带目标环境 Cookie（仅 SW 通道） -->
        <el-form-item :label="t('sendCredentialsLabel')">
          <div class="header-overrides">
            <el-switch v-model="form.sendCredentials" />
            <div class="field-hint">{{ t('sendCredentialsHint') }}</div>
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
                <label class="response-field-label">{{ t('responseStatusTextOverride') }}</label>
                <el-input
                  v-model="form.responseStatusText"
                  :placeholder="t('responseStatusTextPlaceholder')"
                  maxlength="120"
                  show-word-limit
                />
                <!-- 状态行必须是一段 ByteString：`utils/proxyResponse.ts` 会在构造 Response 前
                     把码点 > 255 的字符与换行剔除（不剔除的话 `new Response` 当场抛 TypeError，
                     抛出点在拦截器的 resolve 回调里，页面从此永久 pending）。这里不拦保存，
                     只把「实际发出去的是哪一句」摆在眼前——存量导入规则里那种中文状态行
                     不该反过来把无关的编辑（改优先级、改名）顶在门外。 -->
                <div
                  v-if="statusTextEffective !== null"
                  class="field-hint field-hint-warning"
                >
                  {{ t('responseStatusTextStripped') }}
                  <code class="field-hint-value">{{ statusTextEffective || t('responseStatusTextEmpty') }}</code>
                </div>
              </div>
              <div class="response-field">
                <label class="response-field-label">{{ t('responseHeadersOverride') }}</label>
                <div
                  v-for="(header, index) in responseHeaderList"
                  :key="header.uid"
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
                  @click="addResponseHeader"
                >
                  <el-icon><Plus /></el-icon>
                  {{ t('addHeader') }}
                </el-button>
              </div>
              <div class="response-field">
                <label class="response-field-label">{{ t('responseBodyReplacements') }}</label>
                <div
                  v-for="(replacement, index) in bodyReplacementList"
                  :key="replacement.uid"
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
                  @click="addBodyReplacement"
                >
                  <el-icon><Plus /></el-icon>
                  {{ t('addReplacement') }}
                </el-button>
                <!-- 整段替换与逐项替换是同一格「响应正文」的两种写法，引擎只认前者
                     （`entrypoints/background/proxyHandler.ts` 的 `applyResponseOverrides` 里
                     `bodyRaw` 命中后，逐项替换那一段在 `else if` 分支里根本不执行）。
                     两份都留在表单里是为了「把整段清空就回到逐项替换」这条退路，
                     但那一刻必须说出来，否则用户看到的是「路径替换填了却没生效」。 -->
                <div
                  v-if="bodyRawShadowsReplacements"
                  class="field-hint field-hint-warning"
                >
                  {{ t('responseBodyRawShadowsReplacements') }}
                </div>
              </div>
              <div class="response-field">
                <label class="response-field-label">{{ t('responseBodyRawLabel') }}</label>
                <el-input
                  v-model="form.responseBodyRaw"
                  type="textarea"
                  :rows="4"
                  :placeholder="t('responseBodyRawPlaceholder')"
                />
                <div class="field-hint">
                  {{ t('responseBodyRawHint') }}
                </div>
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
                  :key="cond.uid"
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
                    :key="qp.uid"
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
                    @click="addMockQueryPair(cond)"
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
                  @click="addMockCondition"
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
                :disabled="!testUrl.trim() || !form.matchPattern"
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
                  <!-- 拆成「共用开头 / 这次换进来的 / 共用结尾」三段：读者要看的从来不是两个长地址
                       像不像，而是这条规则动了哪一段。`:key` 让每次按下测试重新起头那段一闪。
                       三段是同一份 `v-for` 渲染出来的，`<code>` 里不留空白兄弟，URL 不会被拆出空格。 -->
                  <code
                    :key="testRunSeq"
                    class="test-result-url"
                  >
                    <span
                      v-for="(segment, index) in rewriteSegments"
                      :key="index"
                      :class="{ 'url-changed': segment.changed }"
                      >{{ segment.text }}</span
                    >
                  </code>
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
          :loading="saving"
          @click="handleSave"
          >{{ t('save') }}</el-button
        >
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { Delete, Plus, Close } from '@element-plus/icons-vue';
import type { FormInstance, FormRules } from 'element-plus';
import type { ProxyRule } from '@/utils/types';
import { HTTP_METHODS } from '@/utils/types';
import { DEFAULT_RULE_PRIORITY } from '@/utils/constants';
import { useI18n } from '@/composables/useI18n';
import { findInvalidHeaderNames } from '@/utils/headerValidation';
import { matchRule, rewriteUrl, applyQueryOverrides, isWebSocketRule } from '@/utils/urlMatcher';
import {
  captureGroupOffsets,
  substitutionRefs,
  buildRegexFilter,
  buildRegexSubstitution,
  isSubstitutionValid,
  MAX_DNR_SUBSTITUTION_REF,
} from '@/utils/dnrRules';
import { toLatin1StatusText } from '@/utils/proxyResponse';
import { diffRewrite } from '@/utils/rewriteDiff';
import { collectRuleVariableRefs, findUndefinedVariableRefs, newlyIntroducedRefs } from '@/utils/variables';
import { useVariables } from '@/composables/useVariables';

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

// 变量表只用于保存前的引用校验；真值从不经界面写入规则，规则里存的一直是 `{{名称}}` 字面量
const { variables, loadVariables } = useVariables();
/** 变量表是否读到过：没读到就别拿它去否决用户的保存 */
const variableNamesLoaded = ref(false);
/**
 * 变量表这一趟读取的 promise（打开弹窗时挂上）
 *
 * 保存闸门等的是它，不是「旗标为假就当读失败」（M-7）：SW 冷启动那几百毫秒里点保存，
 * 读失败与还在路上在旗标上完全同形，按旗标放过的结果是规则静默落盘、运行时原样发出
 * `{{TOKEN}}`，用户只看到一次看不懂的上游 401。
 */
let variablesLoad: Promise<boolean> | null = null;
/**
 * 保存是否在途（按钮的 `:loading`）
 *
 * `validate()` 与变量表那一趟都要 await，弹窗在此期间一直开着、按钮一直可点；
 * 而 `ADD_RULE` 只做 append（去重只在导入侧跑），连点两下就是两条同名同模式的规则。
 * 父组件那一侧还有一道同族的旗标，接住「本组件已把请求交出去、存储写入还在途」的那一段。
 */
const saving = ref(false);
/**
 * 打开时这条规则里已经写着的引用名，两道保存闸门各自按它过滤（见 `handleSave`）：
 * 闸门拦的是这次新写进去的引用，不是存储里本来就有的那一句。
 *
 * WS 那道单独存查询参数一侧，且只认「存储里那条本身就是 WS」的引用：前者是因为把 `{{X}}` 从
 * 请求头挪到查询参数对 WS 规则是**新**造出一份静默坏配置（那一侧读不到变量表），后者是因为把一条
 * 非 WS 的存量规则改成 WS，那句引用同样是这次才够到那条路的。少任一条件都是漏掉设计好的拒绝。
 */
const baselineVarNames = ref<string[]>([]);
const baselineWsQueryVarNames = ref<string[]>([]);

const formRef = ref<FormInstance>();

const defaultForm = {
  name: '',
  matchType: 'wildcard' as ProxyRule['matchType'],
  matchPattern: '',
  targetUrl: '',
  priority: DEFAULT_RULE_PRIORITY,
  enabled: true,
  requestBodyOverride: '',
  responseStatus: undefined as number | undefined,
  /**
   * 状态行文本（`responseOverrides.statusText`）
   *
   * 空串按「不覆盖」处理，见 `submitRule` 里那句 `!== ''` 判据——`new Response` 允许空状态行，
   * 但把用户没填的字段写成「覆盖为空」会让上游那句 `OK` 凭空消失。
   */
  responseStatusText: '',
  /** 整段替换的响应体，优先级高于 JSON 路径替换（`entrypoints/background/proxyHandler.ts` 的 `applyResponseOverrides`） */
  responseBodyRaw: '',
  mockStatus: 200,
  mockContentType: 'application/json',
  mockBody: '',
  delayMs: 1000,
  retryCount: 3,
  retryDelay: 1000,
  blocked: false,
  sendCredentials: false,
};

const form = reactive({ ...defaultForm });

/**
 * 可编辑行的稳定 key
 *
 * 表单里六个列表（请求头、查询参数、响应头、响应体替换、Mock 条件、条件里的查询参数）都能从
 * 中间删一行。以 `index` 为 key 时，删掉中间那行会把后面每一行的输入框实例往前挪一位复用：
 * 正在用 IME 组合的那半截字符跟着串到相邻行，焦点与校验态也一起错位，且没有任何报错。
 * 一个组件内的自增 id 就够——它只服务渲染，保存时按字段重建对象自然不带出去（`SettingsDialog`
 * 的变量行是同一做法）。
 */
let rowUidSeed = 0;
const nextRowUid = (): number => ++rowUidSeed;

/** 给刚建出来的一行补上 key；初始化与「新增一行」共用，避免某个入口漏加导致 key 为 `undefined` */
function withUid<T extends object>(row: T): T & { uid: number } {
  return { ...row, uid: nextRowUid() };
}

/**
 * 头 / 查询参数的可编辑行
 *
 * `uid` 只做列表 key（见 `nextRowUid`），不进规则数据——保存处按字段解构重建对象，它自然落下。
 */
interface PairRow {
  uid: number;
  key: string;
  value: string;
}
/** 响应体 JSON 路径替换行，`uid` 同上 */
interface ReplacementRow {
  uid: number;
  path: string;
  value: string;
}
/** 一条条件化 Mock 响应，`uid` 同上；嵌套的 `queryPairs` 与外面的列表同样支持中间删行 */
interface MockConditionRow {
  uid: number;
  matchUrl: string;
  matchMethod: string;
  queryPairs: PairRow[];
  body: string;
  status: number;
  contentType: string;
}
const headerList = ref<PairRow[]>([]);
const responseHeaderList = ref<PairRow[]>([]);
const bodyReplacementList = ref<ReplacementRow[]>([]);
const enableRequestBodyOverride = ref(false);
const enableResponseOverrides = ref(false);
const enableMockResponse = ref(false);
const enableDelay = ref(false);
const enableRetry = ref(false);
const mockConditions = ref<MockConditionRow[]>([]);

// 规则级 HTTP 方法白名单（空=任意方法）与查询参数追加/覆盖列表
const methodsList = ref<string[]>([]);
const queryList = ref<PairRow[]>([]);

// Test panel state
const showTestPanel = ref(false);
const testUrl = ref('');
const testResult = ref<{ matched: boolean; rewrittenUrl: string; testedUrl: string } | null>(null);
/** 第几次按下「测试」：只用来给高亮重新起头，让连点两次也能看见结果确实又算了一遍 */
const testRunSeq = ref(0);

/**
 * 改写结果按「动了哪一段」拆开
 *
 * 通配符与正则的替换对新用户并不直观（`*` 捕获到的那截到底去了哪里），而让读者在两个长地址
 * 之间逐字找差异，基本等于没告诉任何人任何事。这里只高亮，不改写判定——`rewrittenUrl` 仍然
 * 是 `rewriteUrl` 的原样输出，三段拼回去必然等于它（`utils/rewriteDiff.ts` 有单测钉住这条）。
 * 求差用的是**按下「测试」那一刻的那个地址**（`testedUrl`），不是输入框里当前的：结果是上一次
 * 按出来的，拿新地址去对旧结果，高亮会指着几个谁也没测过的字符说「这就是被换掉的那一段」。
 */
const rewriteSegments = computed(() => {
  const result = testResult.value;
  if (!result?.matched) return [];
  const { before, changed, after } = diffRewrite(result.testedUrl, result.rewrittenUrl);
  return [
    { text: before, changed: false },
    { text: changed, changed: true },
    { text: after, changed: false },
  ].filter(segment => segment.text !== '');
});

/**
 * 状态行文本填了会被改掉时，给出「浏览器实际收到的那一句」
 *
 * 只在内容确实会被收敛时开口（其余情况 `null`，那时无话可说）。判据借运行时那一份
 * `toLatin1StatusText`，而不是照注释重述一遍「Latin-1、不含换行」——两处一旦分叉，
 * 这里承诺的收敛就是假的。
 */
const statusTextEffective = computed<string | null>(() => {
  const raw = form.responseStatusText;
  if (raw === '') return null;
  const kept = toLatin1StatusText(raw);
  return kept === raw ? null : kept;
});

/**
 * 整段替换正文是否压住了下面的 JSON 路径替换
 *
 * 引擎侧是 `bodyRaw !== undefined` 先命中、逐项替换那一段根本不执行（`proxyHandler.ts` 的
 * `applyResponseOverrides`），所以两份都在时「填了却没生效」是必然结果而不是故障。
 * 判据用 `trim()`：一整框空白看着像填了，落盘时却被当成没填，提示跟着落盘判据走才不会自相矛盾。
 */
const bodyRawShadowsReplacements = computed(
  () => form.responseBodyRaw.trim() !== '' && bodyReplacementList.value.some(row => row.path.trim() !== ''),
);

/** 对照条里每个捕获组从模式原文截取的最大字符数（够认出是哪一段，又不至于撑出新滚动区） */
const CAPTURE_SNIPPET_LIMIT = 28;

/**
 * 正则模式的「捕获组 ↔ 替换引用」对照
 *
 * 这是本表单最容易「填对了但结果不对」的一组字段：模式里的括号、目标地址里的 `$1`、
 * 网络层替换串里的 `\1`，三者对不对得上一句报错都不会说，只在浏览器里表现为
 * 「代理好像没生效」（引用越界更是整批 `updateDynamicRules` 被拒，连累所有简单规则）。
 *
 * 所有判据一律借 `utils/dnrRules.ts`：`captureGroupOffsets` 数括号、`substitutionRefs` 按
 * DNR 的贪婪法读引用、`isSubstitutionValid` 给总结句——同一条判据也住在规则列表那个
 * 「未生效」标记背后（`utils/dnrSupport.ts`），这里另写一份就会长出两个答案。
 * **只对照、不拦保存**：语法错误由 `invalidRegex` 那条校验负责，越界引用由列表标记负责，
 * 表单不新增第三道拒绝（存量导入的规则照样能改名字、改优先级）。
 */
const regexRefs = computed(() => {
  if (form.matchType !== 'regex') return null;
  const pattern = form.matchPattern;
  const target = form.targetUrl;
  // 空目标是合法语义（不改写地址，见 `targetUrlHint`），此刻没有替换串可对照
  if (!pattern || !target) return null;
  try {
    new RegExp(pattern);
  } catch {
    return null;
  }

  const offsets = captureGroupOffsets(pattern);
  const groupCount = offsets.length;
  // 引用按「网络层实际读到的那一份」来数：`buildRegexSubstitution` 把 `$n` 换成 `\n`，
  // `substitutionRefs` 再按 DNR 的读法整段取数字（`\12` 是一个引用，不是 `\1` 加个 `2`）。
  const dnrSubstitution = buildRegexSubstitution({
    matchType: 'regex',
    matchPattern: pattern,
    targetUrl: target,
  });
  const refs = [...new Set(substitutionRefs(dnrSubstitution))].sort((a, b) => a - b);
  const usedIndexes = new Set(refs.filter(reference => reference >= 1));

  return {
    groupCount,
    groups: offsets.map((offset, index) => {
      const number = index + 1;
      const snippet = pattern.slice(offset, offset + CAPTURE_SNIPPET_LIMIT);
      return {
        number,
        label: `$${number}`,
        snippet: offset + CAPTURE_SNIPPET_LIMIT < pattern.length ? `${snippet}…` : snippet,
        // 编号 10 起只有转发通道拿得到（网络层按单个数字读替换串），所以「被引用」不等于「没问题」
        className:
          number > MAX_DNR_SUBSTITUTION_REF
            ? 'capture-chip is-warn'
            : usedIndexes.has(number)
              ? 'capture-chip is-used'
              : 'capture-chip',
      };
    }),
    refChecks: refs.map(reference => {
      const text = `$${reference}`;
      // `<code>` 里已经是那串引用本身，措辞接在它后面读，所以消息里不再复述编号
      if (reference === 0) {
        return { text, className: 'capture-ref', message: t('regexRefWholeMatch') };
      }
      if (reference > groupCount) {
        return {
          text,
          className: 'capture-ref is-danger',
          message: groupCount === 0 ? t('regexRefNoGroupAtAll') : t('regexRefOutOfRange', [groupCount]),
        };
      }
      if (reference > MAX_DNR_SUBSTITUTION_REF) {
        return { text, className: 'capture-ref is-warn', message: t('regexRefBeyondNine') };
      }
      return { text, className: 'capture-ref is-ok', message: t('regexRefOk') };
    }),
    unusedMessage: groupCount > 0 && refs.length === 0 ? t('regexRefUnused') : null,
    summary: isSubstitutionValid(buildRegexFilter({ matchType: 'regex', matchPattern: pattern }), dnrSubstitution)
      ? { className: 'capture-summary is-ok', message: t('regexSummaryOk') }
      : { className: 'capture-summary is-danger', message: t('regexSummaryRejected') },
    syntaxNote: t('regexRefSyntaxNote'),
    channelNote: t('regexRefChannelNote'),
  };
});

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
    // 只校验格式、不校验必填：空目标是合法语义（不改写地址，仅由扩展转发并注入头/参数），
    // 见 utils/urlMatcher.ts 的 isSimpleRule 与 rewriteUrl 空目标分支。
    // async-validator 的 type 规则在未声明 required 时会跳过空值，因此非空才做格式校验。
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

// `immediate` 不可省：本弹窗是异步分片，`#add-rule` / `#add-rule-from-tab=` hash 直达时
// 父组件 onMounted 已把 visible 置为 true，分片取回后组件是带着 visible === true 挂载的，
// 无 immediate 的 watcher 永不触发 → 打开一个空白表单，被预填/编辑的规则静默丢失。
watch(
  () => props.visible,
  val => {
    if (val) {
      // 每次打开重新拉一遍引用名：设置页可能刚改过表，拿旧表校验会误报「未定义」
      variableNamesLoaded.value = false;
      saving.value = false;
      variablesLoad = loadVariables().then(ok => {
        variableNamesLoaded.value = ok;
        return ok;
      });
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
          responseStatusText: props.rule.responseOverrides?.statusText ?? '',
          responseBodyRaw: props.rule.responseOverrides?.bodyRaw ?? '',
          mockStatus: props.rule.mockResponse?.status ?? 200,
          mockContentType: props.rule.mockResponse?.contentType ?? 'application/json',
          mockBody: props.rule.mockResponse?.body ?? '',
          delayMs: props.rule.delayMs ?? 1000,
          retryCount: props.rule.retryCount ?? 3,
          retryDelay: props.rule.retryDelay ?? 1000,
          blocked: props.rule.blocked ?? false,
          sendCredentials: props.rule.sendCredentials ?? false,
        });
        headerList.value = props.rule.headerOverrides
          ? Object.entries(props.rule.headerOverrides).map(([key, value]) => withUid({ key, value }))
          : [];
        enableRequestBodyOverride.value = props.rule.requestBodyOverride !== undefined;
        enableResponseOverrides.value = !!props.rule.responseOverrides;
        enableMockResponse.value = !!props.rule.mockResponse;
        enableDelay.value = !!props.rule.delayMs;
        enableRetry.value = !!props.rule.retryCount;
        responseHeaderList.value = props.rule.responseOverrides?.headers
          ? Object.entries(props.rule.responseOverrides.headers).map(([key, value]) => withUid({ key, value }))
          : [];
        bodyReplacementList.value = props.rule.responseOverrides?.bodyReplacements
          ? Object.entries(props.rule.responseOverrides.bodyReplacements).map(([path, value]) =>
              withUid({
                path,
                // 始终 JSON.stringify 保证往返一致：字符串 "123" 若裸显示，下次保存会被 parse 成数字
                value: JSON.stringify(value),
              }),
            )
          : [];
        mockConditions.value =
          props.rule.mockResponse?.conditions?.map(c =>
            withUid({
              matchUrl: c.matchUrl ?? '',
              matchMethod: c.matchMethod ?? '',
              queryPairs: c.matchQuery
                ? Object.entries(c.matchQuery).map(([key, value]) => withUid({ key, value }))
                : [],
              body: c.body,
              status: c.status ?? 200,
              contentType: c.contentType ?? 'application/json',
            }),
          ) ?? [];
        methodsList.value = props.rule.methods ? [...props.rule.methods] : [];
        queryList.value = props.rule.queryOverrides
          ? Object.entries(props.rule.queryOverrides).map(([key, value]) => withUid({ key, value }))
          : [];
      } else {
        const source = props.initialData ?? defaultForm;
        Object.assign(form, source);
        headerList.value = props.initialData?.headerOverrides
          ? Object.entries(props.initialData.headerOverrides).map(([key, value]) => withUid({ key, value }))
          : [];
        // 预填数据（模板/日志建规则等）可能携带请求体覆盖，按其存在与否初始化开关，
        // 硬编码 false 会让保存逻辑丢弃已赋值的 requestBodyOverride
        enableRequestBodyOverride.value = props.initialData?.requestBodyOverride !== undefined;
        enableResponseOverrides.value = false;
        enableMockResponse.value = false;
        enableDelay.value = false;
        enableRetry.value = false;
        // initialData 不含 blocked / sendCredentials，Object.assign 不会重置它们，
        // 需显式清除上一条规则遗留的拦截与凭据状态
        form.blocked = false;
        form.sendCredentials = false;
        // 同一件事也适用于这一组响应覆盖字段：`initialData` 里只有 `responseOverrides` 整个对象，
        // 没有这三格（状态码、状态行文本、整段正文），于是 Object.assign 不会覆盖上一次的残留。
        // 开关下面已经置 false，所以残留值进不了规则——但它会在用户这一次把开关打开时
        // 直接显现在输入框里，看起来像是新建规则自带的默认值。
        form.responseStatus = undefined;
        form.responseStatusText = '';
        form.responseBodyRaw = '';
        responseHeaderList.value = [];
        bodyReplacementList.value = [];
        mockConditions.value = [];
        methodsList.value = [];
        queryList.value = [];
      }
      // 基线取的是「存储里那条规则」而不是刚填进表单的数据：预填路径（initialData）带着
      // 空基线，那些引用与用户新敲进去的一句没有区别
      baselineVarNames.value = props.rule ? collectRuleVariableRefs(props.rule) : [];
      // WS 那道多一道条件：非 WS 的存量规则改成 WS 时，查询参数里那句引用与新建时无异，照旧要拦
      baselineWsQueryVarNames.value =
        props.rule && isWebSocketRule(props.rule)
          ? collectRuleVariableRefs({ queryOverrides: props.rule.queryOverrides })
          : [];
      showTestPanel.value = false;
      testUrl.value = '';
      testResult.value = null;
    }
  },
  { immediate: true },
);

// Reset test result when form pattern/target changes
watch(
  () => [form.matchPattern, form.targetUrl, form.matchType],
  () => {
    testResult.value = null;
  },
);

function addHeader() {
  headerList.value.push(withUid({ key: '', value: '' }));
}

function removeHeader(index: number) {
  headerList.value.splice(index, 1);
}

function addQuery() {
  queryList.value.push(withUid({ key: '', value: '' }));
}

function removeQuery(index: number) {
  queryList.value.splice(index, 1);
}

/** 响应头：模板里原本直接 `push({ key: '', value: '' })`，补 key 得有个出口 */
function addResponseHeader() {
  responseHeaderList.value.push(withUid({ key: '', value: '' }));
}

/** 响应体 JSON 路径替换行 */
function addBodyReplacement() {
  bodyReplacementList.value.push(withUid({ path: '', value: '' }));
}

/** 一条条件化 Mock 响应（默认值与模板里原先那份内联对象一致） */
function addMockCondition() {
  mockConditions.value.push(
    withUid({
      matchUrl: '',
      matchMethod: '',
      queryPairs: [],
      body: '',
      status: 200,
      contentType: 'application/json',
    }),
  );
}

/** 某条 Mock 条件里的查询参数匹配行 */
function addMockQueryPair(cond: MockConditionRow) {
  cond.queryPairs.push(withUid({ key: '', value: '' }));
}

/**
 * 挑出「行 → 名称」列表里重复的名字
 *
 * 四张可变长列表落到规则里都是 `Record<string, string>`：同一个名称写两行，后一行静默盖掉前一行，
 * 而界面上两行都还在，看着像两条都生效。空行跳过（没填名称的行本来就不进记录）。
 * 头名按 HTTP 口径不区分大小写，查询参数名与 JSON 路径是精确匹配，所以分开判。
 */
function findDuplicateNames(names: string[], caseInsensitive: boolean): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const dedupeKey = caseInsensitive ? name.toLowerCase() : name;
    if (seen.has(dedupeKey) && !duplicates.includes(name)) duplicates.push(name);
    seen.add(dedupeKey);
  }
  return duplicates;
}

/**
 * 同名条目只提醒、不拦保存（L-9）
 *
 * 拦下来会把已有这种形状的老规则（导入、手改 storage 都可能带进来）变成存不动的死路，
 * 而重复本身不是错误——用户大概率只是想改其中一个值，只是忘了删另一行。所以保存照走，
 * 话要说一句：哪个列表里的哪个名称，最后一条才算数。
 */
function warnAboutDuplicateNames(): void {
  const segments: string[] = [];
  const pushSegment = (label: string, names: string[], caseInsensitive: boolean) => {
    const duplicates = findDuplicateNames(names, caseInsensitive);
    if (duplicates.length > 0) segments.push(`${label}: ${duplicates.join(', ')}`);
  };
  pushSegment(
    t('headerOverridesLabel'),
    headerList.value.map(header => header.key),
    true,
  );
  if (enableResponseOverrides.value) {
    pushSegment(
      t('responseHeadersOverride'),
      responseHeaderList.value.map(header => header.key),
      true,
    );
    pushSegment(
      t('responseBodyReplacements'),
      bodyReplacementList.value.map(replacement => replacement.path),
      false,
    );
  }
  pushSegment(
    t('queryOverridesLabel'),
    queryList.value.map(query => query.key),
    false,
  );
  // 连接符不用任何一侧语言的标点：这条消息中英共用一个模板
  if (segments.length > 0) ElMessage.warning(t('duplicateOverrideNames', [segments.join(' · ')]));
}

function handleClose() {
  formRef.value?.resetFields();
  emit('update:visible', false);
}

async function submitRule() {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;

  // 保存侧拦截非法头条目：这类规则存进去会在请求时被整体拒绝（页面拿到 status 0），
  // 表单这里报错比运行时日志更早、更可修正。判据与后台运行时同源（utils/headerValidation）。
  const invalidRequestHeaders = findInvalidHeaderNames(headerList.value);
  if (invalidRequestHeaders.length > 0) {
    ElMessage.error(t('invalidRequestHeader', [invalidRequestHeaders.join(', ')]));
    return;
  }
  if (enableResponseOverrides.value) {
    const invalidResponseHeaders = findInvalidHeaderNames(responseHeaderList.value);
    if (invalidResponseHeaders.length > 0) {
      ElMessage.error(t('invalidResponseHeader', [invalidResponseHeaders.join(', ')]));
      return;
    }
  }

  // 同名条目在这一刻起只会生效最后一条，先说清楚再往下拼记录（拦不得，见该函数注释）
  warnAboutDuplicateNames();

  const headerOverrides: Record<string, string> = {};
  headerList.value.forEach(({ key, value }) => {
    if (key.trim()) {
      headerOverrides[key.trim()] = value;
    }
  });

  const queryOverrides: Record<string, string> = {};
  queryList.value.forEach(({ key, value }) => {
    if (key.trim()) queryOverrides[key.trim()] = value;
  });

  // 变量引用拦在保存处：未定义的 `{{名称}}` 存下去会在请求时原样发出，用户看到的只是一次
  // 看不懂的上游 401。拉取变量表**失败**时不做这项校验——宁可放过一个拼错的引用（运行时会
  // 宽容原样发出，控制台点名），也不要在扩展暂时读不到表的时候把保存按钮变成死路。
  // 但「还在路上」不等于「失败」（M-7）：先等这一趟落定再判，代价只是这一次保存多等一会儿。
  if (!variableNamesLoaded.value) {
    await (variablesLoad ??= loadVariables().then(ok => {
      variableNamesLoaded.value = ok;
      return ok;
    }));
  }
  // 同理，按基线过滤：存储里已经写着的那句引用不是这次带进来的，改优先级也该存得回去
  // （导入侧不跑这道校验、手改 storage 也能造出这种规则，否则它们从此再也编不动）。
  if (variableNamesLoaded.value) {
    const undefinedRefs = newlyIntroducedRefs(
      findUndefinedVariableRefs({ headerOverrides, queryOverrides }, variables.value),
      baselineVarNames.value,
    );
    if (undefinedRefs.length > 0) {
      ElMessage.error(t('undefinedVariableError', undefinedRefs.join(', ')));
      return;
    }
  }

  // WebSocket 规则的查询参数由 MAIN world 拦截器拼接（`applyWsQuery`），那一侧永远读不到
  // 变量表，引用只会被原样写进握手 URL —— 静默坏配置，不如当场拒绝保存
  if (
    isWebSocketRule({ matchPattern: form.matchPattern, targetUrl: form.targetUrl }) &&
    newlyIntroducedRefs(collectRuleVariableRefs({ queryOverrides }), baselineWsQueryVarNames.value).length > 0
  ) {
    ElMessage.error(t('variableWsQueryUnsupportedError'));
    return;
  }

  const result: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'> = {
    name: form.name,
    matchType: form.matchType,
    matchPattern: form.matchPattern,
    targetUrl: form.targetUrl,
    priority: form.priority,
    enabled: form.enabled,
    headerOverrides: Object.keys(headerOverrides).length > 0 ? headerOverrides : undefined,
  };

  if (methodsList.value.length > 0) {
    result.methods = [...methodsList.value];
  }

  if (Object.keys(queryOverrides).length > 0) {
    result.queryOverrides = queryOverrides;
  }

  if (enableRequestBodyOverride.value && form.requestBodyOverride) {
    result.requestBodyOverride = form.requestBodyOverride;
  }

  if (enableMockResponse.value) {
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
    // 只要有一项真实内容就写入：以前只看默认 body，导致「只配条件」和「只返回某个状态码」
    // 这两种合法用法被静默丢弃，用户看到保存成功却完全没有 Mock 效果。
    if (form.mockBody || form.mockStatus !== 200 || conditions.length > 0) {
      result.mockResponse = {
        body: form.mockBody,
        contentType: form.mockContentType,
        status: form.mockStatus,
      };
      if (conditions.length > 0) {
        result.mockResponse.conditions = conditions;
      }
    } else {
      // 开关开着却什么都没填：不假装保存了 Mock，明确告知这次不生效
      ElMessage.warning(t('mockIgnored'));
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

  // 与 blocked 同口径：关闭时不写入字段，保持 storage 里的规则形状干净
  if (form.sendCredentials) {
    result.sendCredentials = true;
  }

  if (enableResponseOverrides.value) {
    const responseOverrides: ProxyRule['responseOverrides'] = {};
    if (form.responseStatus !== undefined) {
      responseOverrides.status = form.responseStatus;
    }
    // trim 只用来判「有没有填」，存下去的是原值去掉首尾空白：状态行是 ByteString 的一段文本，
    // 首尾空白在这里没有语义，而留着一格空白会让下一次打开表单看到一条看不见的覆盖。
    // 空值整体不写键——写 `statusText: ''` 是一道覆盖，会把上游那句 `OK` 抹成空串。
    const statusText = form.responseStatusText.trim();
    if (statusText !== '') {
      responseOverrides.statusText = statusText;
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
    // 整段替换按**原值**存（正文里的换行与缩进是内容的一部分，不能 trim），只在全空白时不写键。
    // 两份都在时仍然都存：`applyResponseOverrides` 里 bodyRaw 排在前面，路径替换那一段不执行，
    // 用户把整段正文清空就能立刻回到逐项替换——这正是那行互斥提示要说的事。
    if (form.responseBodyRaw.trim() !== '') {
      responseOverrides.bodyRaw = form.responseBodyRaw;
    }
    if (Object.keys(responseOverrides).length > 0) {
      result.responseOverrides = responseOverrides;
    }
  }

  emit('save', result);
}

/**
 * 保存按钮的入口：一次点击只允许一笔在途（M-6）
 *
 * `submitRule` 里有两处 await（表单校验、变量表那一趟），这期间弹窗一直开着、按钮一直可点，
 * 而 `ADD_RULE` 只做 append——连点两下就是 storage 里两条同名同模式的规则。旗标早退挡住
 * 「同一轮里被点两次」，`:loading` 让第二次点击在界面上就发生不了；父组件写存储那一段
 * 另有 `handleSaveRule` 里的同名旗标接住。
 * 校验没过或被闸门拦下时按钮照常回到可点状态，否则用户改完就再也存不动了。
 */
async function handleSave() {
  if (saving.value) return;
  saving.value = true;
  try {
    await submitRule();
  } finally {
    saving.value = false;
  }
}

// ─── Test panel matching logic（直接复用 utils/urlMatcher，与生产通道语义一致）───

function runTest() {
  const url = testUrl.value.trim();
  if (!url || !form.matchPattern) return;

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
    methods: methodsList.value.length > 0 ? [...methodsList.value] : undefined,
    queryOverrides:
      queryList.value.filter(q => q.key.trim()).length > 0
        ? Object.fromEntries(queryList.value.filter(q => q.key.trim()).map(q => [q.key.trim(), q.value]))
        : undefined,
  };

  const matched = matchRule(url, testRule);
  const rewrittenUrl = matched ? applyQueryOverrides(rewriteUrl(url, testRule), testRule.queryOverrides) : '';
  testResult.value = { matched, rewrittenUrl, testedUrl: url };
  testRunSeq.value += 1;
}
</script>

<style scoped>
.header-overrides {
  width: 100%;
}

.field-hint {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
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
  background: var(--cop-bg-color-secondary, var(--el-fill-color-lighter, #f5f7fa));
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

/* ─── 正则「捕获组 ↔ 引用」对照条 ─────────────────────────────────────────── */

/* 覆盖区里那些「你填的这串会被改掉 / 被压住」的提醒：跟着那一格一起在场，
   而不是弹一条会自己飘走的 toast——用户当时正在看的就是这一格。 */
.field-hint-warning {
  color: var(--el-color-warning, #e6a23c);
}

.field-hint-value {
  padding: 1px 5px;
  background: var(--el-bg-color, #fff);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 3px;
}

.regex-refs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
  background: var(--cop-bg-color-secondary, var(--el-fill-color-lighter, #f5f7fa));
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-left: 3px solid var(--cop-primary, #409eff);
  border-radius: 6px;
}

.regex-refs-head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}

.regex-refs-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-regular, #606266);
}

.regex-refs-count {
  color: var(--el-text-color-secondary, #909399);
}

.capture-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 每颗 chip 带一小截模式原文，为的是「$1 到底是哪一段」这件事不用回去数括号。
   原文只截不折：折行会把括号拆成两截，比不加更难读，所以超长走省略号。 */
.capture-chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  max-width: 100%;
  padding: 2px 8px;
  background: var(--el-bg-color, #fff);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 999px;
}

.capture-chip b {
  color: var(--cop-primary, #409eff);
}

.capture-chip code {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--el-text-color-secondary, #909399);
  white-space: nowrap;
}

/* 「被引用」用底色与边框区分，不只靠文字颜色：这一排本来就有两种颜色（编号 / 原文） */
.capture-chip.is-used {
  background: rgb(var(--cop-primary-rgb) / 10%);
  border-color: var(--cop-primary-border, #d9ecff);
}

.capture-chip.is-warn b,
.capture-chip.is-warn code {
  color: var(--el-color-warning, #e6a23c);
}

.capture-ref {
  display: flex;
  gap: 6px;
  align-items: baseline;
  margin: 0;
  color: var(--el-text-color-secondary, #909399);
}

.capture-ref code {
  flex-shrink: 0;
  color: var(--cop-primary, #409eff);
}

.capture-ref.is-ok code {
  color: var(--el-color-success, #67c23a);
}

.capture-ref.is-warn code {
  color: var(--el-color-warning, #e6a23c);
}

.capture-ref.is-danger,
.capture-ref.is-danger code {
  color: var(--el-color-danger, #f56c6c);
}

.capture-summary {
  margin: 0;
  font-weight: 500;
}

.capture-summary.is-ok {
  color: var(--el-color-success, #67c23a);
}

.capture-summary.is-danger {
  color: var(--el-color-danger, #f56c6c);
}

.regex-refs-note {
  margin: 0;
  color: var(--el-text-color-secondary, #909399);
}

/* ─── Test Panel ─────────────────────────────────────────────────────────── */
.test-panel {
  margin-top: 16px;
  overflow: hidden;
  background: var(--cop-bg-color-secondary, var(--el-fill-color-lighter, #f5f7fa));
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
  line-height: 1.6;
  color: var(--el-color-primary, #409eff);
  word-break: break-all;
  background: var(--cop-bg-color-secondary, var(--el-fill-color-lighter, #f5f7fa));
  border-radius: 4px;
}

/* 换进去的那一段：底色 + 加粗是静止态，一闪是「刚算完这一次」的动效。
   静止态自己就把话说完了，所以系统开了「减少动态效果」时（tokens.css 的降级段落把所有
   动画时长压到 0.01ms）信息一条不少，只是不再闪。
   浓度给到 46%、比日志表格里那一闪（16%）重得多：那一行闪的是「它刚刚才到」，
   这一段闪的是「它刚刚被改写过」，后者要被认出来是同一个字段的第二次读数，
   起点必须明显高于静止态那 14%。500ms 同理不在交互时长阶梯里。 */
.test-result-url .url-changed {
  font-weight: 600;
  background-color: rgb(var(--cop-primary-rgb) / 14%);
  border-radius: 3px;
  animation: url-diff-in 0.5s ease-out;
}

@keyframes url-diff-in {
  from {
    background-color: rgb(var(--cop-primary-rgb) / 46%);
  }
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
