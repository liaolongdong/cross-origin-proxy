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
      <el-switch
        v-model="enabled"
        :loading="loading"
        @change="toggleProxy"
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
        <el-icon class="rules-section-arrow" :class="{ 'is-expanded': rulesExpanded }">
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
            >{{ rule.name }}</span>
            <el-switch
              :model-value="rule.enabled"
              size="small"
              @change="(val: boolean) => handleToggleRule(rule.id, val)"
            />
          </div>
        </div>
      </Transition>
    </div>

    <!-- 数据点：活跃规则 / 今日请求 -->
    <div class="metrics-row">
      <div class="metric">
        <span class="metric-value">{{ activeRuleCount }}</span>
        <span class="metric-label">{{ t('activeRules') }}</span>
      </div>
      <div class="metric-divider"></div>
      <div class="metric">
        <span class="metric-value">{{ todayRequestCount }}</span>
        <span class="metric-label">{{ t('todayRequests') }}</span>
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
      <ul
        v-else
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
          <span class="recent-time">{{ formatTimeAgo(log.timestamp) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Promotion, Setting, Document, FolderOpened, ArrowDown } from '@element-plus/icons-vue';
import { useProxyStatus } from '@/composables/useProxyStatus';
import { useI18n } from '@/composables/useI18n';

/**
 * Popup 弹窗（动作卡片风格，参照 account-password-helper）
 *
 * 结构：头部 → 开关状态行 → 数据点 → 三张动作卡片（直达不同目标）→ 最近请求列表。
 * 动作卡片通过 URL hash 直达 Options 的日志抽屉与导入导出弹窗。
 */
const { t } = useI18n();
const {
  enabled,
  activeRuleCount,
  todayRequestCount,
  recentLogs,
  rules,
  loading,
  toggleProxy,
  toggleRule,
  formatTimeAgo,
  getMethodColor,
  getStatusColor,
  truncateUrl,
} = useProxyStatus();

const rulesExpanded = ref(false);

async function handleToggleRule(ruleId: string, enabled: boolean) {
  try {
    await toggleRule(ruleId, enabled);
  } catch (error) {
    console.error('Toggle rule failed:', error);
    ElMessage.error(t('toggleFailed'));
  }
}

const currentVersion = chrome.runtime.getManifest().version;

/**
 * 打开 Options 页；带 hash 时直达对应弹窗/抽屉（#add-rule / #logs / #import-export）。
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
    console.warn('Reuse options tab failed, creating a new one:', error);
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

.toggle-label {
  display: flex;
  gap: 8px;
  align-items: center;
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

/* 数据点 */
.metrics-row {
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 8px 0 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--cop-border-color-light);
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: center;
}

.metric-value {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--cop-primary);
}

.metric-label {
  font-size: 12px;
  color: var(--cop-text-color-secondary);
}

.metric-divider {
  width: 1px;
  height: 28px;
  background: var(--cop-border-color);
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
  border: 1px solid var(--cop-border-color);
  border-radius: 10px;
  overflow: hidden;
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
  font-size: 11px;
  color: var(--cop-text-color-secondary);
  background: var(--cop-bg-color-tertiary);
  padding: 1px 6px;
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
  white-space: nowrap;
  font-size: 13px;
  color: var(--cop-text-color-regular);
}

/* 折叠动画 */
.slide-enter-active,
.slide-leave-active {
  transition: all 0.2s ease;
  max-height: 300px;
  overflow: hidden;
}

.slide-enter-from,
.slide-leave-to {
  max-height: 0;
  opacity: 0;
}
</style>
