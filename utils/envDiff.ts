/**
 * 环境响应对比（`#env-diff`）的纯判据层
 *
 * 只收两件事：① 载荷在后台侧的重判（界面判过一遍不算数，`IMPORT_HAR` 的 `targetOrigin`
 * 是同一条先例）；② 两份响应正文的逐行对照。不碰 chrome、不碰网络、不引后台模块——
 * 配置上限 `MAX_BODY_SIZE` 那一步刻意留在 `entrypoints/background/envDiff.ts`，
 * 因为把那把尺从这里 import 进来会把整个 SW 代理实现拉进 options 首屏。
 */

import { MAX_ENV_DIFF_HEADERS } from '@/utils/constants';
import { isValidHeaderEntry } from '@/utils/headerValidation';
import { isProxyableUrl } from '@/utils/proxyProtocol';

/** 方法名只允许 RFC token 的一副常见形状：这里的输入是对话框里的一个下拉加自由输入，越形即拒 */
export const ENV_DIFF_METHOD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;

/** 后台重判的拒绝原因（编码与 `EnvDiffErrorCode` 的前四项同集） */
export type EnvDiffPrepareReject = 'url' | 'method' | 'headers';

export interface EnvDiffPrepared {
  url: string;
  /** 已转大写；GET/HEAD 不带 body 的裁剪在调用方（那里才知道最终 body） */
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  sendCredentials: boolean;
}

/**
 * 把一条来路不明的 `ENV_DIFF_REQUEST` 载荷收口成可发形状，或点名它为什么不能发
 *
 * 头表走**严格拒绝**（与规则配置侧同一档，而不是页面传入头那种「跳过个别非法项」）：
 * 对比场景里静默丢掉一条头，用户会拿一份「它其实没发出去」的结果去判断两个环境的差异。
 * 空表、缺字段都按合法处理（「这次就是不带这几项」），畸形值才拒。
 */
export function prepareEnvDiffRequest(raw: unknown): EnvDiffPrepared | { reject: EnvDiffPrepareReject } {
  if (typeof raw !== 'object' || raw === null) return { reject: 'url' };
  const data = raw as Record<string, unknown>;

  const url = typeof data.url === 'string' ? data.url.trim() : '';
  if (!isProxyableUrl(url)) return { reject: 'url' };

  const methodRaw = typeof data.method === 'string' ? data.method.trim() : '';
  const method = methodRaw.toUpperCase();
  if (!methodRaw || !ENV_DIFF_METHOD_RE.test(methodRaw)) return { reject: 'method' };

  const headers: Record<string, string> = {};
  const rawHeaders = data.headers;
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) return { reject: 'headers' };
    const entries = Object.entries(rawHeaders as Record<string, unknown>);
    if (entries.length > MAX_ENV_DIFF_HEADERS) return { reject: 'headers' };
    for (const [key, value] of entries) {
      if (typeof value !== 'string' || !isValidHeaderEntry(key, value)) return { reject: 'headers' };
      headers[key] = value;
    }
  }

  const body = typeof data.body === 'string' && data.body !== '' ? data.body : undefined;
  return { url, method, headers, body, sendCredentials: data.sendCredentials === true };
}

/**
 * 看起来像 JSON 就格式化，读不出来原样交回
 *
 * 格式化只服务对照：两个环境回 `{"a":1,"b":2}` 与 `{"a": 1, "b": 2}` 时，逐字节比会说「不一样」，
 * 而那句不是用户要的答案。解析失败（半截 JSON、YAML、HTML）不动它——那一行行的差异本来就是真的。
 */
export function prettifyEnvDiffBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return body;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return body;
  }
}

/**
 * 两份正文的逐行对照：第一处不同的行号（1 起），完全相同回 null
 *
 * 只报第一处，不数「共 N 处不同」：对比的人拿到「第一处差异在第几行」就会滚过去看，
 * 而总数在那一刻没有决策价值，还得为它多算一遍全表。
 */
export function findFirstBodyDiffLine(a: string, b: string): number | null {
  if (a === b) return null;
  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const shared = Math.min(linesA.length, linesB.length);
  for (let i = 0; i < shared; i++) {
    if (linesA[i] !== linesB[i]) return i + 1;
  }
  // 公共前缀逐行相同而长度不同：差异就是「短的那份在这里之后没有了」
  return shared + 1;
}
