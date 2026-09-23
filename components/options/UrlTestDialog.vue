<template>
  <el-dialog
    :model-value="visible"
    :title="t('urlTest')"
    width="640px"
    align-center
    @close="$emit('update:visible', false)"
  >
    <div class="url-test-dialog dialog-body-scroll">
      <div class="url-test-input-row">
        <el-select
          v-model="testMethod"
          clearable
          :placeholder="t('urlTestMethodAny')"
          class="url-test-method"
        >
          <el-option
            v-for="method in HTTP_METHODS"
            :key="method"
            :label="method"
            :value="method"
          />
        </el-select>
        <el-input
          v-model="testUrl"
          :placeholder="t('urlTestPlaceholder')"
          clearable
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <p
        v-if="!testUrl.trim()"
        class="url-test-hint"
      >
        {{ t('urlTestHint') }}
      </p>

      <template v-else>
        <el-alert
          v-if="!proxyEnabled"
          :title="t('urlTestProxyOff')"
          type="warning"
          show-icon
          :closable="false"
        />

        <!-- 未命中 -->
        <div
          v-if="!matchedRule"
          class="result-block result-miss"
        >
          <el-tag
            type="info"
            effect="plain"
            >{{ t('urlTestNoMatch') }}</el-tag
          >
          <p class="result-desc">{{ t('urlTestNoMatchDesc') }}</p>
          <!-- 说得出原因时才多说一句：单纯「没有规则覆盖」与上面的标签同义，不重复一遍 -->
          <p
            v-if="missDiagnosis"
            class="result-cause"
          >
            {{ diagnosisText(missDiagnosis) }}
          </p>
        </div>

        <!-- 命中 -->
        <div
          v-else
          class="result-block"
        >
          <div class="result-row">
            <span class="result-label">{{ t('urlTestMatchedRule') }}</span>
            <el-tag
              type="success"
              effect="light"
              >{{ matchedRule.name }}</el-tag
            >
            <el-tag
              size="small"
              type="info"
              effect="plain"
            >
              {{ t('urlTestPriority') }} {{ matchedRule.priority }}
            </el-tag>
          </div>
          <div class="result-row">
            <span class="result-label">{{ t('urlTestRewrittenUrl') }}</span>
            <!-- 与规则表单的预演同一份切分：读者要看的不是两个长地址像不像，而是这条规则动了哪一段。
                 这里刻意**不带**那一闪——结果随输入实时重算，每次敲一个字都闪一下就成了干扰。 -->
            <code
              class="result-url"
              :class="{ unchanged: rewrittenUrl === testUrl.trim() }"
            >
              <span
                v-for="(segment, index) in rewrittenDiff"
                :key="index"
                :class="{ 'url-changed': segment.changed }"
                >{{ segment.text }}</span
              >
            </code>
          </div>
          <div class="result-row">
            <span class="result-label">{{ t('urlTestChannel') }}</span>
            <el-tag
              :type="channelIsDnr ? (matchedDnrSkipReason ? 'danger' : 'success') : 'warning'"
              effect="light"
            >
              {{ channelIsDnr ? t('urlTestChannelDnr') : t('urlTestChannelSw') }}
            </el-tag>
          </div>
          <div
            v-if="matchedDnrSkipReason"
            class="dnr-skip-alert"
          >
            <p
              v-for="(line, index) in skipReasonLines(matchedDnrSkipReason)"
              :key="index"
            >
              {{ line }}
            </p>
          </div>
          <p
            v-else-if="channelIsDnr"
            class="cors-note"
          >
            {{ t('urlTestCorsNote') }}
          </p>
          <div
            v-if="extraActions.length > 0"
            class="result-row"
          >
            <span class="result-label">{{ t('urlTestActions') }}</span>
            <el-tag
              v-for="action in extraActions"
              :key="action"
              size="small"
              effect="plain"
              class="action-tag"
            >
              {{ action }}
            </el-tag>
          </div>
        </div>

        <!-- 同时匹配但被遮蔽的规则 -->
        <div
          v-if="shadowedRules.length > 0"
          class="result-block result-shadowed"
        >
          <p class="shadowed-title">{{ t('urlTestShadowedTitle') }}</p>
          <div
            v-for="rule in shadowedRules"
            :key="rule.id"
            class="shadowed-item"
          >
            <el-tag
              size="small"
              type="info"
              effect="plain"
              >{{ rule.name }}</el-tag
            >
            <span class="shadowed-pattern">{{ rule.matchPattern }}</span>
            <span class="shadowed-priority">{{ t('urlTestPriority') }} {{ rule.priority }}</span>
          </div>
        </div>
      </template>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ProxyRule } from '@/utils/types';
import { HTTP_METHODS } from '@/utils/types';
import {
  applyQueryOverrides,
  findMatchingRule,
  isSimpleRule,
  isWebSocketRule,
  matchRule,
  rewriteUrl,
} from '@/utils/urlMatcher';
import { diffRewrite } from '@/utils/rewriteDiff';
import { useI18n } from '@/composables/useI18n';
import { useDnrSkipText } from '@/composables/useDnrSupport';
import { useDiagnosisText } from '@/composables/useDiagnosis';
import { diagnoseRequest, type Diagnosis } from '@/utils/diagnosis';
import type { DnrSkipReason } from '@/utils/dnrSupport';

const props = defineProps<{
  visible: boolean;
  /** 全部规则（来自 App.vue 的响应式状态） */
  rules: ProxyRule[];
  /** 走 DNR 通道但不会被浏览器应用的规则（ruleId → 原因） */
  dnrSkippedRules: Map<string, DnrSkipReason>;
  /** 代理总开关状态：关闭时规则不会实际生效，需提醒 */
  proxyEnabled: boolean;
}>();

defineEmits<{
  'update:visible': [value: boolean];
}>();

const { t } = useI18n();
const { skipReasonLines } = useDnrSkipText();
const { diagnosisText } = useDiagnosisText();

const testUrl = ref('');
/** 参与命中测试的 HTTP 方法（空=不限，与无方法信息时的匹配行为一致） */
const testMethod = ref('');

// 命中判定复用 findMatchingRule（与实际代理行为同一实现，含启用过滤与优先级排序）
const matchedRule = computed(() =>
  testUrl.value.trim() ? findMatchingRule(testUrl.value.trim(), props.rules, testMethod.value || undefined) : null,
);

// 与生产 SW 通道一致：先重写再应用查询参数覆盖（仅展示，不写入）
const rewrittenUrl = computed(() =>
  matchedRule.value
    ? applyQueryOverrides(rewriteUrl(testUrl.value.trim(), matchedRule.value), matchedRule.value.queryOverrides)
    : '',
);

/**
 * 改写结果按「共用开头 / 这次换进来的 / 共用结尾」拆开，与规则表单预演共用 `utils/rewriteDiff`
 *
 * 三段拼回去永远等于 `rewrittenUrl`（那条不变量有单测钉住），所以这只是画法不同，
 * 不存在「高亮说的」和「地址本身」各讲一套的可能。未改写时整段就是那句提示，高亮为空。
 */
const rewrittenDiff = computed(() => {
  const target = rewrittenUrl.value;
  if (!target) return [];
  const source = testUrl.value.trim();
  if (target === source) return [{ text: t('urlTestUrlUnchanged'), changed: false }];
  const { before, changed, after } = diffRewrite(source, target);
  return [
    { text: before, changed: false },
    { text: changed, changed: true },
    { text: after, changed: false },
  ].filter(segment => segment.text !== '');
});

const channelIsDnr = computed(() => (matchedRule.value ? isSimpleRule(matchedRule.value) : false));

// 走 DNR 通道却不会被浏览器应用：命中显示绿色「DNR」并不等于请求真的会被转发
const matchedDnrSkipReason = computed<DnrSkipReason | undefined>(() =>
  matchedRule.value ? props.dnrSkippedRules.get(matchedRule.value.id) : undefined,
);

/**
 * 未命中时的归因结论，`null` = 这一句没有可补充的信息
 *
 * 与 `matchedRule` 共用同一份判定（`diagnoseRequest` 内部就是 `findMatchingRule`），
 * 所以绝不会出现「上面说没命中、下面说会命中」。两种刻意不说话的情形：
 * 总开关关闭已由上方 `el-alert` 说清；单纯「没有规则覆盖」与「未命中任何规则」那个标签同义。
 * 命中侧的三件事（浏览器不会应用这条网络层规则、排在获胜者后面的遮蔽清单、通道本身）
 * 由这一屏别处那几格说，不归归因句——同一个事实不许有第二个出口。
 */
const missDiagnosis = computed<Diagnosis | null>(() => {
  if (!props.proxyEnabled) return null;
  const diagnosis = diagnoseRequest({
    url: testUrl.value,
    method: testMethod.value || undefined,
    rules: props.rules,
    proxyEnabled: props.proxyEnabled,
  });
  return diagnosis.code === 'noMatch' ? null : diagnosis;
});

const shadowedRules = computed(() => {
  const url = testUrl.value.trim();
  const matched = matchedRule.value;
  if (!url || !matched) return [];
  return props.rules
    .filter(r => r.enabled && r.id !== matched.id)
    .sort((a, b) => a.priority - b.priority)
    .filter(r => matchRule(url, r, testMethod.value || undefined));
});

const extraActions = computed(() => {
  const rule = matchedRule.value;
  if (!rule) return [];
  const actions: string[] = [];
  if (rule.blocked) actions.push(t('blockLabel'));
  if (rule.mockResponse) actions.push(t('mockResponseLabel'));
  if (rule.delayMs) actions.push(t('urlTestActionDelay', [String(rule.delayMs)]));
  if (rule.retryCount) actions.push(t('urlTestActionRetry', [String(rule.retryCount)]));
  if (rule.headerOverrides && Object.keys(rule.headerOverrides).length > 0) {
    actions.push(t('headerOverridesLabel'));
  }
  if (rule.requestBodyOverride !== undefined) actions.push(t('requestBodyOverrideLabel'));
  // 严格判据与 isSimpleRule / proxyHandler 一致：真值字符串既不走 SW 也不带 Cookie，预览不能说谎
  if (rule.sendCredentials === true) actions.push(t('sendCredentialsLabel'));
  if (rule.responseOverrides) actions.push(t('responseOverridesLabel'));
  if (rule.methods && rule.methods.length > 0) actions.push(t('urlTestActionMethods', rule.methods.join('/')));
  if (rule.queryOverrides && Object.keys(rule.queryOverrides).length > 0) actions.push(t('urlTestActionQuery'));
  if (isWebSocketRule(rule)) actions.push(t('urlTestActionWs'));
  return actions;
});
</script>

<style scoped>
.url-test-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.url-test-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.url-test-method {
  flex: 0 0 130px;
}

.url-test-hint {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--cop-text-color-secondary);
}

.result-block {
  padding: 12px 14px;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color-light);
  border-radius: 8px;
}

.result-miss .result-desc {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--cop-text-color-secondary);
}

/* 归因句比上面那句结论更实（它给得出下一步），所以用常规文字色 + 一条主题色左线，
   与 `.dnr-skip-alert` 同一套「告警靠左线」的语言，但用中性强度：它不是错误。 */
.result-miss .result-cause {
  padding-left: 9px;
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--cop-text-color-regular);
  border-left: 2px solid var(--cop-primary-border);
}

.result-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}

.result-row + .result-row {
  margin-top: 10px;
}

.result-label {
  flex-shrink: 0;
  min-width: 84px;
  font-size: 13px;
  color: var(--cop-text-color-secondary);
}

.result-url {
  font-size: 13px;
  color: var(--cop-primary);
  word-break: break-all;
}

.result-url.unchanged {
  color: var(--cop-text-color-secondary);
}

/* 换进来的那一段——与规则表单预演同一套画法（那边多一闪，因为那边要按下按钮才出结果）。
   高亮本身就把话说完了，所以「减少动态效果」下两边都只是不再闪，信息一条不少。 */
.result-url .url-changed {
  font-weight: 600;
  background-color: rgb(var(--cop-primary-rgb) / 14%);
  border-radius: 3px;
}

.dnr-skip-alert {
  padding: 8px 10px;
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-color-danger, #f56c6c);
  background: var(--el-color-danger-light-9, #fef2f2);
  border-left: 3px solid var(--el-color-danger, #f56c6c);
  border-radius: 0 6px 6px 0;
}

.dnr-skip-alert p {
  margin: 0;
}

.cors-note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--cop-text-color-secondary);
}

.result-shadowed .shadowed-title {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--cop-text-color-secondary);
}

.shadowed-item {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 0;
}

.shadowed-item + .shadowed-item {
  border-top: 1px dashed var(--cop-border-color-light);
}

.shadowed-pattern {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--cop-text-color-regular);
  white-space: nowrap;
}

.shadowed-priority {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--cop-text-color-placeholder);
}

.action-tag {
  margin-right: 2px;
}
</style>
