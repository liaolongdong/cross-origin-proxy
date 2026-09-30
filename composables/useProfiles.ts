import { ref } from 'vue';
import { MessageType } from '@/utils/types';
import type { EnvironmentProfile } from '@/utils/types';
import { isFailureEnvelope } from '@/utils/messageResult';
import { logger } from '@/utils/logger';

/**
 * 快照载入的结果
 *
 * `error` 只在后台明确回吐了原因（`{ success: false, error }` 信封）时才有值，且它是给用户看的
 * 原文；抛错与空回包这两条「没拿到原因」的路径一律留空，由调用方回落到通用失败文案，
 * 不把 `LOAD_PROFILE_FAILED` 这类内部码抛到界面上。
 */
export interface ProfileLoadResult {
  success: boolean;
  error?: string;
}

/**
 * 环境快照（Profile）的读写层
 *
 * Options 的环境配置弹窗与 popup 的快照切换卡共用这一份 IO：两者问的是同一批消息，
 * 判据也必须同一份——`GET_PROFILES` 回数组或失败信封，`LOAD_PROFILE` 回 `{ success }` 信封，
 * 而 `respondAsync` 会把后台的 reject 转成 **resolved** 的信封（见 `utils/messageResult.ts`），
 * 所以「没读到」与「读到 0 个」、「写入失败」与「写入成功」必须在界面侧分开，
 * 否则 popup 会把一次没落盘的替换显示成「已切换」。
 *
 * 这里只承担 IO 与忙闲旗标，不放文案与 `ElMessage`：措辞由调用方决定（弹窗与 popup 的
 * 反馈形态本就不同），也避免把 Element Plus 的对话框模块带进 popup 首屏。
 */
export function useProfiles() {
  /** 已保存的快照列表；空数组是「真读数」，与「没读到」由 `loadProfiles` 的返回值区分 */
  const profiles = ref<EnvironmentProfile[]>([]);
  /** 列表读取在途 */
  const loadingProfiles = ref(false);
  /** 某一次载入在途（同一时刻只允许一次整套替换） */
  const switchingProfile = ref(false);

  /**
   * 拉取快照列表
   *
   * @returns 是否读取成功；失败时 `profiles` 保持原值，调用方据此决定要不要显示空态——
   *   把「读不到」画成「还没有快照」，用户会以为自己的快照丢了。
   */
  async function loadProfiles(): Promise<boolean> {
    loadingProfiles.value = true;
    try {
      const result: unknown = await chrome.runtime.sendMessage({ type: MessageType.GET_PROFILES });
      if (Array.isArray(result)) {
        profiles.value = result as EnvironmentProfile[];
        return true;
      }
      logger.warn('Failed to load profiles:', (result as { error?: string } | null)?.error);
      return false;
    } catch (error) {
      logger.error('Failed to load profiles:', error);
      return false;
    } finally {
      loadingProfiles.value = false;
    }
  }

  /**
   * 载入一份快照（整套替换当前规则集）
   *
   * 后台 `loadProfile` 会先落一份 `load-profile` 恢复点再写新配置，并把总开关一并打开——
   * 这两件事都属于用户可感知后果，调用方必须在确认文案里说出来，不能当成静默替换。
   */
  async function loadProfile(profileId: string): Promise<ProfileLoadResult> {
    switchingProfile.value = true;
    try {
      const result = (await chrome.runtime.sendMessage({
        type: MessageType.LOAD_PROFILE,
        data: { profileId },
      })) as { success?: boolean; error?: string } | undefined;
      if (isFailureEnvelope(result)) return { success: false, error: result.error };
      // 空回包（SW 回收期）与不带 success 的形状都算没成：整套替换不能靠「大概成了」来提示成功
      if (result?.success !== true) {
        logger.warn('Load profile returned no success flag:', result);
        return { success: false };
      }
      return { success: true };
    } catch (error) {
      logger.error('Failed to load profile:', error);
      return { success: false };
    } finally {
      switchingProfile.value = false;
    }
  }

  return { profiles, loadingProfiles, switchingProfile, loadProfiles, loadProfile };
}
