<template>
  <el-dialog
    :model-value="visible"
    :title="t('profilesTitle')"
    width="640px"
    align-center
    @close="$emit('update:visible', false)"
    @open="fetchProfiles"
  >
    <p class="profiles-desc">{{ t('profilesDesc') }}</p>

    <!-- 保存当前规则为新配置 -->
    <div class="save-row">
      <el-input
        v-model="newProfileName"
        :placeholder="t('profileNamePlaceholder')"
        maxlength="50"
        show-word-limit
        @keyup.enter="handleSaveProfile"
      />
      <el-button
        type="primary"
        :loading="saving"
        :disabled="rulesCount === 0"
        @click="handleSaveProfile"
      >
        <el-icon><FolderAdd /></el-icon>
        {{ t('saveCurrentAsProfile') }}
      </el-button>
    </div>
    <p
      v-if="rulesCount === 0"
      class="save-hint"
    >
      {{ t('profilesNoRulesHint') }}
    </p>

    <el-divider />

    <!-- 配置列表 -->
    <div
      v-if="loading"
      v-loading="true"
      class="profiles-loading"
    ></div>
    <div
      v-else-if="profiles.length === 0"
      class="profiles-empty"
    >
      <p>{{ t('profilesEmpty') }}</p>
      <p class="profiles-empty-hint">{{ t('profilesEmptyHint') }}</p>
    </div>
    <ul
      v-else
      class="profile-list"
    >
      <li
        v-for="profile in profiles"
        :key="profile.id"
        class="profile-item"
      >
        <div class="profile-icon">
          <el-icon><Folder /></el-icon>
        </div>
        <div class="profile-info">
          <div
            class="profile-name"
            :title="profile.name"
          >
            {{ profile.name }}
          </div>
          <div class="profile-meta">
            {{ t('profileRuleCount', profile.rules.length) }}
            <span class="profile-meta-divider">·</span>
            {{ t('profileCreatedAt', formatTime(profile.createdAt)) }}
          </div>
        </div>
        <div class="profile-actions">
          <el-button
            type="primary"
            size="small"
            @click="handleLoadProfile(profile)"
          >
            {{ t('profileLoad') }}
          </el-button>
          <el-button
            type="danger"
            size="small"
            plain
            @click="handleDeleteProfile(profile)"
          >
            {{ t('delete') }}
          </el-button>
        </div>
      </li>
    </ul>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Folder, FolderAdd } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { MessageType } from '@/utils/types';
import type { EnvironmentProfile, ProxyConfig } from '@/utils/types';
import { generateId } from '@/utils/generateId';
import { useI18n } from '@/composables/useI18n';

/**
 * 环境配置管理弹窗
 *
 * 把当前规则集保存为命名快照，支持一键加载（替换当前规则集）与删除。
 * 面向"跨环境代理"核心场景：同一套规则在 FAT / UAT / PROD 间快速切换。
 */
defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  /** 加载环境配置成功后触发，父组件据此刷新规则列表 */
  loaded: [];
}>();

const { t, locale } = useI18n();

const profiles = ref<EnvironmentProfile[]>([]);
const loading = ref(false);
const saving = ref(false);
const newProfileName = ref('');
const rulesCount = ref(0);

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(locale.value === 'en' ? 'en-US' : 'zh-CN');
}

async function fetchProfiles() {
  loading.value = true;
  try {
    const [list, config] = await Promise.all([
      chrome.runtime.sendMessage({ type: MessageType.GET_PROFILES }) as Promise<EnvironmentProfile[]>,
      chrome.runtime.sendMessage({ type: MessageType.GET_PROXY_CONFIG }) as Promise<ProxyConfig>,
    ]);
    profiles.value = Array.isArray(list) ? list : [];
    rulesCount.value = config?.rules?.length ?? 0;
  } catch (error) {
    console.error('Failed to fetch profiles:', error);
  } finally {
    loading.value = false;
  }
}

async function handleSaveProfile() {
  const name = newProfileName.value.trim();
  if (!name) {
    ElMessage.warning(t('profileNameRequired'));
    return;
  }
  saving.value = true;
  try {
    const config: ProxyConfig = await chrome.runtime.sendMessage({
      type: MessageType.GET_PROXY_CONFIG,
    });
    if (!config?.rules?.length) {
      ElMessage.warning(t('profilesNoRulesHint'));
      return;
    }
    // 同名配置覆盖更新，避免列表堆积重复快照
    const existing = profiles.value.find(p => p.name === name);
    const profile: EnvironmentProfile = {
      id: existing?.id ?? generateId(),
      name,
      rules: config.rules.map(r => ({ ...r })),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    await chrome.runtime.sendMessage({ type: MessageType.SAVE_PROFILE, data: profile });
    newProfileName.value = '';
    await fetchProfiles();
    ElMessage.success(t('profileSaved', name));
  } catch (error) {
    ElMessage.error(t('operationFailed'));
    console.error('Save profile failed:', error);
  } finally {
    saving.value = false;
  }
}

async function handleLoadProfile(profile: EnvironmentProfile) {
  try {
    await ElMessageBox.confirm(
      t('confirmLoadProfile', [profile.name, profile.rules.length]),
      t('confirmLoadProfileTitle'),
      {
        confirmButtonText: t('confirm'),
        cancelButtonText: t('cancel'),
        type: 'warning',
      },
    );
  } catch {
    return; // 用户取消
  }
  try {
    const result = await chrome.runtime.sendMessage({
      type: MessageType.LOAD_PROFILE,
      data: { profileId: profile.id },
    });
    if (!result?.success) {
      ElMessage.error(result?.error || t('operationFailed'));
      return;
    }
    ElMessage.success(t('profileLoaded', profile.name));
    emit('loaded');
    emit('update:visible', false);
  } catch (error) {
    ElMessage.error(t('operationFailed'));
    console.error('Load profile failed:', error);
  }
}

async function handleDeleteProfile(profile: EnvironmentProfile) {
  try {
    await ElMessageBox.confirm(t('confirmDeleteProfile', profile.name), t('confirmDeleteProfileTitle'), {
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel'),
      type: 'warning',
    });
  } catch {
    return; // 用户取消
  }
  try {
    await chrome.runtime.sendMessage({
      type: MessageType.DELETE_PROFILE,
      data: { profileId: profile.id },
    });
    profiles.value = profiles.value.filter(p => p.id !== profile.id);
    ElMessage.success(t('profileDeleted'));
  } catch (error) {
    ElMessage.error(t('operationFailed'));
    console.error('Delete profile failed:', error);
  }
}
</script>

<style scoped>
.profiles-desc {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--cop-text-color-secondary);
}

.save-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.save-row .el-input {
  flex: 1;
}

.save-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--el-text-color-placeholder, #c0c4cc);
}

.profiles-loading {
  min-height: 120px;
}

.profiles-empty {
  padding: 32px 0;
  color: var(--cop-text-color-secondary);
  text-align: center;
}

.profiles-empty p {
  margin: 0;
  font-size: 14px;
}

.profiles-empty-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--cop-text-color-placeholder);
}

.profile-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  padding: 0;
  margin: 0;
  overflow-y: auto;
  list-style: none;
}

.profile-item {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
  background: var(--cop-bg-color-secondary, var(--el-fill-color-lighter, #f5f7fa));
  border: 1px solid var(--cop-border-color-light, var(--el-border-color-lighter, #ebeef5));
  border-radius: 10px;
  transition: all 0.2s ease;
}

.profile-item:hover {
  border-color: var(--cop-primary-border, var(--el-color-primary-light-5));
  box-shadow: 0 2px 8px rgb(var(--cop-primary-rgb, 64, 158, 255) / 10%);
}

.profile-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  font-size: 18px;
  color: var(--cop-primary, #409eff);
  background: var(--cop-primary-bg, #ecf5ff);
  border-radius: 8px;
}

.profile-info {
  flex: 1;
  min-width: 0;
}

.profile-name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 500;
  color: var(--cop-text-color-primary);
  white-space: nowrap;
}

.profile-meta {
  margin-top: 2px;
  font-size: 12px;
  color: var(--cop-text-color-secondary);
}

.profile-meta-divider {
  margin: 0 6px;
}

.profile-actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}
</style>
