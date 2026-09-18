import { ref } from 'vue';
import { MessageType } from '@/utils/types';
import type { ExportData, ImportMode } from '@/utils/types';
import { sanitizeExportData } from '@/utils/exportSanitize';
import { logger } from '@/utils/logger';

export function useImportExport() {
  const importing = ref(false);

  /**
   * 导出配置并触发下载
   *
   * @param sanitize 分享模式：摘掉可能承载凭据的请求头 / 响应头 / 查询参数后再落盘
   * @returns `removedCount` 为被摘掉的条目数，调用方据此决定提示文案
   */
  async function exportConfig(sanitize: boolean): Promise<{ removedCount: number }> {
    const data: ExportData = await chrome.runtime.sendMessage({
      type: MessageType.EXPORT_CONFIG,
    });
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
   */
  async function importConfig(jsonString: string, mode: ImportMode): Promise<{ success: boolean; error?: string }> {
    importing.value = true;
    try {
      const data: ExportData = JSON.parse(jsonString);
      if (!data.config || !Array.isArray(data.config.rules)) {
        return { success: false, error: 'INVALID_CONFIG' };
      }
      // SW 刚被回收等异常下 sendMessage 会 resolve undefined，此处兜成失败而不是抛 TypeError
      const result = (await chrome.runtime.sendMessage({
        type: MessageType.IMPORT_CONFIG,
        data: { ...data, mode },
      })) as { success: boolean; error?: string } | undefined;
      return result ?? { success: false, error: 'IMPORT_NO_RESPONSE' };
    } catch (error) {
      logger.error('Import failed:', error);
      // 只有解析失败才是「JSON 格式错误」；sendMessage 抛错（扩展上下文失效等）不能报成格式问题
      return { success: false, error: error instanceof SyntaxError ? 'INVALID_CONFIG' : 'IMPORT_ERROR' };
    } finally {
      importing.value = false;
    }
  }

  return { importing, exportConfig, importConfig };
}
