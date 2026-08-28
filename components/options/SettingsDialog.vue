<template>
  <el-dialog
    :model-value="visible"
    :title="t('settingsTitle')"
    width="480px"
    align-center
    @close="$emit('update:visible', false)"
  >
    <div class="settings-body dialog-body-scroll">
      <!-- 显示模式 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('themeMode') }}</div>
        <el-radio-group
          :model-value="themeMode"
          @update:model-value="handleModeChange"
        >
          <el-radio-button
            v-for="opt in THEME_MODE_OPTIONS"
            :key="opt.value"
            :value="opt.value"
          >
            <el-icon class="mode-icon"><component :is="opt.icon" /></el-icon>
            {{ locale === 'en' ? opt.labelEn : opt.label }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <!-- 主题色 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('themeLabel') }}</div>
        <div class="theme-swatches">
          <button
            v-for="opt in THEME_OPTIONS"
            :key="opt.name"
            class="theme-swatch"
            :class="{ active: currentTheme === opt.name }"
            :style="{ background: opt.swatch, color: opt.swatch }"
            :title="locale === 'en' ? opt.labelEn : opt.label"
            :aria-label="locale === 'en' ? opt.labelEn : opt.label"
            @click="$emit('changeTheme', opt.name)"
          />
        </div>
      </div>

      <!-- 界面语言 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('languageLabel') }}</div>
        <el-radio-group
          :model-value="locale"
          @update:model-value="handleLocaleChange"
        >
          <el-radio-button
            v-for="opt in LOCALE_OPTIONS"
            :key="opt.name"
            :value="opt.name"
          >
            {{ opt.label }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <!-- 键盘快捷键 -->
      <div class="setting-section">
        <div class="setting-label">{{ t('keyboardShortcuts') }}</div>
        <div class="shortcut-list">
          <div class="shortcut-item">
            <span class="shortcut-desc">{{ t('shortcutAddRule') }}</span>
            <kbd>{{ isMac ? '⌘' : 'Ctrl' }}</kbd>
            <span class="shortcut-plus">+</span>
            <kbd>N</kbd>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-desc">{{ t('shortcutSearch') }}</span>
            <kbd>/</kbd>
            <span class="shortcut-or">{{ t('or') }}</span>
            <kbd>{{ isMac ? '⌘' : 'Ctrl' }}</kbd>
            <span class="shortcut-plus">+</span>
            <kbd>F</kbd>
          </div>
          <div class="shortcut-item">
            <span class="shortcut-desc">{{ t('shortcutClose') }}</span>
            <kbd>Esc</kbd>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Sunny, Moon, Monitor } from '@element-plus/icons-vue';
import { THEME_OPTIONS, THEME_MODE_OPTIONS, type ThemeName } from '@/utils/theme';
import { type ThemeMode } from '@/utils/constants';
import { LOCALE_OPTIONS, type LocaleName } from '@/utils/i18n';
import { useI18n } from '@/composables/useI18n';

defineOptions({
  components: { Sunny, Moon, Monitor },
});

/**
 * 偏好设置弹窗（替代原设置 Tab）
 *
 * 显示模式切换 + 六色主题圆形色板 + 应用内中英文切换，均即时生效并跨扩展页同步。
 */
defineProps<{
  visible: boolean;
  /** 当前主题名 */
  currentTheme: ThemeName;
  /** 当前显示模式 */
  themeMode: ThemeMode;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  /** 切换主题 */
  changeTheme: [theme: ThemeName];
  /** 切换显示模式 */
  changeThemeMode: [mode: ThemeMode];
}>();

const { t, locale, setLocale } = useI18n();

/** 平台检测：用于快捷键提示展示 ⌘ / Ctrl */
const isMac = ref(navigator.platform.includes('Mac'));

function handleModeChange(val: string | number | boolean | undefined) {
  if (val === 'light' || val === 'dark' || val === 'system') {
    emit('changeThemeMode', val as ThemeMode);
  }
}

function handleLocaleChange(val: string | number | boolean | undefined) {
  if (val === 'zh_CN' || val === 'en') {
    void setLocale(val as LocaleName);
  }
}
</script>

<style scoped>
.settings-body {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 0 4px;
}

.setting-label {
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--cop-text-color-primary);
}

.mode-icon {
  margin-right: 4px;
  font-size: 14px;
  vertical-align: -2px;
}

.theme-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.theme-swatch {
  width: 32px;
  height: 32px;
  cursor: pointer;
  outline: none;
  border: 2px solid transparent;
  border-radius: 50%;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.theme-swatch:hover {
  transform: scale(1.12);
  box-shadow: 0 2px 8px rgb(var(--cop-primary-rgb) / 25%);
}

.theme-swatch:focus-visible {
  box-shadow: 0 0 0 2px rgb(var(--cop-primary-rgb) / 40%);
}

.theme-swatch.active {
  border-color: var(--cop-bg-color);
  box-shadow:
    0 0 0 2px var(--cop-bg-color),
    0 0 0 4px currentcolor,
    0 2px 8px rgb(var(--cop-primary-rgb) / 30%);
  transform: scale(1.08);
}

.theme-swatch.active:hover {
  transform: scale(1.12);
}

.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.shortcut-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shortcut-desc {
  flex: 1;
  font-size: 13px;
  color: var(--cop-text-color-regular);
}

.shortcut-or,
.shortcut-plus {
  font-size: 12px;
  color: var(--cop-text-color-secondary);
}

kbd {
  display: inline-block;
  min-width: 24px;
  padding: 2px 8px;
  font-family: inherit;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
  color: var(--cop-text-color-regular);
  background: var(--cop-fill-color-light);
  border: 1px solid var(--cop-border-color);
  border-radius: 4px;
  box-shadow: 0 1px 0 var(--cop-border-color);
}
</style>
