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
            @keydown.enter="$emit('addRule')"
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
            @keydown.enter="$emit('importConfig')"
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
          @keydown.enter="handleTemplateClick(tpl)"
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
      matchPattern: '*://*/api/v1/*',
      targetUrl: 'https://uat-api.example.com/api/v2/',
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
  transition: all 0.2s ease;
}

.guide-card:hover {
  border-color: var(--cop-primary, #409eff);
  box-shadow: 0 2px 12px rgb(var(--cop-primary-rgb, 64, 158, 255), 0.15);
  transform: translateY(-2px);
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
  margin-top: 32px;
  padding-top: 24px;
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
  transition: all 0.2s ease;
}

.template-card:hover {
  border-color: var(--cop-primary, #409eff);
  box-shadow: 0 2px 12px rgb(var(--cop-primary-rgb, 64, 158, 255), 0.12);
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
