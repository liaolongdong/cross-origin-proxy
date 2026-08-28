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
 * 获取/缓存编译后的 RegExp（用于 regex 类型规则）
 */
function getCompiledRegex(pattern: string): RegExp | null {
  const cacheKey = `regex:${pattern}`;
  const cached = compiledRegexCache.get(cacheKey);
  if (cached) return cached;

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
 * 根据匹配规则重写 URL
 */
export function rewriteUrl(url: string, rule: ProxyRule): string {
  switch (rule.matchType) {
    case 'wildcard': {
      // 将 matchPattern 中末尾 * 匹配到的部分拼接到 targetUrl 后
      const patternBase = rule.matchPattern.replace(/\*$/, ''); // 去掉末尾的 *
      if (url.startsWith(patternBase)) {
        const rest = url.slice(patternBase.length);
        // targetUrl 去掉末尾的 /；若 patternBase 以 / 结尾，需补回分隔斜杠，
        // 否则 "https://a.com/*" 会拼出 "https://b.comapi/x" 这样的坏 URL
        const target = rule.targetUrl.replace(/\/$/, '');
        const separator = patternBase.endsWith('/') && rest ? '/' : '';
        return target + separator + rest;
      }
      return url;
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
  if (rule.headerOverrides && Object.keys(rule.headerOverrides).length > 0) return false;
  if (rule.requestBodyOverride !== undefined) return false;
  if (rule.responseOverrides) return false;
  if (rule.mockResponse) return false;
  if (rule.delayMs) return false;
  if (rule.blocked) return false;
  return true;
}
