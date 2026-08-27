/**
 * 代理规则
 */
export interface ProxyRule {
  id: string;
  name: string; // 规则名称，如 "FAT → UAT"
  enabled: boolean; // 是否启用
  matchPattern: string; // URL 匹配模式，如 "https://fat-api.example.com/*"
  targetUrl: string; // 目标替换 URL，如 "https://uat-api.example.com"
  matchType: 'wildcard' | 'prefix' | 'regex'; // 匹配类型
  headerOverrides?: Record<string, string>; // 可选请求头覆盖
  priority: number; // 优先级（数值越小越先匹配）
  createdAt: number;
  updatedAt: number;
}

/**
 * 全局代理配置
 */
export interface ProxyConfig {
  enabled: boolean; // 总开关
  rules: ProxyRule[]; // 规则列表
}

/**
 * 消息类型枚举 — 用于 content script / popup / options 与 background SW 通信
 */
export enum MessageType {
  // 代理相关
  PROXY_REQUEST = 'PROXY_REQUEST', // 注入脚本 → SW：代理请求
  PROXY_RESPONSE = 'PROXY_RESPONSE', // SW → 注入脚本：代理响应

  // 配置相关
  GET_PROXY_CONFIG = 'GET_PROXY_CONFIG', // Popup/Options → SW：获取配置
  UPDATE_PROXY_CONFIG = 'UPDATE_PROXY_CONFIG', // Options → SW：更新配置
  TOGGLE_PROXY = 'TOGGLE_PROXY', // Popup → SW：切换总开关
  TOGGLE_RULE = 'TOGGLE_RULE', // Popup/Options → SW：切换单条规则

  // 规则 CRUD
  ADD_RULE = 'ADD_RULE',
  UPDATE_RULE = 'UPDATE_RULE',
  DELETE_RULE = 'DELETE_RULE',
  BATCH_TOGGLE_RULES = 'BATCH_TOGGLE_RULES', // Options → SW：批量启停规则（一次写入）
  BATCH_DELETE_RULES = 'BATCH_DELETE_RULES', // Options → SW：批量删除规则

  // 日志相关
  GET_REQUEST_LOG = 'GET_REQUEST_LOG',
  CLEAR_REQUEST_LOG = 'CLEAR_REQUEST_LOG',
  GET_DNR_STATS = 'GET_DNR_STATS', // Options → SW：DNR 规则级命中统计

  // 状态
  GET_PROXY_STATUS = 'GET_PROXY_STATUS',

  // 导入导出
  IMPORT_CONFIG = 'IMPORT_CONFIG',
  EXPORT_CONFIG = 'EXPORT_CONFIG',
}

/**
 * 代理请求消息体
 */
export interface ProxyRequestMessage {
  type: MessageType.PROXY_REQUEST;
  data: {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | null;
  };
}

/**
 * 代理响应消息体
 */
export interface ProxyResponseMessage {
  type: MessageType.PROXY_RESPONSE;
  data: {
    requestId: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string; // base64 encoded for binary support
    isBase64: boolean;
  };
}

/** 获取代理配置 */
export interface GetProxyConfigMessage {
  type: MessageType.GET_PROXY_CONFIG;
}

/** 更新代理配置 */
export interface UpdateProxyConfigMessage {
  type: MessageType.UPDATE_PROXY_CONFIG;
  data: ProxyConfig;
}

/** 切换总开关 */
export interface ToggleProxyMessage {
  type: MessageType.TOGGLE_PROXY;
  data: { enabled: boolean };
}

/** 切换单条规则 */
export interface ToggleRuleMessage {
  type: MessageType.TOGGLE_RULE;
  data: { ruleId: string; enabled: boolean };
}

/** 添加规则 */
export interface AddRuleMessage {
  type: MessageType.ADD_RULE;
  data: { rule: ProxyRule };
}

/** 更新规则 */
export interface UpdateRuleMessage {
  type: MessageType.UPDATE_RULE;
  data: { rule: ProxyRule };
}

/** 删除规则 */
export interface DeleteRuleMessage {
  type: MessageType.DELETE_RULE;
  data: { ruleId: string };
}

/** 批量启停规则 */
export interface BatchToggleRulesMessage {
  type: MessageType.BATCH_TOGGLE_RULES;
  data: { ruleIds: string[]; enabled: boolean };
}

/** 批量删除规则 */
export interface BatchDeleteRulesMessage {
  type: MessageType.BATCH_DELETE_RULES;
  data: { ruleIds: string[] };
}

/** 获取 DNR 命中统计 */
export interface GetDnrStatsMessage {
  type: MessageType.GET_DNR_STATS;
}

/** 获取请求日志 */
export interface GetRequestLogMessage {
  type: MessageType.GET_REQUEST_LOG;
}

/** 清除请求日志 */
export interface ClearRequestLogMessage {
  type: MessageType.CLEAR_REQUEST_LOG;
}

/** 获取代理状态 */
export interface GetProxyStatusMessage {
  type: MessageType.GET_PROXY_STATUS;
}

/** 导入配置 */
export interface ImportConfigMessage {
  type: MessageType.IMPORT_CONFIG;
  data: ExportData;
}

/** 导出配置 */
export interface ExportConfigMessage {
  type: MessageType.EXPORT_CONFIG;
}

/** 运行时消息 — 判别联合类型 */
export type RuntimeMessage =
  | ProxyRequestMessage
  | ProxyResponseMessage
  | GetProxyConfigMessage
  | UpdateProxyConfigMessage
  | ToggleProxyMessage
  | ToggleRuleMessage
  | AddRuleMessage
  | UpdateRuleMessage
  | DeleteRuleMessage
  | BatchToggleRulesMessage
  | BatchDeleteRulesMessage
  | GetDnrStatsMessage
  | GetRequestLogMessage
  | ClearRequestLogMessage
  | GetProxyStatusMessage
  | ImportConfigMessage
  | ExportConfigMessage;

/**
 * 请求日志条目
 */
export interface RequestLogEntry {
  id: string;
  timestamp: number;
  ruleId: string;
  ruleName: string;
  originalUrl: string;
  proxiedUrl: string;
  method: string;
  status?: number;
  duration?: number; // 毫秒
  error?: string;
  proxyType: 'dnr' | 'sw'; // 代理类型
}

/**
 * DNR 规则级命中统计条目（近 5 分钟窗口，来自 getMatchedRules）
 */
export interface DnrHitStat {
  ruleId: string; // 代理规则 id
  ruleName: string; // 代理规则名称
  hitCount: number; // 窗口内命中次数
}

/**
 * 代理状态（Popup 使用）
 */
export interface ProxyStatus {
  enabled: boolean;
  activeRuleCount: number;
  todayRequestCount: number;
  recentLogs: RequestLogEntry[];
  rules: { id: string; name: string; enabled: boolean }[];
}

/**
 * 导入/导出配置格式
 */
export interface ExportData {
  version: string;
  exportTime: number;
  config: ProxyConfig;
}
