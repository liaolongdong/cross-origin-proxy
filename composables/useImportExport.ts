import { ref } from 'vue';
import { MessageType } from '@/utils/types';
import type { ExportData } from '@/utils/types';
import { logger } from '@/utils/logger';

export function useImportExport() {
  const importing = ref(false);

  async function exportConfig(): Promise<void> {
    const data: ExportData = await chrome.runtime.sendMessage({
      type: MessageType.EXPORT_CONFIG,
    });
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cross-origin-proxy-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importConfig(jsonString: string): Promise<boolean> {
    importing.value = true;
    try {
      const data: ExportData = JSON.parse(jsonString);
      if (!data.config || !Array.isArray(data.config.rules)) {
        throw new Error('Invalid config format');
      }
      const result = await chrome.runtime.sendMessage({
        type: MessageType.IMPORT_CONFIG,
        data,
      });
      return result.success;
    } catch (error) {
      logger.error('Import failed:', error);
      return false;
    } finally {
      importing.value = false;
    }
  }

  return { importing, exportConfig, importConfig };
}
