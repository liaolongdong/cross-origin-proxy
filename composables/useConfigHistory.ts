import { ref } from 'vue';
import { MessageType } from '@/utils/types';
import type { ConfigHistoryEntry } from '@/utils/types';
import { logger } from '@/utils/logger';

/**
 * 配置恢复点的读写
 *
 * 与 `useVariables` 同一档：读写都走后台消息，而不是界面侧直接 `chrome.storage.local`。
 * 恢复点是「成套替换之前的整包配置」，里面的 `headerOverrides` 是原样落盘的真实请求头，
 * 因此那条读取消息与凭据变量表同样过 `isTrustedSender`（见 `messageRouter.ts` 的
 * `CREDENTIAL_READING_TYPES`）。写入只发生在后台的成套操作里，界面侧只读不回写。
 */
export function useConfigHistory() {
  const history = ref<ConfigHistoryEntry[]>([]);
  const loading = ref(false);
  const restoring = ref(false);

  /**
   * 拉取恢复点列表
   *
   * @returns 是否读取成功——失败时 `history` 保持原值，调用方据此决定要不要显示空态
   */
  async function loadHistory(): Promise<boolean> {
    loading.value = true;
    try {
      const result: unknown = await chrome.runtime.sendMessage({ type: MessageType.GET_CONFIG_HISTORY });
      // 被 gate 拒或 SW 异常时回的是 { success: false } 信封，不能当成「没有恢复点」画给用户
      if (Array.isArray(result)) {
        history.value = result as ConfigHistoryEntry[];
        return true;
      }
      logger.warn('Failed to load config restore points:', (result as { error?: string } | null)?.error);
      return false;
    } catch (error) {
      logger.error('Failed to load config restore points:', error);
      return false;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 回退到一个恢复点
   *
   * 后台会在回退落盘之后把回退前的现状补记一份，所以这一步本身也是可回退的。
   */
  async function restore(id: string): Promise<{ success: boolean; restored?: number; error?: string }> {
    restoring.value = true;
    try {
      const result = (await chrome.runtime.sendMessage({
        type: MessageType.RESTORE_CONFIG_HISTORY,
        data: { id },
      })) as { success: boolean; restored?: number; error?: string } | undefined;
      if (!result || result.success !== true) {
        return { success: false, error: result?.error ?? 'RESTORE_NO_RESPONSE' };
      }
      return { success: true, restored: result.restored };
    } catch (error) {
      logger.error('Failed to restore config:', error);
      return { success: false, error: 'RESTORE_CONFIG_ERROR' };
    } finally {
      restoring.value = false;
    }
  }

  return { history, loading, restoring, loadHistory, restore };
}
