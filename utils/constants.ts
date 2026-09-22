import type { ProxyConfig } from '@/utils/types';

// Storage keys
export const STORAGE_KEYS = {
  PROXY_CONFIG: 'proxy_config',
  REQUEST_LOGS: 'request_logs',
  THEME: 'theme',
  THEME_MODE: 'theme_mode', // light | dark | system
  LOCALE: 'locale',
  PROFILES: 'env_profiles',
  AUTO_OFF_MINUTES: 'auto_off_minutes', // 代理自动关闭时长（分钟），0 表示不自动关闭
  VARIABLES: 'variables', // 凭据变量表（规则里以 {{名称}} 引用，真值只存这一处）
  CONFIG_HISTORY: 'config_history', // 配置恢复点（成套替换类写入前的整包快照，见 utils/storage.ts）
} as const;

// Theme modes
export const THEME_MODES = {
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system',
} as const;

export type ThemeMode = (typeof THEME_MODES)[keyof typeof THEME_MODES];

export const DEFAULT_THEME_MODE: ThemeMode = 'system';

// Default config
export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  enabled: false,
  rules: [],
};

// Limits
export const MAX_LOG_ENTRIES = 500;
export const MAX_RULES = 200;
/**
 * 单条日志正文（请求体/响应体）的字符上限，超出部分在写入前截断并留痕。
 *
 * 未设上限时，一条超大 JSON 响应（代理请求体上限本就是 10MB）就能把 `storage.local`
 * 的配额（本扩展未申请 `unlimitedStorage`，约 10MB）撑满，此后不仅日志写入失败，
 * 连配置保存也会一起失败。取 32K 字符：足以看完任何正常接口的载荷。
 */
export const MAX_LOG_BODY_SIZE = 32 * 1024;
/**
 * 正文之外那些「页面/上游可控」字段的字符上限：URL、方法、规则名、错误文案、
 * 头名与头值都走这一个阈值。
 *
 * 只裁正文等于留一堆无上限路径：页面可以用 `fetch('https://a.com/?' + 'x'.repeat(5e6))`
 * 或一条超长 Cookie 头写入日志，那些字段既不进正文上限、也不进总量预算，
 * 500 条足以同样把 `storage.local` 配额占满（后果与正文超限一致：配置也存不进去）。
 * 取 8K 字符：正常 URL 与头值远不到这个量级，因此真实流量不会被裁。
 */
export const MAX_LOG_FIELD_SIZE = 8 * 1024;
/**
 * 单条日志保留的头表条目上限（请求头、响应头各自计）
 *
 * 与 {@link MAX_LOG_FIELD_SIZE} 一起把「头表」这一项的体积钉死：正常请求头远不到 64 条，
 * 超出时留的是头表出现顺序的前 64 条、丢掉的是其后的重复/跟踪头，不影响排障。
 */
export const MAX_LOG_HEADER_COUNT = 64;
/**
 * 全部日志的字符总量预算：单条有上限不代表总量安全
 * （500 条 × 两条正文 × 32K 仍远超配额），超预算时从尾部（最旧）丢弃，
 * 与 {@link MAX_LOG_ENTRIES} 的环形缓冲方向一致。
 *
 * 计的是**一条日志里会被写入的全部字符**（正文 + URL + 头表 + 规则名等），不是只有正文：
 * 只统计正文的话，头表与 URL 就是预算之外的第二个无上限出口。
 */
export const MAX_LOG_TOTAL_SIZE = 4 * 1024 * 1024;

// 规则默认值
/**
 * 规则优先级默认值（数值越小越先匹配）。
 * 新建规则的表单与「priority 缺失/非有限数」时的归一化共用此值，避免各写一份字面量。
 * 导入的规则另用 {@link IMPORTED_RULE_PRIORITY}——不可信来源给更靠后的位次，是刻意区分。
 */
export const DEFAULT_RULE_PRIORITY = 10;
/** 导入规则缺失 priority 时的兜底值（见 messageRouter 的 normalizeImportedRules） */
export const IMPORTED_RULE_PRIORITY = 100;

// DNR rule ID prefix (to avoid conflicts with other extensions)
export const DNR_RULE_ID_PREFIX = 10000;
/**
 * DNR 动态规则 `priority` 的合法上限（Chrome 固定值，非本扩展可调）
 *
 * `updateDynamicRules` 对越界 priority 是**整批拒绝**，不是只丢一条规则：业务优先级
 * 取到足够大的负数时，`1000 - priority` 会翻过这个天花板，让所有简单规则同时停止重定向。
 * 表单侧的 1..999 永远到不了这里，会被越过的只有导入文件与手改的 storage 数据，
 * 故钳制放在 `toDnrPriority`（外部约束住在用它的那一层）。
 */
export const DNR_MAX_PRIORITY = 1_000_000;

// Message channel names
export const CONTENT_SCRIPT_CHANNEL = 'cross-origin-proxy';

// Alarm names
export const KEEPALIVE_ALARM = 'sw-keepalive';
// Chrome 120+ 允许的最小周期为 1 分钟（低于下限会被浏览器钳制并告警）
export const KEEPALIVE_INTERVAL_MINUTES = 1;
// 代理自动关闭：开启代理后倒计时到期自动关闭，防止忘记关闭代理
export const AUTO_OFF_ALARM = 'proxy-auto-off';

// ─── DNR 命中采样（entrypoints/background/dnrSampler） ───────────────────────

/** Chrome 侧 `getMatchedRules` 的配额窗口：20 次 / `GETMATCHEDRULES_QUOTA_INTERVAL`(=10) 分钟 */
export const DNR_QUOTA_WINDOW_MS = 10 * 60_000;

/** 滑窗内的调用软上限：留 2 次余量给读端突发，超限即退避而不是让 API 报错 */
export const DNR_SAMPLE_CALL_BUDGET = 18;

/** 全局聚合结果的缓存新鲜期；`getMatchedRules` 抛错后的退避时长同值 */
export const DNR_AGGREGATE_TTL_MS = 60_000;

/** 按标签页采样的缓存新鲜期（popup 打开频率高，窗口短一些以保持「近 5 分钟」的可信度） */
export const DNR_TAB_TTL_MS = 15_000;

/** 按标签页缓存的条数上限（超出按写入序丢弃最旧；不注册 tabs.onRemoved，交给上限收口） */
export const DNR_TAB_CACHE_SIZE = 5;

// ─── 拦截器活动计数（entrypoints/background/interceptorStats） ────────────────

/**
 * 按标签页存下的自报计数条数上限
 *
 * 一份就是四个数加一个时刻，成本可以忽略，所以这里比 `DNR_TAB_CACHE_SIZE` 宽松：
 * 收得太紧会把还开着的标签页挤掉，popup 于是把「有活动」显示成「还没回报」——
 * 那正是本功能要消灭的误读。`tabs.onRemoved` 负责正常回收，这个上限只是漏事件的兜底。
 */
export const INTERCEPTOR_TAB_CACHE_SIZE = 10;

// ─── 凭据变量（utils/variables.ts + storage 的 `variables` 键） ────────────────

/**
 * 变量条数上限
 *
 * 一个人真需要超过几十把密钥时，该用的不是浏览器扩展。收上限是因为这份表会被
 * 每次代理请求整表读进内存，且它和配置一样不申请 `unlimitedStorage`。
 */
export const MAX_VARIABLES = 50;
/** 变量名长度上限，与 `VARIABLE_NAME_RE` 的 1+63 对齐 */
export const MAX_VARIABLE_NAME_LENGTH = 64;
/**
 * 变量值长度上限
 *
 * 取 4096：JWT 与常见的长 bearer token 都在其内，同时钉死「一个变量塞下一整份
 * 二进制」这种把密钥表当日志用的写法。
 */
export const MAX_VARIABLE_VALUE_LENGTH = 4096;

// ─── 配置恢复点（storage 的 `config_history` 键） ─────────────────────────────

/**
 * 恢复点份数上限
 *
 * 只在「成套换掉规则集」的写入前记录（替换式导入、加载快照、批量删除、回退前自查），
 * 单条编辑不进历史——否则 200 条规则改 5 次就把真正的事故现场挤出去了。
 */
export const MAX_CONFIG_HISTORY = 5;
/**
 * 恢复点整包的字符预算（从最新一份往旧累加，放不下即丢弃其后）
 *
 * 与日志的 {@link MAX_LOG_TOTAL_SIZE} 分开定，因为这份数据的单位体积大得多：一条带 Mock 正文的
 * 规则就能有几 MB，5 份快照等于 5 份。本扩展未申请 `unlimitedStorage`，配额是共享的——
 * 恢复点吃掉配额会让用户**下一次正常的规则保存**一起失败，那比丢一个旧快照严重得多。
 * 取 1M 字符：正常 200 条规则的整包远小于它，因此五份基本都能留住。
 */
export const MAX_CONFIG_HISTORY_TOTAL_SIZE = 1024 * 1024;

/**
 * 导出格式的 schema 版本（与 `package.json` 的扩展版本号无关）
 *
 * 导出时写入 `ExportData.schemaVersion`，导入时「读并拒绝过新」：比本机认识的版本更新的文件
 * 会被明确拒掉，而不是被半解析半丢字段地写进存储。缺省按 v1 处理（历史文件没有这个字段）。
 * 每次让导出格式发生不兼容变化时才 +1，纯新增字段不必。
 */
export const SCHEMA_VERSION = 2;
