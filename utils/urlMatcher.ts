import type { ProxyRule } from '@/utils/types';

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
 * 检查 URL 是否匹配规则
 */
export function matchRule(url: string, rule: ProxyRule): boolean {
  if (!rule.enabled) return false;

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
      const target = rule.targetUrl.replace(/\/$/, '');
      const separator = patternBase.endsWith('/') && rest ? '/' : '';
      return target + separator + rest;
    }
    case 'prefix': {
      if (url.startsWith(rule.matchPattern)) {
        const rest = url.slice(rule.matchPattern.length);
        const target = rule.targetUrl.replace(/\/$/, '');
        return target + rest;
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
 */
export function findMatchingRule(url: string, rules: ProxyRule[]): ProxyRule | null {
  const rulesKey = buildRulesKey(rules);

  let sorted: ProxyRule[];
  if (rulesKey === cachedRulesKey && cachedRules.length > 0) {
    sorted = cachedRules;
  } else {
    sorted = [...rules].filter(r => r.enabled).sort((a, b) => a.priority - b.priority);
    cachedRules = sorted;
    cachedRulesKey = rulesKey;
  }

  for (const rule of sorted) {
    if (matchRule(url, rule)) {
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
  // 不以 * 结尾的 wildcard：DNR 的 regexSubstitution 只能引用捕获组，
  // 会丢失模式末尾的固定文本（如 "a.com/*/x" 的 "/x"）产生错误重定向，
  // 改走 SW 通道（重写语义为不改写地址，仅代理转发）
  if (rule.matchType === 'wildcard' && !rule.matchPattern.endsWith('*')) return false;
  return true;
}
