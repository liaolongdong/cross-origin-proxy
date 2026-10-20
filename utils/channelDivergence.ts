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
import { isSimpleRule, isUrlTooLongForScan, rewriteUrl } from '@/utils/urlMatcher';
import { buildRegexSubstitution } from '@/utils/dnrRules';

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
 * 扫描规则与 `dnrRules.ts` 的 `substitutionRefs` / `maxSubstitutionRef` 同一份口径：
 * `\\` 是字面量反斜杠、其后数字不构成引用；引用编号**贪婪读取**、越界或缺组时替换为空串。
 * 之所以两处都要贪婪读：DNR 实际只接受 `\1`-`\9`，多位引用在同步前就被过滤掉了
 * （见 `MAX_DNR_SUBSTITUTION_REF`），所以能走到这里的规则两种读法结果相同。
 */
export function renderRegexSubstitution(template: string, groups: readonly string[]): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== '\\') {
      out += template[i];
      continue;
    }
    const next = template[i + 1];
    if (next === undefined) break; // 结尾孤立的反斜杠：与 maxSubstitutionRef 同罪，丢弃
    if (next < '0' || next > '9') {
      out += next;
      i++;
      continue;
    }
    let j = i + 1;
    let digits = '';
    while (j < template.length && template[j] >= '0' && template[j] <= '9') {
      digits += template[j];
      j++;
    }
    out += groups[Number(digits)] ?? '';
    i = j - 1;
  }
  return out;
}

/**
 * 判定这笔 URL 在该规则下是否「两条通道会给出不同地址」
 *
 * 只在五个条件同时成立时才可能不一致：规则生效、走网络层通道、是正则规则、
 * 配了目标地址、模式能匹配。结果相同就返回 `null`——「配了正则规则」本身不是问题，
 * 「同一个请求两种答案」才是。
 * 正则本身编译不出来（非法或 RE2 与 JS 判定不一致）时也返回 `null`：那种规则早就被
 * `dnrSupport` 标成未生效，这里再插一句只会把两件事搅在一起。
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
  let matched: RegExpExecArray | null;
  try {
    matched = new RegExp(rule.matchPattern).exec(url);
  } catch {
    return null;
  }
  if (!matched) return null;
  const networkUrl = renderRegexSubstitution(buildRegexSubstitution(rule), Array.from(matched));
  const extensionUrl = rewriteUrl(url, rule);
  return networkUrl === extensionUrl ? null : { networkUrl, extensionUrl };
}
