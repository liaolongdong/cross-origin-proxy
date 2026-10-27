<template>
  <section
    class="welcome-card"
    role="region"
    aria-labelledby="welcome-card-title"
  >
    <h2
      id="welcome-card-title"
      class="welcome-title"
    >
      {{ t('welcomeTitle') }}
    </h2>

    <ol class="welcome-steps">
      <li class="welcome-step">
        <span
          class="welcome-step-index"
          aria-hidden="true"
          >1</span
        >
        <div class="welcome-step-body">
          <h3 class="welcome-step-title">{{ t('welcomeStep1Title') }}</h3>
          <p class="welcome-step-desc">{{ t('welcomeStep1Desc') }}</p>
          <el-button
            type="primary"
            @click="$emit('addRule')"
            >{{ t('welcomeStep1Action') }}</el-button
          >
        </div>
      </li>
      <li class="welcome-step">
        <span
          class="welcome-step-index"
          aria-hidden="true"
          >2</span
        >
        <div class="welcome-step-body">
          <h3 class="welcome-step-title">{{ t('welcomeStep2Title') }}</h3>
          <p class="welcome-step-desc">{{ t('welcomeStep2Desc') }}</p>
          <el-button
            link
            type="primary"
            @click="$emit('openSettings')"
            >{{ t('welcomeStep2Action') }}</el-button
          >
        </div>
      </li>
      <li class="welcome-step">
        <span
          class="welcome-step-index"
          aria-hidden="true"
          >3</span
        >
        <div class="welcome-step-body">
          <h3 class="welcome-step-title">{{ t('welcomeStep3Title') }}</h3>
          <p class="welcome-step-desc">
            {{ proxyEnabled ? t('welcomeStep3DescOn') : t('welcomeStep3DescOff') }}
          </p>
          <el-button
            v-if="!proxyEnabled"
            @click="$emit('enableProxy')"
            >{{ t('welcomeStep3Action') }}</el-button
          >
          <span
            v-else
            class="welcome-step-done"
          >
            <el-icon><Check /></el-icon>
            {{ t('welcomeStep3Done') }}
          </span>
        </div>
      </li>
    </ol>

    <button
      type="button"
      class="welcome-close"
      :aria-label="t('welcomeDismissA11y')"
      @click="$emit('dismiss')"
    >
      <el-icon :size="14"><Close /></el-icon>
    </button>
  </section>
</template>

<script setup lang="ts">
import { Check, Close } from '@element-plus/icons-vue';
import { useI18n } from '@/composables/useI18n';

/**
 * 首装欢迎卡：只做「定位」，不重复空态的模板列表
 *
 * 组件本身不读 `chrome.*`、不判可见性——三个读数与 `v-if` 都留在 `App.vue`，
 * 判据的唯一出口是 `utils/welcome.ts` 的 `shouldShowWelcome`。
 */
defineProps<{
  /** 代理总开关当前是否开启；只影响第 3 步画按钮还是画「已开启」 */
  proxyEnabled: boolean;
}>();

defineEmits<{
  addRule: [];
  openSettings: [];
  enableProxy: [];
  dismiss: [];
}>();

const { t } = useI18n();
</script>

<style scoped>
.welcome-card {
  position: relative;
  padding: 18px 20px 20px;
  margin: 0 32px 16px;
  background: var(--el-bg-color, #fff);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-left: 3px solid var(--cop-primary, #409eff);
  border-radius: 10px;
  animation: cop-rise-in var(--cop-duration-base) var(--cop-ease-enter) backwards;
}

.welcome-title {
  padding-right: 28px;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary, #303133);
}

.welcome-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  padding: 0;
  margin: 14px 0 0;
  list-style: none;
}

.welcome-step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  min-width: 0;
}

.welcome-step-index {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--cop-primary, #409eff);
  background: var(--cop-primary-bg, #ecf5ff);
  border-radius: 50%;
}

.welcome-step-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  min-width: 0;
}

.welcome-step-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary, #303133);
}

.welcome-step-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary, #909399);
}

.welcome-step-done {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-size: 12px;
  color: var(--el-color-success, #67c23a);
}

.welcome-close {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--el-text-color-secondary, #909399);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 6px;
  transition:
    color var(--cop-duration-fast) var(--cop-ease-standard),
    background-color var(--cop-duration-fast) var(--cop-ease-standard);
}

.welcome-close:hover {
  color: var(--el-text-color-primary, #303133);
  background: var(--el-fill-color-light, #f5f7fa);
}

.welcome-close:focus-visible {
  outline: 2px solid var(--cop-primary, #409eff);
  outline-offset: 2px;
}

@media (width <= 768px) {
  .welcome-card {
    margin: 0 20px 12px;
  }

  .welcome-steps {
    grid-template-columns: 1fr;
    gap: 12px;
  }
}
</style>
