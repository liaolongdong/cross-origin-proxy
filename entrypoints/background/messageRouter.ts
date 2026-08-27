import { MessageType } from '@/utils/types';
import type { RuntimeMessage, ExportData, ProxyRule } from '@/utils/types';
import { handleProxyRequest, getProxyStatus } from './proxyHandler';
import { getDnrHitStats } from './dnrStats';
import {
  getProxyConfig,
  saveProxyConfig,
  addRule,
  updateRule,
  deleteRule,
  batchDeleteRules,
  batchToggleRules,
  toggleProxy,
  toggleRule,
  getRequestLogs,
  clearRequestLogs,
} from '@/utils/storage';
import { logsToHar, harEntriesToRules } from '@/utils/har';
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
 * 处理导入配置
 */
async function handleImportConfig(data: ExportData): Promise<{ success: boolean; error?: string }> {
  try {
    if (!data?.config || !Array.isArray(data.config.rules)) {
      return { success: false, error: 'Invalid config data' };
    }
    const validRules: ProxyRule[] = data.config.rules.filter(isValidRule).map(rule => ({
      ...rule,
      priority: typeof rule.priority === 'number' ? rule.priority : 100,
      enabled: rule.enabled === true,
      createdAt: typeof rule.createdAt === 'number' ? rule.createdAt : Date.now(),
      updatedAt: typeof rule.updatedAt === 'number' ? rule.updatedAt : Date.now(),
    }));
    await saveProxyConfig({
      enabled: data.config.enabled === true,
      rules: validRules,
    });
    logger.info(`Config imported: ${validRules.length}/${data.config.rules.length} rules valid`);
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
  MessageType.UPDATE_RULE,
  MessageType.DELETE_RULE,
  MessageType.BATCH_DELETE_RULES,
  MessageType.BATCH_TOGGLE_RULES,
  MessageType.CLEAR_REQUEST_LOG,
  MessageType.IMPORT_HAR,
]);

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
        handleProxyRequest(message.data).then(sendResponse);
        return true; // async response

      case MessageType.GET_PROXY_CONFIG:
        getProxyConfig()
          .then(config => sendResponse(config))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.UPDATE_PROXY_CONFIG:
        saveProxyConfig(message.data)
          .then(() => sendResponse({ success: true }))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.TOGGLE_PROXY:
        toggleProxy(message.data.enabled)
          .then(enabled => {
            logger.info(`Proxy ${enabled ? 'enabled' : 'disabled'}`);
            sendResponse({ success: true });
          })
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.TOGGLE_RULE:
        if (!message.data.ruleId) {
          sendResponse({ success: false, error: 'Invalid ruleId' });
          return false;
        }
        toggleRule(message.data.ruleId, message.data.enabled)
          .then(result => {
            if (result.success) {
              logger.info(`Rule toggled: ${message.data.ruleId}`);
            }
            sendResponse(result);
          })
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.ADD_RULE:
        addRule(message.data.rule)
          .then(() => sendResponse({ success: true }))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.UPDATE_RULE: {
        const { id, ...updates } = message.data.rule;
        updateRule(id, updates)
          .then(() => sendResponse({ success: true }))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;
      }

      case MessageType.DELETE_RULE:
        deleteRule(message.data.ruleId)
          .then(() => sendResponse({ success: true }))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.BATCH_DELETE_RULES: {
        const ruleIds = message.data.ruleIds;
        if (!Array.isArray(ruleIds)) {
          sendResponse({ success: false, error: 'Invalid ruleIds' });
          return false;
        }
        batchDeleteRules(ruleIds)
          .then(updatedConfig => sendResponse({ success: true, data: updatedConfig }))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;
      }

      case MessageType.BATCH_TOGGLE_RULES:
        batchToggleRules(message.data.ruleIds, message.data.enabled)
          .then(() => sendResponse({ success: true }))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.GET_DNR_STATS:
        getDnrHitStats()
          .then(stats => sendResponse(stats))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.GET_REQUEST_LOG:
        getRequestLogs()
          .then(logs => sendResponse(logs))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.CLEAR_REQUEST_LOG:
        clearRequestLogs()
          .then(() => sendResponse({ success: true }))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.GET_PROXY_STATUS:
        getProxyStatus()
          .then(status => sendResponse(status))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.EXPORT_CONFIG:
        getProxyConfig()
          .then(config =>
            sendResponse({
              version: chrome.runtime.getManifest().version,
              exportTime: Date.now(),
              config,
            }),
          )
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.IMPORT_CONFIG:
        handleImportConfig(message.data)
          .then(sendResponse)
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

      case MessageType.EXPORT_HAR:
        getRequestLogs()
          .then(logs => sendResponse(logsToHar(logs)))
          .catch((error: unknown) =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
          );
        return true;

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

      default:
        logger.warn('Unknown message type:', message.type);
        sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
        return false;
    }
  });
}
