/**
 * 自检面板的副作用：五笔读数各读各的，谁失败了都不连累别人
 *
 * 判据全部住在 `utils/selfCheck.ts`（每一行问的都是一个已有的出口），这一层只管「发哪几条消息、
 * 读回没读回」。之所以单独成一层：这几笔的**部分失败**正是本功能的主要形状——一条消息抛错
 * 只该让那一行变成「不知道」；让整屏消失，或把没读到的那一格画成正常，都比"少一行"糟得多。
 * 而「A 成功、B 失败时屏幕上是什么」只有在运行时才测得动——这个环境里组件渲染没有对应物，
 * 所以它放在 composable 里按假 `chrome` 测（`tests/composablesSelfCheck.test.ts`）。
 */
import { ref } from 'vue';
import type { DnrInstallState, ProxyConfig, ProxyRule, ProxyStatus, SiteState } from '@/utils/types';
import { MessageType } from '@/utils/types';
import { hostnameOf } from '@/utils/siteScope';
import { logger } from '@/utils/logger';
import { configRules } from '@/utils/storage';

/** 一次自检的读数现场：每一项都是「读到了」才有值，`null` 一律是「这一项没读到」 */
export interface SelfCheckReadout {
  /** 这一轮还在路上：首屏不许先下结论，也不许把上一轮的读数当这一次的 */
  reading: boolean;
  status: ProxyStatus | null;
  siteState: SiteState | null;
  install: DnrInstallState | null;
  /** 完整规则集（扩展页经 `GET_PROXY_CONFIG` 拿的那一份，不经站点范围收窄） */
  rules: ProxyRule[] | null;
  /** 送达账那一格：`null` = 没读到，或这一屏根本没有对应的网页标签页 */
  configSynced: boolean | null;
  /** 被检查那一页的地址与主机名；读不出（标签页已关、非 http(s)）时都是空串 */
  probeUrl: string;
  host: string;
}

/** 空的一屏：所有行都落到「不知道」那一档，而不是「一切正常」 */
function emptyReadout(reading: boolean): SelfCheckReadout {
  return {
    reading,
    status: null,
    siteState: null,
    install: null,
    rules: null,
    configSynced: null,
    probeUrl: '',
    host: '',
  };
}

/** 回包只认「形状对的那一份」：回收期那封 `{success:false}` 信封与抛错同档，都算没读到 */
async function ask<T>(payload: unknown, validate: (raw: unknown) => raw is T): Promise<T | null> {
  try {
    const raw: unknown = await chrome.runtime.sendMessage(payload);
    return validate(raw) ? raw : null;
  } catch (error) {
    logger.warn('自检有一笔没读到:', error instanceof Error ? error.name : typeof error);
    return null;
  }
}

/**
 * 状态那一笔的闸门把 `activeRuleCount` 也算进形状：`ProxyStatus` 声明它是必填的数，
 * 而开关那一行要把这个数说出口。缺了它还采纳，界面就说出一句「启用规则 0 条」——
 * 那是把「没读到」画成一个看起来很像结论的数（`statusEverRead` 同族的那条老规矩）。
 */
const isStatus = (raw: unknown): raw is ProxyStatus =>
  !!raw &&
  typeof raw === 'object' &&
  typeof (raw as ProxyStatus).enabled === 'boolean' &&
  typeof (raw as ProxyStatus).activeRuleCount === 'number';
const isConfig = (raw: unknown): raw is ProxyConfig =>
  !!raw && typeof raw === 'object' && Array.isArray((raw as ProxyConfig).rules);
const isSiteState = (raw: unknown): raw is SiteState =>
  !!raw && typeof raw === 'object' && (raw as SiteState).mode !== undefined && Array.isArray((raw as SiteState).hosts);
const isInstall = (raw: unknown): raw is DnrInstallState =>
  !!raw &&
  typeof raw === 'object' &&
  typeof (raw as DnrInstallState).readable === 'boolean' &&
  typeof (raw as DnrInstallState).syncing === 'boolean' &&
  Number.isFinite((raw as DnrInstallState).installed) &&
  Number.isFinite((raw as DnrInstallState).expected);
const isSyncedPacket = (raw: unknown): raw is { synced: boolean } =>
  !!raw && typeof raw === 'object' && typeof (raw as { synced: boolean }).synced === 'boolean';

export function useSelfCheck() {
  const readout = ref<SelfCheckReadout>(emptyReadout(true));

  /** 轮次令牌：迟到那一笔不许写回已经换掉的一屏（与 `useDnrSupport` 的 `checkSeq` 同一族） */
  let round = 0;

  /**
   * 读这一屏。`tabId` 为 `null` 时不去猜「当前页」——
   * 配置页自己就是 `tabs.query({active})` 眼里的那一页，拿它当「这一页」会让那句「这一页还没收到
   * 最新配置」指向扩展页面本身（弹窗那一格被收窄过的那条理由在这里同样成立）。
   */
  async function refresh(tabId: number | null): Promise<void> {
    const thisRound = ++round;
    readout.value = emptyReadout(true);

    const [status, siteState, install, config] = await Promise.all([
      ask({ type: MessageType.GET_PROXY_STATUS }, isStatus),
      ask({ type: MessageType.GET_SITE_STATE }, isSiteState),
      ask({ type: MessageType.GET_DNR_INSTALL_STATE }, isInstall),
      ask({ type: MessageType.GET_PROXY_CONFIG }, isConfig),
    ]);

    let probeUrl = '';
    let host = '';
    let configSynced: boolean | null = null;
    if (tabId !== null) {
      // 次序是承重的：**先**问那一页是什么，再决定要不要问送达账。
      // 反过来（先问账、再读页）会让扩展页与已关掉的标签页也拿到一个 `{synced:true}`——
      // 而那笔账从来没有为它们记过（广播只发 http(s) 且 `complete` 的页面），
      // 于是屏幕上会出现「这一页收到了推送」与「没有对应的网页标签页」并存的一屏。
      try {
        const tab = await chrome.tabs.get(tabId);
        const url = typeof tab?.url === 'string' ? tab.url : '';
        host = hostnameOf(url);
        // 只有 http(s) 那几格才谈得上「这一页会不会被改写」：`chrome://`、扩展页本来就在射程之外，
        // 拿它们去匹配规则会问出一句「没有规则命中」，而那是一句没被问过的问题
        probeUrl = host ? url : '';
      } catch (error) {
        // 标签页已经关掉是最常见的一种：那一行画「不知道」，不画「这一页没命中规则」
        logger.warn('自检读不到那一页:', error instanceof Error ? error.name : typeof error);
      }
      if (host) {
        const syncedPacket = await ask({ type: MessageType.GET_CONFIG_SYNC, data: { tabId } }, isSyncedPacket);
        configSynced = syncedPacket ? syncedPacket.synced : null;
      }
    }

    if (thisRound !== round) return;
    readout.value = {
      reading: false,
      status,
      siteState,
      install,
      rules: config ? configRules(config) : null,
      configSynced,
      probeUrl,
      host,
    };
  }

  return { readout, refresh };
}
