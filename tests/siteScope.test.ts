/**
 * 站点维度的生效范围（`utils/siteScope.ts`）——两条通道共用一份判据
 *
 * 这一层最容易坏在三件事上，测试就按这三件写：
 * 1. **键的口径**。判据按主机名记（含子域），因为网络层 `initiatorDomains` 只看域名，不看协议与端口。
 *    扩展侧若按 origin 记，就会出现「同一台站点 `:3000` 关了、`:4000` 还在改写」——本仓最贵的那类分叉。
 * 2. **名单在两种模式里含义相反**。界面说的是结果（这台站点走不走代理），所以「打开/关闭开关」到
 *    名单的翻译必须由判据这一侧做（`withHostActive`），这里逐格钉住那张真值表。
 * 3. **读不到时不许编结论**。`sanitizeSiteState` 一律回落默认值，界面那侧另有「没读到」那一档；
 *    而 `site-only` + 空名单不是任何人的意图，回落 `all` 比「一台都不代理」安全。
 *
 * DNR 那一格刻意断「`all` 时规则原文与这一层不存在时逐字节相同」——那是一切既有安装的回归底线。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SITE_STATE,
  hostnameOf,
  sanitizeSiteState,
  siteAllows,
  siteScopeToggle,
  withHostActive,
  withoutHost,
  dnrInitiatorCondition,
} from '@/utils/siteScope';
import { buildDnrRules } from '@/utils/dnrRules';
import { MAX_SITE_STATE_HOSTS } from '@/utils/constants';
import type { ProxyRule, SiteState } from '@/utils/types';

function rule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r1',
    name: 'fat→uat',
    enabled: true,
    matchPattern: 'https://fat.example.com/*',
    targetUrl: 'https://uat.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('sanitizeSiteState — storage 原文一律当不可信输入', () => {
  it('非对象、数组、null 一律回落默认值', () => {
    for (const raw of [undefined, null, 'x', 42, [], ['a.example.com']]) {
      expect(sanitizeSiteState(raw)).toEqual({ mode: 'all', hosts: [] });
    }
  });

  it('模式只认三个字面量，其余按 all；主机名去重、小写、限长', () => {
    const state = sanitizeSiteState({
      mode: 'whatever',
      hosts: ['A.Example.com', 'a.example.com', 'https://b.example.com', 'b:8443', 'nospace', 'ok.example.cn'],
    });
    expect(state).toEqual({ mode: 'all', hosts: ['a.example.com', 'ok.example.cn'] });
  });

  it('条目数收在 MAX_SITE_STATE_HOSTS 内（越界的是末尾那些，不是随机丢）', () => {
    const hosts = Array.from({ length: MAX_SITE_STATE_HOSTS + 9 }, (_, i) => `h${i}.example.com`);
    const state = sanitizeSiteState({ mode: 'site-off', hosts });
    expect(state.hosts).toHaveLength(MAX_SITE_STATE_HOSTS);
    expect(state.hosts[0]).toBe('h0.example.com');
  });

  it('「仅列出的站点」配空名单回落 all（一台都不代理不是任何人的意图）', () => {
    expect(sanitizeSiteState({ mode: 'site-only', hosts: [] })).toEqual({ mode: 'all', hosts: [] });
  });
});

describe('siteAllows — 判定矩阵（含子域、不看端口与协议）', () => {
  const off: SiteState = { mode: 'site-off', hosts: ['fat.example.com'] };
  const only: SiteState = { mode: 'site-only', hosts: ['fat.example.com'] };

  it('all 模式下任何主机都放行', () => {
    for (const host of ['anything.test', 'fat.example.com', '']) {
      expect(siteAllows(DEFAULT_SITE_STATE, host)).toBe(true);
    }
  });

  it('site-off 排除该主机及其子域，别的站点不受牵连', () => {
    expect(siteAllows(off, 'fat.example.com')).toBe(false);
    expect(siteAllows(off, 'api.fat.example.com')).toBe(false);
    expect(siteAllows(off, 'uat.example.com')).toBe(true);
    // 大小写不敏感（发起页主机名可能是任何写法）
    expect(siteAllows(off, 'FAT.EXAMPLE.COM')).toBe(false);
  });

  it('site-only 只放行名单内（含子域）', () => {
    expect(siteAllows(only, 'fat.example.com')).toBe(true);
    expect(siteAllows(only, 'api.fat.example.com')).toBe(true);
    expect(siteAllows(only, 'other.example.com')).toBe(false);
  });

  it('读不出发起页主机时：排除档放行、白名单档拦下——与网络层同侧', () => {
    // DNR 侧：无 initiator 的请求根本匹配不上带 initiatorDomains 的规则，而 excludedInitiatorDomains 不排它
    expect(siteAllows(off, '')).toBe(true);
    expect(siteAllows(only, '')).toBe(false);
  });

  it('「example.com」这一条覆盖所有子域，所以「a.example.com」也已被排除时不必再记一条', () => {
    const broad: SiteState = { mode: 'site-off', hosts: ['example.com'] };
    expect(siteAllows(broad, 'fat.example.com')).toBe(false);
    expect(siteAllows(broad, 'deep.sub.example.com')).toBe(false);
    expect(siteAllows(broad, 'example.com.evil.test')).toBe(true);
  });
});

describe('withHostActive — 界面那句「这台站点走不走代理」到名单的翻译', () => {
  it('all 档关掉这一台 → 建起排除名单', () => {
    expect(withHostActive(DEFAULT_SITE_STATE, 'fat.example.com', false)).toEqual({
      mode: 'site-off',
      hosts: ['fat.example.com'],
    });
  });

  it('all 档打开这一台 → 什么都不变（本来就在生效）', () => {
    expect(withHostActive(DEFAULT_SITE_STATE, 'fat.example.com', true)).toEqual(DEFAULT_SITE_STATE);
  });

  it('site-off 档：打开=从名单移除，关掉=加进名单，删空则回到 all', () => {
    const off: SiteState = { mode: 'site-off', hosts: ['fat.example.com'] };
    expect(withHostActive(off, 'fat.example.com', true)).toEqual({ mode: 'all', hosts: [] });
    expect(withHostActive(off, 'uat.example.com', false)).toEqual({
      mode: 'site-off',
      hosts: ['fat.example.com', 'uat.example.com'],
    });
  });

  it('site-only 档：同一句「打开」含义相反——加进白名单；关掉则移出', () => {
    const only: SiteState = { mode: 'site-only', hosts: ['fat.example.com'] };
    expect(withHostActive(only, 'uat.example.com', true)).toEqual({
      mode: 'site-only',
      hosts: ['fat.example.com', 'uat.example.com'],
    });
    expect(withHostActive(only, 'fat.example.com', false)).toEqual({ mode: 'all', hosts: [] });
  });

  it('父域覆盖子域时不伪造一次成功：开关意图无法由精确条目表达，原状态交回', () => {
    const off: SiteState = { mode: 'site-off', hosts: ['example.com'] };
    expect(withHostActive(off, 'app.example.com', true)).toEqual(off);
    const only: SiteState = { mode: 'site-only', hosts: ['example.com'] };
    expect(withHostActive(only, 'app.example.com', false)).toEqual(only);
  });

  it('名单已满时拒绝而不是挤掉别人：被 slice 掉的永远是字母序最后那台，与用户点的这台无关', () => {
    const hosts = Array.from({ length: MAX_SITE_STATE_HOSTS }, (_, i) => `h${String(i).padStart(2, '0')}.test`);
    const off: SiteState = { mode: 'site-off', hosts };
    // 这台按字典序排在最后 —— 旧写法 `[...hosts, host].sort().slice(0, 50)` 丢掉的是它，不是这一台
    const result = siteScopeToggle(off, 'zz.test', false);
    expect(result.blocked).toBe('capReached');
    expect(result.state).toEqual(off);
    expect(siteAllows(result.state, 'zz.test'), '拒绝必须真的拒绝：那台仍在生效').toBe(true);
    expect(siteAllows(result.state, 'h49.test'), '别人的条目不许被顺手抹掉').toBe(false);
    // 移出同样满员，但它不越界，照常允许
    expect(siteScopeToggle(off, hosts[0], true)).toEqual({
      state: { mode: 'site-off', hosts: hosts.slice(1) },
      blocked: null,
    });
  });

  it('两种「翻译不出来」各给一个原因，界面才说得出是哪一个', () => {
    const off: SiteState = { mode: 'site-off', hosts: ['example.com'] };
    expect(siteScopeToggle(off, 'app.example.com', true).blocked).toBe('parentCovered');
    const full: SiteState = {
      mode: 'site-only',
      hosts: Array.from({ length: MAX_SITE_STATE_HOSTS }, (_, i) => `h${String(i).padStart(2, '0')}.test`),
    };
    expect(siteScopeToggle(full, 'zz.test', true).blocked).toBe('capReached');
    expect(siteScopeToggle(DEFAULT_SITE_STATE, 'fat.test', true).blocked).toBeNull();
    expect(siteScopeToggle(DEFAULT_SITE_STATE, 'fat.test', false).blocked).toBeNull();
  });

  it('换档意图不丢名单：site-off 与 site-only 之间由 mode 表达，withHostActive 不改 mode', () => {
    const off: SiteState = { mode: 'site-off', hosts: ['a.test', 'b.test'] };
    expect(withHostActive(off, 'c.test', false).mode).toBe('site-off');
  });

  it('非法主机名不改状态（读不到发起页时点开关，不该写出一个空条目）', () => {
    const off: SiteState = { mode: 'site-off', hosts: ['a.test'] };
    for (const junk of ['', 'https://a.test', 'a.test:8443', '*.test', 'not a host']) {
      expect(withHostActive(off, junk, false)).toEqual(off);
    }
  });

  it('不改入参', () => {
    const before: SiteState = { mode: 'site-off', hosts: ['a.test'] };
    const snapshot = JSON.parse(JSON.stringify(before));
    withHostActive(before, 'b.test', false);
    withoutHost(before, 'a.test');
    expect(before).toEqual(snapshot);
  });
});

describe('withoutHost — 设置页那颗删除', () => {
  it('删掉最后一台就回到 all', () => {
    expect(withoutHost({ mode: 'site-only', hosts: ['a.test'] }, 'a.test')).toEqual({ mode: 'all', hosts: [] });
  });

  it('白名单里删一台而还有剩余：mode 保持', () => {
    expect(withoutHost({ mode: 'site-only', hosts: ['a.test', 'b.test'] }, 'a.test')).toEqual({
      mode: 'site-only',
      hosts: ['b.test'],
    });
  });
});

describe('hostnameOf — 发起页主机名的唯一取法', () => {
  it('读不出的 URL 一律空串，不抛', () => {
    expect(hostnameOf('https://FAT.Example.com:8443/a?b=1')).toBe('fat.example.com');
    for (const junk of ['', undefined, null, 'not a url', 'chrome://extensions']) {
      expect(hostnameOf(junk)).toBe('');
    }
  });
});

describe('DNR 条件 — 这一层不参与时规则原文必须逐字节相同', () => {
  const rules = [rule()];

  it('all（含缺省参数）产出的 condition 里没有 initiator 相关键', () => {
    const baseline = buildDnrRules(rules, true).rules;
    const withAll = buildDnrRules(rules, true, DEFAULT_SITE_STATE).rules;
    expect(JSON.stringify(withAll)).toBe(JSON.stringify(baseline));
    expect(withAll[0].condition.initiatorDomains).toBeUndefined();
    expect(withAll[0].condition.excludedInitiatorDomains).toBeUndefined();
  });

  it('site-off 写 excludedInitiatorDomains，site-only 写 initiatorDomains，每一条都有', () => {
    const two = [rule(), rule({ id: 'r2', matchPattern: 'https://other.test/*' })];
    const off = buildDnrRules(two, true, { mode: 'site-off', hosts: ['fat.example.com'] }).rules;
    const only = buildDnrRules(two, true, { mode: 'site-only', hosts: ['fat.example.com'] }).rules;
    expect(off.every(r => r.condition.excludedInitiatorDomains?.join() === 'fat.example.com')).toBe(true);
    expect(off.every(r => r.condition.initiatorDomains === undefined)).toBe(true);
    expect(only.every(r => r.condition.initiatorDomains?.join() === 'fat.example.com')).toBe(true);
    expect(only.every(r => r.condition.excludedInitiatorDomains === undefined)).toBe(true);
  });

  it('条件里的名单是拷贝：调用方之后改自己的数组不会串进已生成的规则', () => {
    const state: SiteState = { mode: 'site-off', hosts: ['a.test'] };
    const built = buildDnrRules(rules, true, state).rules;
    state.hosts.push('b.test');
    expect(built[0].condition.excludedInitiatorDomains).toEqual(['a.test']);
    expect(dnrInitiatorCondition(state)).toEqual({ excludedInitiatorDomains: ['a.test', 'b.test'] });
  });
});

/**
 * 接线契约（本环境测不到渲染，只能按源码钉的少数几条）
 *
 * 每条都对应一个「坏了没人报」的后果，所以判据都写成改动会红的形状：被钉的表达式在文件里
 * 可能有多个调用点时一律数次数。
 */
describe('接线 — 两条通道、导出隔离与「谁都不许自己判」', () => {
  const read = (p: string) => readFileSync(p, 'utf8') as string;
  const router = read('entrypoints/background/messageRouter.ts');
  const manager = read('entrypoints/background/dnrManager.ts');
  const handler = read('entrypoints/background/proxyHandler.ts');
  const bridge = read('entrypoints/content.ts');
  const mainInterceptor = read('entrypoints/main-interceptor.content.ts');
  const popup = read('entrypoints/popup/App.vue');
  const settings = read('components/options/SettingsDialog.vue');
  const exportSanitize = read('utils/exportSanitize.ts');
  const importExport = read('composables/useImportExport.ts');

  it('内容脚本按 frame 收窄，扩展页始终拿完整配置', () => {
    expect(router).toContain('const requesterHost = hostnameOf(sender.url);');
    expect(router).toContain('if (!requesterHost) return config;');
    expect(router).toContain('siteAllows(siteState, requesterHost)');
    expect(manager).toContain('data: { enabled: config.enabled, rules: complexRules, siteState }');
    expect(bridge).toContain(
      'rulesForSite(Array.isArray(config.rules) ? config.rules : [], config.siteState, window.location.hostname)',
    );
  });

  it('代发前再判一次，且带的是 Chrome 写的 frame sender 主机名', () => {
    expect(router).toContain('hostnameOf(sender.url),');
    expect(handler).toContain('siteAllows(await getSiteState(), senderHost) === false');
  });

  it('站点清单变化会重建 DNR 并重广播（规则一条没动，生效范围却整个换了）', () => {
    // 监听器只负责「换档了就重来一次」，重同步本身是那个命名函数——`initDnrManager` 的函数体
    // 必须保持在「同步阶段只注册监听」的形状里（`tests/dnrSupport.test.ts` 也钉着同一件事）
    const listener = manager.slice(
      manager.indexOf('STORAGE_KEYS.SITE_STATE in changes'),
      manager.indexOf('STORAGE_KEYS.PROXY_CONFIG in changes'),
    );
    expect(listener).toContain('void resyncForSiteScopeChange()');
    const resync = manager.slice(
      manager.indexOf('async function resyncForSiteScopeChange'),
      manager.indexOf('/** 启动时按存储里的配置全量重建一次 DNR 规则 */'),
    );
    expect(resync).toContain('await syncDnrRules(config)');
    expect(resync).toContain('await broadcastConfigToTabs(config)');
  });

  it('这一层不进任何导出：分享的配置不该连带交出「你在哪几台站点关过代理」', () => {
    expect(exportSanitize).not.toContain('SITE_STATE');
    expect(importExport).not.toContain('SITE_STATE');
  });

  it('ISOLATED bridge 按 frame 收窄，MAIN world 仍不持有第二份站点判据', () => {
    expect(bridge).toContain('rulesForSite');
    expect(bridge).toContain('window.location.hostname');
    expect(bridge).not.toContain('SITE_STATE');
    expect(mainInterceptor).not.toContain('siteScope');
    expect(mainInterceptor).not.toContain('site_proxy_state');
  });

  it('两处界面都只经 `siteScopeToggle` / `withoutHost` 改名单，不直接摆数组', () => {
    expect(popup.match(/siteScopeToggle\(/g)).toHaveLength(1);
    expect(popup).not.toContain('withHostActive(');
    expect(popup).not.toContain('hosts: [');
    expect(settings.match(/withoutHost\(/g)).toHaveLength(1);
    expect(settings).not.toMatch(/hosts:\s*siteState\.value\.hosts\.(push|splice)/);
  });

  it('两种拒绝各说一句，且界面自己不再判「为什么没改成」', () => {
    expect(popup).toContain("blocked === 'capReached'");
    expect(popup).toContain("t('siteScopeCapReached'");
    expect(popup).toContain("t('siteScopeParentCovered')");
    // 上限这个数只在判据那一侧存在过：界面读的是常量，不是文案里的字面量
    expect(popup).toContain('String(MAX_SITE_STATE_HOSTS)');
  });

  it('每次重算命中预览都先归零，不让上一条规则冒充这一页的新答案', () => {
    const body = popup.slice(popup.indexOf('async function computePageHit'), popup.indexOf('// ─── 拦截器自报活动'));
    expect(body).toContain("pageHitRuleId.value = '';");
    expect(body).toContain("pageHitRuleName.value = '';");
    expect(body).toContain("pageHitRewritten.value = '';");
    expect(body).toContain('pageHitCause.value = null;');
  });

  it('设置页用消息枚举、读写有闸门，且最后一台白名单移除前确认', () => {
    expect(settings).toContain('type: MessageType.GET_SITE_STATE');
    expect(settings).toContain('type: MessageType.SET_SITE_STATE');
    expect(settings).toContain('if (siteScopeUnreadable.value || siteScopeBusy.value) return;');
    expect(settings).toContain('siteScopeLastWhitelistConfirm');
  });

  it('读不到时开关与那一格都说话，而不是画成「全部站点都生效」的确认语气', () => {
    expect(popup).toContain(':disabled="hostProxied === null || siteScopeBusy"');
    expect(popup).toContain("t('siteScopeUnreadable')");
    expect(settings).toContain("t('siteScopeUnreadable')");
  });

  it('「还在路上」是第三档，排在「读不到」之前，两侧各一份', () => {
    // 次序承重：只写 hostProxied === null 的话，首帧那一次往返会被说成「读不到」
    const popupNotes = popup.slice(popup.indexOf('v-if="siteScopeReading"'), popup.indexOf("t('siteScopeBoundary')"));
    expect(popupNotes).toContain("t('siteScopeReading')");
    expect(popupNotes).toContain('v-else-if="hostProxied === null"');
    expect(popup).toContain('const siteScopeFirstReadSettled = ref(false);');
    // 落定标志必须排在 finally：只写在成功分支的话，第一次就失败的那一局会永远挂着「正在读取」
    const fetch = popup.slice(
      popup.indexOf('async function fetchSiteState'),
      popup.indexOf('async function applyHostProxied'),
    );
    expect(fetch).toContain('finally {');
    expect(fetch.indexOf('siteScopeFirstReadSettled.value = true;')).toBeGreaterThan(fetch.indexOf('catch (error)'));
    // 设置页同理：初值必须是「在读」，否则那一节打开就说「没读到」
    expect(settings).toContain('const siteScopeReading = ref(true);');
    expect(settings.match(/siteScopeReading\.value = false/g)).toHaveLength(2);
    expect(settings).toContain('v-else-if="siteScopeUnreadable"');
  });

  it('命中预览不许对着一台已停用的站点承诺改写', () => {
    expect(popup).toContain('const pageHitSiteBlocked = computed(');
    expect(popup).toContain('!siteAllows(siteState.value, pageHost.value)');
    expect(popup).toContain('pageHitRewritten !== pageUrl && !pageHitSiteBlocked');
    expect(popup).toContain("t('pageHitSiteBlocked')");
    // 读不到名单时不判（null 不是「已停用」），那一格自会说「没读到」
    expect(popup).toContain('siteState.value !== null && !siteAllows');
  });
});
