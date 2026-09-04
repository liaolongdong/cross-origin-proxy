import { MessageType } from '@/utils/types';
import type { RuntimeMessage, ExportData, ProxyRule } from '@/utils/types';
import { handleProxyRequest, getProxyStatus, getSwHitStats } from './proxyHandler';
import { getDnrHitStats } from './dnrStats';
import { MAX_RULES } from '@/utils/constants';
import {
  getProxyConfig,
  saveProxyConfig,
  addRule,
  batchAddRules,
  updateRule,
  deleteRule,
  batchDeleteRules,
  batchToggleRules,
  reorderRules,
  toggleProxy,
  toggleRule,
  getRequestLogs,
  clearRequestLogs,
  getProfiles,
  saveProfile,
  loadProfile,
  deleteProfile,
} from '@/utils/storage';
import { logsToHar, harEntriesToRules } from '@/utils/har';
import { generateId } from '@/utils/generateId';
import { logger } from '@/utils/logger';

/**
 * 校验导入规则的必要字段，过滤掉结构非法的条目，避免脏数据写入后导致 DNR 同步/拦截器异常
 */
function isValidRule(rule: unknown): rule is ProxyRule {
  if (!rule || typeof rule !== 'object') return false;
  const r = rule as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.matchPattern === 'string' &&
    typeof r.targetUrl === 'string' &&
    ['wildcard', 'prefix', 'regex'].includes(r.matchType as string)
  );
}

/**
 * 从导入规则中过滤掉与现有规则重复的条目（按 name + matchPattern 去重）
 */
export function deduplicateRules(existing: ProxyRule[], incoming: ProxyRule[]): ProxyRule[] {
  const existingKeys = new Set(existing.map(r => `${r.name}::${r.matchPattern}`));
  return incoming.filter(r => !existingKeys.has(`${r.name}::${r.matchPattern}`));
}

/**
 * 规范化导入的规则列表：过滤结构非法的条目、重新生成 id、补全默认值。
 * 重新生成 id 是必要的：文件中的旧 id 可能与现有规则冲突（合并模式下
 * 会造成重复 id，引发列表 key 冲突与按 id 操作误中其他规则）。
 */
export function normalizeImportedRules(rawRules: unknown[]): ProxyRule[] {
  return rawRules.filter(isValidRule).map(rule => ({
    ...rule,
    id: generateId(),
    priority: typeof rule.priority === 'number' ? rule.priority : 100,
    enabled: rule.enabled === true,
    createdAt: typeof rule.createdAt === 'number' ? rule.createdAt : Date.now(),
    updatedAt: typeof rule.updatedAt === 'number' ? rule.updatedAt : Date.now(),
  }));
}

/**
 * 处理导入配置
 */
async function handleImportConfig(
  data: ExportData & { mode?: 'replace' | 'merge' },
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!data?.config || !Array.isArray(data.config.rules)) {
      return { success: false, error: 'Invalid config data' };
    }
    const validRules = normalizeImportedRules(data.config.rules);

    if (data.mode === 'merge') {
      const existingConfig = await getProxyConfig();
      const newRules = deduplicateRules(existingConfig.rules, validRules);
      const merged = [...existingConfig.rules, ...newRules];
      if (merged.length > MAX_RULES) {
        return {
          success: false,
          error: `Merge would exceed max rules limit (${MAX_RULES})`,
        };
      }
      await saveProxyConfig({
        enabled: data.config.enabled === true ? true : existingConfig.enabled,
        rules: merged,
      });
      logger.info(`Config merged: ${newRules.length} new, ${validRules.length - newRules.length} duplicates skipped`);
    } else {
      await saveProxyConfig({
        enabled: data.config.enabled === true,
        rules: validRules,
      });
      logger.info(`Config imported: ${validRules.length}/${data.config.rules.length} rules valid`);
    }
    return { success: true };
  } catch (error) {
    logger.error('Failed to import config:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 判断消息来源是否为扩展内部页面（用于拦截外部页面的伪造写入请求）
 */
function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.url) return false;
  const extensionUrl = chrome.runtime.getURL('');
  return sender.url.startsWith(extensionUrl);
}

/** 需要 sender 校验的状态修改类消息类型 */
const STATE_MUTATING_TYPES = new Set([
  MessageType.UPDATE_PROXY_CONFIG,
  MessageType.TOGGLE_PROXY,
  MessageType.TOGGLE_RULE,
  MessageType.ADD_RULE,
  MessageType.BATCH_ADD_RULES,
  MessageType.UPDATE_RULE,
  MessageType.DELETE_RULE,
  MessageType.BATCH_DELETE_RULES,
  MessageType.BATCH_TOGGLE_RULES,
  MessageType.REORDER_RULES,
  MessageType.CLEAR_REQUEST_LOG,
  MessageType.IMPORT_CONFIG,
  MessageType.IMPORT_HAR,
  MessageType.SAVE_PROFILE,
  MessageType.LOAD_PROFILE,
  MessageType.DELETE_PROFILE,
]);

/**
 * 统一处理异步消息响应：resolve 时回传结果，reject 时回传 { success: false, error }
 * @returns true（告知 chrome 需保持消息通道开放以异步响应）
 */
function respondAsync(sendResponse: (response?: unknown) => void, promise: Promise<unknown>): boolean {
  promise
    .then(sendResponse)
    .catch((error: unknown) =>
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
    );
  return true;
}

/**
 * 设置消息路由
 */
export function setupMessageRouter(): void {
  chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
    logger.debug('Message received:', message.type);

    // 状态修改类消息：校验 sender 来源
    if (STATE_MUTATING_TYPES.has(message.type) && !isTrustedSender(sender)) {
      sendResponse({ success: false, error: 'Unauthorized sender' });
      return false;
    }

    switch (message.type) {
      case MessageType.PROXY_REQUEST:
        return respondAsync(sendResponse, handleProxyRequest(message.data));

      case MessageType.GET_PROXY_CONFIG:
        return respondAsync(sendResponse, getProxyConfig());

      case MessageType.UPDATE_PROXY_CONFIG:
        return respondAsync(
          sendResponse,
          saveProxyConfig(message.data).then(() => ({ success: true })),
        );

      case MessageType.TOGGLE_PROXY:
        if (!message.data || typeof message.data.enabled !== 'boolean') {
          sendResponse({ success: false, error: 'Invalid data' });
          return false;
        }
        return respondAsync(
          sendResponse,
          toggleProxy(message.data.enabled).then(enabled => {
            logger.info(`Proxy ${enabled ? 'enabled' : 'disabled'}`);
            return { success: true };
          }),
        );

      case MessageType.TOGGLE_RULE: {
        if (!message.data || !message.data.ruleId || typeof message.data.enabled !== 'boolean') {
          sendResponse({ success: false, error: 'Invalid ruleId' });
          return false;
        }
        return respondAsync(
          sendResponse,
          toggleRule(message.data.ruleId, message.data.enabled).then(result => {
            if (result.success) {
              logger.info(`Rule toggled: ${message.data.ruleId}`);
            }
            return result;
          }),
        );
      }

      case MessageType.ADD_RULE:
        if (!message.data || typeof message.data.rule !== 'object' || message.data.rule === null) {
          sendResponse({ success: false, error: 'Invalid rule' });
          return false;
        }
        return respondAsync(
          sendResponse,
          addRule(message.data.rule).then(() => ({ success: true })),
        );

      case MessageType.BATCH_ADD_RULES: {
        if (!message.data || !Array.isArray(message.data.rules)) {
          sendResponse({ success: false, error: 'Invalid rules' });
          return false;
        }
        return respondAsync(
          sendResponse,
          batchAddRules(message.data.rules).then(() => ({ success: true })),
        );
      }

      case MessageType.UPDATE_RULE: {
        if (!message.data || typeof message.data.rule !== 'object' || message.data.rule === null) {
          sendResponse({ success: false, error: 'Invalid rule' });
          return false;
        }
        const { id, ...updates } = message.data.rule;
        return respondAsync(
          sendResponse,
          updateRule(id, updates).then(() => ({ success: true })),
        );
      }

      case MessageType.DELETE_RULE:
        if (!message.data || typeof message.data.ruleId !== 'string') {
          sendResponse({ success: false, error: 'Invalid ruleId' });
          return false;
        }
        return respondAsync(
          sendResponse,
          deleteRule(message.data.ruleId).then(() => ({ success: true })),
        );

      case MessageType.BATCH_DELETE_RULES: {
        if (!message.data || !Array.isArray(message.data.ruleIds)) {
          sendResponse({ success: false, error: 'Invalid ruleIds' });
          return false;
        }
        const ruleIds = message.data.ruleIds;
        return respondAsync(
          sendResponse,
          batchDeleteRules(ruleIds).then(updatedConfig => ({ success: true, data: updatedConfig })),
        );
      }

      case MessageType.BATCH_TOGGLE_RULES:
        if (!message.data || !Array.isArray(message.data.ruleIds) || typeof message.data.enabled !== 'boolean') {
          sendResponse({ success: false, error: 'Invalid data' });
          return false;
        }
        return respondAsync(
          sendResponse,
          batchToggleRules(message.data.ruleIds, message.data.enabled).then(() => ({ success: true })),
        );

      case MessageType.REORDER_RULES: {
        if (!message.data || !Array.isArray(message.data.orderedIds)) {
          sendResponse({ success: false, error: 'Invalid orderedIds' });
          return false;
        }
        const orderedIds = message.data.orderedIds;
        return respondAsync(
          sendResponse,
          reorderRules(orderedIds).then(() => ({ success: true })),
        );
      }

      case MessageType.GET_DNR_STATS:
        return respondAsync(sendResponse, getDnrHitStats());

      case MessageType.GET_SW_STATS:
        sendResponse(getSwHitStats());
        return false;

      case MessageType.GET_REQUEST_LOG:
        return respondAsync(sendResponse, getRequestLogs());

      case MessageType.CLEAR_REQUEST_LOG:
        return respondAsync(
          sendResponse,
          clearRequestLogs().then(() => ({ success: true })),
        );

      case MessageType.GET_PROXY_STATUS:
        return respondAsync(sendResponse, getProxyStatus());

      case MessageType.EXPORT_CONFIG:
        return respondAsync(
          sendResponse,
          getProxyConfig().then(config => ({
            version: chrome.runtime.getManifest().version,
            exportTime: Date.now(),
            config,
          })),
        );

      case MessageType.IMPORT_CONFIG:
        return respondAsync(sendResponse, handleImportConfig(message.data));

      case MessageType.EXPORT_HAR:
        return respondAsync(
          sendResponse,
          getRequestLogs().then(logs => logsToHar(logs)),
        );

      case MessageType.IMPORT_HAR: {
        const entries = message.data?.log?.entries;
        if (!Array.isArray(entries)) {
          sendResponse({ success: false, error: 'Invalid HAR data' });
          return false;
        }
        const rules = harEntriesToRules(entries);
        sendResponse({ success: true, rules });
        return false;
      }

      case MessageType.GET_PROFILES:
        return respondAsync(sendResponse, getProfiles());

      case MessageType.SAVE_PROFILE:
        if (!message.data || typeof message.data !== 'object') {
          sendResponse({ success: false, error: 'Invalid profile' });
          return false;
        }
        return respondAsync(
          sendResponse,
          saveProfile(message.data).then(() => ({ success: true })),
        );

      case MessageType.LOAD_PROFILE:
        if (!message.data || typeof message.data.profileId !== 'string') {
          sendResponse({ success: false, error: 'Invalid profileId' });
          return false;
        }
        return respondAsync(sendResponse, loadProfile(message.data.profileId));

      case MessageType.DELETE_PROFILE:
        if (!message.data || typeof message.data.profileId !== 'string') {
          sendResponse({ success: false, error: 'Invalid profileId' });
          return false;
        }
        return respondAsync(
          sendResponse,
          deleteProfile(message.data.profileId).then(() => ({ success: true })),
        );

      default:
        logger.warn('Unknown message type:', message.type);
        sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
        return false;
    }
  });
}
