/**
 * 日志重放：把一条已记录的请求交回代理引擎再发一次，并把回包读成一句人话
 *
 * 存在的理由只有一句：日志里那一行说的是**过去某个时刻**的结果，而用户在排查时想知道的是
 * 「现在还是这样吗」。重放不新建一条通路——它把这条记录交回 `PROXY_REQUEST` 那同一个入口，
 * 于是总开关、站点范围、规则匹配、mock / block / delay / retry、凭据展开全部按原样再走一遍，
 * 界面无需（也不许）自己拼一份「代理会怎么做」的模型。第二份判据就是下一次改动里分叉的开始。
 *
 * 三条刻意的取舍：
 * - **发出去的载荷来自这条记录自己**（地址、方法、当时那组请求头、当时的正文）。日志里的请求头
 *   与正文本就是原值（只有详情视图按 `headerMask` 打码显示），重发它们与原请求同一条落点，
 *   不是新的外传面；`{{名称}}` 若在头值里，那是**代发那一刻**才展开的，这里一律按字面交出。
 * - **长连接不重放**。日志只由后台通道落，握手不经过它，而 `wss://` 交给 `fetch` 只会得到一个
 *   谁都看不懂的失败——那种「报了一个错」比「这件事我做不到」更难排查。
 * - **回包里的英文串是内部编码，不是文案**。`statusText` 与两份 bypass 的 body 由
 *   `entrypoints/background/proxyHandler.ts` 写死，这里把它们收成 `ReplayOutcome` 那几档，
 *   界面只说 i18n 的那一句；原始 statusText 作为数据另外带着。
 *   这层映射的全部风险是那一头改了字面量而这一头静默失配，所以判读表两侧由
 *   `tests/requestReplay.test.ts` 按源码对账，改一侧必红。
 */

import { MAX_LOG_BODY_SIZE } from '@/utils/constants';
import type { ProxyRequestMessage } from '@/utils/types';

/** 一条日志记录里，重放要用的那几项（其余字段一概不看：重放的是「这笔请求」，不是它的结果） */
export interface ReplaySource {
  originalUrl?: unknown;
  method?: unknown;
  requestHeaders?: unknown;
  requestBody?: unknown;
}

/**
 * 交给 `PROXY_REQUEST` 的载荷。
 *
 * 类型直接从消息协议那一份剥出来（少了只有页面才有的 `requestId` 与 `ruleId`），而不是手抄一遍字段：
 * 协议将来多一个必填项时这里会当场编译不过，而手抄的那一份只会安静地少发一个字段。
 */
export type ReplayPayload = Omit<ProxyRequestMessage['data'], 'requestId' | 'ruleId'>;

/**
 * 重放前的计划：要么给出一份可直接发出的载荷，要么点名为什么不能发
 *
 * `headersPresent` / `bodyPresent` 说的是「这条记录留没留下那样东西」，与「它是不是空的」是两件事：
 * 被阻断的那一笔、失败收口的那一笔都不记请求头，此时照发一份空头请求是合法的，
 * 但界面必须说清楚——用户以为自己在重放原请求，而原请求的头根本没进过日志。
 */
export type ReplayPlan =
  | { ok: true; payload: ReplayPayload; headersPresent: boolean; bodyPresent: boolean }
  | { ok: false; reason: 'noUrl' | 'notHttp' | 'badMethod' };

/** 只有 http(s) 能被 `fetch` 发出去；其余协议（含 `ws://` / `wss://`）在这里就挡下，不交给网络层报错 */
const REPLAYABLE_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/** 方法是自由文本（日志的字段收口只钳长度，不校验取值），空或纯空白就没法发 */
function readMethod(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

/**
 * 把 storage / 消息里读出的头表收成 `Record<string, string>`
 *
 * 非对象当「没有这一项」，对象里的非字符串值丢掉——代理那侧对进来的头本来就是宽容过滤
 * （`filterIncomingHeaders` 跳过个别非法项），这里提前丢一遍只是不让一个 `undefined` 混进 postMessage 式的结构化克隆。
 */
function readHeaders(raw: unknown): { headers: Record<string, string>; present: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { headers: {}, present: false };
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') headers[key] = value;
  }
  return { headers, present: true };
}

export function planReplay(source: ReplaySource): ReplayPlan {
  const rawUrl = typeof source.originalUrl === 'string' ? source.originalUrl.trim() : '';
  if (!rawUrl) return { ok: false, reason: 'noUrl' };

  let protocol: string;
  try {
    protocol = new URL(rawUrl).protocol;
  } catch {
    // 日志里的地址来自页面，理论上一定是 URL；真读不出（手改过 storage、或被截断留痕截坏了）
    // 就说「这条记录发不出去」，不拿一个残缺地址去换一次网络错误
    return { ok: false, reason: 'notHttp' };
  }
  if (!REPLAYABLE_PROTOCOLS.includes(protocol)) return { ok: false, reason: 'notHttp' };

  const method = readMethod(source.method);
  if (!method) return { ok: false, reason: 'badMethod' };

  const { headers, present: headersPresent } = readHeaders(source.requestHeaders);
  const body = typeof source.requestBody === 'string' ? source.requestBody : null;
  return {
    ok: true,
    payload: body === null ? { url: rawUrl, method, headers } : { url: rawUrl, method, headers, body },
    headersPresent: headersPresent,
    bodyPresent: body !== null,
  };
}

/**
 * 这些方法按 HTTP 语义是「读」，其余一律当成会改东西
 *
 * 判据保守是有意的：`POST` / `PUT` / `PATCH` / `DELETE` 重发一次就是再改一次状态，
 * 非幂等接口上「一次下单两张单」正是这类工具最贵的错。认不准的方法（自定义动词）也走确认——
 * 多说一句的成本是一次点击，少说一句的成本是一次用户没有打算做的写入。
 */
const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

export function needsReplayConfirm(method: unknown): boolean {
  return !SAFE_METHODS.includes(readMethod(method));
}

/** `proxyHandler` 写死的内部编码（**唯一**一份判读表；改那一头必须让这里的用例红） */
const BYPASS_SITE_EXCLUDED = 'Site excluded';
const BYPASS_DISABLED = 'Proxy is disabled';
const BYPASS_NO_RULE = 'No matching rule';
const TEXT_BLOCKED = 'Blocked';
const TEXT_MOCK = 'Mock';
const TEXT_BODY_TOO_LARGE = 'Body Too Large';
const TEXT_INVALID_RULE_HEADERS = 'Invalid Rule Headers';
const TEXT_PROXY_ERROR = 'Proxy Error';
const TEXT_PROXY_BYPASS = 'Proxy Bypass';
/** 同一个 `Body Too Large` 有两种来路，靠这句前缀分开：一个是发不出去，一个是回包掐掉 */
const REASON_REQUEST_BODY = 'Request body exceeds';
const REASON_RESPONSE_BODY = 'Response body exceeds';

/**
 * 这一笔到底发生了什么
 *
 * `answered` 只说「服务器给了个回包」，**不说成功**——4xx / 5xx 都是 answered，
 * 因为「重放之后拿到 500」正是用户想知道的那件事。
 * `malformed` 留给「回包形状不对」（SW 回收期那份 `{success:false}` 信封、或压根不是信封）：
 * 它既不是「服务器报错」也不是「代理没生效」，画成任何一边都是替别人编话。
 * 中间那一排每一档都是一个**不同的下一步**（改规则 / 开总开关 / 把这台站点加进名单 / 缩小正文），
 * 所以合并任何两档都会把排查送去错误的地方——`siteExcluded` 与 `noRule` 都表现为「没走代理」，
 * 而它们的修法正好相反：一个是「这条规则本来就不该动这一页」，一个是「你还没写这条规则」。
 */
export type ReplayOutcome =
  | 'answered'
  | 'mock'
  | 'blocked'
  | 'noRule'
  | 'siteExcluded'
  | 'disabled'
  | 'invalidRuleHeaders'
  | 'requestTooLarge'
  | 'responseTooLarge'
  | 'failed'
  | 'malformed';

/** 读回来的那笔重放结果：给界面的是收好的一档，外加原样的状态码与状态文本（后者作为数据展示） */
export interface ReplayReading {
  outcome: ReplayOutcome;
  status: number;
  statusText: string;
  body: string;
  isBase64: boolean;
  /** 回包正文字符数（`bodyLength` 与 `body` 的长度可以不同：正文只截到显示上限） */
  bodyLength: number;
  /** 正文是否为了显示被截短（`body` 因此是前缀，界面上必须点名，别让它看起来像完整响应） */
  bodyTruncated: boolean;
  headerCount: number;
}

/**
 * 哪几档值得把回包正文贴在结果下面
 *
 * 内部编码那几句（Bypass / Blocked / 没有规则 / 站点不在名单）已经被上面那句中文说完了，
 * 把英文原文再贴一遍只是噪声；真正是**对面说的话**的那几档必须留着——服务器正文、Mock 正文、
 * 体积上限那句（里面带着具体字节数）、以及失败原因。最后那一条尤其重要：超时、断网、DNS 失败
 * 与连接被拒在界面上是同一句话，只有那一行原文分得出是哪一种。
 */
const OUTCOMES_WITH_BODY: readonly ReplayOutcome[] = [
  'answered',
  'mock',
  'requestTooLarge',
  'responseTooLarge',
  'failed',
];

export function replayBodyUseful(outcome: ReplayOutcome): boolean {
  return OUTCOMES_WITH_BODY.includes(outcome);
}

/**
 * 把 `PROXY_REQUEST` 的回包读成一档结局
 *
 * 只认「形状」与「proxyHandler 那几句写死的编码」，不猜别的东西：`status` 不是数字、
 * 或整包不是对象，一律 `malformed`，界面据此说「没能读到这一笔的答案」，而不是把 0 当状态码报出去。
 */
export function readReplayEnvelope(raw: unknown): ReplayReading {
  const empty: ReplayReading = {
    outcome: 'malformed',
    status: 0,
    statusText: '',
    body: '',
    isBase64: false,
    bodyLength: 0,
    bodyTruncated: false,
    headerCount: 0,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;

  const packet = raw as Record<string, unknown>;
  const status = typeof packet.status === 'number' && Number.isFinite(packet.status) ? packet.status : NaN;
  const statusText = typeof packet.statusText === 'string' ? packet.statusText : '';
  const bodyText = typeof packet.body === 'string' ? packet.body : '';
  const isBase64 = packet.isBase64 === true;
  if (!Number.isFinite(status)) return empty;

  const headers = packet.headers;
  const headerCount =
    headers && typeof headers === 'object' && !Array.isArray(headers) ? Object.keys(headers).length : 0;

  let outcome: ReplayOutcome;
  if (statusText === TEXT_MOCK) outcome = 'mock';
  else if (statusText === TEXT_BLOCKED) outcome = 'blocked';
  else if (statusText === TEXT_INVALID_RULE_HEADERS) outcome = 'invalidRuleHeaders';
  else if (statusText === TEXT_BODY_TOO_LARGE) {
    // 两个方向共用一句状态，分开靠正文前缀——写请求那一头是「没送到」，回包那一头是「送到了但掐了」。
    // 认不出这两个前缀就不猜档：宁可说「答案没读到」，也不要替一次未来的改动编一个像模像样的解释
    outcome = bodyText.startsWith(REASON_REQUEST_BODY)
      ? 'requestTooLarge'
      : bodyText.startsWith(REASON_RESPONSE_BODY)
        ? 'responseTooLarge'
        : 'malformed';
  } else if (statusText === TEXT_PROXY_ERROR) outcome = 'failed';
  else if (statusText === TEXT_PROXY_BYPASS) {
    // 三种 bypass 在页面上是同一个信封，只有 body 那一句分得开：这一格不能只说「没走代理」，
    // 得说清是没走代理的**哪一个原因**，否则用户会去改规则，而问题在总开关或站点名单上
    outcome =
      bodyText === BYPASS_SITE_EXCLUDED
        ? 'siteExcluded'
        : bodyText === BYPASS_DISABLED
          ? 'disabled'
          : bodyText === BYPASS_NO_RULE
            ? 'noRule'
            : 'malformed';
  } else outcome = 'answered';

  return {
    outcome,
    status,
    statusText,
    body: bodyText.slice(0, MAX_LOG_BODY_SIZE),
    isBase64,
    bodyLength: bodyText.length,
    bodyTruncated: bodyText.length > MAX_LOG_BODY_SIZE,
    headerCount,
  };
}
