import { ref } from 'vue';
import { MessageType } from '@/utils/types';
import type { ExportData, ImportMode, ImportPlan } from '@/utils/types';
import { sanitizeExportData } from '@/utils/exportSanitize';
import { isFailureEnvelope } from '@/utils/messageResult';
import { logger } from '@/utils/logger';

/** 导入前 JSON 文本的本地校验结果：解析失败与结构缺失都归 `INVALID_CONFIG`，不发消息 */
type ParsedPayload = { data: ExportData; error?: undefined } | { data?: undefined; error: string };

function parseImportJson(jsonString: string): ParsedPayload {
  try {
    const data = JSON.parse(jsonString) as ExportData;
    if (!data.config || !Array.isArray(data.config.rules)) return { error: 'INVALID_CONFIG' };
    return { data };
  } catch {
    return { error: 'INVALID_CONFIG' };
  }
}

export function useImportExport() {
  const importing = ref(false);

  /**
   * 导出配置并触发下载
   *
   * @param sanitize 分享模式：摘掉可能承载凭据的请求头 / 响应头 / 查询参数后再落盘
   * @returns `removedCount` 为被摘掉的条目数，调用方据此决定提示文案
   */
  async function exportConfig(sanitize: boolean): Promise<{ removedCount: number }> {
    const data = (await chrome.runtime.sendMessage({
      type: MessageType.EXPORT_CONFIG,
    })) as ExportData | { success: false; error?: string } | undefined;
    // 后台读配置失败时回的是这份 resolved 的信封，不是抛错：不判就是拿 `{success:false,error}`
    // 当成配置下载走，用户手上多一份再也导不回去的文件
    if (!data || isFailureEnvelope(data)) {
      throw new Error((data && isFailureEnvelope(data) && data.error) || 'EXPORT_CONFIG_FAILED');
    }
    const { data: payload, removedCount } = sanitize ? sanitizeExportData(data) : { data, removedCount: 0 };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cross-origin-proxy-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return { removedCount };
  }

  /**
   * 导入配置
   *
   * 返回后台的结构化结果而非布尔：调用方需要按 `error` 错误码（如 MAX_RULES_EXCEEDED）
   * 给出可读提示，并在失败时保留用户刚粘贴的内容以便修正后重试。
   * 成功时带回**实际**写入数（`added` / `skipped` / `invalid`），界面据此说实话，
   * 而不是只报一句「导入成功」。
   */
  async function importConfig(
    jsonString: string,
    mode: ImportMode,
  ): Promise<{ success: boolean; error?: string; added?: number; skipped?: number; invalid?: number }> {
    const parsed = parseImportJson(jsonString);
    if (parsed.error) return { success: false, error: parsed.error };
    importing.value = true;
    try {
      // SW 刚被回收等异常下 sendMessage 会 resolve undefined，此处兜成失败而不是抛 TypeError
      const result = (await chrome.runtime.sendMessage({
        type: MessageType.IMPORT_CONFIG,
        data: { ...parsed.data, mode },
      })) as { success: boolean; error?: string; added?: number; skipped?: number; invalid?: number } | undefined;
      return result ?? { success: false, error: 'IMPORT_NO_RESPONSE' };
    } catch (error) {
      logger.error('Import failed:', error);
      // sendMessage 抛错（扩展上下文失效等）不能报成格式问题。回稳定码而不是 `error.message`：
      // 界面按码选文案，而异常文本可能带 URL 等上下文，只进日志。
      return { success: false, error: 'IMPORT_ERROR' };
    } finally {
      importing.value = false;
    }
  }

  /**
   * 导入前预览：把这次写入会发生的条数变化算出来给界面看
   *
   * 后台只做纯计算、不落库。失败时返回失败而不是一块空预览——界面要能说「这次没法预告」，
   * 并仍然让用户继续导入（预览是增强，不是新的必经关卡）。
   */
  async function fetchImportPlan(
    jsonString: string,
    mode: ImportMode,
  ): Promise<{ success: boolean; plan?: ImportPlan; error?: string }> {
    const parsed = parseImportJson(jsonString);
    if (parsed.error) return { success: false, error: parsed.error };
    try {
      const result = (await chrome.runtime.sendMessage({
        type: MessageType.GET_IMPORT_PLAN,
        data: { ...parsed.data, mode },
      })) as { success: boolean; plan?: ImportPlan; error?: string } | undefined;
      return result ?? { success: false, error: 'IMPORT_NO_RESPONSE' };
    } catch (error) {
      logger.error('Import preview failed:', error);
      return { success: false, error: 'IMPORT_PLAN_ERROR' };
    }
  }

  return { importing, exportConfig, importConfig, fetchImportPlan };
}
