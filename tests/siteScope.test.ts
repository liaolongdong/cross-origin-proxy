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

  it('页面拉到的配置与逐 tab 推送的配置用同一份判据（两处不一致就是「拉到的与推来的行为不同」）', () => {
    expect(router).toContain('siteAllows(siteState, hostnameOf(sender.tab?.url ?? sender.url))');
    expect(manager).toContain('rulesForSite(complexRules, siteState, hostnameOf(tab.url))');
  });

  it('代发前再判一次，且带的是 Chrome 写的 sender 主机名', () => {
    expect(router).toContain('hostnameOf(sender.tab?.url ?? sender.url),');
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

  it('收窄发生在下发之前，所以页面侧两个 world 都不需要（也不该有）第二份判据', () => {
    expect(bridge).not.toContain('SITE_STATE');
    expect(mainInterceptor).not.toContain('siteScope');
    expect(mainInterceptor).not.toContain('site_proxy_state');
  });

  it('两处界面都只经 `withHostActive` / `withoutHost` 改名单，不直接摆数组', () => {
    expect(popup.match(/withHostActive\(/g)).toHaveLength(1);
    expect(popup).not.toContain('hosts: [');
    expect(settings.match(/withoutHost\(/g)).toHaveLength(1);
    expect(settings).not.toMatch(/hosts:\s*siteState\.value\.hosts\.(push|splice)/);
  });

  it('读不到时开关与那一格都说话，而不是画成「全部站点都生效」的确认语气', () => {
    expect(popup).toContain(':disabled="hostProxied === null || siteScopeBusy"');
    expect(popup).toContain("t('siteScopeUnreadable')");
    expect(settings).toContain("t('siteScopeUnreadable')");
  });
});
