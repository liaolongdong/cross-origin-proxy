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
 * 可选的 HTTP 方法集合（规则级方法过滤与表单下拉共用）。
 * 大小写统一为大写，匹配时对请求方法与配置值均做大写归一比较。
 */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

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
  methods?: string[]; // HTTP 方法白名单（大小写不敏感）；空/未定义=任意方法。非空时强制走 SW 通道（DNR 无法按方法过滤）
  queryOverrides?: Record<string, string>; // 命中后对最终 URL 追加/覆盖的查询参数（仅 SW 通道）
  headerOverrides?: Record<string, string>; // 可选请求头覆盖
  // 携带目标环境的 Cookie（SW fetch 的 credentials: 'include'）。仅 SW 通道能力：DNR 重定向由浏览器
  // 直接发出，跨站子请求不带 Cookie 且扩展无从干预。默认关闭——开启等于把用户在该环境的会话
  // 交给这条规则命中的所有路径，因此非布尔值（导入文件）一律按未开启处理，见 isSimpleRule/proxyHandler
  sendCredentials?: boolean;
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
 * 凭据变量表（变量名 → 真值）
 *
 * 规则里的凭据位点写成 `{{名称}}`，真值只存在这一份（`storage.local` 的 `variables` 键），
 * 展开只发生在后台服务线程组装出站请求之前——见 `utils/variables.ts` 的使用约束。
 */
export type VariableStore = Record<string, string>;

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
  BATCH_UPDATE_TARGETS = 'BATCH_UPDATE_TARGETS', // Options → SW：批量迁移目标 URL（一次写入）
  REORDER_RULES = 'REORDER_RULES', // Options → SW：拖拽排序（一次写入）

  // 日志相关
  GET_REQUEST_LOG = 'GET_REQUEST_LOG',
  CLEAR_REQUEST_LOG = 'CLEAR_REQUEST_LOG',
  GET_DNR_STATS = 'GET_DNR_STATS', // Popup/Options → SW：DNR 命中采样（可选按标签页）
  GET_SW_STATS = 'GET_SW_STATS', // Options → SW：SW 通道规则级命中统计

  // 拦截器活动（MAIN world 自报，只用于展示）
  /** 注入脚本 → SW：本页四个计数（页面可伪造，故纯展示、不改任何状态，见 `InterceptorStats`） */
  INTERCEPTOR_STATS = 'INTERCEPTOR_STATS',
  /** Popup → SW：读某个标签页最近一次被采信的自报计数（只读，刻意**不加** sender gate，与 `GET_DNR_STATS` 同档） */
  GET_INTERCEPTOR_STATS = 'GET_INTERCEPTOR_STATS',

  // 状态
  GET_PROXY_STATUS = 'GET_PROXY_STATUS',

  // 导入导出
  IMPORT_CONFIG = 'IMPORT_CONFIG',
  EXPORT_CONFIG = 'EXPORT_CONFIG',
  /** 导入前预览：纯算不落库，只读且不含凭据真值，因此与其余读取消息一样**不加** sender gate */
  GET_IMPORT_PLAN = 'GET_IMPORT_PLAN',

  // 配置恢复点（成套替换类写入前的整包快照）
  GET_CONFIG_HISTORY = 'GET_CONFIG_HISTORY',
  RESTORE_CONFIG_HISTORY = 'RESTORE_CONFIG_HISTORY',

  // HAR 报文导入导出
  EXPORT_HAR = 'EXPORT_HAR',
  IMPORT_HAR = 'IMPORT_HAR',

  // 环境配置
  GET_PROFILES = 'GET_PROFILES',
  SAVE_PROFILE = 'SAVE_PROFILE',
  LOAD_PROFILE = 'LOAD_PROFILE',
  DELETE_PROFILE = 'DELETE_PROFILE',

  // 凭据变量（仅扩展页面可用：GET 回的是真值表，内容脚本一旦能读就等于把密钥交给站点）
  GET_VARIABLES = 'GET_VARIABLES',
  SET_VARIABLES = 'SET_VARIABLES',
}

/**
 * 代理请求消息体
 *
 * `ruleId` 是 MAIN world 拦截器**已经选中**的规则 id：桥接层只下发复杂规则，页面侧的窄规则
 * 选择必须在 SW 侧得到尊重（见 `proxyHandler` 的 `resolveSelectedRule`）。它属于不可信输入，
 * 只作为「候选规则的校验」使用，校验不过即回落到全量重匹配。
 */
export interface ProxyRequestMessage {
  type: MessageType.PROXY_REQUEST;
  data: {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | null;
    ruleId?: string;
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
    /** base64 编码的二进制正文；null 表示「无正文」——204/205/304 只能配 null */
    body: string | null;
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

/** 批量迁移目标 URL：对指定规则集在 targetUrl 上查找/替换（一次写入） */
export interface BatchUpdateTargetsMessage {
  type: MessageType.BATCH_UPDATE_TARGETS;
  data: { updates: { id: string; targetUrl: string }[] };
}

/** 拖拽排序规则 */
export interface ReorderRulesMessage {
  type: MessageType.REORDER_RULES;
  data: { orderedIds: string[] };
}

/**
 * 获取 DNR 命中统计
 *
 * 带 `tabId` 时只统计该标签页（popup 的「本页 · 近 5 分钟」），缺省为全局聚合（options）。
 * 响应是 `DnrSample` 而非 `DnrHitStat[]`：读端必须能看出「这次是缓存」和「从未采到样」。
 */
export interface GetDnrStatsMessage {
  type: MessageType.GET_DNR_STATS;
  data?: { tabId?: number };
}

/**
 * MAIN world 拦截器自报的本页计数（累计到该文档本次加载，页面刷新即归零）
 *
 * 四个数的口径各不相同，界面不得混着说：
 * - `intercepted`：命中了复杂规则、被拦截器接手的 HTTP 请求数（含随后回退原生的那些）
 * - `proxied`：真正交给后台代发的数量
 * - `fellBack`：因同步 XHR、非字符串请求体或代理失败而**回退原生**的数量——请求成功但没走代理
 * - `timedOut`：等后台响应超时的数量（fetch 路径上它随后也会计入 `fellBack`）
 *
 * WebSocket 不在这四个数里：它的地址重写与查询注入全在页面侧完成，从不交给后台代发，
 * 记进 `proxied` 会是谎报，不记又会让这一格数字对不上，因此本计数只覆盖 HTTP。
 *
 * 这些数字**页面可以伪造**（桥接层入站只校验 `event.source === window` 与 channel），
 * 所以它只能是展示数据：不写 storage、不参与匹配、不改任何状态，最坏后果是一行难看的假数字。
 */
export interface InterceptorStats {
  intercepted: number;
  proxied: number;
  fellBack: number;
  timedOut: number;
}

/**
 * SW 采信的自报计数（popup 读端返回的形态）
 *
 * - `updatedAt === 0`：这个文档还没有被采信过任何自报包（`stats` 全 0）。与「没有数据」是两件事，
 *   界面得能分开说：`swProxied > 0` 时后台**确实代发过**，多半只是 SW 回收把上一条读数带走了。
 * - `swProxied`：SW 自己数到的该标签页代发请求数，交叉校验的基准，也是上面那句话的证据。
 */
export interface InterceptorStatsEntry extends InterceptorStats {
  updatedAt: number;
  swProxied: number;
}

/** 拦截器上报本页计数（内容脚本 → SW） */
export interface InterceptorStatsMessage {
  type: MessageType.INTERCEPTOR_STATS;
  data?: Partial<InterceptorStats>;
}

/** 读取某个标签页最近一次被采信的拦截器计数 */
export interface GetInterceptorStatsMessage {
  type: MessageType.GET_INTERCEPTOR_STATS;
  data?: { tabId?: number };
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

/** 导入模式：整体替换当前规则集，或按 name + matchPattern 去重后合并 */
export type ImportMode = 'replace' | 'merge';

/**
 * 导入预览中「同 name + matchPattern 但内容不同」的一条
 *
 * 合并模式下它会被静默跳过（既有语义），也就是**文件里改的目标地址不会生效**。
 * 把新旧两个 targetUrl 都带回去，用户才看得懂「为什么导入了却没变」。
 */
export interface ImportPlanConflict {
  name: string;
  matchPattern: string;
  /** 现网那条的目标地址，导入后仍然是它 */
  currentTargetUrl: string;
  /** 文件里这条的目标地址，合并模式下不会生效 */
  incomingTargetUrl: string;
}

/** `planImport` 的结果，同时是 `GET_IMPORT_PLAN` 的响应体 */
export interface ImportPlan {
  mode: ImportMode;
  /** 预计新增条数（合并模式已去过重） */
  added: number;
  /** 因与现网规则同键而被跳过的条数 */
  skipped: number;
  conflicts: ImportPlanConflict[];
  /** 文件内部自重复、将被一并写入的条数（去重只比对现网，不比对文件内） */
  duplicatesWithinFile: number;
  /** 替换模式下会被整包换掉的现有规则数；合并模式恒为 0 */
  replaces: number;
  exceedsLimit: boolean;
}

/**
 * 一次导入**实际**写入了多少条
 *
 * 与 `ImportPlan` 的「预计」相对：这份是存储层在锁内算完的那份，界面按它说实话。
 * `invalid` 是结构非法、在规范化阶段就被丢掉的条数——它不属于 skipped，两件事必须分开报。
 */
export interface ImportResultStats {
  added: number;
  skipped: number;
  invalid: number;
}

/**
 * 恢复点的成因：只有「成套换掉规则集」的写入会记录，单条编辑不进历史
 *
 * `unknown` 只出现在读取阶段——存储里的这条不是本版本写的（手改过的数据、或更新版本写下的新成因），
 * 宁可标成「未知来源」也不丢快照，也不把它硬塞进某个已知成因里说谎。
 */
export type ConfigHistoryReason = 'replace-import' | 'load-profile' | 'batch-delete' | 'before-restore' | 'unknown';

/**
 * 一份配置恢复点
 *
 * `config` 是写入前的整包快照（含规则原样的 `headerOverrides`，因此这份数据的读取权限与
 * 凭据变量表同档）。只在后台侧流动，从不下发到页面世界。
 */
export interface ConfigHistoryEntry {
  id: string;
  savedAt: number;
  reason: ConfigHistoryReason;
  ruleCount: number;
  config: ProxyConfig;
}

/** 导入配置 */
export interface ImportConfigMessage {
  type: MessageType.IMPORT_CONFIG;
  data: ExportData & { mode?: ImportMode };
}

/** 导入前预览（响应为 `ImportPlan`） */
export interface GetImportPlanMessage {
  type: MessageType.GET_IMPORT_PLAN;
  data: ExportData & { mode?: ImportMode };
}

/** 读取恢复点列表（响应为 `ConfigHistoryEntry[]`，与凭据表共用 sender 校验） */
export interface GetConfigHistoryMessage {
  type: MessageType.GET_CONFIG_HISTORY;
}

/** 回退到某个恢复点 */
export interface RestoreConfigHistoryMessage {
  type: MessageType.RESTORE_CONFIG_HISTORY;
  data: { id: string };
}

/** 导出配置 */
export interface ExportConfigMessage {
  type: MessageType.EXPORT_CONFIG;
}

/**
 * 导出 HAR
 *
 * `sanitize` 与配置导出的「分享模式」同源：缺省按脱敏处理，只有显式传 `false`
 * （界面上取消勾选）才导出全量请求/响应头，判据收在 `sanitizeExportedLogs`。
 */
export interface ExportHarMessage {
  type: MessageType.EXPORT_HAR;
  data?: { sanitize?: boolean };
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

/**
 * 读取凭据变量表（响应是完整的 `VariableStore`）
 *
 * 只有扩展自己的页面会发它，且必须过 `isTrustedSender`：内容脚本的 `sender.url` 就是被注入
 * 页面的 URL，让它读到这张表等于把用户所有环境的密钥交给站点。
 */
export interface GetVariablesMessage {
  type: MessageType.GET_VARIABLES;
}

/** 整体写入凭据变量表（新增、改名、删除都走这一条，语义与 UPDATE_PROXY_CONFIG 一致） */
export interface SetVariablesMessage {
  type: MessageType.SET_VARIABLES;
  data: { variables: VariableStore };
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
  | BatchUpdateTargetsMessage
  | ReorderRulesMessage
  | GetDnrStatsMessage
  | GetSwStatsMessage
  | InterceptorStatsMessage
  | GetInterceptorStatsMessage
  | GetRequestLogMessage
  | ClearRequestLogMessage
  | GetProxyStatusMessage
  | ImportConfigMessage
  | GetImportPlanMessage
  | GetConfigHistoryMessage
  | RestoreConfigHistoryMessage
  | ExportConfigMessage
  | ExportHarMessage
  | ImportHarMessage
  | GetProfilesMessage
  | SaveProfileMessage
  | LoadProfileMessage
  | DeleteProfileMessage
  | GetVariablesMessage
  | SetVariablesMessage;

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
 * 一次网络层（DNR）命中采样的结果
 *
 * 三种状态必须可区分，否则 UI 会把「不知道」说成「没有」：
 * - `sampledAt === 0`：从未成功采样（或当前根本没有生效的动态规则）→ 渲染「—」
 * - `stale === true`：本次未真正调用 API，`stats` 是上一次的旧值 → 灰显 + 说明
 * - 其余：`stats` 是本次真实读数
 */
export interface DnrSample {
  stats: DnrHitStat[];
  /** 采样时刻（epoch ms）；0 = 从未成功采样 */
  sampledAt: number;
  /** 本次未真正调用 API，返回的是缓存 */
  stale: boolean;
  /** 有值 = 仅统计该标签页的命中 */
  tabId?: number;
}

/**
 * 代理状态（Popup 使用）
 */
export interface ProxyStatus {
  enabled: boolean;
  activeRuleCount: number;
  /**
   * 今日经**后台服务线程（SW fetch 通道）**处理的请求数
   *
   * 简单规则由浏览器网络层重定向、不写日志，因此这里数不到它们；popup 另有一格
   * 按标签页的网络层命中数（见 `DnrSample`）补这半边。旧名 `todayRequestCount`
   * 会被读成「今日全部请求」，是本轮可见性缺陷的源头，不再保留。
   */
  swRequestCount: number;
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
  /**
   * 导出格式的 schema 版本，与 `version`（扩展版本号）是两件事
   *
   * 导入侧「读并拒绝过新」：比本机认识的版本更新的文件会被拒，而不是半解析半丢字段。
   * 缺省即历史文件——按 v1 处理，走既有的宽松兜底，不做破坏性迁移。
   */
  schemaVersion?: number;
  exportTime: number;
  config: ProxyConfig;
}
