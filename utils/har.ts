import type { RequestLogEntry, HarEntry, ProxyRule } from '@/utils/types';
import { sanitizeImportedHeaderMap } from '@/utils/headerValidation';
import { isProxyableProtocol } from '@/utils/ruleValidation';
import { apiOriginOf } from '@/utils/pageApiOrigins';
import { generateId } from '@/utils/generateId';
import { MAX_HAR_IMPORT_ENTRIES } from '@/utils/constants';

/**
 * HAR 条数闸门的判据：超出上限返回 `{ actual, limit }`，合规返回 `null`。
 *
 * 两侧都要问一次，所以判据只能有一份——界面在序列化与发消息之前先拒（不然那一次
 * `sendMessage` 的结构化克隆与后台的整表遍历已经付过钱了），后台在把条目交给
 * `harEntriesToRules` 之前复核（消息体与文件内容同样按不可信输入对待）。
 * 两边各写一个 `> MAX_HAR_IMPORT_ENTRIES` 迟早会漂：界面上那句是给用户看的，
 * 要报实际条数；后台那句回的是失败信封。它们对「多少算多」必须给同一个答案。
 *
 * 选「拒」而不是「悄悄截到上限」：截一半会让导入结果与被选的文件对不上，而 HAR 这条通道
 * 没有去重可言（不像 JSON 导入会跳过同名同模式的既有条目），用户无从核对少了哪些。
 *
 * @param entries HAR 的 `log.entries`（调用方须已确认它是数组）
 */
export function harEntriesOverLimit(entries: readonly unknown[]): { actual: number; limit: number } | null {
  return entries.length > MAX_HAR_IMPORT_ENTRIES ? { actual: entries.length, limit: MAX_HAR_IMPORT_ENTRIES } : null;
}

/** HAR 里会被当成凭据带上目标环境的三枚头名；搬家侧与生成侧必须共用这一份清单 */
export const HAR_CREDENTIAL_HEADER_NAMES = new Set(['authorization', 'cookie', 'x-api-key']);

/**
 * 将请求日志转换为 HAR 格式（HTTP Archive）
 *
 * 仅包含 SW 通道记录的日志（DNR 通道无请求/响应详情）。
 */
export function logsToHar(logs: RequestLogEntry[]): object {
  const entries = logs.filter(l => l.proxyType === 'sw' && l.responseBody !== undefined).map(l => logToHarEntry(l));

  return {
    log: {
      version: '1.2',
      creator: {
        name: 'Cross-Origin Proxy',
        version: '1.0.0',
      },
      entries,
    },
  };
}

function findContentType(headers: Record<string, string> | undefined): string {
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'content-type') return value;
    }
  }
  return 'application/json';
}

function logToHarEntry(log: RequestLogEntry): HarEntry {
  const requestHeaders = log.requestHeaders
    ? Object.entries(log.requestHeaders).map(([name, value]) => ({ name, value }))
    : [];

  const responseHeaders = log.responseHeaders
    ? Object.entries(log.responseHeaders).map(([name, value]) => ({ name, value }))
    : [];

  return {
    request: {
      method: log.method,
      url: log.originalUrl,
      headers: requestHeaders,
      postData: log.requestBody ? { text: log.requestBody, mimeType: findContentType(log.requestHeaders) } : undefined,
    },
    response: {
      status: log.status ?? 0,
      statusText: '',
      headers: responseHeaders,
      content: log.responseBody
        ? { text: log.responseBody, mimeType: findContentType(log.responseHeaders) }
        : undefined,
    },
  };
}

/**
 * 从 HAR 条目里收集去重后的 http(s) 来源，供导入前的多来源确认使用
 *
 * 只数 http(s)：`apiOriginOf` 就是「什么算一个环境」的那份判据，而目标环境按它定义——
 * 长连接条目压根不会被它搬走（见 `harEntriesToRules` 里 `isWebSocket` 那一支），
 * 把它算进确认文案等于问了一件不发生的事。
 */
export function distinctHarOrigins(entries: readonly HarEntry[]): string[] {
  const origins = new Set<string>();
  for (const entry of entries) {
    const url = entry?.request?.url;
    const origin = typeof url === 'string' ? apiOriginOf(url) : '';
    if (origin) origins.add(origin);
  }
  return [...origins];
}

/**
 * 从 HAR 条目生成代理规则
 *
 * 提取请求 URL 的 origin 作为 matchPattern（wildcard），提取请求头里的凭据作为 `headerOverrides` 参考。
 *
 * 两道闸门，都排在「这条条目算不算占住了这个 origin」之前：
 * - 协议：只收本扩展能代理的协议（{@link isProxyableProtocol}，口径与 `utils/curlParser.ts` 同源）。
 * - 条目形状：`headers` 不是数组、头项缺 `name`/`value` 都只跳过那一条头，不让它连带作废整条规则。
 * 去重登记因此必须挨着 `rules.push`——早一步登记就会让一条坏条目吃掉同 origin 后面那条好规则。
 *
 * @param entries HAR 条目（不可信输入）
 * @param opts `targetOrigin` 把这一批 origin 规则**一并指过去**（抓包→可用配置的那一步）；
 *   它为空或解析不出 http(s) origin 时当作没填，产出与本函数历史形状逐字节相同（`enabled: false`、
 *   目标等于源站）。`enabled` 绑在合法目标之后，没有换环境就不凭空打开这批规则。
 */
export function harEntriesToRules(
  entries: HarEntry[],
  opts?: { targetOrigin?: string; enabled?: boolean },
): ProxyRule[] {
  const now = Date.now();
  const seenOrigins = new Set<string>();
  const rules: ProxyRule[] = [];
  // 目标环境只在**自己解析得出 http(s) origin** 时生效：空串或非法串一律当「没填」，
  // 于是下面的产出与不传 opts 时逐字节相同。启用开关绑在它之后——没换环境就默认启用是凭空打开规则。
  const targetOrigin = opts?.targetOrigin ? apiOriginOf(opts.targetOrigin) : '';
  const enabled = !!targetOrigin && opts?.enabled === true;

  for (const entry of entries) {
    try {
      const url = new URL(entry.request.url);
      // 协议闸门：`data:` / `blob:` / `file:` 条目的 `url.origin` 是字符串 "null"，此前会原样
      // 生成一条 `matchPattern: "null/*"`、`targetUrl: "null"` 的垃圾规则——进列表、占 200 个
      // 名额之一，却永远命中不了任何真实请求。`ws` / `wss` 有像样的 origin，留在可用范围内
      // （HAR 里那条握手是改造成跨环境长连接规则的合理起点）。
      // 第二道 `origin` 检查是兜底：闸门认的是字段形状，认不出「字段齐全但没有内容」的意思。
      if (!isProxyableProtocol(url.protocol)) continue;
      const origin = url.origin;
      if (!origin || origin === 'null') continue;

      // 「目标环境」这一格按 `apiOriginOf` 定义，只能是 http(s) 的源；把 wss 握手改写到
      // `https://…` 上不是换环境，是把这条规则变成永远连不上（`new WebSocket('https://…')`
      // 当场被判成非法地址）。所以长连接条目一律留在自己的 origin 上，要跨 ws 环境去表单里改。
      const isWebSocket = url.protocol === 'ws:' || url.protocol === 'wss:';
      const target = isWebSocket ? origin : targetOrigin || origin;

      // 去重登记必须挨着 `rules.push`：此前它排在头清洗之前，一条头形状坏掉的条目
      // 自己没成为规则，却已经把这个 origin 占住，同 origin 后面那条完好的跟着一起丢。
      if (seenOrigins.has(origin)) continue;

      const headerOverrides: Record<string, string> = {};
      if (Array.isArray(entry.request.headers)) {
        for (const h of entry.request.headers) {
          if (!h || typeof h.name !== 'string' || typeof h.value !== 'string') continue;
          const name = h.name.toLowerCase();
          if (HAR_CREDENTIAL_HEADER_NAMES.has(name)) {
            headerOverrides[h.name] = h.value;
          }
        }
      }

      const rule: ProxyRule = {
        id: generateId(),
        name: `Imported: ${url.hostname}`,
        // 换环境没换到它的那条（长连接）不跟着启用：一条自映射的活动规则不是任何人的意图
        enabled: isWebSocket ? false : enabled,
        matchPattern: `${origin}/*`,
        targetUrl: target,
        matchType: 'wildcard',
        priority: 100,
        createdAt: now,
        updatedAt: now,
      };

      // HAR 文件是不可信输入，且这条路径不经 normalizeImportedRules：
      // 取值含换行的头会让规则在运行时被 validateRuleHeaders 整条拒绝，故在此清洗
      const sanitizedHeaders = sanitizeImportedHeaderMap(headerOverrides);
      if (sanitizedHeaders) {
        rule.headerOverrides = sanitizedHeaders;
      }

      seenOrigins.add(origin);
      rules.push(rule);
    } catch {
      // Skip invalid URLs
    }
  }

  return rules;
}
