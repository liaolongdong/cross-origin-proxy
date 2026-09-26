<template>
  <div class="empty-guide">
    <el-empty :description="t('noRules')">
      <template #image>
        <svg
          class="empty-icon"
          viewBox="0 0 120 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle
            cx="60"
            cy="60"
            r="50"
            fill="var(--cop-primary-bg, #ecf5ff)"
          />
          <path
            d="M38 50h36"
            stroke="var(--cop-primary, #409eff)"
            stroke-width="3"
            stroke-linecap="round"
          />
          <path
            d="M68 44l8 6-8 6"
            stroke="var(--cop-primary, #409eff)"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M82 70H46"
            stroke="var(--cop-primary, #409eff)"
            stroke-width="3"
            stroke-linecap="round"
          />
          <path
            d="M52 64l-8 6 8 6"
            stroke="var(--cop-primary, #409eff)"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </template>
      <template #default>
        <p class="empty-hint">{{ t('noRulesHint') }}</p>
        <div class="guide-cards">
          <div
            class="guide-card"
            role="button"
            tabindex="0"
            @click="$emit('addRule')"
            @keydown.enter.space.prevent="$emit('addRule')"
          >
            <div class="guide-card-icon">
              <el-icon><Plus /></el-icon>
            </div>
            <div class="guide-card-text">
              <div class="guide-card-title">{{ t('guideAddRule') }}</div>
              <div class="guide-card-desc">{{ t('guideAddRuleDesc') }}</div>
            </div>
          </div>
          <div
            class="guide-card"
            role="button"
            tabindex="0"
            @click="$emit('importConfig')"
            @keydown.enter.space.prevent="$emit('importConfig')"
          >
            <div class="guide-card-icon">
              <el-icon><Upload /></el-icon>
            </div>
            <div class="guide-card-text">
              <div class="guide-card-title">{{ t('guideImport') }}</div>
              <div class="guide-card-desc">{{ t('guideImportDesc') }}</div>
            </div>
          </div>
        </div>
      </template>
    </el-empty>

    <!-- 快速模板区域 -->
    <div class="templates-section">
      <div class="templates-header">
        <h3 class="templates-title">{{ t('quickTemplates') }}</h3>
        <p class="templates-desc">{{ t('templateDesc') }}</p>
      </div>
      <div class="template-cards">
        <div
          v-for="tpl in templates"
          :key="tpl.key"
          class="template-card"
          role="button"
          tabindex="0"
          @click="handleTemplateClick(tpl)"
          @keydown.enter.space.prevent="handleTemplateClick(tpl)"
        >
          <div class="template-card-icon">
            <el-icon><component :is="tpl.icon" /></el-icon>
          </div>
          <div class="template-card-text">
            <div class="template-card-title">{{ t(tpl.titleKey) }}</div>
            <div class="template-card-desc">{{ t(tpl.descKey) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Plus, Upload, Link, Switch as SwitchIcon, Key, Setting } from '@element-plus/icons-vue';
import { useI18n } from '@/composables/useI18n';
import type { ProxyRule } from '@/utils/types';
import type { Component } from 'vue';

const emit = defineEmits<{
  addRule: [];
  importConfig: [];
  useTemplate: [ruleData: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>];
}>();

const { t } = useI18n();

interface TemplateItem {
  key: string;
  titleKey: string;
  descKey: string;
  icon: Component;
  ruleData: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>;
}

const templates: TemplateItem[] = [
  {
    key: 'wildcard-api',
    titleKey: 'wildcardApiProxy',
    descKey: 'wildcardApiProxyDesc',
    icon: Link,
    ruleData: {
      name: 'FAT → UAT API',
      enabled: true,
      matchPattern: '*://api-fat.example.com/*',
      targetUrl: 'https://api-uat.example.com/',
      matchType: 'wildcard',
      priority: 100,
    },
  },
  {
    key: 'prefix-path',
    titleKey: 'prefixPathProxy',
    descKey: 'prefixPathProxyDesc',
    icon: SwitchIcon,
    ruleData: {
      name: 'API v1 → v2',
      enabled: true,
      matchPattern: 'https://api-fat.example.com/api/v1',
      targetUrl: 'https://api-uat.example.com/api/v2',
      matchType: 'prefix',
      priority: 100,
    },
  },
  {
    key: 'auth-header',
    titleKey: 'addAuthHeader',
    descKey: 'addAuthHeaderDesc',
    icon: Key,
    ruleData: {
      name: 'Add Bearer Token',
      enabled: true,
      matchPattern: '*://*.example.com/*',
      targetUrl: '',
      matchType: 'wildcard',
      headerOverrides: {
        Authorization: 'Bearer <your-token-here>',
      },
      priority: 50,
    },
  },
  {
    key: 'custom-header',
    titleKey: 'customHeaderOverride',
    descKey: 'customHeaderOverrideDesc',
    icon: Setting,
    ruleData: {
      name: 'Custom Header Override',
      enabled: true,
      matchPattern: '*://*.example.com/*',
      targetUrl: '',
      matchType: 'wildcard',
      headerOverrides: {
        'X-Custom-Header': 'custom-value',
      },
      priority: 50,
    },
  },
];

function handleTemplateClick(tpl: TemplateItem) {
  emit('useTemplate', tpl.ruleData);
}
</script>

<style scoped>
.empty-guide {
  padding: 40px 20px;
}

.empty-icon {
  width: 120px;
  height: 120px;
}

.empty-hint {
  margin: 0;
  font-size: 14px;
  color: var(--el-text-color-secondary, #909399);
}

.guide-cards {
  display: flex;
  gap: 16px;
  justify-content: center;
  margin-top: 20px;
}

.guide-card {
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: 200px;
  padding: 16px 20px;
  cursor: pointer;
  background: var(--el-bg-color, #fff);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 10px;
  transition:
    border-color var(--cop-duration-fast) var(--cop-ease-standard),
    box-shadow var(--cop-duration-fast) var(--cop-ease-standard),
    transform var(--cop-duration-fast) var(--cop-ease-enter);
}

.guide-card:hover {
  border-color: var(--cop-primary, #409eff);
  box-shadow: 0 2px 12px rgb(var(--cop-primary-rgb) / 15%);
  transform: translateY(-2px);
}

/* 首次进入时按 60ms 一档错峰落位：这一屏是用户装完扩展看到的第一页，几条建议同时出现
   和先后出现，读起来是「一屏文案」与「几件可做的事」的差别。
   每一级都写成 `n + k`（「第 k 张起」）而不是逐个点名：逐个点名时，将来从 `templates` 里
   多加一张卡、或往 `.guide-cards` 里再插一张，那张没有规则命中它，延迟回落到 0、跟第一张
   同时进场，阶梯走到末尾会倒着跳一次——而且没有任何报错。今天实算是 2 张引导卡 + 4 张模板卡
   （`templates` 那份数组），`n + 4` 就是给第 5 张预留的那一级。
   填充只用 `backwards`（延迟期间停在起始帧，播完就交还给样式）——用 `both` 会把
   `transform` 冻结在动画的收尾值上，而动画的层叠优先级高于 `:hover`，
   那张卡从此抬不起来。阶梯本身由 `tests/designTokens.test.ts` 按张数与写法双向钉住。 */
.guide-card,
.template-card {
  animation: cop-rise-in var(--cop-duration-base) var(--cop-ease-enter) backwards;
}

.guide-card:nth-child(n + 2),
.template-card:nth-child(n + 2) {
  animation-delay: 60ms;
}

.template-card:nth-child(n + 3) {
  animation-delay: 120ms;
}

.template-card:nth-child(n + 4) {
  animation-delay: 180ms;
}

.guide-card-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  font-size: 18px;
  color: var(--cop-primary, #409eff);
  background: var(--cop-primary-bg, #ecf5ff);
  border-radius: 50%;
}

.guide-card-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary, #303133);
}

.guide-card-desc {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}

/* 快速模板区域 */
.templates-section {
  padding-top: 24px;
  margin-top: 32px;
  border-top: 1px dashed var(--el-border-color-lighter, #ebeef5);
}

.templates-header {
  margin-bottom: 16px;
  text-align: center;
}

.templates-title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary, #303133);
}

.templates-desc {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary, #909399);
}

.template-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  max-width: 960px;
  margin: 0 auto;
}

.template-card {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px 16px;
  cursor: pointer;
  background: var(--el-bg-color, #fff);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 10px;
  transition:
    border-color var(--cop-duration-fast) var(--cop-ease-standard),
    box-shadow var(--cop-duration-fast) var(--cop-ease-standard),
    transform var(--cop-duration-fast) var(--cop-ease-enter);
}

.template-card:hover {
  border-color: var(--cop-primary, #409eff);
  box-shadow: 0 2px 12px rgb(var(--cop-primary-rgb) / 12%);
  transform: translateY(-2px);
}

.template-card-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: 16px;
  color: var(--cop-primary, #409eff);
  background: var(--cop-primary-bg, #ecf5ff);
  border-radius: 8px;
}

.template-card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary, #303133);
}

.template-card-desc {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-secondary, #909399);
}
</style>
