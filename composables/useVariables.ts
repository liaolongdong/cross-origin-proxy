import { ref } from 'vue';
import { MessageType } from '@/utils/types';
import type { VariableStore } from '@/utils/types';
import { logger } from '@/utils/logger';

/**
 * 凭据变量的读写（`{{名称}}` 语法的真值表）
 *
 * 读写统一走后台消息而不是 `chrome.storage.local`：真值的唯一合法读者是 Service Worker，
 * 界面侧要拿到这张表也只能通过那道带 sender 校验的消息。这样「哪个上下文能读到密钥」
 * 只有一个答案，不必在每个调用点重复判据。
 */
export function useVariables() {
  const variables = ref<VariableStore>({});
  const loading = ref(false);
  const saving = ref(false);

  /**
   * 拉取变量表
   *
   * @returns 是否读取成功——失败时 `variables` 保持原值，调用方据此决定要不要覆盖界面状态
   */
  async function loadVariables(): Promise<boolean> {
    loading.value = true;
    try {
      const result: unknown = await chrome.runtime.sendMessage({ type: MessageType.GET_VARIABLES });
      // 被 gate 拒或 SW 异常时回的是 { success: false } 信封，不能当成空表用
      if (result && typeof result === 'object' && 'success' in result && result.success === false) {
        logger.warn('Failed to load variables:', (result as { error?: string }).error);
        return false;
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
      variables.value = result as VariableStore;
      return true;
    } catch (error) {
      logger.error('Failed to load variables:', error);
      return false;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 整表写入（新增、改名、删除都走这一条）
   *
   * `dropped` 是后台收口时丢弃的条目数：界面已按同一套判据校验过，这里非零即说明两侧漂移，
   * 调用方必须把它说出来，而不是让用户以为凭据存好了。
   */
  async function saveVariables(next: VariableStore): Promise<{ success: boolean; dropped: number; error?: string }> {
    saving.value = true;
    try {
      const result = (await chrome.runtime.sendMessage({
        type: MessageType.SET_VARIABLES,
        data: { variables: next },
      })) as { success: boolean; dropped?: number; error?: string } | undefined;
      if (!result || result.success === false) {
        return { success: false, dropped: 0, error: result?.error ?? 'SET_VARIABLES_NO_RESPONSE' };
      }
      variables.value = next;
      return { success: true, dropped: result.dropped ?? 0 };
    } catch (error) {
      logger.error('Failed to save variables:', error);
      return { success: false, dropped: 0, error: 'SET_VARIABLES_ERROR' };
    } finally {
      saving.value = false;
    }
  }

  return { variables, loading, saving, loadVariables, saveVariables };
}
