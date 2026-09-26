import type { ProxyRule } from '@/utils/types';

/**
 * `matchType` 的合法取值：导入侧与恢复点侧共用这一份
 *
 * 下面这几份是**并列**的清单，运行时互不引用：`utils/types.ts` 的联合类型、表单那组 radio
 * （`RuleFormDialog.vue`）、表格的 tag 类型与案名两套映射（`RuleTable.vue`）、筛选下拉的三个选项
 * （`SearchFilterBar.vue`），再加中英两套案名键。加一种匹配方式得一次改齐，这七处对不上由
 * `tests/ruleValidation.test.ts` 判红。两处不在契约射程里：表单那组 `matchPattern` placeholder（少一项
 * 只是没有示例文本）与 MAIN world 那份内联类型（它自包含、与 `utils/types.ts` 没有编译期连接，
 * 认不出的取值在 `matchUrl` 落到 `default: return false`——页面侧永不匹配，但也不会报错）。
 */
const MATCH_TYPES: readonly string[] = ['wildcard', 'prefix', 'regex'];

/**
 * 结构与取值判据：一条未知数据能不能被安全地当成规则写进 `proxy_config`
 *
 * 两个调用方，同一份判据，必须同源：
 * - 导入文件（`normalizeImportedRules`）——文件是不可信输入，缺字段的规则落库后会让 DNR 同步
 *   与拦截器拿到 `undefined` 的 pattern；
 * - 配置恢复点（`sanitizeConfigHistory`）——`storage.local` 里的历史快照同样是可被手改的数据，
 *   回退这一步等于把它重新变成生效配置。
 *
 * 判据到「字段在不在、类型对不对、枚举合不合法、匹配模式有没有内容」这一层：优先级/时间戳的
 * NaN 归一化、重试与延迟的取值收口（{@link normalizeRuleTimings}）、请求头清洗与 id 重生成各有
 * 归属，不在这里顺手做。
 *
 * **`matchPattern` 不得为空白**：表单侧的必填只拦得住界面保存那一次，而「字段在但没内容」的
 * prefix 规则在两条通道上都是全流量命中——SW 侧 `url.startsWith('')` 恒真，DNR 侧
 * `buildRegexFilter` 编译出 `^(.*)`（`resourceTypes` 含 `main_frame`）。一份分享文件就能让
 * 每个标签页的每个请求（含顶层导航）被改写到文件里的那个域，所以这一格只能在数据入口拦，
 * 不能指望界面校验。
 */
export function isValidRuleShape(rule: unknown): rule is ProxyRule {
  if (!rule || typeof rule !== 'object') return false;
  const r = rule as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.matchPattern === 'string' &&
    r.matchPattern.trim() !== '' &&
    typeof r.targetUrl === 'string' &&
    MATCH_TYPES.includes(r.matchType as string)
  );
}

/**
 * 本扩展能代理的协议（`URL#protocol` 形态，含冒号、已小写）
 *
 * 只有这两个家族能走到「重定向」这一步：HTTP 由 DNR 网络层与后台 `fetch` 两条通道处理，
 * WebSocket 由拦截器的握手通道处理。其余协议（`data:` / `blob:` / `file:` / `about:` /
 * `javascript:`）不是「某种代理实现」的 target——`fetch()` 在扩展页面里根本取不到它们，
 * DNR 也不会为它们命中任何请求。
 */
const PROXYABLE_PROTOCOLS: readonly string[] = ['http:', 'https:', 'ws:', 'wss:'];

/**
 * 导入侧的协议闸门：这条 URL 有没有可能变成一条有意义的代理规则
 *
 * 两个消费者（`utils/curlParser.ts` 与 `utils/har.ts`）都是「`new URL()` 成功就当可用」，
 * 而 `new URL('data:text/html,x')` 与 `new URL('file:///etc/passwd')` 都是成功的——它们的
 * `origin` 是字符串 `'null'`，于是产出一条 `matchPattern: 'null/*'`、`targetUrl: 'null'` 的规则：
 * 进列表、占 200 个名额之一、永远不会命中（`^(null/(.*))$` 是合法 RE2，但没有真实 URL 长这样）。
 * 收口点在生成规则那一刻，而不是等闸门判形状：闸门认的是「字段齐不齐」，`'null/*'` 在字段层面无辜。
 *
 * `ws` / `wss` 保持可用（它们有像样的 origin，HAR 里那条握手是改造成跨环境规则的合理起点），
 * 所以判据是协议白名单而不是「非 http(s) 一律丢」。
 *
 * 两个消费者的口径**允许比这里更窄**：cURL 导入（`utils/curlParser.ts`）在此之上再收一层，
 * 只放 http/https 过去——那份解析结果是一个方法、一组头和一个请求体，本来就是 HTTP 的形状，
 * 预填出来的表单也只服务这一类规则。HAR 侧（`utils/har.ts`）直接用这一份判据，长连接握手因此留得住。
 */
export function isProxyableProtocol(protocol: string): boolean {
  return PROXYABLE_PROTOCOLS.includes(protocol.toLowerCase());
}

/** 重试次数上限：与表单 `el-input-number` 的 `:max` 和 `utils/types.ts` 的契约同源 */
export const MAX_RULE_RETRY_COUNT = 5;
/** 重试间隔上限（毫秒）：够覆盖「等依赖服务起来」的场景，再高就是把代理改成计时器 */
export const MAX_RULE_RETRY_DELAY = 30_000;
/** 请求延迟上限（毫秒）：与 Chrome DevTools 网络节流的可配最大值同档 */
export const MAX_RULE_DELAY = 60_000;

/** 有限数才采纳：`typeof NaN === 'number'`，而 NaN 延迟会让 `setTimeout` 立刻触发 */
function bounded(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : undefined;
}

/**
 * 收口重试与延迟三项：导入侧与恢复点侧共用，运行时取用处再钳一次
 *
 * 这三项表单给不出越界值（`:max` 卡死），但导入文件与手改的 storage 给得出：
 * `retryCount: 1e9` + `retryDelay: 0` 在 5xx 分支上就是零间隔热循环——循环体内不写日志，
 * 页侧超时又按 retries 线性放大，界面上完全看不出异常，因此它属于「静默坏配置」那一档。
 * 只**钳制**不丢弃：越界值被压回上限，规则本身照常生效。
 *
 * 返回一份新对象（不就地改）：入参可能是缓存里的规则，就地改会污染别的读者。
 */
export function normalizeRuleTimings(rule: ProxyRule): ProxyRule {
  const next = { ...rule };
  const patch = (key: 'retryCount' | 'retryDelay' | 'delayMs', max: number): void => {
    const clamped = bounded(rule[key], max);
    if (clamped === undefined) delete next[key];
    else next[key] = clamped;
  };
  patch('retryCount', MAX_RULE_RETRY_COUNT);
  patch('retryDelay', MAX_RULE_RETRY_DELAY);
  patch('delayMs', MAX_RULE_DELAY);
  return next;
}
