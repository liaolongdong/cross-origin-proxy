import { DEFAULT_RULE_PRIORITY } from '@/utils/constants';
import type { ProxyRule } from '@/utils/types';

// ─── WebSocket / Method / Query helpers ────────────────────────────────────────

/**
 * 归一化业务优先级：`undefined`/`NaN`/非数字（导入的不可信配置、被清空的输入框）
 * 统一回落为默认值。
 *
 * 不归一化会让 `1000 - priority` 得到 `NaN`，进而使整批 `updateDynamicRules`
 * 被 Chrome 拒绝（所有简单规则同时停止重定向），并让排序比较器返回 `NaN`
 * 导致命中顺序不确定。
 */
export function normalizePriority(priority: number): number {
  return Number.isFinite(priority) ? priority : DEFAULT_RULE_PRIORITY;
}

const WS_SCHEME_RE = /wss?:\/\//i;

/**
 * 判断规则是否为 WebSocket 相关（匹配模式或目标含 ws:// / wss://）。
 *
 * WebSocket 连接只能由 MAIN-world 拦截器代理（DNR 资源类型不含 websocket），
 * 因此此类规则不得判为“简单规则”。UI 徽标与双世界分流判定共用此函数。
 */
export function isWebSocketRule(rule: Pick<ProxyRule, 'matchPattern' | 'targetUrl'>): boolean {
  return WS_SCHEME_RE.test(rule.matchPattern) || WS_SCHEME_RE.test(rule.targetUrl);
}

/**
 * 规则的 HTTP 方法白名单是否放行给定方法。
 * 未配置 methods（或为空）时放行任意方法；配置后仅放行列表内方法（大小写不敏感）。
 * 无方法信息（method 为 undefined，如命中测试）时不因方法维度收窄。
 */
function methodAllowed(rule: ProxyRule, method?: string): boolean {
  if (!rule.methods || rule.methods.length === 0) return true;
  if (!method) return true;
  const upper = method.toUpperCase();
  return rule.methods.some(m => m.toUpperCase() === upper);
}

/**
 * 对绝对 URL 追加/覆盖查询参数。
 *
 * 覆盖语义：同名参数（含重复项）合并为一条新值，不存在则追加到末尾。
 * URL 非法时原样返回（防御不可信的 targetUrl，如 regex 重写产出的非绝对地址）。
 *
 * 只用 `URL` 做合法性校验，改写本身在原始 query 串上定点增删：
 * `new URL().searchParams.set()` 会对**所有**参数重新编解码，把
 * `?redirect=https://y.com?a=1` 变成 `?redirect=https%3A%2F%2Fy.com%3Fa%3D1`，
 * 从而破坏依赖原文比对的签名参数与回调地址白名单。
 */
export function applyQueryOverrides(url: string, overrides?: Record<string, string>): string {
  if (!overrides) return url;
  const entries = Object.entries(overrides);
  if (entries.length === 0) return url;

  try {
    new URL(url);
  } catch {
    return url;
  }

  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = beforeHash.indexOf('?');
  const base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  let pairs =
    queryAt >= 0
      ? beforeHash
          .slice(queryAt + 1)
          .split('&')
          .filter(p => p !== '')
      : [];

  for (const [key, value] of entries) {
    const injected = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    let written = false;
    pairs = pairs.reduce<string[]>((acc, pair) => {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      if (name === key || safeDecode(name) === key) {
        if (!written) {
          acc.push(injected);
          written = true;
        }
        return acc;
      }
      acc.push(pair);
      return acc;
    }, []);
    if (!written) pairs.push(injected);
  }

  return pairs.length > 0 ? `${base}?${pairs.join('&')}${hash}` : `${base}${hash}`;
}

/** 解码失败（原文含裸 `%`）时退回原值，保证不抛错 */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// ─── Matcher Cache ────────────────────────────────────────────────────────────

const MAX_REGEX_CACHE = 500;

let cachedRules: ProxyRule[] = [];
let cachedRulesKey = '';
const compiledRegexCache = new Map<string, RegExp>();

/**
 * 使匹配器缓存失效（配置变更时调用）
 */
export function invalidateMatcherCache(): void {
  cachedRules = [];
  cachedRulesKey = '';
  compiledRegexCache.clear();
}

function setCacheEntry(key: string, value: RegExp): void {
  if (compiledRegexCache.size >= MAX_REGEX_CACHE && !compiledRegexCache.has(key)) {
    const oldest = compiledRegexCache.keys().next().value;
    if (oldest !== undefined) compiledRegexCache.delete(oldest);
  }
  compiledRegexCache.set(key, value);
}

/**
 * 将 wildcard 模式转换为正则表达式（带缓存）
 * 支持 * 通配符，如 "https://fat-api.example.com/*"
 */
function wildcardToRegex(pattern: string): RegExp {
  const cacheKey = `wildcard:${pattern}`;
  const cached = compiledRegexCache.get(cacheKey);
  if (cached) return cached;

  // 转义正则特殊字符，然后将 * 替换为 .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  setCacheEntry(cacheKey, regex);
  return regex;
}

/**
 * 检测可能导致灾难性回溯的嵌套量词（ReDoS）
 */
function isRegexSafe(pattern: string): boolean {
  const dangerousPatterns = [
    /\([^)]*[+*][^)]*\)[+*]/, // (a+)+ or (a*)+ 等
    /\([^)]*[+*][^)]*\)\{/, // (a+){n} 等
    /(\+|\*)\1/, // ++ 或 **
  ];
  return !dangerousPatterns.some(p => p.test(pattern));
}

/**
 * 获取/缓存编译后的 RegExp（用于 regex 类型规则）
 */
function getCompiledRegex(pattern: string): RegExp | null {
  const cacheKey = `regex:${pattern}`;
  const cached = compiledRegexCache.get(cacheKey);
  if (cached) return cached;

  // 检查 ReDoS 风险
  if (!isRegexSafe(pattern)) {
    return null;
  }

  try {
    const regex = new RegExp(pattern);
    setCacheEntry(cacheKey, regex);
    return regex;
  } catch {
    return null;
  }
}

/**
 * 检查 URL 是否匹配规则（可选按 HTTP 方法白名单收窄）
 */
export function matchRule(url: string, rule: ProxyRule, method?: string): boolean {
  if (!rule.enabled) return false;
  if (!methodAllowed(rule, method)) return false;

  switch (rule.matchType) {
    case 'wildcard': {
      const regex = wildcardToRegex(rule.matchPattern);
      return regex.test(url);
    }
    case 'prefix':
      return url.startsWith(rule.matchPattern);
    case 'regex': {
      const regex = getCompiledRegex(rule.matchPattern);
      if (!regex) return false;
      return regex.test(url);
    }
    default:
      return false;
  }
}

/**
 * 提取 wildcard 模式末尾 * 匹配到的内容（带缓存）
 *
 * 将模式转为正则：末尾 * 变为捕获组 (.*)，其余 * 变为 .*，整串锚定。
 * 多 * 模式（如 "*://*.example.com/*"）无法用 startsWith 判断，必须正则捕获，
 * 否则 SW 通道重写失效，与 DNR 通道（引用最后一个捕获组）行为不一致。
 * 模式不以 * 结尾时重写语义不明确，返回 null 表示不重写。
 */
function wildcardTailRegex(pattern: string): RegExp | null {
  if (!pattern.endsWith('*')) return null;
  const cacheKey = `wildcard-tail:${pattern}`;
  const cached = compiledRegexCache.get(cacheKey);
  if (cached) return cached;

  const base = pattern.slice(0, -1);
  const escaped = base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  let regex: RegExp;
  try {
    regex = new RegExp(`^${escaped}(.*)$`);
  } catch {
    return null;
  }
  setCacheEntry(cacheKey, regex);
  return regex;
}

/**
 * 根据匹配规则重写 URL
 */
export function rewriteUrl(url: string, rule: ProxyRule): string {
  // 空目标表示不改写地址（如仅注入请求头的规则），直接代理原 URL
  if (!rule.targetUrl) return url;
  switch (rule.matchType) {
    case 'wildcard': {
      // 提取模式末尾 * 匹配到的部分，拼接到 targetUrl 后
      const regex = wildcardTailRegex(rule.matchPattern);
      if (!regex) return url;
      const matched = regex.exec(url);
      if (!matched) return url;
      const rest = matched[1];
      const patternBase = rule.matchPattern.slice(0, -1);
      // targetUrl 去掉末尾的 /；若 patternBase 以 / 结尾，需补回分隔斜杠，
      // 否则 "https://a.com/*" 会拼出 "https://b.comapi/x" 这样的坏 URL
      // 已知差异：rest 为空时 DNR 的静态模板仍会补斜杠（这里返回 "https://b.com"，
      // DNR 返回 "https://b.com/"）。两者指向同一资源，故不为此改变本通道的输出。
      const target = rule.targetUrl.replace(/\/$/, '');
      const separator = patternBase.endsWith('/') && rest ? '/' : '';
      return target + separator + rest;
    }
    case 'prefix': {
      if (url.startsWith(rule.matchPattern)) {
        const rest = url.slice(rule.matchPattern.length);
        // 与 wildcard 分支同源：模式以 / 结尾时斜杠已被消耗，需补回分隔符，
        // 否则拼出 "https://uat.com/v2users"（DNR 侧 buildRegexSubstitution 同步修正）
        const target = rule.targetUrl.replace(/\/$/, '');
        const separator = rule.matchPattern.endsWith('/') ? '/' : '';
        return target + separator + rest;
      }
      return url;
    }
    case 'regex': {
      const regex = getCompiledRegex(rule.matchPattern);
      if (!regex) return url;
      return url.replace(regex, rule.targetUrl);
    }
    default:
      return url;
  }
}

/**
 * 生成规则集的缓存 key（基于长度 + 各规则 id+updatedAt 的快速指纹）
 */
function buildRulesKey(rules: ProxyRule[]): string {
  return `${rules.length}:${rules.map(r => `${r.id}:${r.updatedAt ?? 0}`).join(',')}`;
}

/**
 * 查找第一个匹配的已启用规则（按优先级排序，结果缓存）
 * @param method 可选 HTTP 方法；传入时按规则的 methods 白名单收窄匹配
 */
export function findMatchingRule(url: string, rules: ProxyRule[], method?: string): ProxyRule | null {
  const rulesKey = buildRulesKey(rules);

  let sorted: ProxyRule[];
  if (rulesKey === cachedRulesKey && cachedRules.length > 0) {
    sorted = cachedRules;
  } else {
    sorted = [...rules]
      .filter(r => r.enabled)
      .sort((a, b) => normalizePriority(a.priority) - normalizePriority(b.priority));
    cachedRules = sorted;
    cachedRulesKey = rulesKey;
  }

  for (const rule of sorted) {
    if (matchRule(url, rule, method)) {
      return rule;
    }
  }
  return null;
}

/**
 * 判断是否为简单规则（无任何 SW 通道专属功能，可使用 DNR）
 */
export function isSimpleRule(rule: ProxyRule): boolean {
  // 空目标表示不改写地址（仅代理转发/注入请求头），DNR 的 regexSubstitution
  // 无法表达该语义（空/相对替换是非法值，会导致 updateDynamicRules 整批失败），必须走 SW 通道
  if (!rule.targetUrl) return false;
  if (rule.headerOverrides && Object.keys(rule.headerOverrides).length > 0) return false;
  if (rule.requestBodyOverride !== undefined) return false;
  if (rule.responseOverrides) return false;
  if (rule.mockResponse) return false;
  if (rule.delayMs) return false;
  if (rule.blocked) return false;
  if (rule.retryCount) return false;
  // WebSocket 规则：DNR 资源类型不含 websocket，只能由拦截器代理，强制走 SW 通道
  if (isWebSocketRule(rule)) return false;
  // 方法过滤：DNR condition 不支持按 HTTP 方法筛选，只能由 SW/拦截器实现
  if (rule.methods && rule.methods.length > 0) return false;
  // 查询参数注入：由 SW 在重写后统一处理，不走 DNR regexSubstitution
  if (rule.queryOverrides && Object.keys(rule.queryOverrides).length > 0) return false;
  // 不以 * 结尾的 wildcard：DNR 的 regexSubstitution 只能引用捕获组，
  // 会丢失模式末尾的固定文本（如 "a.com/*/x" 的 "/x"）产生错误重定向，
  // 改走 SW 通道（重写语义为不改写地址，仅代理转发）
  if (rule.matchType === 'wildcard' && !rule.matchPattern.endsWith('*')) return false;
  return true;
}
