import { MessageType } from '@/utils/types';
import type { RuntimeMessage, ExportData, ImportMode, ProxyRule, ImportPlan } from '@/utils/types';
import {
  cancelProxiedRequest,
  getProxyStatus,
  getSwHitStats,
  handleProxyRequest,
  proxyRequestKey,
} from './proxyHandler';
import { sampleAggregate, sampleForTab } from './dnrSampler';
import { countProxyRequestForTab, getInterceptorStats, recordInterceptorStats } from './interceptorStats';
import { clearConfigUnsynced, isConfigUnsynced } from './configSyncState';
import { IMPORTED_RULE_PRIORITY, SCHEMA_VERSION } from '@/utils/constants';
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
  getVariables,
  saveVariables,
  getConfigHistory,
  restoreConfigHistory,
} from '@/utils/storage';
import { logsToHar, harEntriesToRules } from '@/utils/har';
import { sanitizeImportedHeaderMap } from '@/utils/headerValidation';
import { sanitizeExportedLogs } from '@/utils/exportSanitize';
import { isValidRuleShape } from '@/utils/ruleValidation';
import { planImport } from '@/utils/importPlan';
import { generateId } from '@/utils/generateId';
import { logger } from '@/utils/logger';

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
 *
 * 结构判据与配置恢复点的读取侧共用 `utils/ruleValidation`：两处都是「把未知数据变成生效配置」的入口。
 */
export function normalizeImportedRules(rawRules: unknown[]): ProxyRule[] {
  return rawRules.filter(isValidRuleShape).map(rule => {
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
 * 文件比本机认识的导出格式更新：拒掉，而不是半解析半丢字段地写进存储
 *
 * 缺省（历史文件没有 `schemaVersion`）按 v1 处理，走既有的宽松兜底。
 */
function isSchemaTooNew(data: ExportData | undefined): boolean {
  const raw = data?.schemaVersion;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > SCHEMA_VERSION;
}

/** 导入载荷的共同校验：结构可用 + 格式版本不超本机认知 */
function readImportPayload(data: (ExportData & { mode?: ImportMode }) | undefined):
  | {
      rules: unknown[];
      mode: ImportMode;
      error?: undefined;
    }
  | { error: string } {
  if (!data?.config || !Array.isArray(data.config.rules)) return { error: 'INVALID_CONFIG' };
  if (isSchemaTooNew(data)) return { error: 'SCHEMA_TOO_NEW' };
  return { rules: data.config.rules, mode: data.mode === 'merge' ? 'merge' : 'replace' };
}

/**
 * 处理导入配置
 *
 * 回传给 UI 的 `error` 是稳定错误码而非英文句子：界面按码映射本地化文案，
 * 直接透传英文会让中文界面夹一句机器话。
 * 写入统一交给 `importProxyConfig`（存储锁内完成读-去重-上限校验-落盘）。
 *
 * 成功时也把**实际**写入结果带回界面：`added` / `skipped` 是存储层在锁内算完的那份，
 * `invalid` 是被结构校验丢弃的条数。此前这三个数只进控制台，用户看到的永远是一句「导入成功」，
 * 于是「改了目标地址的合并导入其实没改任何东西」这类事完全没有被告知（见 `GET_IMPORT_PLAN` 的预览）。
 */
async function handleImportConfig(
  data: ExportData & { mode?: ImportMode },
): Promise<{ success: boolean; error?: string; added?: number; skipped?: number; invalid?: number }> {
  const payload = readImportPayload(data);
  if ('error' in payload) {
    logger.warn(`Config import rejected (${payload.error})`);
    return { success: false, error: payload.error };
  }
  try {
    const validRules = normalizeImportedRules(payload.rules);
    const invalid = payload.rules.length - validRules.length;
    const isMerge = payload.mode === 'merge';
    // 开关键语义与既有一致：文件显式开启才置真；合并模式下缺省沿用当前开关，替换模式下缺省关闭
    const enabled = data.config.enabled === true ? true : isMerge ? undefined : false;
    const result = await importProxyConfig(validRules, { mode: payload.mode, enabled });

    if (!result.success) {
      logger.warn(`Config import rejected (${result.error})`);
      return { success: false, error: result.error };
    }
    logger.info(
      isMerge
        ? `Config merged: ${result.added} new, ${result.skipped} duplicates skipped, ${invalid} invalid dropped`
        : `Config imported: ${validRules.length}/${payload.rules.length} rules valid`,
    );
    return { success: true, added: result.added, skipped: result.skipped, invalid };
  } catch (error) {
    logger.error('Failed to import config:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 导入前预览：把「这次会发生什么」算给界面，纯函数、不落库、不写任何存储
 *
 * 与写入侧共用 `normalizeImportedRules` + `deduplicateRules`（经 `planImport`），所以数字不会和
 * 实际结果对不上；但真实合并仍在存储锁内重算，界面措辞必须是「预计」。
 *
 * 刻意不加 `isTrustedSender`，判据**不是**「它是只读的」，而是「页面根本没有通往它的路径」：
 * 桥接层通往 SW 的出口只有 `GET_PROXY_CONFIG`（页面那侧写作 `REQUEST_CONFIG`）、`INTERCEPTOR_STATS`、
 * `CANCEL_REQUEST` 与 `PROXY_REQUEST` 四种，这一型不在其中，同频道伪造消息也发不出它——
 * 那份清单在 `tests/contentBridge.test.ts` 末尾按源码枚举，加一个出口就得回来重新判一次 gate。
 * 合并模式的回包会把现网规则的目标地址带回界面（`planImport` 的 `currentTargetUrl`，预演要说清
 * 「保留哪一条」就必须知道旧值），所以将来若给页面开这条路，这一条得重新评估——按下面
 * `CREDENTIAL_READING_TYPES` 的判据，「整包本地数据」那一半它占得住。
 */
async function handleImportPlan(
  data: ExportData & { mode?: ImportMode },
): Promise<{ success: boolean; error?: string; plan?: ImportPlan }> {
  const payload = readImportPayload(data);
  if ('error' in payload) return { success: false, error: payload.error };
  try {
    const config = await getProxyConfig();
    const validRules = normalizeImportedRules(payload.rules);
    return {
      success: true,
      plan: planImport(config.rules, validRules, payload.mode),
    };
  } catch (error) {
    logger.error('Failed to build import plan:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 判断消息发送上下文是否为本扩展自己的页面（popup / options / SW 自身）
 *
 * 只看 `sender.url`，而它由 Chrome 写入、页面伪造不了——这道 gate 挡的不是「伪造来源」，
 * 而是来自非扩展上下文的状态修改请求：内容脚本的 `sender.url` 就是被注入页面的 URL，
 * 与外部页面同列，所以桥接层（`entrypoints/content.ts`）只转发只读配置、`PROXY_REQUEST`、
 * `CANCEL_REQUEST` 与 `INTERCEPTOR_STATS`。
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
  MessageType.RESTORE_CONFIG_HISTORY,
  MessageType.SAVE_PROFILE,
  MessageType.LOAD_PROFILE,
  MessageType.DELETE_PROFILE,
  MessageType.SET_VARIABLES,
]);

/**
 * 只读、但**回的是凭据或整包本地数据**的消息类型，与状态修改类共用同一道 sender 校验
 *
 * 「只读消息不加 gate」那条规则挡的是内容脚本要用的消息（加了代理当场失效）——这两条都没有
 * 页面侧调用方，桥接层永远不转发它们，因此这里不违反那条约束，反而是它的前提：
 * 漏掉这道 gate，任意页面的 `chrome.runtime.sendMessage({type:'GET_VARIABLES'})` 就能读到
 * 用户所有环境的密钥，本批次其余设计（真值不下发页面）当场作废。
 *
 * `GET_CONFIG_HISTORY` 同档：恢复点是写入前的整包快照，里面的 `headerOverrides` 是**原样落盘的
 * 真实请求头**（凭据变量库之前录入的规则尤其如此），一份历史等于把配好几种环境的会话全交出去。
 *
 * 新增读取类消息时不要照这里加：判据是「页面从不读取 + 回的是凭据类数据」，两者缺一就别加。
 */
const CREDENTIAL_READING_TYPES = new Set([MessageType.GET_VARIABLES, MessageType.GET_CONFIG_HISTORY]);

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

    // 状态修改类与「回的是凭据真值」的读取类消息：校验 sender 来源
    if (
      (STATE_MUTATING_TYPES.has(message.type) || CREDENTIAL_READING_TYPES.has(message.type)) &&
      !isTrustedSender(sender)
    ) {
      sendResponse({ success: false, error: 'Unauthorized sender' });
      return false;
    }

    switch (message.type) {
      case MessageType.PROXY_REQUEST:
        // 顺手累加这个 frame 的代发数，作为拦截器自报计数的交叉校验基准（`sender.tab` 与
        // `sender.frameId` 都由 Chrome 写入，页面伪造不了；四个自报数字本身可以，见 `interceptorStats`）
        countProxyRequestForTab(sender.tab?.id, sender.frameId);
        return respondAsync(
          sendResponse,
          handleProxyRequest(message.data, proxyRequestKey(sender.tab?.id, sender.frameId, message.data.requestId)),
        );

      case MessageType.CANCEL_REQUEST:
        // 刻意**不加** sender gate：这条消息存在的意义就是让页面取消自己那笔代发请求，
        // 而内容脚本的 `sender.url` 就是页面 URL（与 `PROXY_REQUEST` 同档）。
        // 越权面也被键本身挡住——取消要命中 `tabId + frameId + requestId` 拼出的登记键，
        // 而这三段都由 Chrome 写入的 sender 与前一笔 `PROXY_REQUEST` 同源（见 `proxyRequestKey`）。
        if (!message.data || typeof message.data.requestId !== 'string' || !message.data.requestId) {
          sendResponse({ success: false, error: 'Invalid requestId' });
          return false;
        }
        sendResponse({
          success: true,
          cancelled: cancelProxiedRequest(proxyRequestKey(sender.tab?.id, sender.frameId, message.data.requestId)),
        });
        return false;

      case MessageType.GET_PROXY_CONFIG: {
        // 来拉配置的页面下一秒就在用这份配置，所以它那条「广播没送达」的账当场作废。
        // 这一笔是那句警告不误报的兜底：老文档销毁带来的失败回执可能很晚才被处理完
        // （见 `configSyncState` 与 `broadcastConfigToTabs` 的时序说明）。
        const requesterTabId = sender.tab?.id;
        if (typeof requesterTabId === 'number') clearConfigUnsynced(requesterTabId);
        return respondAsync(sendResponse, getProxyConfig());
      }

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

      case MessageType.GET_DNR_STATS: {
        // 只读消息：刻意不加 isTrustedSender（见 .qoder/rules/wxt-rules.md 第 12 条）
        const tabId = typeof message.data?.tabId === 'number' ? message.data.tabId : undefined;
        return respondAsync(sendResponse, tabId === undefined ? sampleAggregate() : sampleForTab(tabId));
      }

      case MessageType.GET_SW_STATS:
        sendResponse(getSwHitStats());
        return false;

      case MessageType.INTERCEPTOR_STATS: {
        // 页面自报的展示数据：刻意不进 `STATE_MUTATING_TYPES`，也刻意**不写 storage**——
        // 它改不了配置、参与不了匹配，最坏后果是 popup 上一行难看的假数字（判据见 `interceptorStats`）
        const accepted = recordInterceptorStats(sender.tab?.id, sender.frameId, message.data);
        sendResponse({ success: accepted });
        return false;
      }

      case MessageType.GET_INTERCEPTOR_STATS: {
        // 只读消息：与 `GET_DNR_STATS` 同档，刻意不加 isTrustedSender（见 .qoder/rules/wxt-rules.md 第 12 条）
        const tabId = typeof message.data?.tabId === 'number' ? message.data.tabId : undefined;
        sendResponse(tabId === undefined ? null : getInterceptorStats(tabId));
        return false;
      }

      case MessageType.GET_CONFIG_SYNC: {
        // 只读消息：与 `GET_INTERCEPTOR_STATS` 同档，刻意不加 isTrustedSender
        // （它回的是一个布尔——「这一页上次没接到配置广播」，改不了任何状态）
        const tabId = typeof message.data?.tabId === 'number' ? message.data.tabId : undefined;
        sendResponse(tabId === undefined ? null : { synced: !isConfigUnsynced(tabId) });
        return false;
      }

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
            // 导出格式的 schema 版本：导入侧「读并拒绝过新」（见 SCHEMA_VERSION）
            schemaVersion: SCHEMA_VERSION,
            exportTime: Date.now(),
            config,
          })),
        );

      case MessageType.IMPORT_CONFIG:
        return respondAsync(sendResponse, handleImportConfig(message.data));

      case MessageType.GET_IMPORT_PLAN:
        // 刻意不加 sender gate：判据是「页面没有通往它的路径」，不是「它只读」（见 handleImportPlan）
        return respondAsync(sendResponse, handleImportPlan(message.data));

      case MessageType.GET_CONFIG_HISTORY:
        // 走到这里说明已过 `CREDENTIAL_READING_TYPES` 那道 sender 校验；回的是整包历史快照
        return respondAsync(sendResponse, getConfigHistory());

      case MessageType.RESTORE_CONFIG_HISTORY:
        if (!message.data || typeof message.data.id !== 'string') {
          sendResponse({ success: false, error: 'Invalid history id' });
          return false;
        }
        return respondAsync(sendResponse, restoreConfigHistory(message.data.id));

      case MessageType.EXPORT_HAR: {
        // 「分享模式」同样管住 HAR：日志里的 Cookie / Authorization 是用户当时那个会话的凭据，
        // 贴进工单就等于把会话交出去。缺省按脱敏处理——只有显式传 false（界面上取消勾选）
        // 才导出全量头，避免出现「没传参数的那条路径反而更宽松」。
        const sanitize = message.data?.sanitize !== false;
        return respondAsync(
          sendResponse,
          getRequestLogs().then(logs => logsToHar(sanitize ? sanitizeExportedLogs(logs).logs : logs)),
        );
      }

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

      case MessageType.GET_VARIABLES:
        // 走到这里说明已过 `CREDENTIAL_READING_TYPES` 那道 sender 校验；回的是真值表
        return respondAsync(sendResponse, getVariables());

      case MessageType.SET_VARIABLES:
        // 整表写入（与 UPDATE_PROXY_CONFIG 同形态）：非键值对象在 `saveVariables` 里抛错，
        // 由 `respondAsync` 转成 { success: false }，绝不当成空表清掉用户凭据
        return respondAsync(
          sendResponse,
          saveVariables(message.data?.variables).then(({ dropped }) => ({ success: true, dropped })),
        );

      default:
        logger.warn('Unknown message type:', message.type);
        sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
        return false;
    }
  });
}
