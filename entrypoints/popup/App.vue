<template>
  <div class="popup-container">
    <!-- 头部：Logo + 标题 + 版本 tag -->
    <div class="header">
      <el-icon
        class="logo"
        :size="24"
        ><Promotion
      /></el-icon>
      <h3>{{ t('popupTitle') }}</h3>
      <el-tag
        size="small"
        type="info"
        class="version-tag"
        >v{{ currentVersion }}</el-tag
      >
    </div>

    <!-- 代理开关状态行 + 自动关闭档位 -->
    <div
      class="toggle-section"
      :class="{ 'is-active': enabled }"
    >
      <div class="toggle-row">
        <div class="toggle-label-col">
          <div class="toggle-label">
            <span
              class="status-dot"
              :class="{ active: enabled }"
            ></span>
            <span class="toggle-text">{{ t('proxySwitch') }}</span>
            <span
              class="toggle-status"
              :class="{ 'is-active': enabled }"
            >
              {{ enabled ? t('statusEnabled') : t('statusDisabled') }}
            </span>
          </div>
          <div
            v-if="autoOffText"
            class="auto-off-countdown"
          >
            <el-icon><Timer /></el-icon>
            {{ autoOffText }}
          </div>
        </div>
        <el-switch
          v-model="enabled"
          :loading="loading"
          :aria-label="t('proxySwitch')"
          @change="(val: boolean | string | number) => handleToggleProxy(val as boolean)"
        />
      </div>
      <!--
        自动关闭的档位条：倒计时的用途是「别忘了关代理」，而做这个决定的时刻就在拨开关这一下，
        不该为它开一个标签页。整条只在读到位（`autoOffMinutes !== null`）时画——读失败时画成
        「从不」是把「不知道」说成一句结论，与这一屏其余「读不到就画 —」同一条规矩。
        每一格是原生 `<button>` + `aria-pressed`（不是 radiogroup：方向键在 radio 里是「选中即生效」，
        而这里的生效会重启一次倒计时，走五格箭头就等于连写五次存储）。
      -->
      <div
        v-if="autoOffMinutes !== null"
        class="auto-off-picker"
        role="group"
        :aria-label="t('autoOffPickTitle')"
      >
        <div class="auto-off-picker-head">
          <span class="auto-off-picker-label">{{ t('autoOffPickTitle') }}</span>
          <span
            v-if="!enabled && autoOffMinutes > 0"
            class="auto-off-picker-note"
            >{{ t('autoOffPickStartsOnEnable') }}</span
          >
          <span
            v-else-if="autoOffIsCustom"
            class="auto-off-picker-note"
            >{{ t('autoOffPickCustom', String(autoOffMinutes)) }}</span
          >
        </div>
        <div class="auto-off-chips">
          <button
            v-for="preset in AUTO_OFF_PRESETS"
            :key="preset.minutes"
            type="button"
            class="auto-off-chip"
            :class="{ 'is-selected': autoOffMinutes === preset.minutes }"
            :aria-pressed="autoOffMinutes === preset.minutes"
            :aria-label="t('autoOffPickA11y', t(preset.shortKey))"
            :disabled="autoOffPending"
            @click="chooseAutoOff(preset)"
          >
            {{ t(preset.shortKey) }}
          </button>
        </div>
      </div>
    </div>

    <!-- 可折叠规则列表 -->
    <div class="rules-section">
      <div
        class="rules-section-header"
        role="button"
        tabindex="0"
        :aria-expanded="rulesExpanded ? 'true' : 'false'"
        aria-controls="rules-section-collapse"
        @click="rulesExpanded = !rulesExpanded"
        @keydown.enter.space.prevent="rulesExpanded = !rulesExpanded"
      >
        <span class="rules-section-title">{{ t('quickToggleRules') }}</span>
        <span class="rules-section-count">{{ rules.length }}</span>
        <el-icon
          class="rules-section-arrow"
          :class="{ 'is-expanded': rulesExpanded }"
        >
          <ArrowDown />
        </el-icon>
      </div>
      <!-- 折叠用 grid-template-rows: 0fr → 1fr，不再用 max-height 夹：
           旧的 `max-height: 300px` 在规则多于约八条时先在动画里被裁一刀、过渡结束后又突然长全。
           `aria-controls` 指向的就是这一层（它始终在 DOM 里，只是收起时 `visibility: hidden`，
           因此既不出现在读屏的朗读顺序里、也拿不到焦点）；标题那侧配 `aria-expanded`，
           否则读屏只报得出「按钮」，报不出它是开着的还是关着的、开了会多出什么来。 -->
      <div
        id="rules-section-collapse"
        class="rules-section-collapse"
        :class="{ 'is-open': rulesExpanded }"
      >
        <div class="rules-section-body">
          <div
            v-if="rules.length === 0"
            class="rules-empty"
          >
            {{ t('noRulesInPopup') }}
          </div>
          <!-- 不写成 v-for + v-else 同元素：那里 v-else 优先级更高，恰好条件不引用循环变量才「碰巧」对 -->
          <template v-else>
            <div
              v-for="rule in rules"
              :key="rule.id"
              class="rule-toggle-item"
            >
              <span
                class="rule-toggle-name"
                :title="rule.name"
                >{{ rule.name }}</span
              >
              <el-switch
                :model-value="rule.enabled"
                size="small"
                :aria-label="t('enableRuleA11y', rule.name)"
                @change="(val: boolean | string | number) => handleToggleRule(rule.id, val as boolean)"
              />
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 数据点：活跃规则 / 经扩展请求 / 本页网络层命中 + 拦截器自报活动 -->
    <div class="metrics-block">
      <div class="metrics-row">
        <div class="metric">
          <span class="metric-value"
            ><span
              :key="activeRuleCount"
              class="metric-value-digit"
              >{{ activeRuleCount }}</span
            ></span
          >
          <span class="metric-label">{{ t('activeRules') }}</span>
        </div>
        <div class="metric-divider"></div>
        <div class="metric">
          <span class="metric-value">{{ swRequestCount }}</span>
          <span class="metric-label">{{ t('todayRequests') }}</span>
        </div>
        <div class="metric-divider"></div>
        <div
          class="metric"
          :class="{ 'is-unknown': dnrTabDimmed }"
        >
          <span class="metric-value">{{ dnrTabHitsText }}</span>
          <span class="metric-label">{{ t('metricDnrTab') }}</span>
          <span class="metric-note">{{ dnrTabNoteText }}</span>
        </div>
      </div>

      <!-- 拦截器活动（页面自报）：这一页的 JS 层有没有被拦，只有它自己知道 -->
      <div
        v-if="interceptorStripVisible"
        class="interceptor-strip"
        :class="`interceptor-strip--${interceptorView.state}`"
        :title="interceptorDetailText"
      >
        <span class="interceptor-chip">{{ t('interceptorTag') }}</span>
        <span class="interceptor-text">{{ interceptorText }}</span>
      </div>

      <!-- 配置广播没送达：这一页还在拿旧规则干活，是唯一一条「现在就刷新」能解决的话 -->
      <p
        v-if="configSyncVisible"
        class="config-sync-warning"
        :title="t('configNotSyncedHint')"
      >
        {{ t('configNotSynced') }}
      </p>
    </div>

    <!-- 本页地址命中预览（只回答页面地址本身，边界写在卡内） -->
    <div
      v-if="pageUrl"
      class="page-hit-card"
    >
      <div class="page-hit-header">
        <el-icon><Link /></el-icon>
        <span class="page-hit-title">{{ t('currentPageHit') }}</span>
      </div>
      <p class="page-hit-boundary">{{ t('pageHitBoundary') }}</p>
      <p
        class="page-hit-url"
        :title="pageUrl"
      >
        {{ truncateUrl(pageUrl, 48) }}
      </p>
      <div
        v-if="!pageHitProxiable"
        class="page-hit-empty"
      >
        {{ t('pageHitNotProxiable') }}
      </div>
      <div
        v-else-if="pageHitRuleName"
        class="page-hit-result"
      >
        <div class="page-hit-row">
          <span class="page-hit-label">{{ t('pageHitRule') }}</span>
          <el-tag
            size="small"
            type="success"
            effect="light"
            class="page-hit-rule-tag"
            :title="pageHitRuleName"
            >{{ pageHitRuleName }}</el-tag
          >
          <el-tag
            size="small"
            :type="pageHitRuleSkipped ? 'danger' : 'info'"
            :effect="pageHitRuleSkipped ? 'dark' : 'plain'"
            >{{ pageHitChannelLabel }}</el-tag
          >
        </div>
        <div
          v-if="pageHitRewritten && pageHitRewritten !== pageUrl"
          class="page-hit-row"
        >
          <span class="page-hit-label">{{ t('pageHitRewritten') }}</span>
          <code class="page-hit-rewritten">{{ truncateUrl(pageHitRewritten, 44) }}</code>
        </div>
        <div
          v-if="!enabled"
          class="page-hit-off"
        >
          {{ t('pageHitProxyOff') }}
        </div>
      </div>
      <div
        v-else
        class="page-hit-empty"
      >
        <span>{{ t('pageHitNoMatch') }}</span>
        <p
          v-if="pageHitCauseText"
          class="page-hit-cause"
        >
          {{ pageHitCauseText }}
        </p>
        <button
          type="button"
          class="page-hit-link"
          @click="openOptionsPage('#url-test')"
        >
          {{ t('pageHitOpenUrlTest') }}
        </button>
      </div>
    </div>

    <!-- 动作卡片列表 -->
    <div class="action-list">
      <div
        class="action-card"
        role="button"
        tabindex="0"
        @click="openOptionsPage('#add-rule')"
        @keydown.enter.space.prevent="openOptionsPage('#add-rule')"
      >
        <div class="action-card__icon action-card__icon--primary">
          <el-icon><Setting /></el-icon>
        </div>
        <div class="action-card__content">
          <div class="action-card__title">{{ t('actionOpenConfig') }}</div>
          <div class="action-card__desc">{{ t('actionOpenConfigDesc') }}</div>
        </div>
      </div>

      <div
        class="action-card"
        role="button"
        tabindex="0"
        :aria-expanded="apiPicker ? 'true' : 'false'"
        @click="handleCreateRuleFromTab"
        @keydown.enter.space.prevent="handleCreateRuleFromTab"
      >
        <div class="action-card__icon action-card__icon--tint">
          <el-icon><Plus /></el-icon>
        </div>
        <div class="action-card__content">
          <div class="action-card__title">{{ t('actionCreateRuleFromTab') }}</div>
          <div class="action-card__desc">{{ createRuleFromTabDesc }}</div>
        </div>
      </div>

      <!--
        候选面板：代理要挂的是接口地址，不是页面文档地址，所以先把「这一页在调谁」摊出来。
        面板紧跟在卡片后面，键盘用户按完 Enter 再 Tab 就落在第一行；每行是真按钮，指针与键盘同一条路。
        上面那张卡片只给 `aria-expanded`、不给 `aria-controls`，与规则列表那处折叠刻意不同：
        这一层是 `v-if`，收起时目标元素根本不在 DOM 里，指向一个不存在的 id 是无效 IDREF
        （axe 的 aria-valid-attr-value 直接报），而规则列表那层的折叠体始终在、只是 `visibility: hidden`。
      -->
      <div
        v-if="apiPicker"
        class="api-picker"
        role="group"
        :aria-label="t('apiPickerTitle')"
      >
        <p class="api-picker-title">{{ t('apiPickerTitle') }}</p>
        <button
          v-for="row in apiPicker.rows"
          :key="row.origin"
          type="button"
          class="api-picker-row"
          :class="{ 'api-picker-row--suspect': row.suspect > 0 }"
          @click="chooseApiDraft(row.origin)"
        >
          <span
            class="api-picker-origin"
            :title="row.origin"
            >{{ row.origin }}</span
          >
          <!-- 带标记的那一格说「疑似几笔」而不是「几次」：这一行该先知道的是它像没通；
               资源计时里读不到条数时（count = 0）这一格照样只讲疑似笔数，不必再说「次数未知」 -->
          <span
            v-if="row.suspect > 0"
            class="api-picker-count api-picker-count--suspect"
            :title="t('apiPickerSuspectHint', String(row.suspect))"
            >{{ t('apiPickerSuspect', String(row.suspect)) }}</span
          >
          <span
            v-else
            class="api-picker-count"
            >{{ t('apiPickerCount', String(row.count)) }}</span
          >
        </button>
        <button
          v-if="apiPicker.fallback"
          type="button"
          class="api-picker-row api-picker-row--muted"
          @click="chooseApiDraft(apiPicker.fallback.draft)"
        >
          <span
            class="api-picker-origin"
            :title="apiPicker.fallback.draft"
            >{{ apiPicker.fallback.origin }}</span
          >
          <span class="api-picker-count">{{ t('apiPickerOwn') }}</span>
        </button>
        <p
          v-if="apiPickerSuspectVisible"
          class="api-picker-suspect-note"
        >
          {{ t('apiPickerSuspectNote') }}
        </p>
        <p class="api-picker-boundary">{{ t('apiPickerBoundary') }}</p>
      </div>

      <div
        class="action-card"
        role="button"
        tabindex="0"
        @click="openOptionsPage('#logs')"
        @keydown.enter.space.prevent="openOptionsPage('#logs')"
      >
        <div class="action-card__icon action-card__icon--accent">
          <el-icon><Document /></el-icon>
        </div>
        <div class="action-card__content">
          <div class="action-card__title">{{ t('actionViewLogs') }}</div>
          <div class="action-card__desc">{{ t('actionViewLogsDesc') }}</div>
        </div>
      </div>

      <div
        class="action-card"
        role="button"
        tabindex="0"
        @click="openOptionsPage('#import-export')"
        @keydown.enter.space.prevent="openOptionsPage('#import-export')"
      >
        <div class="action-card__icon action-card__icon--tint">
          <el-icon><FolderOpened /></el-icon>
        </div>
        <div class="action-card__content">
          <div class="action-card__title">{{ t('actionImportExport') }}</div>
          <div class="action-card__desc">{{ t('actionImportExportDesc') }}</div>
        </div>
      </div>

      <div
        class="action-card"
        role="button"
        tabindex="0"
        :aria-expanded="profilePicker ? 'true' : 'false'"
        @click="handleProfilesCard"
        @keydown.enter.space.prevent="handleProfilesCard"
      >
        <div class="action-card__icon action-card__icon--tint">
          <el-icon><Collection /></el-icon>
        </div>
        <div class="action-card__content">
          <div class="action-card__title">{{ t('actionProfiles') }}</div>
          <div class="action-card__desc">{{ t('actionProfilesDesc') }}</div>
        </div>
      </div>

      <!--
        环境快照面板：切环境是这个扩展最勤的动作，不值得为它开一次标签页。
        复用「这一页在调谁」那套面板样式与真按钮行——同一层交互不该有两种键盘路径。
        确认这一步做在面板里而不是 `ElMessageBox`：弹窗模块一旦进 popup 首屏就是白涨的体积，
        而这里要的只是「把后果说清楚 + 再点一下」。措辞必须点名两件副作用（整套替换、总开关被打开），
        这是 `utils/storage.ts` 的 `loadProfile` 既有语义，本轮刻意不改。
      -->
      <div
        v-if="profilePicker"
        class="api-picker"
        role="group"
        :aria-label="t('profilePickerTitle')"
      >
        <p class="api-picker-title">{{ t('profilePickerTitle') }}</p>
        <template
          v-for="profile in profiles"
          :key="profile.id"
        >
          <button
            type="button"
            class="api-picker-row"
            :class="{ 'is-pending': pendingProfileId === profile.id }"
            :aria-expanded="pendingProfileId === profile.id ? 'true' : 'false'"
            :disabled="switchingProfile"
            @click="chooseProfile(profile.id)"
          >
            <span
              class="api-picker-origin"
              :title="profile.name"
              >{{ profile.name }}</span
            >
            <span class="api-picker-count">{{ t('profilePickerRuleCount', String(profile.rules.length)) }}</span>
          </button>
          <div
            v-if="pendingProfileId === profile.id"
            class="profile-confirm"
          >
            <p class="profile-confirm-text">{{ t('profilePickerConfirm', [profile.name, profile.rules.length]) }}</p>
            <div class="profile-confirm-actions">
              <button
                type="button"
                class="profile-confirm-btn profile-confirm-btn--apply"
                :disabled="switchingProfile"
                @click="applyProfile(profile)"
              >
                {{ switchingProfile ? t('profilePickerApplying') : t('profilePickerApply') }}
              </button>
              <button
                type="button"
                class="profile-confirm-btn"
                :disabled="switchingProfile"
                @click="pendingProfileId = ''"
              >
                {{ t('cancel') }}
              </button>
            </div>
          </div>
        </template>
        <button
          type="button"
          class="api-picker-row api-picker-row--muted"
          @click="openOptionsPage('#profiles')"
        >
          <span class="api-picker-origin">{{ t('profilePickerManage') }}</span>
        </button>
      </div>
    </div>

    <!-- 最近请求 -->
    <div class="recent-section">
      <div class="recent-title">{{ t('recentRequests') }}</div>
      <div
        v-if="recentLogs.length === 0"
        class="recent-empty"
      >
        {{ t('noRecentRequests') }}
      </div>
      <p
        v-if="recentLogs.length === 0 && hasEnabledSimpleRule"
        class="recent-empty-hint"
      >
        {{ t('recentRequestsDnrHint') }}
      </p>
      <!-- 新请求进来时：顶行淡入落位，下面的行被「挤」下去（move 过渡），而不是整列表换脸。
           不加 appear——popup 每次打开都让八行重新演一遍进场，看起来像加载慢 -->
      <TransitionGroup
        v-else-if="recentLogs.length > 0"
        tag="ul"
        name="log-row"
        class="recent-list"
      >
        <li
          v-for="log in recentLogRows"
          :key="log.id"
          class="recent-item"
        >
          <!--
            两处 `as TagProps['type']` 是给 `pnpm typecheck:vue` 的纯类型断言（编译后不存在）。
            Element Plus 的 `type` 联合里**没有「中性」这一档**，而 `getMethodColor` /
            `getStatusColor` 用空串表示它（GET 徽章、3xx 状态徽章；`utils/formatters.ts` 写了
            3xx 刻意落中性、不许挪到 success 那边）。空串在运行时靠 `.el-tag` 基础规则画成浅色底
            + **继承字色**，改成 `'primary'`（也就是不传 `type`）字色就变主题蓝——那是视觉改动，
            不在本轮范围，所以值原样交出去，只在类型层对齐。
          -->
          <el-tag
            :type="getMethodColor(log.method) as TagProps['type']"
            size="small"
            class="method-tag"
            disable-transitions
          >
            {{ log.method }}
          </el-tag>
          <span
            class="recent-url"
            :title="log.originalUrl"
          >
            {{ truncateUrl(log.originalUrl) }}
          </span>
          <el-tag
            v-if="log.status"
            :type="getStatusColor(log.status) as TagProps['type']"
            size="small"
            class="status-tag"
            disable-transitions
          >
            {{ log.status }}
          </el-tag>
          <el-tag
            v-else-if="log.error"
            type="danger"
            size="small"
            class="status-tag"
            disable-transitions
          >
            {{ t('requestFailed') }}
          </el-tag>
          <span class="recent-time">{{ formatTimeAgo(log.timestamp) }}</span>
        </li>
      </TransitionGroup>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import {
  Promotion,
  Setting,
  Document,
  FolderOpened,
  Collection,
  ArrowDown,
  Timer,
  Plus,
  Link,
} from '@element-plus/icons-vue';
import type { TagProps } from 'element-plus';
import { useProxyStatus } from '@/composables/useProxyStatus';
import { useI18n } from '@/composables/useI18n';
import { useDiagnosisText } from '@/composables/useDiagnosis';
import { useProfiles } from '@/composables/useProfiles';
import { MessageType } from '@/utils/types';
import { probeCorsSuspects, probePageApiOrigins } from '@/utils/pageApiProbe';
import { buildPickerRows, type ApiPickerRow, type CorsSuspect } from '@/utils/corsSuspects';
import { applyQueryOverrides, findMatchingRule, isSimpleRule, rewriteUrl } from '@/utils/urlMatcher';
import { diagnoseRequest, type Diagnosis, type DiagnosisCode } from '@/utils/diagnosis';
import { findDnrSkippedRules, usesDnrChannel } from '@/utils/dnrSupport';
import { describeDnrSample, isDnrSample } from '@/utils/dnrSample';
import { describeInterceptorStats, isInterceptorStatsEntry } from '@/utils/interceptorStats';
import { isConfigSyncStatus } from '@/utils/configSync';
import {
  AUTO_OFF_PRESETS,
  AUTO_OFF_PRESET_MINUTES,
  applyAutoOffMinutes,
  readAutoOffMinutes,
  writeAutoOffMinutes,
} from '@/utils/autoOff';
import type { AutoOffApplyResult } from '@/utils/autoOff';
import { formatClock } from '@/utils/formatters';
import { logger } from '@/utils/logger';
import type { DnrSample, InterceptorStatsEntry, ProxyConfig, ProxyRule } from '@/utils/types';

/**
 * Popup 弹窗（动作卡片风格，参照 account-password-helper）
 *
 * 结构：头部 → 开关状态行 → 数据点 → 动作卡片（直达不同目标）→ 最近请求列表。
 * 动作卡片通过 URL hash 直达 Options 的对应弹窗/抽屉，并支持按当前标签页地址预填新规则。
 */
const { t } = useI18n();
const { diagnosisText } = useDiagnosisText();
const {
  enabled,
  activeRuleCount,
  swRequestCount,
  recentLogs,
  rules,
  loading,
  autoOffAt,
  toggleProxy,
  toggleRule,
  fetchStatus,
  formatTimeAgo,
  getMethodColor,
  getStatusColor,
  truncateUrl,
} = useProxyStatus();

const rulesExpanded = ref(false);

/** 「最近请求」只露 5 行；模板里直接 slice 会每次渲染都新建一份数组 */
const recentLogRows = computed(() => recentLogs.value.slice(0, 5));

// ─── 本页网络层命中（DNR） ────────────────────────────────────────────────

/** 最近一次按标签页的网络层采样；null = 还没拿到过任何结构完整的响应 */
const dnrTabSample = ref<DnrSample | null>(null);
/** 走 DNR 通道但不会被应用的规则 id 集合（挂载时判定一次） */
const dnrSkippedRuleIds = ref<Set<string>>(new Set());
/** 是否存在「已启用的简单规则」——用来解释最近请求为什么是空的 */
const hasEnabledSimpleRule = ref(false);

const dnrTabView = computed(() => describeDnrSample(dnrTabSample.value));

/** 只有真采到样才给数字；其余一律「—」，绝不用 0 冒充一个已知答案 */
const dnrTabHitsText = computed(() => {
  const { hits } = dnrTabView.value;
  return hits === null ? '—' : String(hits);
});

/**
 * 注释按状态分档：「没有网络层规则」与「读不到」是两件事，说反了就是误导。
 * `notApplicable` 还要再分一次因——总开关关闭时动态规则被整体撤下，此时说
 * 「无生效的网络层规则」会与同屏的「活跃规则 N」正面冲突，用户此刻的事实只有「代理未开启」。
 */
const dnrTabNoteText = computed(() => {
  const { state } = dnrTabView.value;
  if (state === 'fresh') return t('sampledAt', formatClock(dnrTabSample.value?.sampledAt ?? 0));
  if (state === 'stale') return t('statsMayLag');
  if (state === 'notApplicable') return enabled.value ? t('statsNotApplicable') : t('statsProxyOff');
  // pending（首次采样在途）与 unavailable（退避 / API 抛错）在这一格里没法分开表达，
  // 但都不能沉默：画了「—」却不给理由，用户只能猜
  if (state === 'unavailable' || state === 'pending') return t('statsUnavailable');
  return '';
});

const dnrTabDimmed = computed(() => dnrTabView.value.state !== 'fresh');

async function fetchTabDnrStats(tabId: number | undefined) {
  if (typeof tabId !== 'number') return;
  try {
    const sample: unknown = await chrome.runtime.sendMessage({
      type: MessageType.GET_DNR_STATS,
      data: { tabId },
    });
    // 只接受结构完整的 DnrSample：SW 异常时的 { success:false } 不得覆盖已有读数
    if (isDnrSample(sample)) dnrTabSample.value = sample;
  } catch (error) {
    logger.debug('Fetch tab DNR stats failed:', error);
  }
}

// ─── 当前页命中预览 ────────────────────────────────────────────────────

const pageUrl = ref('');
const pageHitProxiable = ref(false);
const pageHitRuleName = ref('');
/** 命中规则的 id：只用于查 `dnrSkippedRuleIds`，不参与渲染 */
const pageHitRuleId = ref('');
const pageHitRewritten = ref('');
const pageHitChannelDnr = ref(false);

/** 走 DNR 通道但浏览器不会应用它（RE2 不兼容 / 捕获引用越界） */
const pageHitRuleSkipped = computed(() => !!pageHitRuleId.value && dnrSkippedRuleIds.value.has(pageHitRuleId.value));

/** 通道标签：未生效时整枚标签转红并追加「未生效」，与 options 规则列表同一个词、同一个 key */
const pageHitChannelLabel = computed(() => {
  const channel = pageHitChannelDnr.value ? t('pageHitChannelDnr') : t('pageHitChannelSw');
  return pageHitRuleSkipped.value ? `${channel} · ${t('dnrSkippedTag')}` : channel;
});

/**
 * 「本页地址没命中」时补的那一句成因；`null` = 无话可补
 *
 * 只说屏幕上别处还没说过的三种「差一点就命中」：规则被禁用、方法白名单不含 GET、模式本身
 * 不被接受。总开关状态就在头顶那一行，「一条规则都没有」另有引导卡，重复一遍只会挤掉卡片。
 * 它与 `pageHitRuleName` 互斥：命中了就没有「为什么没命中」可说。
 */
const pageHitCause = ref<Diagnosis | null>(null);

/** 愿意补一句的成因编码；其余（含「没有任何规则覆盖」）沿用卡片里原有那行说明 */
const PAGE_HIT_CAUSES: readonly DiagnosisCode[] = ['disabledMatch', 'methodFiltered', 'patternRejected'];

/** 成因 → 那句话（判据来自 `utils/diagnosis`，措辞与 URL 匹配测试共用同一份出口） */
const pageHitCauseText = computed(() => (pageHitCause.value ? diagnosisText(pageHitCause.value) : ''));

/**
 * 读取当前活动标签页地址，用与实际代理同一套 urlMatcher 纯函数计算命中预览。
 * popup 生命周期短，仅在挂载时计算一次；非 http(s) 页面不可代理，仅展示提示。
 *
 * 三条证据各自独立：页面地址命中（本函数）、本页网络层命中数（`fetchTabDnrStats`）、
 * 哪些规则其实没被应用（`findDnrSkippedRules`）。任一失败都不连带另两条。
 * 另两条在同一处发出、同样互不连带：拦截器自报活动（`fetchTabInterceptorStats`）
 * 与配置广播的送达账（`fetchTabConfigSync`）。
 * 第四处是页面自报的疑似跨域失败（`fetchCorsSuspects`）：它不描述本页**已经**被代理得怎样，
 * 而是给下面那张「为本页创建规则」卡片提供一句话与面板里的标记，所以问不到只是少一句卖点。
 */
async function computePageHit() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    pageUrl.value = url;
    const proxiable = /^https?:/i.test(url);
    pageHitProxiable.value = proxiable;

    // 三条证据各自独立：网络层命中先发出。它不依赖配置，也不得排在可用性诊断之后——
    // regex 型规则每条要一次 isRegexSupported 往返，那样会把数字一起拖慢。
    if (proxiable) {
      void fetchTabDnrStats(tab?.id);
      void fetchTabInterceptorStats(tab?.id);
      void fetchTabConfigSync(tab?.id);
      void fetchCorsSuspects(tab?.id);
    }

    // 配置先行：「最近请求为什么是空的」那条解释与本页能不能被代理无关，非 http 页也要给
    const config: ProxyConfig | undefined = await chrome.runtime.sendMessage({
      type: MessageType.GET_PROXY_CONFIG,
    });
    if (!config || !Array.isArray(config.rules)) return;
    const rules: ProxyRule[] = config.rules;
    hasEnabledSimpleRule.value = rules.some(usesDnrChannel);
    try {
      const skipped = await findDnrSkippedRules(rules);
      dnrSkippedRuleIds.value = new Set(skipped.keys());
    } catch (error) {
      // 判定失败时保持现状：不得把「未判定」渲染成「未生效」
      logger.debug('DNR applicability check failed:', error);
    }

    // 不可代理的标签页不测命中预览：那一块整体不显示
    if (!proxiable) return;

    // 页面导航视为 GET；与实际一致地按方法白名单收窄
    const rule = findMatchingRule(url, rules, 'GET');
    if (rule) {
      pageHitRuleId.value = rule.id;
      pageHitRuleName.value = rule.name;
      pageHitRewritten.value = applyQueryOverrides(rewriteUrl(url, rule), rule.queryOverrides);
      pageHitChannelDnr.value = isSimpleRule(rule);
    } else {
      // 没命中才归因。总开关取这一份 config，不读 `enabled.value`：popup 挂载时
      // `fetchStatus()` 与这里是并发的那两回事，取同一份读到的数据才不会把「还没读到」说成「关着」。
      // 命中了却不生效的那几档不由这里说：这一支压根没有命中，而那三档各有界面出口。
      const diagnosis = diagnoseRequest({ url, method: 'GET', rules, proxyEnabled: config.enabled });
      if (PAGE_HIT_CAUSES.includes(diagnosis.code)) pageHitCause.value = diagnosis;
    }
  } catch (error) {
    logger.debug('Compute page hit failed:', error);
  }
}

// ─── 拦截器自报活动（页面 JS 层） ─────────────────────────────────────────

/** 最近一次读到的自报读数；null = 还没拿到过结构完整的响应 */
const interceptorRaw = ref<InterceptorStatsEntry | null>(null);
/** 首次读取是否已回：没回之前整条不渲染，否则「还没回报」会在挂载瞬间闪一下 */
const interceptorFetched = ref(false);

const interceptorView = computed(() => describeInterceptorStats(interceptorRaw.value));

/**
 * 什么时候占一行：有读数就占；没有读数时，只有「本页地址确实命中了一条走后台通道的规则」
 * 才值得说一句「还没回报」——那正是用户在问「为什么代理没生效」的位置。
 *
 * 三个刻意不显示的情况：非 http 页（JS 层根本不存在）、一条规则都没命中的普通网站
 * （这一句在这里等于噪声），以及命中网络层规则且无读数的页面（那条证据由
 * 「本页 · 近 5 分钟」那一格负责，这里再补一句会与同屏的命中数正面打架）。
 * 有读数时照旧一律显示，包括网络层页面：那说明页面上另有一条后台通道规则在工作。
 * 判据取 `pageHitRuleId` 而不是「配置里有复杂规则」——后者几乎恒真，会把这一行变成常驻噪声。
 */
const interceptorStripVisible = computed(() => {
  if (!enabled.value || !pageHitProxiable.value || !interceptorFetched.value) return false;
  if (interceptorView.value.state !== 'noData') return true;
  return !!pageHitRuleId.value && !pageHitChannelDnr.value;
});

/**
 * 一句话状态。措辞红线：「没有读数」只能说成「还没回报」，不能说成「代理未生效」——
 * iframe 场景下父页面本来就可能一个请求都没有，五种状态各有各的成因。
 * 优先级是回退 > 超时 > 正常：一句话只放得下最该先知道的那件事，其余三个数在悬停里。
 */
const interceptorText = computed(() => {
  const { state, stats } = interceptorView.value;
  if (state === 'fellBack' && stats)
    return t('interceptorFellBack', [String(stats.intercepted), String(stats.fellBack)]);
  if (state === 'timedOut' && stats)
    return t('interceptorTimedOut', [String(stats.intercepted), String(stats.timedOut)]);
  if (state === 'active' && stats) return t('interceptorActive', [String(stats.intercepted), String(stats.proxied)]);
  if (state === 'noReport' && stats) return t('interceptorNoReport', String(stats.swProxied));
  return t('interceptorNoData');
});

/** 悬停给完整四个计数与采信时刻（原生 title，纯文本，并点名四个数不可相加）；只有真读数值得展开，「没有数据」没有可展开的东西 */
const interceptorDetailText = computed(() => {
  const { state, stats } = interceptorView.value;
  if (!stats || state === 'noData' || state === 'noReport') return '';
  return t('interceptorDetail', [
    formatClock(stats.updatedAt),
    String(stats.intercepted),
    String(stats.proxied),
    String(stats.fellBack),
    String(stats.timedOut),
  ]);
});

async function fetchTabInterceptorStats(tabId: number | undefined) {
  if (typeof tabId !== 'number') return;
  try {
    const entry: unknown = await chrome.runtime.sendMessage({
      type: MessageType.GET_INTERCEPTOR_STATS,
      data: { tabId },
    });
    interceptorFetched.value = true;
    // 只接受结构完整的读数：SW 异常时的 `{ success:false }` 不得覆盖已有数字
    if (isInterceptorStatsEntry(entry)) interceptorRaw.value = entry;
  } catch (error) {
    logger.debug('Fetch tab interceptor stats failed:', error);
  }
}

// ─── 配置广播的送达状态（这一页有没有在用最新规则） ──────────────────────────

/** 最近一次读到的结论；SW 只记已知的问题，没记过就是已同步 */
const configUnsynced = ref(false);
/**
 * 是否真的读到过一回账。
 *
 * 这句话的前提是「一次真实读取说它没送达」，而不是「某个布尔恰好停在初始值」——
 * 把前提写成显式闸门，读不到账（SW 未起、消息失败、回包形状不完整）就永远不会出现这句警告。
 */
const configSyncFetched = ref(false);

/**
 * 只在「确实读到过、且读到的就是没送达」时出现。
 *
 * 闸门与拦截器那一行同源：非 http(s) 页根本没有内容脚本，那句话对它既不适用也无从修复；
 * 总开关关闭时旧配置与新配置同样都不生效，此时警告只是噪声。
 */
const configSyncVisible = computed(
  () => enabled.value && pageHitProxiable.value && configSyncFetched.value && configUnsynced.value,
);

async function fetchTabConfigSync(tabId: number | undefined) {
  if (typeof tabId !== 'number') return;
  try {
    const status: unknown = await chrome.runtime.sendMessage({
      type: MessageType.GET_CONFIG_SYNC,
      data: { tabId },
    });
    // 只接受带布尔 `synced` 的回执：形状不对就当没读到过，宁可不说话，也不把「不知道」说成「有问题」
    if (!isConfigSyncStatus(status)) return;
    configSyncFetched.value = true;
    configUnsynced.value = !status.synced;
  } catch (error) {
    logger.debug('Fetch tab config sync state failed:', error);
  }
}

// ─── 自动关闭倒计时 ─────────────────────────────────────────────────────────

/** 剩余时间格式化：超过 1 小时显示 "Xh Ym"，否则 "m:ss" */
function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const autoOffText = ref('');

function tickAutoOff() {
  if (!autoOffAt.value || !enabled.value) {
    autoOffText.value = '';
    return;
  }
  const remaining = autoOffAt.value - Date.now();
  if (remaining <= 0) {
    autoOffText.value = '';
    // 到期后 SW 可能已自动关闭代理，刷新一次状态保持一致。
    // 刷完必须把 `autoOffAt` 清掉（L-8）：不归零的话每一 tick 都重新「判到期 → 拉整份状态」，
    // `loading` 每秒被置真一次——开关下面反复闪 spinner 且短暂禁点，而下一秒的读数与这一秒相同，
    // 多刷的这几轮什么也没换来（真正的终态由那一次 `fetchStatus` 写回）。
    autoOffAt.value = undefined;
    void fetchStatus();
    return;
  }
  autoOffText.value = t('autoOffCountdown', formatRemaining(remaining));
}

let autoOffTimer: ReturnType<typeof setInterval> | null = null;

// ─── 自动关闭档位：就在开关下面改，不必为它开一次配置页 ──────────────────────

/**
 * 当前档位；`null` = 还没读到或读失败。
 *
 * 读失败时整条不画（模板的 `v-if`）。把它当 `0` 画就是指着用户说「你没设自动关闭」，
 * 而事实是我们不知道——与这一屏「读不到就画 —」同一条规矩。
 */
const autoOffMinutes = ref<number | null>(null);

/** 一次设置在途：整条禁用，避免两份「预期落点」互相顶掉（`applyAutoOffMinutes` 靠它自己那次预期判断） */
const autoOffPending = ref(false);

/**
 * 存的值不在档位表里（手改过 storage、或旧版本留下的 15 分钟）。
 * 这时五格没有一格是亮的，光秃秃的一排比一个假选中更让人困惑，所以补一句「当前 N 分钟」。
 */
const autoOffIsCustom = computed(
  () =>
    autoOffMinutes.value !== null &&
    autoOffMinutes.value > 0 &&
    !AUTO_OFF_PRESET_MINUTES.includes(autoOffMinutes.value),
);

/** 挂载时读一份：点下去不该有等待，读不到则整条不出现（失败不弹提示，与快照列表那处一致） */
async function loadAutoOffMinutes() {
  try {
    autoOffMinutes.value = await readAutoOffMinutes();
  } catch (error) {
    logger.debug('Read auto-off minutes failed:', error);
  }
}

/**
 * 选一格：写进 storage，后台的 `storage.onChanged` 是唯一重建倒计时的人，这里只负责把新落点读回来。
 *
 * 三档结果各有说法（`utils/autoOff.ts`）：写入失败要回滚那一格的选中态并报错；
 * 读到落点就直接写给倒计时，省掉一次整份状态拉取；落点没读到（预算 600ms 用尽）时设置本身已经生效，
 * 于是重拉一次状态、按后台真正给出的那个值画——绝不拿 `Date.now() + 时长` 造一个没观测到的时刻。
 * 选中的就是当前那格时一个字都不写：不然每点一次就重启一次倒计时，还白写一次存储。
 */
async function chooseAutoOff(preset: (typeof AUTO_OFF_PRESETS)[number]) {
  if (autoOffPending.value || autoOffMinutes.value === preset.minutes) return;
  const previous = autoOffMinutes.value;
  autoOffPending.value = true;
  autoOffMinutes.value = preset.minutes;
  try {
    // 总开关关着时后台压根不会挂那枚 alarm（它只在 enabled 且有时长时建），轮询六趟只会白等 600ms
    // 然后诚实报「读不到落点」。所以那一趟只在代理开着时跑；关着就只写字面值，落点本来就是「无」。
    const result: AutoOffApplyResult = enabled.value
      ? await applyAutoOffMinutes(preset.minutes)
      : (await writeAutoOffMinutes(preset.minutes))
        ? { status: 'applied', autoOffAt: undefined }
        : { status: 'failed' };
    if (result.status === 'failed') {
      autoOffMinutes.value = previous;
      ElMessage.error(t('autoOffSaveFailed'));
      return;
    }
    if (result.status === 'applied') {
      autoOffAt.value = result.autoOffAt;
      tickAutoOff();
    } else {
      void fetchStatus();
    }
    ElMessage.success(preset.minutes > 0 ? t('autoOffSet', t(preset.shortKey)) : t('autoOffCancelled'));
  } catch (error) {
    logger.error('Set auto-off failed:', error);
    autoOffMinutes.value = previous;
    ElMessage.error(t('autoOffSaveFailed'));
  } finally {
    autoOffPending.value = false;
  }
}

onMounted(() => {
  tickAutoOff();
  autoOffTimer = setInterval(tickAutoOff, 1000);
  void loadAutoOffMinutes();
  void computePageHit();
  // 快照列表先读一份：点卡片时不该有等待。失败不在这里报，留给下一次点击重试
  void refreshProfiles();
});

onUnmounted(() => {
  if (autoOffTimer) clearInterval(autoOffTimer);
});

async function handleToggleProxy(value: boolean) {
  try {
    await toggleProxy(value);
  } catch (error) {
    logger.error('Toggle proxy failed:', error);
    ElMessage.error(t('toggleFailed'));
    // v-model 已翻转开关显示，从后台重新拉取状态回滚，避免 UI 与实际不一致
    await fetchStatus();
  }
}

async function handleToggleRule(ruleId: string, enabled: boolean) {
  try {
    await toggleRule(ruleId, enabled);
  } catch (error) {
    logger.error('Toggle rule failed:', error);
    ElMessage.error(t('toggleFailed'));
  }
}

const currentVersion = chrome.runtime.getManifest().version;

/**
 * 页面自报的「疑似被 CORS 拦下」来源清单
 *
 * 空数组有两种来源：这一页确实没报过失败的原生请求，以及**问不到**（没有内容脚本、超时）。
 * 两者都不许说成「这一页没有跨域问题」，所以界面只在非空时说话——与「配置送达账」那条同一个口径。
 * 这份数由页面自报、同页脚本可伪造（判据见 `utils/corsSuspects.ts`），因此它只加一个「疑似」标记，
 * 绝不参与任何开关、不写 storage、不进任何判定分支。
 */
const corsSuspects = ref<CorsSuspect[]>([]);

/** 拉一次快照：`probeCorsSuspects` 自己把失败收成空数组，这里不需要 catch */
async function fetchCorsSuspects(tabId: number | undefined): Promise<void> {
  corsSuspects.value = await probeCorsSuspects(tabId);
}

/** 卡片那行说明：侦到了就先说这件事——值不值得点开，用户应该在点之前就知道 */
const createRuleFromTabDesc = computed(() =>
  corsSuspects.value.length > 0
    ? t('actionCreateRuleFromTabSuspect', String(corsSuspects.value.length))
    : t('actionCreateRuleFromTabDesc'),
);

/**
 * 「这一页在调哪些接口」的候选面板；`null` = 收起
 *
 * 面板里每一行点下去都走同一个 hash（`#add-rule-from-tab=<地址>`），只是带过去的地址
 * 从「页面文档」换成了「这一页真正在调的接口」。`fallback` 是旧行为的那一行（本页文档地址），
 * 只在本页 origin 没出现在候选里时补上——同一件事不该在同一列里出现两遍。
 * `rows` 由 `buildPickerRows` 把两份读数拼成一列，带疑似标记的行排在最前。
 */
const apiPicker = ref<{ rows: ApiPickerRow[]; fallback: { origin: string; draft: string } | null } | null>(null);

/** 面板里有没有带「疑似」标记的行：那一句解释只在说得出这件事时出现，没标记就不必自证清白 */
const apiPickerSuspectVisible = computed(() =>
  apiPicker.value ? apiPicker.value.rows.some(row => row.suspect > 0) : false,
);

/** 选定一个来源（或那行本页地址）：沿用与旧行为完全相同的 hash 契约直达 Options */
async function chooseApiDraft(draft: string) {
  apiPicker.value = null;
  await openOptionsPage(`#add-rule-from-tab=${encodeURIComponent(draft)}`);
}

/**
 * 为当前标签页创建规则：先问这一页在调哪些接口、哪些像是没通，问得出就给候选，
 * 两句都问不到照旧按页面地址预填。
 * 非 http/https 页面（如浏览器内部页）无法代理，提示后保留 popup 不跳转。
 *
 * 两次探测并发发出：它们各有各的 800ms 上限，串起来就是点击后悬着 1.6 秒。
 * 面板用的是**刷新过的那份**疑似清单（与卡片那行说明同一个数，不会点开后少一个标记）。
 */
async function handleCreateRuleFromTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url || !/^https?:/i.test(url)) {
      ElMessage.error(t('createRuleFromTabFailed'));
      return;
    }
    const [choices] = await Promise.all([probePageApiOrigins(tab?.id), fetchCorsSuspects(tab?.id)]);
    const rows = buildPickerRows(choices, corsSuspects.value);
    if (rows.length === 0) {
      await openOptionsPage(`#add-rule-from-tab=${encodeURIComponent(url)}`);
      return;
    }
    // 只取 origin 做「候选里有没有本页」的比对：文档地址带路径时字符串永远不相等
    const pageOrigin = new URL(url).origin;
    apiPicker.value = {
      rows,
      fallback: rows.some(row => row.origin === pageOrigin) ? null : { origin: pageOrigin, draft: url },
    };
  } catch (error) {
    logger.error('Create rule from tab failed:', error);
    ElMessage.error(t('createRuleFromTabFailed'));
  }
}

// ─── 环境快照一键切换 ─────────────────────────────────────────────────────

/** 快照面板展开状态；`null` 语义与 `apiPicker` 同一套——收起时面板整个不在 DOM 里 */
const profilePicker = ref(false);
/** 等待确认的那一条；只有它下面展开后果说明 */
const pendingProfileId = ref('');
/** 列表是否真读到过：没读到就不许说「你还没有快照」，点卡片照旧直达 Options 管理弹窗 */
const profilesReadOk = ref(false);

const { profiles, loadingProfiles, switchingProfile, loadProfiles, loadProfile } = useProfiles();

/**
 * 拉一次快照列表并记下「读到过」这件事。
 *
 * 挂载时先拉（点开卡片不该有等待），读失败时留给下一次点击重试一次——
 * SW 冷启动的第一笔消息最容易空回，而「没读到」和「一条都没有」在界面上必须是两回事。
 */
async function refreshProfiles(): Promise<boolean> {
  const ok = await loadProfiles();
  if (ok) profilesReadOk.value = true;
  return ok;
}

/**
 * 快照卡片：有快照就地展开面板，没有（或读不到）照旧跳 Options 的管理弹窗。
 *
 * 判据顺序是「读得到 + 非空」而不是 `profiles.length > 0`：读取失败时列表停在空数组，
 * 只看长度就等于把一次 IO 失败说成「用户一份快照都没存」。
 */
async function handleProfilesCard() {
  if (profilePicker.value) {
    profilePicker.value = false;
    pendingProfileId.value = '';
    return;
  }
  if (loadingProfiles.value) return;
  const ok = profilesReadOk.value || (await refreshProfiles());
  if (!ok || profiles.value.length === 0) {
    await openOptionsPage('#profiles');
    return;
  }
  pendingProfileId.value = '';
  profilePicker.value = true;
}

/** 点某一条：先把它自己的后果说明摊开，确认按钮出现在它正下方 */
function chooseProfile(profileId: string) {
  pendingProfileId.value = pendingProfileId.value === profileId ? '' : profileId;
}

/**
 * 确认切换：整套替换当前规则集，成功后刷新这一屏能看见的三处读数。
 *
 * 成功判据只认 composable 的 `success`（后台失败回的是 resolved 的 `{success:false}`，
 * `catch` 拦不到）；失败时面板留在原地、说明文字仍在，用户不需要重走一遍。
 * 之后 `fetchStatus()` 与 `computePageHit()` 各跑一次：规则集换了，
 * 「活跃规则 / 快捷开关列表」与「本页命中」都是它的派生值，不重算就是拿旧账回答新问题。
 */
async function applyProfile(profile: { id: string; name: string }) {
  const result = await loadProfile(profile.id);
  if (!result.success) {
    ElMessage.error(result.error || t('operationFailed'));
    return;
  }
  ElMessage.success(t('profileSwitched', profile.name));
  profilePicker.value = false;
  pendingProfileId.value = '';
  void fetchStatus();
  void computePageHit();
}

/**
 * 打开 Options 页；带 hash 时直达对应弹窗/抽屉
 * （#add-rule / #logs / #import-export / #add-rule-from-tab=<encoded url>）。
 * 优先复用已打开的 Options 标签页（通过 runtime.getContexts 查找，无需 tabs 权限），
 * 避免重复打开；更新 hash 属同文档导航，Options 侧监听 hashchange 响应直达。
 */
async function openOptionsPage(hash = '') {
  const optionsUrl = chrome.runtime.getURL('/options.html');
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.TAB],
    });
    const existing = contexts.find(c => c.documentUrl?.startsWith(optionsUrl));
    if (existing && existing.tabId !== -1) {
      await chrome.tabs.update(existing.tabId, {
        active: true,
        ...(hash ? { url: `${optionsUrl}${hash}` } : {}),
      });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: `${optionsUrl}${hash}` });
    }
  } catch (error) {
    // 降级处理：直接新建标签页
    logger.warn('Reuse options tab failed, creating a new one:', error);
    void chrome.tabs.create({ url: `${optionsUrl}${hash}` });
  }
  window.close();
}
</script>

<style scoped>
.popup-container {
  width: 320px;
  padding: 16px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--cop-bg-color);
  border-radius: 8px;
}

/* 头部 */
.header {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--cop-border-color-light);
}

.logo {
  color: var(--cop-primary);
}

.header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--cop-text-color-primary);
}

.version-tag {
  flex-shrink: 0;
  padding: 0 6px;
  font-size: 11px;
  line-height: 18px;
  color: var(--cop-text-color-secondary);
  cursor: default;
  user-select: none;
}

/* 开关状态行 */
.toggle-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color);
  border-radius: 10px;
  transition:
    background var(--cop-duration-base) var(--cop-ease-standard),
    border-color var(--cop-duration-base) var(--cop-ease-standard);
}

.toggle-section.is-active {
  background: var(--cop-primary-bg);
  border-color: var(--cop-primary-border);
}

/* 开关那一行自己回到原来的横向布局：整张卡改成列之后，档位条要占满宽度 */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.auto-off-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.auto-off-picker-head {
  display: flex;
  gap: 6px;
  align-items: baseline;
}

.auto-off-picker-label {
  font-size: 11px;
  color: var(--cop-text-color-secondary);
  user-select: none;
}

.auto-off-picker-note {
  font-size: 11px;
  color: var(--cop-text-color-placeholder);
}

.auto-off-chips {
  display: flex;
  gap: 6px;
}

/*
  五格等宽：内容宽 320px 减去这一行左右的 14px 内边距与四段 6px 间隙，
  中英文最长的「4小时 / 4h」都放得下（2026-09-30 用一次性探针在 320px 下逐个量过，见交付说明）。
  选中态不只靠颜色：字重与边框同时变，`aria-pressed` 再说给读屏。
*/
.auto-off-chip {
  flex: 1;
  padding: 4px 0;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.4;
  color: var(--cop-text-color-regular);
  text-align: center;
  cursor: pointer;
  background: var(--cop-bg-color);
  border: 1px solid var(--cop-border-color);
  border-radius: 6px;
  transition:
    color var(--cop-duration-fast) var(--cop-ease-standard),
    background var(--cop-duration-fast) var(--cop-ease-standard),
    border-color var(--cop-duration-fast) var(--cop-ease-standard);
}

.auto-off-chip:hover {
  border-color: var(--cop-primary-border);
}

.auto-off-chip.is-selected {
  font-weight: 600;
  color: var(--cop-primary);
  background: var(--cop-primary-bg);
  border-color: var(--cop-primary);
}

.auto-off-chip:focus-visible {
  outline: none;
  border-color: var(--cop-primary);
  box-shadow: 0 0 0 2px rgb(var(--cop-primary-rgb) / 25%);
}

.auto-off-chip:disabled {
  cursor: default;
  opacity: 0.6;
}

.toggle-label-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.toggle-label {
  display: flex;
  gap: 8px;
  align-items: center;
}

.auto-off-countdown {
  display: flex;
  gap: 4px;
  align-items: center;
  padding-left: 16px;
  font-size: 11px;
  color: var(--el-color-warning);
  user-select: none;
}

.status-dot {
  width: 8px;
  height: 8px;
  background: var(--cop-text-color-placeholder);
  border-radius: 50%;
  transition: background var(--cop-duration-base) var(--cop-ease-standard);
}

.status-dot.active {
  background: var(--el-color-success);

  /* 类是「拨开关」那一刻加上的，所以这一圈只在状态真的变了的那一次跑：
     不用 JS 记时器、也不区分变化来自本页还是别的扩展页。
     只有一处用，故关键帧就近放在这条规则下面，不进 `tokens.css` 的共用段。 */
  animation: dot-ping var(--cop-duration-slow) var(--cop-ease-standard) 1;
}

/* 向外扩散并散掉的一圈主色：起始 0 扩散半径、收尾 6px 全透明，
   所以动画结束后不必收回——它落回的就是「没有 box-shadow」这个静止态 */
@keyframes dot-ping {
  from {
    box-shadow: 0 0 0 0 rgb(var(--cop-primary-rgb) / 40%);
  }

  to {
    box-shadow: 0 0 0 6px rgb(var(--cop-primary-rgb) / 0%);
  }
}

.toggle-text {
  font-size: 14px;
  font-weight: 500;
  color: var(--cop-text-color-primary);
}

.toggle-status {
  font-size: 12px;
  color: var(--cop-text-color-secondary);
}

.toggle-status.is-active {
  color: var(--el-color-success);
}

/* 数据点 + 拦截器活动（两者共用同一条分隔线，间距与拆分前一致） */
.metrics-block {
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--cop-border-color-light);
}

.metrics-row {
  display: flex;

  /* 三格顶部对齐：只有第三格带注释行，居中会让前两格的数字下沉半行 */
  align-items: flex-start;
  justify-content: space-around;
  padding-top: 8px;
}

.metric {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  align-items: center;
  min-width: 0;
}

.metric-value {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--cop-primary);
}

/* 「活跃规则」这一格说的就是工具栏徽章上那个数（两者同源于 `activeRuleCount`，
   见 `entrypoints/background/badgeManager.ts`）。用户拨完开关最常问的一句是「徽章数字变没变」，
   所以数字每换一次读数就向外散一圈——开关那一侧的 `dot-ping` 是同一个动作的同一个语言。
   动画挂在**按读数 key 化的内层**：值没变就不会重挂载，也就不会响；周期性的状态刷新因此是安静的。
   `to` 落回「没有 box-shadow」这个静止态，动画散场后不必收回（与状态点那份同一写法）。
   圆角是给这一圈的形状：20px 粗体字的方框外面套一圈硬边矩形会显脏。 */
.metric-value-digit {
  display: inline-block;
  border-radius: 4px;
  animation: dot-ping var(--cop-duration-slow) var(--cop-ease-standard) 1;
}

.metric-label {
  max-width: 96px;
  font-size: 11px;
  line-height: 1.3;
  color: var(--cop-text-color-secondary);
}

/* 注释行抬到 11px（与 `.metric-label` 同一档，L-15）。
   改之前在真机 320px 下量过一轮（`.test-tmp/probe/popup-320.cjs`，不入库）：中文最长那句
   「无生效的网络层规则」90px → 99px，仍在 106px 的列宽里，一行不变；英文
   「No network-layer rules」改前改后都是两行——那是 `max-width: 100px` 掐的，与字号无关。
   也就是说这一格**没有因为抬字号多占一行**，之前的担心不成立。`max-width` 保留：
   它管的是英文长句的换行点，第三列的可用宽度由 `.metrics-row` 的 `flex: 1` 定。 */
.metric-note {
  max-width: 100px;
  font-size: 11px;
  line-height: 1.3;
  color: var(--cop-text-color-secondary);
}

.metric.is-unknown .metric-value {
  color: var(--cop-text-color-placeholder);
}

.metric-divider {
  align-self: center;
  width: 1px;
  height: 28px;
  background: var(--cop-border-color);
}

/* 拦截器自报活动：一整行的话术，塞进 320px 的第三格只会截断 */
.interceptor-strip {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--cop-text-color-secondary);
  cursor: default;

  /* 它是 v-if 出来的：读数第一次攒够时整条凭空出现，不给一次进场就像界面抖了一下。
     位移就是共用的那 6px——这一行是旁路观测，动效不该比它上面那三个数字更抢眼 */
  animation: cop-rise-in var(--cop-duration-base) var(--cop-ease-enter);
}

/* 「页面自报」这枚小标签按 11px 排（与它右边那句话同档，L-15）。
   它自己是 `flex: none` 的整块，撑不开的只会右边那句（它有 `min-width: 0`）——
   真机 320px 量过：中文标签 48px → 52px、英文 78px → 85px，都是单行，
   右侧那句话从 266px / 236px 让到 262px / 229px，行数不变、不裁切、不溢出容器。 */
.interceptor-chip {
  flex: none;
  padding: 0 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--cop-text-color-secondary);
  background: var(--cop-bg-color-tertiary);
  border-radius: 4px;
}

.interceptor-text {
  min-width: 0;

  /* 状态换色（回退 / 超时 / 无读数 / 正常）此前是硬切，读的人分不清这是「新消息」还是「同一句换了语气」 */
  transition: color var(--cop-duration-base) var(--cop-ease-standard);
}

/* 状态同时靠文字与颜色说话（颜色只是强化，不是唯一载体） */
.interceptor-strip--fellBack .interceptor-text {
  color: var(--el-color-danger, #f56c6c);
}

/* 代发超时与「没有可采信读数」共用告警色：都是「有事，但还没到没走代理那一步」 */
.interceptor-strip--timedOut .interceptor-text {
  color: var(--el-color-warning, #e6a23c);
}

.interceptor-strip--noReport .interceptor-text {
  color: var(--el-color-warning, #e6a23c);
}

.interceptor-strip--active .interceptor-text {
  color: var(--el-color-success, #67c23a);
}

/* 配置没送达：这一页仍在用旧规则干活，用户当下唯一能做的动作就是刷新，所以给告警色而非次要色 */
.config-sync-warning {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--el-color-warning, #e6a23c);
  cursor: default;

  /* 与拦截器那一行同一种进场：两条提示都会在读数到位后突然出现，抖动的方式得一致 */
  animation: cop-rise-in var(--cop-duration-base) var(--cop-ease-enter);
}

/* 当前页命中预览 */
.page-hit-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color-light);
  border-radius: 8px;
}

.page-hit-header {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--cop-text-color-secondary);
}

.page-hit-title {
  font-size: 12px;
  font-weight: 600;
}

.page-hit-boundary {
  margin: 0;
  font-size: 11px;
  line-height: 1.35;
  color: var(--cop-text-color-secondary);
}

.page-hit-url {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--cop-text-color-secondary);
  white-space: nowrap;
}

.page-hit-empty {
  font-size: 12px;
  color: var(--cop-text-color-secondary);
}

/* 成因是这一屏唯一给得出下一步的说明，所以比上面那句「未被代理」更重一档：常规文字色 +
   主题色左线，与 options「URL 匹配测试」里同一句话用同一套视觉语言（同一个 key，同一种说法）。 */
.page-hit-cause {
  padding-left: 8px;
  margin: 8px 0 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--cop-text-color-regular);
  border-left: 2px solid var(--cop-primary-border);
}

.page-hit-link {
  padding: 0;

  /* button 不吃继承字体，Chrome 会给它 UA 默认字形，同一句话里与正文不一致 */
  font-family: inherit;
  font-size: 12px;
  color: var(--cop-primary);
  text-decoration: underline;
  cursor: pointer;
  background: none;
  border: none;
}

.page-hit-link:focus-visible {
  outline: 2px solid var(--cop-primary);
  outline-offset: 2px;
}

.page-hit-result {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.page-hit-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}

.page-hit-label {
  flex: none;
  color: var(--cop-text-color-secondary);
}

/* 规则名可以很长，而 el-tag 是 nowrap 的整块：不约束就会画到卡片右边界之外
   （`.page-hit-row` 的 flex-wrap 救不了它——单个弹性项比行还宽时只能溢出）。
   overflow 让自动最小尺寸归零，省略号落在 EP 自带 min-width:0 的内容层上，
   完整名字经 title 悬停读到，与同一张卡片里 .page-hit-rewritten 的处理方式一致。 */
.page-hit-rule-tag {
  max-width: 100%;
  overflow: hidden;
}

.page-hit-rule-tag :deep(.el-tag__content) {
  overflow: hidden;
  text-overflow: ellipsis;
}

.page-hit-rewritten {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--cop-primary);
  white-space: nowrap;
}

.page-hit-off {
  font-size: 12px;
  color: var(--el-color-warning);
}

/* 动作卡片列表 */
.action-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.action-card {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px;
  cursor: pointer;
  user-select: none;
  outline: none;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color);
  border-radius: 10px;
  transition:
    background var(--cop-duration-fast) var(--cop-ease-standard),
    border-color var(--cop-duration-fast) var(--cop-ease-standard),
    box-shadow var(--cop-duration-fast) var(--cop-ease-standard),
    transform var(--cop-duration-instant) var(--cop-ease-standard);
}

.action-card:hover {
  background: var(--cop-primary-bg-hover);
  border-color: var(--cop-primary-border);
  box-shadow: 0 2px 8px rgb(var(--cop-primary-rgb) / 10%);
}

.action-card:active {
  background: var(--cop-primary-bg);
  box-shadow: 0 1px 4px rgb(var(--cop-primary-rgb) / 8%);
  transform: scale(0.99);
}

.action-card:focus-visible {
  border-color: var(--cop-primary);
  box-shadow: 0 0 0 2px rgb(var(--cop-primary-rgb) / 25%);
}

.action-card__icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  font-size: 18px;
  border-radius: 50%;
}

/* 三张动作卡图标为同一主题色阶家族（实心 / 浅调渐变 / 浅底纯调），
   全部由 --cop-primary 系列令牌派生，自动跟随六套主题切换 */
.action-card__icon--primary {
  color: var(--cop-text-color-on-primary);
  background: var(--cop-primary);
}

.action-card__icon--accent {
  color: var(--cop-text-color-on-primary);
  background: linear-gradient(135deg, var(--cop-primary-hover) 0%, var(--cop-primary) 100%);
}

.action-card__icon--tint {
  color: var(--cop-primary);
  background: rgb(var(--cop-primary-rgb) / 15%);
}

.action-card__content {
  flex: 1;
  min-width: 0;
}

.action-card__title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--cop-text-color-primary);
}

.action-card__desc {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.3;
  color: var(--cop-text-color-secondary);
}

/* 候选面板（「为当前页创建规则」点开后）：与动作卡同一套圆角与底色，
   靠主色边框表示「这是刚才那次点击展开的东西」，而不是第四张卡 */
.api-picker {
  padding: 10px 12px 12px;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-primary-border);
  border-radius: 10px;
}

.api-picker-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--cop-text-color-primary);
}

.api-picker-row {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 8px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--cop-bg-color);
  border: 1px solid var(--cop-border-color);
  border-radius: 6px;
  transition: border-color var(--cop-duration-fast) var(--cop-ease-standard);
}

.api-picker-row + .api-picker-row {
  margin-top: 6px;
}

.api-picker-row:hover {
  border-color: var(--cop-primary-border);
}

.api-picker-row:focus-visible {
  outline: none;
  border-color: var(--cop-primary);
  box-shadow: 0 0 0 2px rgb(var(--cop-primary-rgb) / 25%);
}

.api-picker-origin {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--cop-text-color-primary);
  white-space: nowrap;
}

.api-picker-count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--cop-text-color-secondary);
}

/* 「疑似 N 笔」那一格：与 options 规则列表的「未生效」同一套危险色通道。
   状态由文字说出来，颜色只是让它在这一列里更醒目（无障碍基线：不只用颜色表达状态）。 */
.api-picker-count--suspect {
  color: var(--el-color-danger, #f56c6c);
}

/* 带标记的行加一道同色描边，让最该点的那一行先跳出来；悬停时加深，与主色那套同一节奏 */
.api-picker-row--suspect {
  border-color: var(--el-color-danger-light-7, #f5cccc);
}

.api-picker-row--suspect:hover {
  border-color: var(--el-color-danger, #f56c6c);
}

/* 那行「本页地址」是旧行为，措辞与颜色都退半步，别与真候选同权重 */
.api-picker-row--muted .api-picker-origin {
  color: var(--cop-text-color-regular);
}

/* 「疑似」那句说明与边界那句同权重：都是这份读数的限制，不是一条错误 */
.api-picker-suspect-note,
.api-picker-boundary {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--cop-text-color-secondary);
}

/* 快照面板特有：确认块紧跟在被点的那一行下面，焦点仍留在原行，Tab 一步就落到「切换」 */
.api-picker-row.is-pending {
  border-color: var(--cop-primary);
}

.api-picker-row:disabled {
  cursor: default;
  opacity: 0.6;
}

/* 确认说明挤开了 `.api-picker-row + .api-picker-row` 的相邻关系，间距在这里补回来 */
.profile-confirm + .api-picker-row {
  margin-top: 6px;
}

.profile-confirm {
  padding: 8px;
  margin-top: 6px;
  background: var(--cop-primary-bg);
  border: 1px solid var(--cop-primary-border);
  border-radius: 6px;
}

.profile-confirm-text {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--cop-text-color-regular);
}

.profile-confirm-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.profile-confirm-btn {
  padding: 4px 12px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
  color: var(--cop-text-color-regular);
  cursor: pointer;
  background: var(--cop-bg-color);
  border: 1px solid var(--cop-border-color);
  border-radius: 6px;
  transition:
    border-color var(--cop-duration-fast) var(--cop-ease-standard),
    color var(--cop-duration-fast) var(--cop-ease-standard);
}

.profile-confirm-btn--apply {
  color: var(--cop-text-color-on-primary);
  background: var(--cop-primary);
  border-color: var(--cop-primary);
}

.profile-confirm-btn:hover:not(:disabled) {
  border-color: var(--cop-primary-border);
}

.profile-confirm-btn--apply:hover:not(:disabled) {
  background: var(--cop-primary-hover);
  border-color: var(--cop-primary-hover);
}

.profile-confirm-btn:focus-visible {
  outline: none;
  border-color: var(--cop-primary);
  box-shadow: 0 0 0 2px rgb(var(--cop-primary-rgb) / 25%);
}

.profile-confirm-btn:disabled {
  cursor: default;
  opacity: 0.6;
}

/* 最近请求 */
.recent-section {
  padding-top: 4px;
}

.recent-title {
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--cop-text-color-primary);
}

.recent-empty {
  padding: 12px 0;
  font-size: 12px;
  color: var(--cop-text-color-placeholder);
  text-align: center;
}

.recent-empty-hint {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--cop-text-color-secondary);
  text-align: center;
}

.recent-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  margin: 0;
  list-style: none;
}

/* 斑马纹 + hover 微右移 */
.recent-item {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 8px;
  border-radius: 6px;
  transition:
    background var(--cop-duration-fast) var(--cop-ease-standard),
    transform var(--cop-duration-fast) var(--cop-ease-standard);
}

.recent-item:nth-child(even) {
  background: var(--cop-bg-color-secondary);
}

.recent-item:hover {
  background: var(--cop-surface-hover);
  transform: translateX(2px);
}

.method-tag {
  flex-shrink: 0;
  width: 48px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 11px;
  text-align: center;
}

.recent-url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 1.4;
  color: var(--cop-text-color-regular);
  white-space: nowrap;
}

.status-tag {
  flex-shrink: 0;
  font-size: 11px;
}

.recent-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--cop-text-color-placeholder);
}

/* 可折叠规则列表 */
.rules-section {
  margin-bottom: 12px;
  overflow: hidden;
  border: 1px solid var(--cop-border-color);
  border-radius: 10px;
}

.rules-section-header {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  background: var(--cop-bg-color-secondary);
  transition: background var(--cop-duration-fast) var(--cop-ease-standard);
}

.rules-section-header:hover {
  background: var(--cop-primary-bg-hover);
}

/* 焦点环画在盒子里侧（inset），因为父级 `.rules-section` 带 `overflow: hidden`——
   标题正好铺满那一层的宽度，UA 默认描边（或任何往外长的环）会在四边被裁掉，
   于是「有焦点样式」与「焦点看得见」是两件事。同 `.api-picker-row:focus-visible` 一样
   显式接管描边，只是把环换成内阴影。 */
.rules-section-header:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--cop-primary-rgb) / 45%);
}

.rules-section-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--cop-text-color-primary);
}

.rules-section-count {
  padding: 1px 6px;
  font-size: 11px;
  color: var(--cop-text-color-secondary);
  background: var(--cop-bg-color-tertiary);
  border-radius: 8px;
}

.rules-section-arrow {
  font-size: 12px;
  color: var(--cop-text-color-secondary);
  transition: transform var(--cop-duration-base) var(--cop-ease-standard);
}

.rules-section-arrow.is-expanded {
  transform: rotate(180deg);
}

.rules-section-body {
  visibility: hidden;
  min-height: 0;
  padding: 0 10px;
  overflow: hidden;
  transition: visibility var(--cop-duration-base) var(--cop-ease-standard);
}

/* 原先由容器出的 4px / 8px 上下留白挪到这里：padding 计入元素高度，折叠时会在标题下面
   留下一条 12px 的空缝；margin 连同内容一起被 0fr 压掉，展开时又原样回到那个位置 */
.rules-section-body > :first-child {
  margin-top: 4px;
}

.rules-section-body > :last-child {
  margin-bottom: 8px;
}

/* 折叠动画：0fr → 1fr 让容器自己按内容长高，两端都不必猜高度 */
.rules-section-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--cop-duration-base) var(--cop-ease-standard);
}

.rules-section-collapse.is-open {
  grid-template-rows: 1fr;
}

.rules-section-collapse.is-open .rules-section-body {
  visibility: visible;
}

.rules-empty {
  padding: 12px 0;
  font-size: 12px;
  color: var(--cop-text-color-placeholder);
  text-align: center;
}

.rule-toggle-item {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 6px 4px;
  border-radius: 6px;
  transition: background var(--cop-duration-fast) var(--cop-ease-standard);
}

.rule-toggle-item:hover {
  background: var(--cop-primary-bg-hover);
}

.rule-toggle-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--cop-text-color-regular);
  white-space: nowrap;
}

/* 最近请求进场：新行从顶部淡入落位，已被挤下去的行跟着移动。
   move 那一档比进场略长一点——它是「别的东西在让位」，看慢一点反而说得清是谁挤的 */
.log-row-enter-active {
  transition:
    opacity var(--cop-duration-base) var(--cop-ease-enter),
    transform var(--cop-duration-base) var(--cop-ease-enter);
}

.log-row-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}

.log-row-leave-active {
  transition:
    opacity var(--cop-duration-fast) var(--cop-ease-exit),
    transform var(--cop-duration-fast) var(--cop-ease-exit);
}

.log-row-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.log-row-move {
  transition: transform var(--cop-duration-slow) var(--cop-ease-standard);
}
</style>
