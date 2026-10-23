/**
 * 连通性自检：把「装了没生效」要问的几件事按顺序摆成一屏
 *
 * 这个品类最集中的抱怨是「装了、开了、规则也在，可请求就是没被改」。答案散在四处：弹窗的开关与
 * 那一行「页面自报」、规则列表的「未生效」徽章、配置页的站点名单、URL 匹配预演。老用户会自己拼，
 * 新用户不会——所以他们去查后端，而问题在名单里少勾了一台站点。
 *
 * 本模块**不新增任何一条判定**：每一行问的都是一个已经存在的出口（`findMatchingRule` /
 * `isSimpleRule` / `siteAllows` / `describeDnrInstallState` 的回包 / 送达账 / `checkDnrRule`），
 * 它只决定「按什么顺序问、读到的是什么形状、该说哪一句」。这与 `utils/diagnosis.ts` 是同一条纪律：
 * 第二个「代理会怎么做」的模型就是下一次改动里两句话互相打脸的开始。
 *
 * 每一行都有 `unknown` 那一档，而且它不与 `ok` 共用一句：「没读到」画成「正常」是本仓反复堵的那类
 * 谎（`statusEverRead` / `logsEverRead` / `dnrSupportRead` 同族）。顺序也承重——按「离用户已经
 * 做过的事」由近到远，前一条不成立时后面几条多半都是连带结果，所以界面把第一条顶到最前。
 */

import type { ProxyRule, ProxyStatus, DnrInstallState, SiteState } from '@/utils/types';
import { siteAllows } from '@/utils/siteScope';
import { findMatchingRule, isSimpleRule } from '@/utils/urlMatcher';

/**
 * hash 里带过来的标签页 id：只认非负整数
 *
 * 那一串住在地址栏里，任何人改掉它就能让面板去问一个不该问的标签页。负数、小数、`1e999`、
 * 别人的字符串一律当「没带」——宁可不读那一格，也不要拿一个猜出来的 tab 去问「这一页收到配置了吗」。
 * 长度上限顺手挡掉 `Number` 精度之外的写法（12 位以内必然是 safe integer）。
 */
export function parseSelfCheckTab(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/**
 * 一行的结论：`ok` 正常、`warn` 值得看一眼、`fail` 就是它挡住了这一笔、`unknown` 没读到、
 * `pending` **这一项自己还没落定**（同步在排队、RE2 那份判定没跑完）。
 *
 * `pending` 与 `unknown` 都是「不作结论」，但它们是两件事，而且修法不同：一个是「去查为什么读不到」，
 * 一个是「稍等再看」。把它们并成一句就是把一次正常的中间态写成故障——与本仓「这一次还在路上」
 * 排在「读不到」之前那条同一口径。
 */
export type SelfCheckLevel = 'ok' | 'warn' | 'fail' | 'unknown' | 'pending';

/** 一行的结论加它要带的数据（状态码、条数、规则名——文案住在界面侧的 i18n，这里只给参数） */
export interface SelfCheckRow {
  /** 界面按这个挑那一句字面量 key（拼出来的键 i18n 的源码扫描查不到） */
  key: 'switch' | 'site' | 'delivery' | 'match' | 'install';
  level: SelfCheckLevel;
  /** 给 `t()` 的实参；条数一律先转成字符串，界面上不许出现 `undefined` 占位 */
  params?: string[];
}

/** 一次自检的全部读数：每一项都可能是 `null`——那是「这一项没读到」，不是「这一项没问题」 */
export interface SelfCheckFacts {
  /** `GET_PROXY_STATUS` 的回包（总开关、启用规则数、规则集） */
  status: ProxyStatus | null;
  /** 这一台页面的主机名；读不出（非 http(s)、扩展页、标签页已关）时为空串 */
  host: string;
  /** 站点生效范围；`null` = 没读到，与「读到一份空名单」是两件事 */
  siteState: SiteState | null;
  /**
   * 配置广播送达账：`null` = 没读到。
   * 只有**那一页真的是网页**时才会去问它（`host` 为空时不问，问回来也不算数）——
   * 扩展页与 `chrome://` 本来就不参与广播，对它们说「没有这一页没收到的记录」是一句关于不存在页面的话。
   */
  configSynced: boolean | null;
  /** 网络层装载状态；`null` = 没读到 */
  install: DnrInstallState | null;
  /** **完整**规则集（扩展页经 `GET_PROXY_CONFIG` 拿的那一份）；`null` = 这一笔没读到 */
  rules: ProxyRule[] | null;
  /** 拿来匹配的那条地址（那一页的文档地址）；读不出时那一行整行 `unknown` */
  probeUrl: string;
}

/** 开关那一行：关闭不是错误，但它确实是「这一笔没被改」最常见的那个原因 */
export function checkSwitchRow(status: ProxyStatus | null): SelfCheckRow {
  if (!status || typeof status.enabled !== 'boolean' || typeof status.activeRuleCount !== 'number') {
    return { key: 'switch', level: 'unknown' };
  }
  return { key: 'switch', level: status.enabled ? 'ok' : 'fail', params: [String(status.activeRuleCount)] };
}

/**
 * 站点生效范围那一行。
 *
 * 判据只有 `siteAllows` 一个出口——包括它「读不出发起页主机时只认『没有站点被停用』」那一档，
 * 这里不为它补一个更乐观的解释。名单读不到与名单里没有这台站点，是两句话。
 *
 * 主机名读不出时同样不作结论：`siteAllows(state, '')` 回答的是「没有发起页时该怎么办」（执行侧那一档），
 * 而这一行问的是「**那一页**在不在生效范围内」。没有那一页，`all` 档下回一句「在范围内」
 * 就是一句关于不存在的主机的确认——`selfCheckNoTab` 说的正是「有三行只能停在不知道」。
 */
export function checkSiteRow(siteState: SiteState | null, host: string): SelfCheckRow {
  if (!siteState || !host) return { key: 'site', level: 'unknown' };
  const allowed = siteAllows(siteState, host);
  // 主机名那一格自己就在面板标题上，这一行只补「它是哪一种名单」——那一句话的修法两种相反
  return { key: 'site', level: allowed ? 'ok' : 'fail', params: [siteState.mode] };
}

/**
 * 配置送达那一行。
 *
 * 这笔账**只记已知的问题**（`configSyncState.ts`：没有这笔账 = 「收到了，或从来没有过这笔账」），
 * 所以 `true` 只能翻译成「没有这一页没收到的记录」，翻不成「它收到了」——弹窗在 `true` 时根本不说活。
 *
 * 主机名读不出时整行不作结论，理由与站点那一行同一条：这一格问的是**那一页**有没有接住推送，
 * 而扩展页、`chrome://` 与已经关掉的标签页压根不参与广播（`broadcastConfigToTabs` 只发 http(s) 且
 * `complete` 的页面），对它们回一个「没有记录」正是那条被反复堵住的「把没读到画成没问题」。
 */
export function checkDeliveryRow(configSynced: boolean | null, host: string): SelfCheckRow {
  if (configSynced === null || !host) return { key: 'delivery', level: 'unknown' };
  return { key: 'delivery', level: configSynced ? 'ok' : 'warn' };
}

/**
 * 网络层装载那一行：装着几条 vs 按这份配置该装着几条。
 *
 * 两个数都必须是真读出来的数：缺一个就整行 `unknown`，而不是拿 0 去补出一个「0 对 0，一切正常」
 * （`isStatus` 那扇形状闸门同理，两处的口径必须一致——这一屏的全部价值就在于「没读到」有三种说法）。
 * `syncing` 落 `pending` 而不是 `unknown`：那一刻两个数**都读到了**，只是差值还没落定，
 * 说成「读不到」会把一件正在正常发生的事写成故障。
 */
export function checkInstallRow(install: DnrInstallState | null): SelfCheckRow {
  if (!install || install.readable !== true) return { key: 'install', level: 'unknown' };
  if (!Number.isFinite(install.installed) || !Number.isFinite(install.expected)) {
    return { key: 'install', level: 'unknown' };
  }
  const params = [String(install.installed), String(install.expected)];
  if (install.syncing === true) return { key: 'install', level: 'pending', params };
  if (install.installed === install.expected) return { key: 'install', level: 'ok', params };
  // 两侧对不上：最常见的是最近一次 `updateDynamicRules` 被整批拒了（一条非法项就够），
  // 但这一格只说得出「对不上」——装得比该装的还多也有别的原因，界面上不许替它认其中一个
  return { key: 'install', level: 'fail', params };
}

/**
 * 命中那一行：这一页这条地址，现在会被哪条规则、走哪条通道
 *
 * 三条判据各是一个出口，这里只是把它们并排读一遍：
 * `findMatchingRule`（哪条赢了）、`isSimpleRule`（赢的那条走网络层还是转发通道）、
 * 以及它是否「浏览器根本不会应用」（`skippedRuleIds` 由调用方经 `checkDnrRule` 算好交进来——
 * 那一头是异步的 RE2 校验，纯函数不碰 chrome，本模块因此也不碰）。
 * 「命中了但浏览器不会应用」单独成一档 `fail`：它是这一屏里唯一「界面上写着已启用、实际零作用」的形状。
 *
 * 三种「不作结论」在这一行里是分开的两档：规则集或地址没读到是 `unknown`；命中了网络层、
 * 但那份 RE2 判定**一次都还没落到**是 `pending`——这一行其实知道两件事（命中谁、走哪条通道），
 * 只是说不出第三件（浏览器会不会应用它）。把它压成 `unknown` 会把已经知道的那两件一起丢掉，
 * 压成 `ok` 就是拿「没被跳过」当「会被应用」（`useDnrSupport` 的 `dnrSupportRead` 同一条）。
 *
 * `rules` 必须是**完整**的规则集：`ProxyStatus.rules` 只有 `{id,name,enabled}` 三项，
 * 拿它去问 `isSimpleRule` 会把一条注头规则说成走网络层——那一格的谎正好指向错误的下一步。
 */
export function checkMatchRow(
  rules: ProxyRule[] | null,
  probeUrl: string,
  skippedRuleIds: Set<string> | null,
): SelfCheckRow {
  // 规则集没读到与「读了、没有一条命中」是两件事：把前者说成后者，用户会去新建一条本来就已经在的规则
  if (!probeUrl || !rules) return { key: 'match', level: 'unknown' };
  const rule = findMatchingRule(probeUrl, rules);
  if (!rule) return { key: 'match', level: 'warn', params: [] };
  const via = isSimpleRule(rule) ? 'network' : 'forward';
  // 网络层那条还要问第三家：浏览器到底会不会应用它。那份判定没落到过（`null`）时这一格只说得出两件事，
  // 第三件留给 `pending`——把「没判完」写成「会被应用」正是 URL 匹配预演那边反复堵过的同一格
  if (via === 'network') {
    if (skippedRuleIds === null) return { key: 'match', level: 'pending', params: [rule.name, via] };
    if (skippedRuleIds.has(rule.id)) return { key: 'match', level: 'fail', params: [rule.name, via] };
  }
  return { key: 'match', level: 'ok', params: [rule.name, via] };
}

/**
 * 按顺序摆出这几行。
 *
 * 顺序就是排查顺序：开关 → 这一页在不在名单里 → 这一页有没有拿到最新配置 → 这条地址命中谁 →
 * 网络层到底装上了几条。前一条不成立时后面的多半是连带结果，所以界面把第一条留在最上面，
 * 而不是把所有行按严重度重排（重排会让「命中谁」这种最有信息量的一行忽上忽下）。
 */
export function buildSelfCheckRows(facts: SelfCheckFacts, skippedRuleIds: Set<string> | null = null): SelfCheckRow[] {
  return [
    checkSwitchRow(facts.status),
    checkSiteRow(facts.siteState, facts.host),
    checkDeliveryRow(facts.configSynced, facts.host),
    checkMatchRow(facts.rules, facts.probeUrl, skippedRuleIds),
    checkInstallRow(facts.install),
  ];
}
