<template>
  <div class="header">
    <!-- 第一行：Logo + 标题 + 版本 + 代理状态信号灯 -->
    <div class="header-title-row">
      <h1>
        <el-icon class="logo"><Promotion /></el-icon>
        {{ t('extensionName') }}
        <el-tag
          size="small"
          type="info"
          class="version-tag"
          >v{{ currentVersion }}</el-tag
        >
        <span
          class="status-dot"
          :class="{ 'is-on': proxyEnabled }"
          role="img"
          :aria-label="proxyEnabled ? t('statusEnabled') : t('statusDisabled')"
        ></span>
      </h1>
    </div>

    <!-- 第二行：操作按钮 -->
    <div class="header-actions-row">
      <div class="header-actions">
        <el-button
          type="primary"
          :icon="Plus"
          @click="$emit('addRule')"
        >
          {{ t('addRule') }}
        </el-button>
        <el-button
          :icon="Document"
          @click="$emit('openLogs')"
        >
          {{ t('tabLogs') }}
        </el-button>
        <el-button
          :icon="FolderOpened"
          @click="$emit('openImportExport')"
        >
          {{ t('importExportConfig') }}
        </el-button>
        <el-button
          :icon="Collection"
          @click="$emit('openProfiles')"
        >
          {{ t('openProfiles') }}
        </el-button>
        <el-button
          :icon="Setting"
          @click="$emit('openSettings')"
        >
          {{ t('tabSettings') }}
        </el-button>
      </div>

      <!-- 代理总开关：毛玻璃 pill -->
      <div class="proxy-toggle-pill">
        <span class="proxy-toggle-label">
          {{ proxyEnabled ? t('statusEnabled') : t('statusDisabled') }}
        </span>
        <el-switch
          :model-value="proxyEnabled"
          @change="val => $emit('toggleProxy', val as boolean)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Plus, Document, FolderOpened, Collection, Setting, Promotion } from '@element-plus/icons-vue';
import { useI18n } from '@/composables/useI18n';

/**
 * Options 页头部组件（135° 主题渐变通栏）
 *
 * 包含标题、版本号、代理状态信号灯、主操作按钮（添加规则）
 * 与毛玻璃半透明按钮（日志/导入导出/环境配置/设置），右侧为代理总开关 pill。
 */
defineProps<{
  /** 当前插件版本号 */
  currentVersion: string;
  /** 代理总开关状态 */
  proxyEnabled: boolean;
}>();

defineEmits<{
  /** 点击添加规则 */
  addRule: [];
  /** 打开请求日志抽屉 */
  openLogs: [];
  /** 打开导入导出弹窗 */
  openImportExport: [];
  /** 打开环境配置弹窗 */
  openProfiles: [];
  /** 打开偏好设置弹窗 */
  openSettings: [];
  /** 切换代理总开关 */
  toggleProxy: [enabled: boolean];
}>();

const { t } = useI18n();
</script>

<style scoped>
.header {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 32px;
  margin-bottom: 24px;
  color: white;
  background: linear-gradient(135deg, var(--cop-primary) 0%, var(--cop-primary-hover) 100%);
  box-shadow: 0 2px 12px rgb(var(--cop-primary-rgb) / 15%);
}

.header-title-row {
  display: flex;
  align-items: center;
}

.header-title-row h1 {
  display: flex;
  align-items: center;
  margin: 0;
  font-size: 24px;
  font-weight: 500;
  color: white;
}

.logo {
  margin-right: 12px;
  font-size: 28px;
  color: var(--cop-text-color-on-primary);
}

.version-tag {
  flex-shrink: 0;
  padding: 0 6px;
  margin-left: 10px;
  font-size: 11px;
  line-height: 18px;
  color: rgb(255 255 255 / 70%);
  cursor: default;
  user-select: none;
  background: rgb(255 255 255 / 15%);
  border-color: rgb(255 255 255 / 20%);
}

/* 代理状态信号灯：一眼可见的红绿小圆点 */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 10px;
  background: #f56c6c;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgb(255 255 255 / 35%);
  transition: background 0.2s ease;
}

.status-dot.is-on {
  background: #67c23a;
}

.header-actions-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

/* 毛玻璃半透明按钮（主按钮反白除外） */
:deep(.header-actions .el-button) {
  font-weight: 400;
  color: white;
  background: rgb(255 255 255 / 15%);
  border: 1px solid rgb(255 255 255 / 25%);
  backdrop-filter: blur(10px);
  transition: all 0.2s ease;
}

:deep(.header-actions .el-button:hover) {
  background: rgb(255 255 255 / 20%);
  border-color: rgb(255 255 255 / 40%);
  box-shadow: 0 4px 12px rgb(0 0 0 / 15%);
  transform: translateY(-1px);
}

:deep(.header-actions .el-button--primary) {
  font-weight: 500;
  color: var(--cop-primary);
  background: var(--cop-bg-color);
  border: 1px solid var(--cop-bg-color);
}

:deep(.header-actions .el-button--primary:hover) {
  color: var(--cop-primary);
  background: var(--cop-surface-hover);
  border-color: var(--cop-surface-hover);
  box-shadow: 0 4px 12px rgb(0 0 0 / 15%);
  transform: translateY(-1px);
}

/* 总开关 pill：毛玻璃底 + 状态文案 */
.proxy-toggle-pill {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px 14px;
  background: rgb(255 255 255 / 15%);
  border: 1px solid rgb(255 255 255 / 25%);
  border-radius: 999px;
  backdrop-filter: blur(10px);
  transition: all 0.2s ease;
}

.proxy-toggle-label {
  font-size: 13px;
  color: rgb(255 255 255 / 90%);
  user-select: none;
}

:deep(.proxy-toggle-pill .el-switch.is-checked .el-switch__core) {
  background: rgb(255 255 255 / 90%);
  border-color: rgb(255 255 255 / 90%);
}

:deep(.proxy-toggle-pill .el-switch.is-checked .el-switch__core .el-switch__action) {
  background: var(--cop-primary);
}

/* 响应式 */
@media (width <= 768px) {
  .header {
    padding: 20px;
  }

  .header-title-row h1 {
    font-size: 20px;
  }

  .header-actions-row {
    flex-direction: column;
    gap: 12px;
  }

  .header-actions {
    justify-content: center;
    width: 100%;
  }
}
</style>
