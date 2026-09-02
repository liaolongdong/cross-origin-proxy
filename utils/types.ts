/**
 * 响应体覆盖配置
 *
 * 支持修改响应状态码、响应头、以及 JSON 响应体中的字段替换。
 * bodyReplacements 为 JSONPath 风格的键值对：key 是点分隔路径（如 "data.token"），value 是替换值。
 * bodyRaw 为完整的响应体替换（优先级高于 bodyReplacements）。
 */
export interface ResponseOverrides {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyRaw?: string;
  bodyReplacements?: Record<string, unknown>;
}

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
  requestBodyOverride?: string; // 请求体覆盖（仅 SW 通道）
  responseOverrides?: ResponseOverrides; // 响应覆盖（仅 SW 通道）
  mockResponse?: MockResponseConfig; // Mock 响应（启用后不发真实请求）
  delayMs?: number; // 请求延迟（毫秒），模拟慢网络
  blocked?: boolean; // 拦截请求（匹配后直接阻断，返回网络错误）
  retryCount?: number; // 失败重试次数（0-5，默认 0 不重试）
  retryDelay?: number; // 重试间隔（毫秒，默认 1000）
  priority: number; // 优先级（数值越小越先匹配）
  createdAt: number;
  updatedAt: number;
}

/**
 * Mock 条件（条件化 Mock 响应的单个条件条目）
 *
 * 所有字段为 AND 逻辑：全部匹配时该条件命中，返回对应的 body/status/contentType。
 */
export interface MockCondition {
  matchUrl?: string; // URL 正则匹配模式
  matchMethod?: string; // HTTP 方法过滤（GET/POST 等）
  matchQuery?: Record<string, string>; // 查询参数匹配（key-value）
  body: string; // 条件命中时的 Mock 响应体
  contentType?: string; // 条件命中时的 Content-Type
  status?: number; // 条件命中时的状态码
}

/**
 * Mock 响应配置
 *
 * 启用后，匹配的请求不会发送到目标服务器，直接返回配置的 Mock 数据。
 * 适用于前端脱离后端开发、接口联调前的 UI 调试等场景。
 * conditions 支持按请求属性返回不同的 Mock 响应（首个命中条件生效，无命中则用默认 body）。
 */
export interface MockResponseConfig {
  body: string; // Mock 响应体（JSON 字符串或纯文本）
  contentType?: string; // 响应 Content-Type，默认 application/json
  status?: number; // 响应状态码，默认 200
  conditions?: MockCondition[]; // 可选的条件化响应列表
}

/**
 * 环境配置（命名快照）
 *
 * 保存当前规则集的命名快照，支持一键切换不同环境。
 */
export interface EnvironmentProfile {
  id: string;
  name: string;
  rules: ProxyRule[];
  createdAt: number;
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
  BATCH_ADD_RULES = 'BATCH_ADD_RULES', // Options → SW：批量新增规则（一次写入，HAR 导入用）
  UPDATE_RULE = 'UPDATE_RULE',
  DELETE_RULE = 'DELETE_RULE',
  BATCH_TOGGLE_RULES = 'BATCH_TOGGLE_RULES', // Options → SW：批量启停规则（一次写入）
  BATCH_DELETE_RULES = 'BATCH_DELETE_RULES', // Options → SW：批量删除规则
  REORDER_RULES = 'REORDER_RULES', // Options → SW：拖拽排序（一次写入）

  // 日志相关
  GET_REQUEST_LOG = 'GET_REQUEST_LOG',
  CLEAR_REQUEST_LOG = 'CLEAR_REQUEST_LOG',
  GET_DNR_STATS = 'GET_DNR_STATS', // Options → SW：DNR 规则级命中统计
  GET_SW_STATS = 'GET_SW_STATS', // Options → SW：SW 通道规则级命中统计

  // 状态
  GET_PROXY_STATUS = 'GET_PROXY_STATUS',

  // 导入导出
  IMPORT_CONFIG = 'IMPORT_CONFIG',
  EXPORT_CONFIG = 'EXPORT_CONFIG',

  // HAR 报文导入导出
  EXPORT_HAR = 'EXPORT_HAR',
  IMPORT_HAR = 'IMPORT_HAR',

  // 环境配置
  GET_PROFILES = 'GET_PROFILES',
  SAVE_PROFILE = 'SAVE_PROFILE',
  LOAD_PROFILE = 'LOAD_PROFILE',
  DELETE_PROFILE = 'DELETE_PROFILE',
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

/** 批量新增规则（一次写入） */
export interface BatchAddRulesMessage {
  type: MessageType.BATCH_ADD_RULES;
  data: { rules: ProxyRule[] };
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

/** 拖拽排序规则 */
export interface ReorderRulesMessage {
  type: MessageType.REORDER_RULES;
  data: { orderedIds: string[] };
}

/** 获取 DNR 命中统计 */
export interface GetDnrStatsMessage {
  type: MessageType.GET_DNR_STATS;
}

/** 获取 SW 通道命中统计 */
export interface GetSwStatsMessage {
  type: MessageType.GET_SW_STATS;
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
  data: ExportData & { mode?: 'replace' | 'merge' };
}

/** 导出配置 */
export interface ExportConfigMessage {
  type: MessageType.EXPORT_CONFIG;
}

/** 导出 HAR */
export interface ExportHarMessage {
  type: MessageType.EXPORT_HAR;
}

/** 导入 HAR */
export interface ImportHarMessage {
  type: MessageType.IMPORT_HAR;
  data: HarImportPayload;
}

/** 获取环境配置列表 */
export interface GetProfilesMessage {
  type: MessageType.GET_PROFILES;
}

/** 保存环境配置 */
export interface SaveProfileMessage {
  type: MessageType.SAVE_PROFILE;
  data: EnvironmentProfile;
}

/** 加载环境配置（替换当前规则集） */
export interface LoadProfileMessage {
  type: MessageType.LOAD_PROFILE;
  data: { profileId: string };
}

/** 删除环境配置 */
export interface DeleteProfileMessage {
  type: MessageType.DELETE_PROFILE;
  data: { profileId: string };
}

/** HAR 导入载荷 */
export interface HarImportPayload {
  log: {
    entries: HarEntry[];
  };
}

/** HAR 条目（简化版，仅保留生成规则所需字段） */
export interface HarEntry {
  request: {
    method: string;
    url: string;
    headers?: { name: string; value: string }[];
    postData?: { text?: string; mimeType?: string };
  };
  response: {
    status: number;
    statusText?: string;
    headers?: { name: string; value: string }[];
    content?: { text?: string; mimeType?: string };
  };
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
  | BatchAddRulesMessage
  | UpdateRuleMessage
  | DeleteRuleMessage
  | BatchToggleRulesMessage
  | BatchDeleteRulesMessage
  | ReorderRulesMessage
  | GetDnrStatsMessage
  | GetSwStatsMessage
  | GetRequestLogMessage
  | ClearRequestLogMessage
  | GetProxyStatusMessage
  | ImportConfigMessage
  | ExportConfigMessage
  | ExportHarMessage
  | ImportHarMessage
  | GetProfilesMessage
  | SaveProfileMessage
  | LoadProfileMessage
  | DeleteProfileMessage;

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
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseIsBase64?: boolean;
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
  /** 自动关闭时间点（epoch ms），未配置自动关闭时为 undefined */
  autoOffAt?: number;
}

/**
 * 导入/导出配置格式
 */
export interface ExportData {
  version: string;
  exportTime: number;
  config: ProxyConfig;
}
