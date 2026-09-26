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
          :icon="Search"
          @click="$emit('openUrlTest')"
        >
          {{ t('urlTest') }}
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
import { Plus, Document, Search, FolderOpened, Collection, Setting, Promotion } from '@element-plus/icons-vue';
import { useI18n } from '@/composables/useI18n';

/**
 * Options 页头部组件（135° 主题渐变通栏）
 *
 * 包含标题、版本号、代理状态信号灯、主操作按钮（添加规则）
 * 与毛玻璃半透明按钮（日志/URL 测试/导入导出/环境配置/设置），右侧为代理总开关 pill。
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
  /** 打开 URL 匹配测试弹窗 */
  openUrlTest: [];
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

/* 代理状态信号灯：一眼可见的红绿小圆点
   切换时除了换色，还在点亮的那一档跑一次白色光环（一次性，不循环）——
   总开关是这一页最要紧的结论，光环让「刚刚变了」这件事不必靠余光去发现。
   光环叠在常驻的那圈白边上，收尾正好落回常驻值，动画结束没有跳变。 */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 10px;
  background: var(--el-color-danger, #f56c6c);
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgb(255 255 255 / 35%);
  transition: background-color var(--cop-duration-base) var(--cop-ease-standard);
}

.status-dot.is-on {
  background: var(--el-color-success, #67c23a);
  animation: dot-flare var(--cop-duration-slow) var(--cop-ease-standard) 1;
}

@keyframes dot-flare {
  from {
    box-shadow:
      0 0 0 2px rgb(255 255 255 / 35%),
      0 0 0 0 rgb(255 255 255 / 65%);
  }

  to {
    box-shadow:
      0 0 0 2px rgb(255 255 255 / 35%),
      0 0 0 9px rgb(255 255 255 / 0%);
  }
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

/* 毛玻璃半透明按钮（主按钮反白除外）
   颜色与投影走 90ms、上浮走同样的时长：悬停反馈要「立刻跟上指针」，
   200ms 以上就会觉得按钮比手慢。显式列属性而不是 `all`——`all` 会把
   按钮宽度（语言切换时文案变长）也纳入过渡。 */
:deep(.header-actions .el-button) {
  font-weight: 400;
  color: white;
  background: rgb(255 255 255 / 15%);
  border: 1px solid rgb(255 255 255 / 25%);
  backdrop-filter: blur(10px);
  transition:
    color var(--cop-duration-instant) var(--cop-ease-standard),
    background-color var(--cop-duration-instant) var(--cop-ease-standard),
    border-color var(--cop-duration-instant) var(--cop-ease-standard),
    box-shadow var(--cop-duration-instant) var(--cop-ease-standard),
    transform var(--cop-duration-instant) var(--cop-ease-enter);
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
}

/* 开关本体：Element Plus 用 `left` 移动滑块、`transition: all` 一视同仁。
   这里把时长压到 220ms、换成末段减速的进场曲线（滑块是「被推过去后停住」，
   不是匀速滑过去），并只留真正会变的三个属性。
   不用带超调的弹簧曲线：轨道只有 40px、滑块离边只有 1px，超调会让滑块探出胶囊外沿。 */
:deep(.proxy-toggle-pill .el-switch__core) {
  transition:
    background-color var(--cop-duration-base) var(--cop-ease-enter),
    border-color var(--cop-duration-base) var(--cop-ease-enter);
}

:deep(.proxy-toggle-pill .el-switch__core .el-switch__action) {
  transition:
    left var(--cop-duration-base) var(--cop-ease-enter),
    background-color var(--cop-duration-fast) var(--cop-ease-standard);
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
