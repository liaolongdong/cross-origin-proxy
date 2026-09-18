/**
 * 代理响应整形（纯函数模块，便于单元测试）
 *
 * 后台 `respondAsync` 在 Promise reject 时回的是 `{ success: false, error }`——
 * 既没有 `requestId` 也没有 `status`。这份载荷经 `content.ts` 原样转成
 * `PROXY_RESPONSE` 后有两个后果：
 *
 * 1. 拦截器按 `requestId` 兑现挂起请求，id 缺失 ⇒ 无人认领 ⇒ 页面挂到
 *    `computeProxyTimeout`（默认 35s）才失败，且失败后会**回退原生 fetch**，
 *    等于把本该被代理/阻断的请求真的发出去；
 * 2. 若载荷带了 `requestId` 却没带 `status`，`new Response(body, { status: undefined })`
 *    会静默变成 **HTTP 200**，页面把后台故障当成一次成功的空响应。
 *
 * 桥接层是这条边界上唯一能同时拿到「原始 requestId」和「后台回包」的地方，
 * 因此在这里整形；`entrypoints/main-interceptor.content.ts` 的区间守卫作为
 * 第二层防御（MAIN world 自包含，无法 import 本模块）。
 */

/** 桥接层发往 MAIN world 的代理响应载荷（与 `ProxyResponseMessage['data']` 同构） */
export interface ProxyResponsePayload {
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** null 表示「无正文」，只出现在 `isNullBodyStatus` 命中的状态码上 */
  body: string | null;
  isBase64: boolean;
  [key: string]: unknown;
}

/** 只接受字符串值，否则整个 headers 退回空对象（不可信回包不做逐项清洗） */
function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')
    ? (value as Record<string, string>)
    : {};
}

/**
 * Fetch 规范的「null body 状态」：这些状态码只能配 null 正文，
 * 空串同样非法（`new Response('', { status: 204 })` 直接抛 TypeError）。
 */
export function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

/**
 * 收敛为 ByteString 可承载的文本：`ResponseInit.statusText` 是 ByteString，
 * 码点大于 255 的字符（如中文状态描述）会让构造调用抛 TypeError。
 *
 * CR/LF 同样要剔除：规范要求状态描述不含换行，带 `\r\n` 的响应行经 hand-crafted
 * `statusText` 传进来时同样抛 TypeError——抛出点在拦截器的 resolve 回调里，
 * 超时已被摘掉，页面从此永久 pending。
 */
export function toLatin1StatusText(statusText: string): string {
  let result = '';
  for (const char of statusText) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0xff && code !== 0x0a && code !== 0x0d) result += char;
  }
  return result;
}

/**
 * 把后台回包整形成「一定能让拦截器兑现对应挂起请求」的载荷。
 *
 * 合法回包原样透传（仅补齐类型）；缺字段时逐项回落，其中 `status` 缺失回落为
 * `0`——交给拦截器的区间守卫判失败，本模块不重复决定合法状态码区间。
 *
 * 两处形状约束由本模块承担（`entrypoints/main-interceptor.content.ts` 镜像同一语义）：
 * - `204/205/304` 是「null body 状态」，配任何非 null 正文都会让
 *   `new Response(body, { status })` 抛 TypeError，而抛出点在拦截器的 resolve
 *   回调里——既不会 reject 也已被 `clearTimeout` 摘掉超时，页面从此永久 pending；
 * - `statusText` 走 ByteString：含码点 > 255 的字符（如中文状态描述）或 CR/LF 同样抛 TypeError。
 * @param raw 后台 `sendResponse` 的原始值，可能是失败信封或 `undefined`
 * @param requestId 桥接层持有的原始请求 id，用于失败信封无人认领的情况
 */
export function normalizeProxyResponse(raw: unknown, requestId: string): ProxyResponsePayload {
  const payload: Record<string, unknown> = raw && typeof raw === 'object' ? { ...raw } : {};

  const status = typeof payload.status === 'number' ? payload.status : 0;
  const rawBody = typeof payload.body === 'string' ? payload.body : '';

  return {
    ...payload,
    requestId: typeof payload.requestId === 'string' ? payload.requestId : requestId,
    status,
    statusText: toLatin1StatusText(typeof payload.statusText === 'string' ? payload.statusText : 'Proxy Error'),
    headers: toStringRecord(payload.headers),
    // 失败信封的 error 文案不外泄给页面（它跑在 MAIN world，同源脚本可读），
    // 拦截器会退回 statusText 作为错误信息
    body: isNullBodyStatus(status) ? null : rawBody,
    isBase64: payload.isBase64 === true,
  };
}
