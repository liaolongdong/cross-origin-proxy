import { MessageType } from '@/utils/types';
import type { RuntimeMessage, ExportData, ImportMode, ProxyRule } from '@/utils/types';
import { handleProxyRequest, getProxyStatus, getSwHitStats } from './proxyHandler';
import { getDnrHitStats } from './dnrStats';
import { IMPORTED_RULE_PRIORITY } from '@/utils/constants';
import {
  getProxyConfig,
  saveProxyConfig,
  importProxyConfig,
  addRule,
  batchAddRules,
  updateRule,
  deleteRule,
  batchDeleteRules,
  batchToggleRules,
  batchUpdateTargets,
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
import { sanitizeImportedHeaderMap } from '@/utils/headerValidation';
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
 * 导入文件是不可信输入：`typeof x === 'number'` 会放行 `NaN` 与 `Infinity`。
 * NaN 优先级会让 DNR 侧算出 NaN 而使整批规则被拒，NaN 时间戳会打乱日志与排序，
 * 因此这里只接受有限数。
 */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 优先级取整：DNR 的 `priority` 只接受整数，导入文件里的小数（如 1.5）
 * 与 NaN 同样是整批 `updateDynamicRules` 被拒，而不是只丢一条规则。
 */
function integerPriority(value: unknown): number {
  return Math.round(finiteOr(value, IMPORTED_RULE_PRIORITY));
}

/**
 * 规范化导入的规则列表：过滤结构非法的条目、重新生成 id、补全默认值、清洗请求头覆盖。
 * 重新生成 id 是必要的：文件中的旧 id 可能与现有规则冲突（合并模式下
 * 会造成重复 id，引发列表 key 冲突与按 id 操作误中其他规则）。
 *
 * 请求头必须在导入侧清洗：带非法头名的规则落库后，运行时 `validateRuleHeaders`
 * 会整条拒绝（页面拿到 status 0），而导入文件不会回到表单让用户修正，等于静默坏规则。
 */
export function normalizeImportedRules(rawRules: unknown[]): ProxyRule[] {
  return rawRules.filter(isValidRule).map(rule => {
    const normalized: ProxyRule = {
      ...rule,
      id: generateId(),
      priority: integerPriority(rule.priority),
      enabled: rule.enabled === true,
      createdAt: finiteOr(rule.createdAt, Date.now()),
      updatedAt: finiteOr(rule.updatedAt, Date.now()),
    };
    const headerOverrides = sanitizeImportedHeaderMap(rule.headerOverrides);
    if (headerOverrides) normalized.headerOverrides = headerOverrides;
    else delete normalized.headerOverrides;
    return normalized;
  });
}

/**
 * 处理导入配置
 *
 * 回传给 UI 的 `error` 是稳定错误码而非英文句子：界面按码映射本地化文案，
 * 直接透传英文会让中文界面夹一句机器话。
 * 写入统一交给 `importProxyConfig`（存储锁内完成读-去重-上限校验-落盘）。
 */
async function handleImportConfig(
  data: ExportData & { mode?: ImportMode },
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!data?.config || !Array.isArray(data.config.rules)) {
      return { success: false, error: 'INVALID_CONFIG' };
    }
    const validRules = normalizeImportedRules(data.config.rules);
    const isMerge = data.mode === 'merge';
    // 开关键语义与既有一致：文件显式开启才置真；合并模式下缺省沿用当前开关，替换模式下缺省关闭
    const enabled = data.config.enabled === true ? true : isMerge ? undefined : false;
    const result = await importProxyConfig(validRules, { mode: isMerge ? 'merge' : 'replace', enabled });

    if (!result.success) {
      logger.warn(`Config import rejected (${result.error})`);
      return { success: false, error: result.error };
    }
    logger.info(
      isMerge
        ? `Config merged: ${result.added} new, ${result.skipped} duplicates skipped`
        : `Config imported: ${validRules.length}/${data.config.rules.length} rules valid`,
    );
    return { success: true };
  } catch (error) {
    logger.error('Failed to import config:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 判断消息发送上下文是否为本扩展自己的页面（popup / options / SW 自身）
 *
 * 只看 `sender.url`，而它由 Chrome 写入、页面伪造不了——这道 gate 挡的不是「伪造来源」，
 * 而是来自非扩展上下文的状态修改请求：内容脚本的 `sender.url` 就是被注入页面的 URL，
 * 与外部页面同列，所以桥接层（`entrypoints/content.ts`）只转发只读配置与 `PROXY_REQUEST`。
 * 页面侧能让扩展代发哪些请求，判据要在桥接层与规则匹配处收紧，不靠往这些类型上加 gate。
 *
 * @param sender - 消息发送者的上下文信息
 * @returns 如果是扩展内部页面返回 true，否则返回 false
 */
export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
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
  MessageType.BATCH_UPDATE_TARGETS,
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

      case MessageType.BATCH_UPDATE_TARGETS: {
        const updates = message.data?.updates;
        if (
          !Array.isArray(updates) ||
          updates.some(u => !u || typeof u.id !== 'string' || typeof u.targetUrl !== 'string')
        ) {
          sendResponse({ success: false, error: 'Invalid updates' });
          return false;
        }
        return respondAsync(
          sendResponse,
          batchUpdateTargets(updates).then(() => ({ success: true })),
        );
      }

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
