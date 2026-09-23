/**
 * 「这一笔为什么没走代理」——一句话归因
 *
 * 判据本来就有，但散在五个地方：弹窗的通道格、未生效徽章、送达账、拦截器自报、URL 预演。
 * 老用户会自己拼，新用户不会，而这个品类最集中的差评恰恰是「装了没生效」。本模块**不新增
 * 任何判定**：它只把已有的纯函数（`findMatchingRule` / `matchRule` / `isSimpleRule` /
 * `isPatternUsable`）与调用方手上已有的异步事实（`dnrSkipped`、送达账）串成**第一个阻断原因**，
 * 并且每一条原因都指向界面上一个已经存在的动作。结论永远不可能与判据分叉——分叉的唯一可能
 * 是它自己另算一份判据，那在这里是禁止的。
 *
 * 归因顺序（一次只说一件最该先知道的事）：
 * 1. 没有规则、总开关关闭——这两条覆盖一切，先说；
 * 2. 命中了却仍不生效：浏览器不会应用这条网络层规则 → 这一页还在用旧规则集 → 命中的不是
 *    用户心里那条（被更高优先级抢走）→ 都没有问题；
 * 3. 没命中：模式覆盖但被禁用 → 模式覆盖但方法不在白名单 → 模式本身没被接受（永远不会命中）
 *    → 单纯没有规则覆盖这个地址。
 *
 * 「不知道」与「没问题」不共用一个结论：`dnrSkipped` 与 `pageSynced` 是异步事实，调用方
 * 没拿到就留 `undefined`，这一档整个跳过，而不是替它说一句「正常」。
 */

import type { ProxyRule } from '@/utils/types';
import type { DnrSkipReason } from '@/utils/dnrSupport';
import { findMatchingRule, isPatternUsable, isSimpleRule, matchRule } from '@/utils/urlMatcher';

/** 归因结论的编码；文案住在界面侧，判据侧不关心措辞 */
export type DiagnosisCode =
  /** 一条规则都没有 */
  | 'noRules'
  /** 总开关关闭：有规则也不会代理 */
  | 'proxyDisabled'
  /** 命中了，但这条网络层规则浏览器根本不会应用 */
  | 'ruleNotApplied'
  /** 命中了，但这一页还没用上最新配置（刷新即可） */
  | 'pageNotSynced'
  /** 命中的不是用户心里那条规则——被优先级更高的抢走了 */
  | 'shadowedBy'
  /** 有规则的模式覆盖这个地址，但它被禁用了 */
  | 'disabledMatch'
  /** 有规则的模式覆盖这个地址，但它的方法白名单不含这一笔 */
  | 'methodFiltered'
  /** 有启用的规则，但它的匹配模式没被接受（正则语法或嵌套量词筛查），永远不会命中 */
  | 'patternRejected'
  /** 没有任何规则覆盖这个地址 */
  | 'noMatch'
  /** 一切正常：这一笔会被命中的规则接管 */
  | 'ok';

/** 归因的输入：只收调用方**已经算到手**的事实，本模块不做任何异步判定 */
export interface DiagnosisInput {
  /** 待归因的请求地址（绝对地址）；空白地址直接按「没有规则覆盖」处理 */
  url: string;
  /** HTTP 方法；省略时与匹配层一致——不按方法白名单收窄 */
  method?: string;
  /** 全部规则（含已禁用的）：禁用项同样要能解释，所以不能只喂启用的 */
  rules: ProxyRule[];
  /** 代理总开关 */
  proxyEnabled: boolean;
  /** 浏览器不会应用的网络层规则（ruleId → 原因）；尚未判定时省略 */
  dnrSkipped?: ReadonlyMap<string, DnrSkipReason>;
  /** 这一页是否已经用上最新配置；`undefined` = 不适用或还没读到 */
  pageSynced?: boolean;
  /** 用户心里那条规则（从规则行进入预演时才有）：命中的不是它时才谈遮蔽 */
  expectedRuleId?: string;
}

/** 归因输出：编码 + 涉及到的规则，界面据此拼出一句人话 */
export interface Diagnosis {
  code: DiagnosisCode;
  /** 这句话关于哪条规则；`noRules` / `proxyDisabled` / `noMatch` 这类全局原因没有规则 */
  rule?: ProxyRule;
  /** `shadowedBy` 时抢走命中的那一条 */
  blocker?: ProxyRule;
  /** 仅 `code === 'ok'` 时有值：这一笔实际走的通道 */
  channel?: 'dnr' | 'sw';
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
 * 给一个请求地址做归因，返回第一个阻断原因
 *
 * 纯函数：不读 storage、不碰 `chrome.*`、不发起判定。异步事实（`dnrSkipped`、`pageSynced`）
 * 由调用方备好再传进来，缺哪一项就跳过哪一档。
 */
export function diagnoseRequest(input: DiagnosisInput): Diagnosis {
  const { url, method, rules, proxyEnabled, dnrSkipped, pageSynced, expectedRuleId } = input;
  const address = url.trim();
  if (!address) return { code: 'noMatch' };
  if (rules.length === 0) return { code: 'noRules' };
  if (!proxyEnabled) return { code: 'proxyDisabled' };

  const hit = findMatchingRule(address, rules, method);
  if (hit) {
    // 界面画着「已启用」，浏览器却不会应用它：这才是「为什么没生效」的第一答案。
    // 只有走网络层的规则才有这个面（后台通道由扩展自己发请求，不经过 RE2 校验）。
    if (dnrSkipped?.has(hit.id) && isSimpleRule(hit)) return { code: 'ruleNotApplied', rule: hit };
    // 规则没问题，但这一页跑的还是旧配置——送达账说它没接到最近一次广播
    if (pageSynced === false) return { code: 'pageNotSynced', rule: hit };
    // 命中的不是用户心里那条：只在确实给定、确实覆盖这个地址、且确实被别的规则抢走时说
    const expected = expectedRuleId ? rules.find(rule => rule.id === expectedRuleId) : undefined;
    if (expected && expected.id !== hit.id && expected.enabled && patternCovers(address, expected)) {
      return { code: 'shadowedBy', rule: expected, blocker: hit };
    }
    return { code: 'ok', rule: hit, channel: isSimpleRule(hit) ? 'dnr' : 'sw' };
  }

  // 没命中的四档解释，按「离用户已经做过的事」由近到远排
  const disabled = findCovering(rules, address, rule => !rule.enabled);
  if (disabled) return { code: 'disabledMatch', rule: disabled };

  // 模式覆盖却仍不命中，且给定过方法：只能是方法白名单挡下的（启用与覆盖都已确认）
  const wrongMethod = findCovering(rules, address, rule => rule.enabled && !!method);
  if (wrongMethod) return { code: 'methodFiltered', rule: wrongMethod };

  const rejected = rules.find(rule => rule.enabled && !isPatternUsable(rule));
  if (rejected) return { code: 'patternRejected', rule: rejected };

  return { code: 'noMatch' };
}
