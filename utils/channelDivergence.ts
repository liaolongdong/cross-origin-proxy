/**
 * 正则规则的两通道重写差异（纯函数模块，可在 Node 环境直接测试）
 *
 * 分流与重写语义都是既定的：`isSimpleRule` 为真的正则规则由网络层（declarativeNetRequest）
 * 用 `regexSubstitution` **整体替换整条 URL**，而后台通道用 `String.replace` **只替换匹配到的片段**
 * （见 `utils/urlMatcher.ts` 的 `rewriteUrl` 与 `utils/dnrRules.ts` 的 `buildRegexSubstitution`）。
 * 仓库口径把这件事列为**已接受的差异**、不去修平，所以这里不改行为，只做一件事：
 * 拿着用户自己输入的那个 URL，把两条通道**分别会得到什么地址**算出来并在不一致时点名——
 * 覆盖不全的正则（如 `/api/(.*)`）在后台通道里会拼出一个夹着原主机名的怪地址，
 * 而网络层给出的是干净的替换结果，两者都不报错，用户只会看到「同一个请求两次结果不一样」。
 *
 * 刻意只判 `regex`：`wildcard` 末尾 `*` 捕获为空时两通道差一个分隔斜杠是另一条已接受的差异
 * （两者指向同一资源），把它也算进来说谎的成本比收益高。
 */

import type { ProxyRule } from '@/utils/types';
import { getCompiledRegex, isSimpleRule, isUrlTooLongForScan, rewriteUrl } from '@/utils/urlMatcher';
import { buildRegexSubstitution, substitutionSegments } from '@/utils/dnrRules';

/** 同一笔请求在两条通道下分别会被改成什么 */
export interface RegexRewriteDivergence {
  /** 网络层（DNR）的结果：整条 URL 由替换模板重建 */
  readonly networkUrl: string;
  /** 后台通道（SW）的结果：只有匹配到的片段被替换 */
  readonly extensionUrl: string;
}

/**
 * 按 DNR 的替换语法渲染模板
 *
 * 扫描交给 `dnrRules.ts` 的 `substitutionSegments`——「什么算一个引用」全仓只有那一处定义，
 * 越界守卫、界面上的对照条与这里的渲染必须读同一个规则；抄第二份时先错的是没人测的那份，
 * 而这一格错的代价是预演报出一个与浏览器不同的地址。越界或缺组时替换为空串，
 * 与 `MAX_DNR_SUBSTITUTION_REF` 之前的读法一致（能走到这里的规则编号都在 `\1`-`\9` 内）。
 */
export function renderRegexSubstitution(template: string, groups: readonly string[]): string {
  return substitutionSegments(template)
    .map(segment => (segment.kind === 'literal' ? segment.text : (groups[segment.index] ?? '')))
    .join('');
}

/**
 * 判定这笔 URL 在该规则下是否「两条通道会给出不同地址」
 *
 * 只在五个条件同时成立时才可能不一致：规则生效、走网络层通道、是正则规则、
 * 配了目标地址、模式能匹配。结果相同就返回 `null`——「配了正则规则」本身不是问题，
 * 「同一个请求两种答案」才是。正则本身在 JS 侧就编译不出来时返回 `null`。
 *
 * **这一格不判「浏览器会不会真的应用这条规则」**：那要 RE2 校验（`isRegexSupported`）与
 * 替换引用越界两道，都在 `utils/dnrSupport.ts` 那一侧，而且是异步的。所以消费方必须自己补上
 * 那一层——`UrlTestDialog` 在「判定还没落到过一次」（`dnrSupportRead`）或这条规则已被标成
 * 不会应用时都不说话。少了那道，一条 RE2 拒收的规则会被这里断言成「网络层拿到 X」，
 * 而网络层对它什么都不做。
 */
export function findRegexRewriteDivergence(url: string, rule: ProxyRule): RegexRewriteDivergence | null {
  if (rule.matchType !== 'regex' || !rule.targetUrl || !url) return null;
  // 禁用的规则两条通道都轮不到它：`isSimpleRule` 只看能力面、不看生效面，
  // 所以这一格必须自己关上，否则界面上会出现「这条停用规则两通道不一致」。
  if (!rule.enabled || !isSimpleRule(rule)) return null;
  // 与 `rewriteUrl` 同一道 ReDoS 闸门（非 prefix 模式一律先量长度）。漏了它不只是白扫一次：
  // 超长时后台通道**原样返回**这条 URL，而这里仍会渲染出替换后的地址，
  // 于是报出一个「后台通道根本没算过」的差异——判据会当场变成谎话。
  if (isUrlTooLongForScan(url)) return null;
  // 编译与 ReDoS 筛查走 `getCompiledRegex`——与 `matchRule` / `rewriteUrl` 同一道闸门、同一份缓存。
  // 自己 `new RegExp` 就是第三份匹配器：那种模式后台通道根本不会命中（`matchRule` 对它返回
  // false），而这里若照常渲染，就报出一个「后台通道根本没算过」的差异。
  const regex = getCompiledRegex(rule.matchPattern);
  if (!regex) return null;
  const matched = regex.exec(url);
  if (!matched) return null;
  const networkUrl = renderRegexSubstitution(buildRegexSubstitution(rule), Array.from(matched));
  const extensionUrl = rewriteUrl(url, rule);
  return networkUrl === extensionUrl ? null : { networkUrl, extensionUrl };
}
