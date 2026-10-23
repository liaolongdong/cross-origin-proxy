import { DEFAULT_RULE_PRIORITY } from '@/utils/constants';
import { isTruncatedForLog } from '@/utils/formatters';
import type { ProxyRule, RequestLogEntry } from '@/utils/types';

/**
 * 把一条被记录下来的响应折成 Mock 规则草稿
 *
 * 这一层是那道「从日志到 mock」的唯一判据出口：界面只负责按 `reason` 挑一句 i18n 文案，
 * 于是「为什么这一笔不能变成 Mock」在全仓只有一份答案——与 `utils/dnrSample.ts`、
 * `utils/interceptorStats.ts` 同族的做法。
 *
 * 五档直接拒绝，都是「给了也会交付一份坏响应」：
 * - 没有正文（失败、被阻断，或那笔走的是网络层，扩展压根没读到）；
 * - 没有状态码（读不出状态就构造不出合法 `Response`；404/500 是**有用**的 mock，只拒「没有」）；
 * - 二进制（`responseIsBase64` 的正文存成文本 mock，返回的是 base64 串配原 content-type）；
 * - 正文被截断过——判据与产出方同源（`isTruncatedForLog`）。这与代理侧「绝不截断返回」
 *   是同一条取舍：半截 JSON 只是把报错挪进页面的 `JSON.parse`，不该由我们从另一头塞回去；
 * - URL 或协议读不出（这一条不能借用 `noBody` 的话，那句会说错事）。
 *
 * 命中范围用 `prefix` 掐到 path：查询参数不参与匹配，`matchType` 里没有 `exact` 这一档，
 * 而界面必须把这件事说出来（`mockFromLogQueryNote`）。
 * 草稿一律 `enabled: false`，与 HAR 那条「填了目标才启用」方向相反：后果不对称——改写规则坏了
 * 用户看到请求失败，mock 一生效页面拿到的是看着正常的假数据，用户会去查后端。
 */

/** 为什么这一笔不能变成 Mock——界面按它挑文案，绝不进任何回包的 `error` 字段（那会被 `ElMessage.error` 原样画出来） */
export type MockDraftRefusal = 'noBody' | 'noStatus' | 'base64' | 'truncated' | 'badUrl';

/** 成功时交出的草稿形状与规则表单的 `initialData` 完全一致，因此复用「派生 → 表单确认 → 保存」那条既有路径 */
export type MockDraftResult =
  { ok: true; draft: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'> } | { ok: false; reason: MockDraftRefusal };

/** 响应头里那个决定 mock 内容类型的键（浏览器给出的大小写不固定） */
const CONTENT_TYPE_HEADER = 'content-type';

/** 从响应头表里取 content-type；取不到就不设，交给 Mock 自己的默认值 */
function contentTypeOf(headers: RequestLogEntry['responseHeaders']): string | undefined {
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === CONTENT_TYPE_HEADER && typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function buildMockDraftFromLog(log: RequestLogEntry): MockDraftResult {
  const body = log.responseBody;
  if (body === undefined) return { ok: false, reason: 'noBody' };
  if (log.status === undefined) return { ok: false, reason: 'noStatus' };
  if (log.responseIsBase64 === true) return { ok: false, reason: 'base64' };
  if (isTruncatedForLog(body)) return { ok: false, reason: 'truncated' };

  // 优先用被改写后的地址：那才是这一笔真正打到的地方，mock 要复刻的是它而不是原始意图
  const address = log.proxiedUrl || log.originalUrl;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, reason: 'badUrl' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'badUrl' };
  const origin = url.origin;
  if (!origin || origin === 'null') return { ok: false, reason: 'badUrl' };

  const contentType = contentTypeOf(log.responseHeaders);
  const draft: Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'> = {
    name: `Mock: ${log.method} ${url.pathname}`,
    enabled: false,
    matchType: 'prefix',
    matchPattern: `${origin}${url.pathname}`,
    // 空目标 = 不改写地址（`targetUrlHint` 那句合法语义）：mock 要交付的是响应，不是换后端
    targetUrl: '',
    priority: DEFAULT_RULE_PRIORITY,
    mockResponse: contentType ? { body, status: log.status, contentType } : { body, status: log.status },
  };
  return { ok: true, draft };
}
