/**
 * 「这一笔日志能不能当环境对比的输入」的唯一判据
 *
 * 三条各自都要成立，缺一条就是一次比错的对比：
 * ① 取 `originalUrl` 不是 `proxiedUrl`——用户问的是「当初那一笔在两个环境各回什么」，
 *    拿重写后的地址当输入，等于先把两边搬进同一个环境（与「URL 匹配预演」是前后两步，不是重复功能）；
 * ② 截断过的一律拒绝——`storage.ts` 的 `capLogEntry` 会在 URL / 方法 / 每个头的名与值 / 正文末尾
 *    留下 `…[truncated, original N chars]`，照原样填进输入框就是把一个残缺地址连着当初那组真凭据
 *    发往两个环境。`utils/requestReplay.ts` 与 `utils/mockFromLog.ts` 对同一件事选的也是拒绝，
 *    判据共用 `isTruncatedForLog` 那一份——产出方与判读方各写一遍后缀，就是下一次静默的开始；
 * ③ 只取请求侧——`responseHeaders` / `responseBody` 是结果不是输入，带进草稿就是替用户多发出
 *    几个他没说过的头。
 *
 * 与 `entrypoints/background/envDiff.ts` 的分工：这里拦的是「界面上根本不该出现这颗按钮」，
 * 后台那道拦的是「真正出门那一刻」。地址与方法各复用现成的那一份出口
 * （`isProxyableUrl` / `ENV_DIFF_METHOD_RE`），不再发明第二把尺。
 */
import type { RequestLogEntry } from '@/utils/types';
import { isTruncatedForLog } from '@/utils/formatters';
import { isProxyableUrl } from '@/utils/proxyProtocol';
import { ENV_DIFF_METHOD_RE } from '@/utils/envDiff';
import { ENV_DIFF_PICK_LIMIT } from '@/utils/constants';

/** 这一笔不能当对比输入的原因；四档各有一句界面话，不许合成一句「不能用」 */
export type EnvDiffPickBlock = 'truncated' | 'unsupportedProtocol' | 'noMethod' | 'badUrl';

/** 交给界面的那一份草稿：字段与弹窗里的输入框一一对应 */
export interface EnvDiffPickDraft {
  url: string;
  method: string;
  headers: { key: string; value: string }[];
  body: string;
}

export type EnvDiffPrefill = { ok: true; draft: EnvDiffPickDraft } | { ok: false; blocked: EnvDiffPickBlock };

/** 弹窗里的一行：合法与非法都要在列，非法那行必须说得出为什么 */
export interface EnvDiffPickRow {
  id: string;
  url: string;
  method: string;
  timestamp: number;
  prefill: EnvDiffPrefill;
  blocked?: EnvDiffPickBlock;
}

/**
 * 把头表收成草稿里的行
 *
 * 只做形状收窄与「有没有被裁过」这一件事：头名字符集与 CRLF 的判据住在
 * `utils/headerValidation.ts`，而对比那一侧真正发出前会由 `prepareEnvDiffRequest` 再过一遍——
 * 这里提前拦是为了让按钮不出现，不是为了替后台做决定。
 */
function headerRowsOf(raw: unknown): { rows: { key: string; value: string }[] } | { blocked: EnvDiffPickBlock } {
  if (raw === undefined || raw === null) return { rows: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { blocked: 'badUrl' };
  const rows: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') return { blocked: 'badUrl' };
    if (isTruncatedForLog(key) || isTruncatedForLog(value)) return { blocked: 'truncated' };
    if (!key.trim()) continue;
    rows.push({ key, value });
  }
  return { rows };
}

/**
 * 把一条日志收成环境对比的输入
 *
 * 入参是 `unknown`：这条记录来自 `GET_REQUEST_LOG` 的回包，属不可信输入。读不出形状就是
 * `badUrl`，绝不抛——抛出去会沿着弹窗的点击处理器变成一句未处理拒绝，而用户看到的是一声不响。
 */
export function planEnvDiffFromLog(entry: unknown): EnvDiffPrefill {
  if (typeof entry !== 'object' || entry === null) return { ok: false, blocked: 'badUrl' };
  const data = entry as Partial<RequestLogEntry>;

  if (typeof data.originalUrl !== 'string' || !data.originalUrl.trim()) return { ok: false, blocked: 'badUrl' };
  const url = data.originalUrl.trim();
  if (isTruncatedForLog(url)) return { ok: false, blocked: 'truncated' };
  if (!isProxyableUrl(url)) return { ok: false, blocked: 'unsupportedProtocol' };

  const method = typeof data.method === 'string' ? data.method.trim() : '';
  if (!ENV_DIFF_METHOD_RE.test(method)) return { ok: false, blocked: 'noMethod' };

  const headers = headerRowsOf(data.requestHeaders);
  if ('blocked' in headers) return { ok: false, blocked: headers.blocked };

  const rawBody = data.requestBody;
  if (rawBody !== undefined && typeof rawBody !== 'string') return { ok: false, blocked: 'badUrl' };
  const body = rawBody ?? '';
  if (isTruncatedForLog(body)) return { ok: false, blocked: 'truncated' };

  return { ok: true, draft: { url, method, headers: headers.rows, body } };
}

/**
 * 把回包装成弹窗里那几行
 *
 * 顺序原样交给界面（存储侧本就按新到旧存），这里只做上界与逐条判定；越界的条目不画，
 * 也不说「还有更多」——全量与筛选都在日志抽屉那一屏，重复一份就是两个界面各筛各的。
 */
export function buildEnvDiffPickRows(raw: unknown, limit: number = ENV_DIFF_PICK_LIMIT): EnvDiffPickRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: EnvDiffPickRow[] = [];
  for (const item of raw) {
    if (rows.length >= limit) break;
    if (typeof item !== 'object' || item === null) continue;
    const data = item as Partial<RequestLogEntry>;
    if (typeof data.id !== 'string' || !data.id) continue;
    const prefill = planEnvDiffFromLog(item);
    rows.push({
      id: data.id,
      url: typeof data.originalUrl === 'string' ? data.originalUrl : '',
      method: typeof data.method === 'string' ? data.method : '',
      timestamp: typeof data.timestamp === 'number' ? data.timestamp : 0,
      prefill,
      blocked: prefill.ok ? undefined : prefill.blocked,
    });
  }
  return rows;
}
