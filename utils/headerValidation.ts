/**
 * 请求/响应头校验（防头注入的单一事实源）
 *
 * 原先住在 `entrypoints/background/proxyHandler.ts`，但保存侧（规则表单、cURL 导入）
 * 需要在 UI 里复用同一套判据——从后台入口导入会把整个 SW 代理实现拉进 options 首屏。
 * 因此纯函数下沉到这里，后台与界面共用，避免两侧规则集漂移。
 */

/** RFC 7230 token 字符集：头名只允许这些字符，空格/冒号/中文一律拒绝 */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;

/** 单个头条目是否合法：头名符合 RFC 7230 token 字符集，且值不含 CR/LF（防头注入） */
export function isValidHeaderEntry(key: string, value: string): boolean {
  return HEADER_NAME_RE.test(key) && !/[\r\n]/.test(value);
}

/**
 * 过滤页面传入的请求头：跳过非法条目（非法名称或含换行的值），
 * 避免个别脏头部导致整个代理请求被拒绝
 */
export function filterIncomingHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && isValidHeaderEntry(key, value)) {
      result[key] = value;
    }
  }
  return result;
}

/** `validateRuleHeaders` 的结果：`invalidKey` 非空表示整体拒绝，此时 `headers` 为空 */
export interface RuleHeaderCheck {
  headers: Record<string, string>;
  invalidKey?: string;
}

/**
 * 校验规则配置的请求头覆盖：任一非法即整体拒绝，
 * 规则由用户直接编辑，应报错促其修正而非静默丢弃。
 *
 * 返回被拒的**头名**而不只是 null，好让请求日志能指出该去改哪一条；
 * 头值不进日志——那里存的很可能就是凭据本身。
 */
export function validateRuleHeaders(headers: Record<string, string>): RuleHeaderCheck {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || !isValidHeaderEntry(key, value)) {
      return { headers: {}, invalidKey: key };
    }
    result[key] = value;
  }
  return { headers: result };
}

/**
 * 找出非法的头条目并返回其头名（去空白后），供保存侧一次性列给用户。
 *
 * 空名行由调用方按"未填即忽略"处理，这里只筛出真正会被写入存储的非法项；
 * 头名而非头值出现在返回值里，避免把可能是凭据的取值带回 UI 提示。
 */
export function findInvalidHeaderNames(pairs: { key: string; value: string }[]): string[] {
  return pairs
    .map(pair => ({ key: pair.key.trim(), value: pair.value }))
    .filter(pair => pair.key !== '' && !isValidHeaderEntry(pair.key, pair.value))
    .map(pair => pair.key);
}

/**
 * 清洗导入文件里的 `headerOverrides`：结构不对（非纯对象）整体丢弃，
 * 条目非法（头名越出 token 字符集、值含换行、值非字符串）逐条丢弃。
 *
 * 与运行时 `validateRuleHeaders` 的严格整体拒绝相反：导入是不可信、且不会逐条回显给用户
 * 编辑的输入，静默丢掉个别脏头，好过让整条规则在请求时被拒（页面拿到 status 0）。
 *
 * @returns 清洗后的头映射；无有效条目时返回 `undefined`，保持「未配置」而不是空对象
 */
export function sanitizeImportedHeaderMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && isValidHeaderEntry(key, entry)) {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
