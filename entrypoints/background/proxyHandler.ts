import { findMatchingRule, matchRule, rewriteUrl, applyQueryOverrides, isRegexSafe } from '@/utils/urlMatcher';
import { filterIncomingHeaders, isValidHeaderEntry, validateRuleHeaders } from '@/utils/headerValidation';
import { getProxyConfig, addRequestLog, getRequestLogs, getVariables } from '@/utils/storage';
import { collectRuleVariableRefs, resolveVariableMap } from '@/utils/variables';
import { generateId } from '@/utils/generateId';
import { AUTO_OFF_ALARM } from '@/utils/constants';
import { logger } from '@/utils/logger';
import type {
  ProxyStatus,
  ProxyRule,
  ProxyRequestMessage,
  ProxyResponseMessage,
  RequestLogEntry,
  ResponseOverrides,
  MockCondition,
  DnrHitStat,
} from '@/utils/types';

export const MAX_BODY_SIZE = 10 * 1024 * 1024;

/** 页面取消时写进日志与失败信封的文案（与 `'Request timeout (30s)'` 同档的自由文本） */
const CANCELLED_BY_PAGE = 'Cancelled by page';

/**
 * 可被取消打断的等待：`signal` 一到就提前结束，之后由调用处的 `signal.aborted` 判定收尾。
 *
 * 没有它，配置了 `delayMs` 的请求在延迟期间收到取消仍然会睡满再出发——上游连接是省下来了，
 * 但 SW 还要多等几十秒才知道这件事。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * 判断字符串按 UTF-8 编码后是否超出请求体上限。
 *
 * 上限约束的是**实际上线的字节数**，而 `string.length` 数的是 UTF-16 码元：
 * 一段全中文的 6 MB body 实际约 18 MB，按 length 判定会放行。
 * 先按码元数做廉价早退——UTF-8 字节数恒 ≥ 码元数，码元已超限则必然越界——
 * 只有这一侧没越界时，才付 `TextEncoder` 的线性开销去精确计量。
 */
export function exceedsBodyCap(text: string): boolean {
  if (text.length > MAX_BODY_SIZE) return true;
  return new TextEncoder().encode(text).length > MAX_BODY_SIZE;
}

// ─── SW 通道命中统计 ──────────────────────────────────────────────────────────

const swHitStats = new Map<string, { ruleId: string; ruleName: string; hitCount: number }>();

export function getSwHitStats(): DnrHitStat[] {
  return Array.from(swHitStats.values())
    .map(({ ruleId, ruleName, hitCount }) => ({ ruleId, ruleName, hitCount }))
    .sort((a, b) => b.hitCount - a.hitCount);
}

export function resetSwHitStats(): void {
  swHitStats.clear();
}

function trackRuleHit(ruleId: string, ruleName: string): void {
  const existing = swHitStats.get(ruleId);
  if (existing) {
    existing.hitCount++;
  } else {
    swHitStats.set(ruleId, { ruleId, ruleName, hitCount: 1 });
  }
}

/**
 * 记录一条「请求尚未发出就被规则拒绝」的日志（非法头覆盖 / body 超限）。
 *
 * 这两类失败此前只给页面回一个信封，本地日志里查不到痕迹，用户在日志抽屉里
 * 完全看不到自己的规则被拒过。字段口径与阻断分支一致：`status: 0`、未改写地址。
 * `reason` 只进本地存储的 `error`，页面侧仍只拿到通用文案。
 */
function logRejectedRequest(
  rule: ProxyRule,
  url: string,
  method: string,
  startTime: number,
  reason: string,
): Promise<void> {
  return addRequestLog({
    id: generateId(),
    timestamp: Date.now(),
    ruleId: rule.id,
    ruleName: rule.name,
    originalUrl: url,
    proxiedUrl: url,
    method,
    status: 0,
    duration: Date.now() - startTime,
    error: reason,
    proxyType: 'sw',
  });
}

/**
 * 把「引用了不存在的变量」记到 SW 控制台
 *
 * 未定义的引用按 `{{名称}}` 字面量发出，上游多半回 401，用户在日志里看到的就是那次 401。
 * 这里补的是**原因**：缺哪个变量、由哪条规则引用——名字可以进日志，值永远不行。
 *
 * 刻意不再另写一条请求日志：那次请求是真实发生的、并且会由本函数所在的分支正常记一条，
 * 再补一条 `status: 0` 会让规则列表的失败数与命中数双双虚高。删除变量前的「被 N 条规则使用」
 * 提示（设置页）才是把这个坑填在发生之前的那道闸。
 */
function warnMissingVariables(rule: ProxyRule, missing: string[]): void {
  logger.warn(
    `Undefined variable${missing.length > 1 ? 's' : ''}: ${missing.map(name => `{{${name}}}`).join(', ')} (rule: ${rule.name})`,
  );
}

// ─── 重试判定 ─────────────────────────────────────────────────────────────────

/**
 * 判断错误是否可重试：5xx 状态码、超时（AbortError）、网络错误（TypeError）
 */
export function isRetryableError(error: unknown, status?: number): boolean {
  if (status !== undefined && status >= 500) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (error instanceof TypeError) return true;
  return false;
}

// ─── 条件 Mock 匹配 ───────────────────────────────────────────────────────────

/**
 * 判断请求是否满足单个 Mock 条件（AND 逻辑）
 *
 * `matchUrl` 与规则的匹配模式同为不可信输入（表单与导入文件都能写入），因此这里跑的是
 * `matchRule` 同一道 ReDoS 筛查：嵌套量词的条件按「不匹配」处理，落到默认 Mock 响应体，
 * 而不是让单线程的 SW 在 `test()` 上卡死。
 */
export function matchesMockCondition(url: string, method: string, condition: MockCondition): boolean {
  if (condition.matchUrl) {
    if (!isRegexSafe(condition.matchUrl)) return false;
    try {
      if (!new RegExp(condition.matchUrl).test(url)) return false;
    } catch {
      return false;
    }
  }
  if (condition.matchMethod) {
    if (method.toUpperCase() !== condition.matchMethod.toUpperCase()) return false;
  }
  if (condition.matchQuery) {
    try {
      const parsed = new URL(url);
      for (const [key, value] of Object.entries(condition.matchQuery)) {
        if (parsed.searchParams.get(key) !== value) return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

// ─── 响应覆盖 ─────────────────────────────────────────────────────────────────

/** 出现在不可信路径里会沿原型链写入的键名 */
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 按点分隔路径写入 JSON 字段。
 *
 * `bodyReplacements` 的键来自导入的配置文件（不可信输入）：`"__proto__.x"` 会让
 * `current['__proto__']` 取到 `Object.prototype`——它是对象、能通过 `typeof` 守卫——
 * 于是赋值落在原型上，污染整个 SW realm 的每一次对象读取。任一路径段命中原型链
 * 键名即整体拒绝。
 *
 * @returns 是否完成写入（拒绝时 `obj` 未被改动）
 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): boolean {
  const keys = path.split('.');
  if (keys.some(key => UNSAFE_PATH_KEYS.has(key))) return false;

  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return true;
}

/**
 * 把状态码钳制在可构造 `Response` 的合法区间（200-599）。
 *
 * 越界值会让前端构造响应失败并静默回退原生请求，覆盖因此不生效；
 * 这里按「取整 → 落到区间」收敛，非法/空值（0、NaN、负数）统一回 200。
 * 注意：落在区间内并不等于一定可构造——204/205/304 还要求正文为 null，
 * 那一半约束由桥接层 `utils/proxyResponse.ts` 的 `normalizeProxyResponse` 承担。
 */
export function clampResponseStatus(status: number): number {
  return Math.min(599, Math.max(200, Math.trunc(status) || 200));
}

function applyResponseOverrides(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  body: string,
  isBase64: boolean,
  overrides: ResponseOverrides,
): { status: number; statusText: string; headers: Record<string, string>; body: string; isBase64: boolean } {
  const result = { status, statusText, headers: { ...headers }, body, isBase64 };

  if (overrides.status !== undefined) {
    // 状态码必须在可构造 Response 的合法区间（200-599），
    // 否则前端无法构造响应会回退原生请求，覆盖静默失效
    result.status = clampResponseStatus(overrides.status);
  }
  if (overrides.statusText !== undefined) {
    result.statusText = overrides.statusText;
  }
  if (overrides.headers) {
    for (const [key, value] of Object.entries(overrides.headers)) {
      if (isValidHeaderEntry(key, value)) {
        result.headers[key] = value;
      }
    }
  }

  if (overrides.bodyRaw !== undefined) {
    result.body = overrides.bodyRaw;
    result.isBase64 = false;
  } else if (overrides.bodyReplacements && !isBase64) {
    try {
      const json = JSON.parse(body);
      for (const [path, value] of Object.entries(overrides.bodyReplacements)) {
        if (!setByPath(json, path, value)) {
          logger.warn(`Skipping unsafe bodyReplacements path: ${path}`);
        }
      }
      result.body = JSON.stringify(json);
    } catch {
      logger.warn('Response body is not valid JSON, skipping bodyReplacements');
    }
  }

  return result;
}

// ─── 代理请求主逻辑 ───────────────────────────────────────────────────────────

/**
 * 页面拦截器已选中的规则优先于 SW 侧的全量重匹配
 *
 * 桥接层只把复杂规则下发给页面（`content.ts` 的 `toInterceptorConfig`），页面按窄规则决定代理；
 * SW 此前却拿**完整**规则集重匹配，于是一条更宽、优先级更高的简单规则会把请求抢走：窄规则的
 * 头注入与 Mock 静默失效，窄规则是 `blocked` 时被阻断的请求还会真的发出去。
 *
 * 校验复用同一条 `matchRule`（存在 + enabled + 仍匹配该 url/method），任一不成立就返回 `null`
 * 回落全量重匹配：`ruleId` 来自页面、属不可信输入，伪造它拿不到别的规则的能力，规则刚被删除
 * 也只是退回修复前的行为。
 */
function resolveSelectedRule(
  ruleId: string | undefined,
  url: string,
  method: string,
  rules: ProxyRule[],
): ProxyRule | null {
  if (!ruleId) return null;
  const chosen = rules.find(rule => rule.id === ruleId && rule.enabled);
  if (!chosen) return null;
  return matchRule(url, chosen, method) ? chosen : null;
}

/** `PROXY_REQUEST` 的载荷；返回形状与 `PROXY_RESPONSE` 的 data 同形（桥接层再兜一次整形） */
type ProxyRequestPayload = ProxyRequestMessage['data'];
type ProxyResponsePayload = ProxyResponseMessage['data'];

/**
 * 在途代发请求的登记表：登记键 → 这一笔的取消控制器。
 *
 * 键必须带 tabId：`requestId` 是每个页面各自的计数器，两个标签页同时发请求就是同一个字符串，
 * 不带 tabId 等于让一个页面掐断另一个页面的代发。只存内存、请求一落定就摘除——SW 被回收时
 * 这些上游连接本来也一起没了。
 */
const inFlightRequests = new Map<string, AbortController>();

/**
 * 拼在途请求的登记键。`PROXY_REQUEST` 的登记侧与 `CANCEL_REQUEST` 的取消侧共用这一处，
 * 免得两边各拼一遍、拼歪成「取消永远打不中」。
 *
 * 两段坐标都不能省：`requestId` 是**每个 frame 自己的**拦截器从 1 数起来的计数器，
 * 只带 requestId 时一个标签页能掐断另一个标签页的代发；内容脚本注入到所有 frame 之后，
 * 同一标签页里两个 frame 的同名 requestId 会直接共用一个键——后登记的那笔把前一笔挤出
 * 登记表，于是「取消顶层这一笔」实际掐断的是子 frame 那笔。
 */
export function proxyRequestKey(
  tabId: number | undefined,
  frameId: number | undefined,
  requestId: string,
): string {
  return `${tabId ?? 'no-tab'}::${frameId ?? 'no-frame'}::${requestId}`;
}

/**
 * 取消一笔正在代发的请求：掐断上游连接，并让重试循环不再追加尝试。
 *
 * @param key - `proxyRequestKey` 拼出的登记键
 * @returns 这个键当前有没有在途请求（没有就是已落定或从未登记，两种情形都不用处理）
 */
export function cancelProxiedRequest(key: string): boolean {
  const controller = inFlightRequests.get(key);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * 代发一笔页面请求。
 *
 * @param data - `PROXY_REQUEST` 载荷
 * @param requestKey - 在途登记键（`proxyRequestKey` 拼出）；不传则这笔请求无法被页面取消，
 *   留给不经内容脚本的调用方
 */
export async function handleProxyRequest(
  data: ProxyRequestPayload,
  requestKey?: string,
): Promise<ProxyResponsePayload> {
  if (!requestKey) return runProxyRequest(data);

  const controller = new AbortController();
  inFlightRequests.set(requestKey, controller);
  try {
    return await runProxyRequest(data, controller.signal);
  } finally {
    inFlightRequests.delete(requestKey);
  }
}

async function runProxyRequest(data: ProxyRequestPayload, signal?: AbortSignal): Promise<ProxyResponsePayload> {
  const startTime = Date.now();
  const config = await getProxyConfig();

  if (!config.enabled) {
    return {
      requestId: data.requestId,
      status: 0,
      statusText: 'Proxy Bypass',
      headers: {},
      body: 'Proxy is disabled',
      isBase64: false,
    };
  }

  const rule =
    resolveSelectedRule(data.ruleId, data.url, data.method, config.rules) ??
    findMatchingRule(data.url, config.rules, data.method);
  if (!rule) {
    return {
      requestId: data.requestId,
      status: 0,
      statusText: 'Proxy Bypass',
      headers: {},
      body: 'No matching rule',
      isBase64: false,
    };
  }

  // 记录 SW 通道命中
  trackRuleHit(rule.id, rule.name);

  // ─── 请求阻断 ─────────────────────────────────────────────────────────────
  if (rule.blocked) {
    logger.info(`Blocked: ${data.url} (rule: ${rule.name})`);
    const logEntry: RequestLogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      ruleId: rule.id,
      ruleName: rule.name,
      originalUrl: data.url,
      proxiedUrl: data.url,
      method: data.method,
      status: 0,
      error: 'Request blocked by rule',
      proxyType: 'sw',
    };
    await addRequestLog(logEntry);
    return {
      requestId: data.requestId,
      status: 0,
      statusText: 'Blocked',
      headers: {},
      body: 'Request blocked by proxy rule',
      isBase64: false,
    };
  }

  // ─── Mock 响应（含条件化 Mock）─────────────────────────────────────────────
  if (rule.mockResponse) {
    let mockBody = rule.mockResponse.body;
    let mockStatus = rule.mockResponse.status ?? 200;
    let mockContentType = rule.mockResponse.contentType ?? 'application/json';

    // 条件化 Mock：首个命中的条件覆盖默认值
    if (rule.mockResponse.conditions?.length) {
      for (const condition of rule.mockResponse.conditions) {
        if (matchesMockCondition(data.url, data.method, condition)) {
          mockBody = condition.body;
          mockStatus = condition.status ?? mockStatus;
          mockContentType = condition.contentType ?? mockContentType;
          break;
        }
      }
    }

    // 状态码必须在可构造 Response 的合法区间（200-599），否则前端会回退原生请求使 Mock 失效
    mockStatus = clampResponseStatus(mockStatus);

    const mockHeaders: Record<string, string> = { 'content-type': mockContentType };
    logger.info(`Mock: ${data.url} → ${mockStatus} (rule: ${rule.name})`);

    if (rule.delayMs) {
      await new Promise(resolve => setTimeout(resolve, rule.delayMs));
    }

    const logEntry: RequestLogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      ruleId: rule.id,
      ruleName: rule.name,
      originalUrl: data.url,
      proxiedUrl: `mock://${rule.name}`,
      method: data.method,
      status: mockStatus,
      duration: Date.now() - startTime,
      proxyType: 'sw',
      responseHeaders: mockHeaders,
      responseBody: mockBody,
    };
    await addRequestLog(logEntry);

    return {
      requestId: data.requestId,
      status: mockStatus,
      statusText: 'Mock',
      headers: mockHeaders,
      body: mockBody,
      isBase64: false,
    };
  }

  // ─── 凭据变量展开（仅真实代理分支）─────────────────────────────────────────
  // 规则里的 `{{名称}}` 到这一步才换成真值：下发给页面世界的配置永远只带字面量
  // （`entrypoints/content.ts` 的 `toInterceptorConfig`），DNR 侧则由 `isSimpleRule` 保证
  // 引用只出现在 header/query 覆盖上，而这两项本身就强制走 SW。
  // 只在规则自身配置的位点上展开，**绝不在整条 URL 上展开**：wildcard 捕获到的片段来自
  // 页面，页面就能借一次重写把某个变量的值送进自己可读的响应里。
  const variables = collectRuleVariableRefs(rule).length > 0 ? await getVariables() : {};

  const rewrittenUrl = rewriteUrl(data.url, rule);
  const resolvedQuery = resolveVariableMap(rule.queryOverrides, variables);
  if (resolvedQuery?.missing.length) warnMissingVariables(rule, resolvedQuery.missing);

  // 先算未展开形态再算出站形态：`{{名称}}` 字面量留在日志与回显里，真值只进 `fetch`。
  // 查询参数位点上放的常常正是 token，落进 `request_logs` 就违背了「日志不含真实凭据」。
  const loggedUrl = applyQueryOverrides(rewrittenUrl, rule.queryOverrides);
  const targetUrl = resolvedQuery ? applyQueryOverrides(rewrittenUrl, resolvedQuery.resolved) : loggedUrl;
  logger.info(`Proxying: ${data.url} → ${loggedUrl}`);

  // ─── 准备请求参数（重试循环外，避免重复计算）────────────────────────────────
  // 传入头宽容过滤（跳过个别非法条目）；规则头严格校验（非法则拒绝并提示修正）
  const sanitizedIncoming = filterIncomingHeaders(data.headers);

  const headerCheck = rule.headerOverrides ? validateRuleHeaders(rule.headerOverrides) : null;
  if (headerCheck?.invalidKey !== undefined) {
    // 头名只进本地日志与 SW 控制台；页面侧维持原有的通用文案，契约不变
    const reason = `Rule header override rejected: "${headerCheck.invalidKey}"`;
    logger.warn(`${reason} (rule: ${rule.name})`);
    await logRejectedRequest(rule, data.url, data.method, startTime, reason);
    return {
      requestId: data.requestId,
      status: 0,
      statusText: 'Invalid Rule Headers',
      headers: {},
      body: 'Rule contains invalid header override',
      isBase64: false,
    };
  }

  // 展开后再严格复查一遍：`{{TOKEN}}` 字面量合法不代表它换出来的真值合法（手改存储、
  // 旧导入数据都可能带换行），漏过去就是一次头注入；复查不过沿用同一套整体拒绝语义
  const resolvedHeaders = resolveVariableMap(headerCheck?.headers, variables);
  if (resolvedHeaders?.missing.length) warnMissingVariables(rule, resolvedHeaders.missing);
  const expandedCheck = resolvedHeaders ? validateRuleHeaders(resolvedHeaders.resolved) : null;
  if (expandedCheck?.invalidKey !== undefined) {
    const reason = `Rule header override rejected after variable expansion: "${expandedCheck.invalidKey}"`;
    logger.warn(`${reason} (rule: ${rule.name})`);
    await logRejectedRequest(rule, data.url, data.method, startTime, reason);
    return {
      requestId: data.requestId,
      status: 0,
      statusText: 'Invalid Rule Headers',
      headers: {},
      body: 'Rule contains invalid header override',
      isBase64: false,
    };
  }

  const sanitizedOverrides = expandedCheck?.headers ?? {};

  const fetchOptions: RequestInit = {
    method: data.method,
    headers: {
      ...sanitizedIncoming,
      ...sanitizedOverrides,
    },
  };

  // 携带凭据是规则级显式 opted-in 的能力：SW 以 chrome-extension:// 发起请求，默认的
  // 'same-origin' 对跨源目标一律不带 Cookie，需要会话的后端因此始终 401。
  // 不开启时这行完全不执行，出站请求与改动前逐字节一致。
  // 严格等于 true 与 isSimpleRule 同判据，避免导入文件里的真值字符串单边生效。
  if (rule.sendCredentials === true) {
    fetchOptions.credentials = 'include';
  }

  // GET/HEAD 不可携带 body（fetch 会直接抛 TypeError 使代理失败）；
  // method 可能是页面传入的原始小写形式，比较前需归一化
  const method = data.method.toUpperCase();
  const canHaveBody = method !== 'GET' && method !== 'HEAD';

  // 最终真正发出的 body：规则覆盖优先于页面传入；GET/HEAD 一律不带
  let outgoingBody: string | undefined;
  if (canHaveBody) {
    outgoingBody = rule.requestBodyOverride !== undefined ? rule.requestBodyOverride : data.body || undefined;
  }

  if (outgoingBody !== undefined) {
    // 上限量的是这份最终 body 的 UTF-8 字节数：此前按码元数判定会低估非 ASCII body，
    // 且在规则覆盖 body 之前就算完，等于规则侧可绕过上限
    if (exceedsBodyCap(outgoingBody)) {
      const reason = `Request body exceeds ${MAX_BODY_SIZE} bytes`;
      logger.warn(`${reason} (rule: ${rule.name})`);
      await logRejectedRequest(rule, data.url, data.method, startTime, reason);
      return {
        requestId: data.requestId,
        status: 0,
        statusText: 'Body Too Large',
        headers: {},
        body: reason,
        isBase64: false,
      };
    }
    fetchOptions.body = outgoingBody;
  }

  if (rule.delayMs) {
    await sleep(rule.delayMs, signal);
  }

  // ─── 重试循环 ─────────────────────────────────────────────────────────────
  const maxRetries = rule.retryCount ?? 0;
  const retryDelay = rule.retryDelay ?? 1000;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 页面已经取消（含在 delayMs 期间取消）：不再追加尝试，也不在最后一刻打开新连接
    if (signal?.aborted) {
      lastError = CANCELLED_BY_PAGE;
      break;
    }
    if (attempt > 0) {
      logger.info(`Retry ${attempt}/${maxRetries}: ${data.url} (rule: ${rule.name})`);
      await sleep(retryDelay, signal);
    }

    const controller = new AbortController();
    // 截止时间要覆盖到 body 读满，所以 clearTimeout 只能放在 finally：
    // 一旦在拿到响应头之后就撤掉，`text/event-stream` 这类不结束的流就再没有超时——
    // 上游连接一直握到 SW 被回收，而日志是在 body 读满之后才落的，这条请求连一笔账都不留。
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    // 页面取消走同一个 abort 入口：连接阶段掐 fetch，读取阶段掐 body
    const abortForPage = () => controller.abort();
    signal?.addEventListener('abort', abortForPage, { once: true });

    try {
      const response = await fetch(targetUrl, {
        ...fetchOptions,
        signal: controller.signal,
      });

      // 5xx 且还有重试次数：重试
      if (response.status >= 500 && attempt < maxRetries) {
        lastError = `Server error ${response.status}`;
        continue;
      }

      // Read response
      const contentType = response.headers.get('content-type') || '';
      let responseBody: string;
      let isBase64 = false;

      if (contentType.includes('application/json') || contentType.includes('text/')) {
        responseBody = await response.text();
      } else {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const CHUNK_SIZE = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
        }
        responseBody = btoa(binary);
        isBase64 = true;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let finalStatus = response.status;
      let finalStatusText = response.statusText;
      let finalHeaders = responseHeaders;
      let finalBody = responseBody;
      let finalIsBase64 = isBase64;

      if (rule.responseOverrides) {
        const overridden = applyResponseOverrides(
          finalStatus,
          finalStatusText,
          finalHeaders,
          finalBody,
          finalIsBase64,
          rule.responseOverrides,
        );
        finalStatus = overridden.status;
        finalStatusText = overridden.statusText;
        finalHeaders = overridden.headers;
        finalBody = overridden.body;
        finalIsBase64 = overridden.isBase64;
      }

      const logEntry: RequestLogEntry = {
        id: generateId(),
        timestamp: Date.now(),
        ruleId: rule.id,
        ruleName: rule.name,
        originalUrl: data.url,
        proxiedUrl: loggedUrl,
        method: data.method,
        status: finalStatus,
        duration: Date.now() - startTime,
        proxyType: 'sw',
        requestHeaders: sanitizedIncoming,
        requestBody: typeof fetchOptions.body === 'string' ? fetchOptions.body : undefined,
        responseHeaders: finalHeaders,
        responseBody: finalIsBase64 ? undefined : finalBody,
        responseIsBase64: finalIsBase64 || undefined,
      };
      await addRequestLog(logEntry);

      return {
        requestId: data.requestId,
        status: finalStatus,
        statusText: finalStatusText,
        headers: finalHeaders,
        body: finalBody,
        isBase64: finalIsBase64,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      lastError = isTimeout ? 'Request timeout (30s)' : errorMessage;

      // 取消与超时同为 AbortError，但只有前者该立刻收口：页面已经不想要这份响应，
      // 按可重试失败处理等于替它把凭据再往外发几次。
      if (signal?.aborted) {
        lastError = CANCELLED_BY_PAGE;
        break;
      }

      if (isRetryableError(error) && attempt < maxRetries) {
        continue;
      }
      break;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortForPage);
    }
  }

  // 所有重试耗尽
  if (lastError === CANCELLED_BY_PAGE) {
    logger.info(`Proxy request cancelled by page: ${data.url} (rule: ${rule.name})`);
  } else {
    logger.error('Proxy request failed after retries:', lastError);
  }

  const logEntry: RequestLogEntry = {
    id: generateId(),
    timestamp: Date.now(),
    ruleId: rule.id,
    ruleName: rule.name,
    originalUrl: data.url,
    proxiedUrl: loggedUrl,
    method: data.method,
    duration: Date.now() - startTime,
    error: lastError,
    proxyType: 'sw',
  };
  await addRequestLog(logEntry);

  return {
    requestId: data.requestId,
    status: 0,
    statusText: 'Proxy Error',
    headers: {},
    body: lastError ?? 'Unknown error',
    isBase64: false,
  };
}

// ─── 代理状态 ─────────────────────────────────────────────────────────────────

export async function getProxyStatus(): Promise<ProxyStatus> {
  const config = await getProxyConfig();
  const logs = await getRequestLogs();

  const todayTimestamp = new Date();
  todayTimestamp.setHours(0, 0, 0, 0);
  const todayTs = todayTimestamp.getTime();

  let swRequestCount = 0;
  // 日志按批刷写（批间新到旧、批内旧到新），整体并非严格降序，须全量遍历
  for (const l of logs) {
    if (l.timestamp >= todayTs) swRequestCount++;
  }

  // 代理关闭时倒计时已被清除，无需查询
  let autoOffAt: number | undefined;
  if (config.enabled) {
    const alarm = await chrome.alarms.get(AUTO_OFF_ALARM);
    autoOffAt = alarm?.scheduledTime;
  }

  return {
    enabled: config.enabled,
    activeRuleCount: config.rules.filter(r => r.enabled).length,
    swRequestCount,
    recentLogs: logs.slice(0, 10),
    rules: config.rules.map(r => ({ id: r.id, name: r.name, enabled: r.enabled })),
    autoOffAt,
  };
}
