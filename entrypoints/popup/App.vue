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

    <!-- 代理开关状态行 -->
    <div
      class="toggle-section"
      :class="{ 'is-active': enabled }"
    >
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
        @change="handleToggleProxy"
      />
    </div>

    <!-- 可折叠规则列表 -->
    <div class="rules-section">
      <div
        class="rules-section-header"
        role="button"
        tabindex="0"
        @click="rulesExpanded = !rulesExpanded"
        @keydown.enter="rulesExpanded = !rulesExpanded"
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
      <Transition name="slide">
        <div
          v-show="rulesExpanded"
          class="rules-section-body"
        >
          <div
            v-if="rules.length === 0"
            class="rules-empty"
          >
            {{ t('noRulesInPopup') }}
          </div>
          <div
            v-for="rule in rules"
            v-else
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
              @change="(val: boolean) => handleToggleRule(rule.id, val)"
            />
          </div>
        </div>
      </Transition>
    </div>

    <!-- 数据点：活跃规则 / 经扩展请求 / 本页网络层命中 + 拦截器自报活动 -->
    <div class="metrics-block">
      <div class="metrics-row">
        <div class="metric">
          <span class="metric-value">{{ activeRuleCount }}</span>
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
        @keydown.enter="openOptionsPage('#add-rule')"
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
        @click="handleCreateRuleFromTab"
        @keydown.enter="handleCreateRuleFromTab"
      >
        <div class="action-card__icon action-card__icon--tint">
          <el-icon><Plus /></el-icon>
        </div>
        <div class="action-card__content">
          <div class="action-card__title">{{ t('actionCreateRuleFromTab') }}</div>
          <div class="action-card__desc">{{ t('actionCreateRuleFromTabDesc') }}</div>
        </div>
      </div>

      <div
        class="action-card"
        role="button"
        tabindex="0"
        @click="openOptionsPage('#logs')"
        @keydown.enter="openOptionsPage('#logs')"
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
        @keydown.enter="openOptionsPage('#import-export')"
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
        @click="openOptionsPage('#profiles')"
        @keydown.enter="openOptionsPage('#profiles')"
      >
        <div class="action-card__icon action-card__icon--tint">
          <el-icon><Collection /></el-icon>
        </div>
        <div class="action-card__content">
          <div class="action-card__title">{{ t('actionProfiles') }}</div>
          <div class="action-card__desc">{{ t('actionProfilesDesc') }}</div>
        </div>
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
      <ul
        v-else-if="recentLogs.length > 0"
        class="recent-list"
      >
        <li
          v-for="log in recentLogs.slice(0, 5)"
          :key="log.id"
          class="recent-item"
        >
          <el-tag
            :type="getMethodColor(log.method)"
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
            :type="getStatusColor(log.status)"
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
      </ul>
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
import { useProxyStatus } from '@/composables/useProxyStatus';
import { useI18n } from '@/composables/useI18n';
import { MessageType } from '@/utils/types';
import { applyQueryOverrides, findMatchingRule, isSimpleRule, rewriteUrl } from '@/utils/urlMatcher';
import { findDnrSkippedRules, usesDnrChannel } from '@/utils/dnrSupport';
import { describeDnrSample, isDnrSample } from '@/utils/dnrSample';
import { describeInterceptorStats, isInterceptorStatsEntry } from '@/utils/interceptorStats';
import { isConfigSyncStatus } from '@/utils/configSync';
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
 * 读取当前活动标签页地址，用与实际代理同一套 urlMatcher 纯函数计算命中预览。
 * popup 生命周期短，仅在挂载时计算一次；非 http(s) 页面不可代理，仅展示提示。
 *
 * 三条证据各自独立：页面地址命中（本函数）、本页网络层命中数（`fetchTabDnrStats`）、
 * 哪些规则其实没被应用（`findDnrSkippedRules`）。任一失败都不连带另两条。
 * 另两条在同一处发出、同样互不连带：拦截器自报活动（`fetchTabInterceptorStats`）
 * 与配置广播的送达账（`fetchTabConfigSync`）。
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
    // 到期后 SW 可能已自动关闭代理，刷新状态保持一致
    void fetchStatus();
    return;
  }
  autoOffText.value = t('autoOffCountdown', formatRemaining(remaining));
}

let autoOffTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  tickAutoOff();
  autoOffTimer = setInterval(tickAutoOff, 1000);
  void computePageHit();
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
 * 为当前标签页创建规则：读取活动标签页 URL，经 hash 直达 Options 并预填 origin 通配符草稿。
 * 非 http/https 页面（如浏览器内部页）无法代理，提示后保留 popup 不跳转。
 */
async function handleCreateRuleFromTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url || !/^https?:/i.test(url)) {
      ElMessage.error(t('createRuleFromTabFailed'));
      return;
    }
    await openOptionsPage(`#add-rule-from-tab=${encodeURIComponent(url)}`);
  } catch (error) {
    logger.error('Create rule from tab failed:', error);
    ElMessage.error(t('createRuleFromTabFailed'));
  }
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
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: var(--cop-bg-color-secondary);
  border: 1px solid var(--cop-border-color);
  border-radius: 10px;
  transition: all 0.2s ease;
}

.toggle-section.is-active {
  background: var(--cop-primary-bg);
  border-color: var(--cop-primary-border);
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
  transition: background 0.2s ease;
}

.status-dot.active {
  background: var(--el-color-success);
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

.metric-label {
  max-width: 96px;
  font-size: 11px;
  line-height: 1.3;
  color: var(--cop-text-color-secondary);
}

.metric-note {
  max-width: 100px;
  font-size: 10px;
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
}

.interceptor-chip {
  flex: none;
  padding: 0 4px;
  font-size: 10px;
  line-height: 16px;
  color: var(--cop-text-color-secondary);
  background: var(--cop-bg-color-tertiary);
  border-radius: 4px;
}

.interceptor-text {
  min-width: 0;
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
  transition: all 0.2s ease;
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
  transition: all 0.2s ease;
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
  transition: background 0.2s ease;
}

.rules-section-header:hover {
  background: var(--cop-primary-bg-hover);
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
  transition: transform 0.2s ease;
}

.rules-section-arrow.is-expanded {
  transform: rotate(180deg);
}

.rules-section-body {
  padding: 4px 10px 8px;
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
  transition: background 0.15s ease;
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

/* 折叠动画 */
.slide-enter-active,
.slide-leave-active {
  max-height: 300px;
  overflow: hidden;
  transition: all 0.2s ease;
}

.slide-enter-from,
.slide-leave-to {
  max-height: 0;
  opacity: 0;
}
</style>
