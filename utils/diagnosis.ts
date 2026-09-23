/**
 * 「这一笔为什么没走代理」——一句话归因
 *
 * 判据本来就有，但散在五个地方：弹窗的通道格、未生效徽章、送达账、拦截器自报、URL 预演。
 * 老用户会自己拼，新用户不会，而这个品类最集中的差评恰恰是「装了没生效」。本模块**不新增
 * 任何判定**：它只把已有的纯函数（`findMatchingRule` / `matchRule` / `isPatternUsable`）串成
 * **第一个阻断原因**，并且每一条原因都指向界面上一个已经存在的动作。结论永远不可能与判据
 * 分叉——分叉的唯一可能是它自己另算一份判据，那在这里是禁止的。
 *
 * 射程只有一件事：**这一笔没命中任何规则，为什么**。命中了却不生效的那几档（浏览器不会应用
 * 这条网络层规则、这一页还在跑旧规则集、命中的不是用户心里那条）在两个界面上都已经各有一句
 * 话——通道格旁的「未生效」标记、弹窗的「这一页还没收到最新配置」、预演结果里排在获胜者后面的
 * 那份遮蔽清单——这里再算一份就是同一个事实的第二个出口，所以本模块**不做**那三档，
 * `findMatchingRule` 一旦有结果就直接交给它们。
 *
 * 归因顺序（一次只说一件最该先知道的事，按「离用户已经做过的事」由近到远）：
 * 1. 一条规则都没有；
 * 2. 模式覆盖但被禁用（且它自己的方法白名单确实放得过这一笔）；
 * 3. 模式覆盖、启用中，但方法不在白名单里；
 * 4. 有一条启用中的规则的模式永远编译不过，而它的话头像是在说这个地址；
 * 5. 都没有：这个地址确实不被任何规则覆盖。
 *
 * 「不知道」与「没问题」不共用一个结论：说不出成因时回到 `noMatch`，让界面维持它本来那句
 * 「未命中」，而不是替用户编一个原因。
 */

import type { ProxyRule } from '@/utils/types';
import { findMatchingRule, isPatternUsable, matchRule } from '@/utils/urlMatcher';

/** 归因结论的编码；文案住在界面侧，判据侧不关心措辞 */
export type DiagnosisCode =
  /** 一条规则都没有 */
  | 'noRules'
  /** 有规则的模式覆盖这个地址，但它被禁用了 */
  | 'disabledMatch'
  /** 有规则的模式覆盖这个地址，但它的方法白名单不含这一笔 */
  | 'methodFiltered'
  /** 有启用的规则，但它的匹配模式没被接受（正则语法或嵌套量词筛查），永远不会命中 */
  | 'patternRejected'
  /** 没有任何规则覆盖这个地址，或者说不出成因 */
  | 'noMatch';

/** 归因的输入：只收调用方**已经算到手**的事实，本模块不做任何异步判定 */
export interface DiagnosisInput {
  /** 待归因的请求地址（绝对地址）；空白地址直接按「没有规则覆盖」处理 */
  url: string;
  /** HTTP 方法；省略时与匹配层一致——不按方法白名单收窄 */
  method?: string;
  /** 全部规则（含已禁用的）：禁用项同样要能解释，所以不能只喂启用的 */
  rules: ProxyRule[];
  /** 代理总开关：关闭时这里一句话也不说，那一句话是开关那一行自己的 */
  proxyEnabled: boolean;
}

/** 归因输出：编码 + 涉及到的规则，界面据此拼出一句人话 */
export interface Diagnosis {
  code: DiagnosisCode;
  /** 这句话关于哪条规则；`noRules` / `noMatch` 这类全局原因没有规则 */
  rule?: ProxyRule;
}

/**
 * 只看「模式覆不覆盖这个地址」，忽略启用状态与方法白名单
 *
 * 复用 `matchRule` 而不是再解析一遍模式：把禁用项就地打开、方法白名单清空，得到的就是
 * 纯粹的模式覆盖判定，通配符/前缀/正则的语义仍然只有 `urlMatcher` 一份。副本是浅拷贝
 * 加两个覆盖字段，不改到调用方手里那条规则。
 */
function patternCovers(url: string, rule: ProxyRule): boolean {
  return matchRule(url, { ...rule, enabled: true, methods: undefined });
}

/** 找第一条「模式覆盖这个地址」且满足附加条件的规则 */
function findCovering(rules: ProxyRule[], url: string, accept: (rule: ProxyRule) => boolean): ProxyRule | undefined {
  return rules.find(rule => accept(rule) && patternCovers(url, rule));
}

/**
 * 这条规则的话头像是在说这个地址吗——只管排除明显不相干的，不主张「它在说」
 *
 * 模式编译不过，就无从用匹配层判断它覆不覆盖这个地址，而 `matchPattern` 是用户自己写的原文：
 * 一个 200 条规则的库里的某条坏正则，光凭「它是坏的」被点名成**这一笔**没命中的原因，就是把
 * 不相干的毛病递到读者脸上。所以这里只做一个保守的前置：模式原文（去掉转义反斜杠之后）得含
 * 这个地址的主机名，才允许它被点名。原文里带着 `https://fat\.example\.com/...` 这样的主机名时
 * 才算「像是为这个地址写的」；地址解析不出来、模式里压根没有主机名，一律不点名。
 * 这条判据刻意**不是**覆盖判定——它宁可少说一句，也不多说一句。
 */
function plausiblyAbout(rule: ProxyRule, address: string): boolean {
  const host = readHost(address);
  if (!host) return false;
  return rule.matchPattern.replace(/\\/g, '').toLowerCase().includes(host.toLowerCase());
}

/** 取地址的主机名；解析不出来的（含没带协议的草稿）按「不知道」处理 */
function readHost(address: string): string {
  try {
    return new URL(address).hostname;
  } catch {
    return '';
  }
}

/**
 * 给一个请求地址做归因，返回第一个阻断原因
 *
 * 纯函数：不读 storage、不碰 `chrome.*`、不发起判定。
 */
export function diagnoseRequest(input: DiagnosisInput): Diagnosis {
  const { url, method, rules, proxyEnabled } = input;
  const address = url.trim();
  if (!address) return { code: 'noMatch' };
  if (rules.length === 0) return { code: 'noRules' };
  // 开关关闭时开关那一行自己会说话；这里回到 `noMatch`（= 「这一句没有可补充的信息」），
  // 而不是把「它被禁用」当成这一笔没走代理的原因——真那样说只讲了一半。
  if (!proxyEnabled) return { code: 'noMatch' };

  // 命中了却不生效的那几档不归这里（见文件头）：有结果就把那句话让给界面上已有的那三处。
  if (findMatchingRule(address, rules, method)) return { code: 'noMatch' };

  // 禁用项要能被这一笔的方法白名单放过，才谈得上「打开它就生效」：一条只处理 POST 的
  // 禁用规则，对这一笔 GET 来说打开也不生效，点名它就是给一半的修法。
  const disabled = findCovering(rules, address, rule => !rule.enabled && admitsMethod(rule, method));
  if (disabled) return { code: 'disabledMatch', rule: disabled };

  // 模式覆盖却仍不命中，且给定过方法：只能是方法白名单挡下的（启用与覆盖都已确认）
  const wrongMethod = findCovering(rules, address, rule => rule.enabled && !!method);
  if (wrongMethod) return { code: 'methodFiltered', rule: wrongMethod };

  const rejected = rules.find(rule => rule.enabled && !isPatternUsable(rule) && plausiblyAbout(rule, address));
  if (rejected) return { code: 'patternRejected', rule: rejected };

  return { code: 'noMatch' };
}

/**
 * 这一笔的方法在这条规则自己的白名单里吗
 *
 * 与匹配层同一口径：`methods` 为空 = 不限方法；省略 `method` 时不拿白名单收窄（匹配层也
 * 是这么处理的），此时「打开它就生效」这话依然成立。
 */
function admitsMethod(rule: ProxyRule, method?: string): boolean {
  if (!method || !rule.methods || rule.methods.length === 0) return true;
  return rule.methods.some(item => item.toUpperCase() === method.toUpperCase());
}
