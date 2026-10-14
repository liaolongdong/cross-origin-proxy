/**
 * 模拟后端演示规则集（`scripts/mock-env/demoRules.mjs`）的可用性守卫
 *
 * 这份夹具是给人拿来「验证扩展核心功能是否正常」的，所以它坏掉的方式特别贵：
 * 规则里多打一个字母、少一个必填字段、或者把某条 SW 专属能力挂到了一条本该走网络层的规则上，
 * 界面上看上去**全都正常**，只有对照表里那一格读数不对，而人会先怀疑扩展。
 *
 * 断言全部打在扩展真正使用的那几份判据上（`normalizeImportedRules` / `isSimpleRule` /
 * `buildDnrRules` / `rewriteUrl`），这里不另写第二份「什么算合法规则」——预览与实际写入
 * 判据不同源，是本仓库反复踩过的那类谎报。
 *
 * 四条刻意的事实：
 * 1. `version` 与 `exportTime` 不参与对账：前者是这份演示包自己的标记（`PRESET_VERSION`，
 *    故意不抄扩展版本号——抄了每次发版就假一次，而导入侧读的是 `schemaVersion`），
 *    后者是生成器里的固定时间戳（让重复启动不弄脏工作树）。
 * 2. 「哪几条走网络层」是**逐条点名**的名单，不是「数一下个数」。新增一条纯重写规则而忘了
 *    它因此受页面 CORS 约束时，只有点名会红。
 * 3. 网络层那几条的**落点档位**也逐条对账（跨原点改写让目标收到 `Origin: null`，只有
 *    `wildcard` 接得住）——它和事实 2 是两件事：名单对了、落点换回 `local` 那一档，演示当场全红
 *    而规则列表看上去一切正常。
 * 4. 路由存在性按 `backend.mjs` 的 `ROUTES` 对账，而不是硬编码一份路径清单：夹具的路由与
 *    规则的两端必须是同一份事实。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from '@/utils/constants';
import { buildDnrRules, buildRegexFilter, buildRegexSubstitution, isSubstitutionValid } from '@/utils/dnrRules';
import { findMatchingRule, isSimpleRule, rewriteUrl } from '@/utils/urlMatcher';
import type { ProxyRule } from '@/utils/types';
import { createEnvServer, ENVS, ROUTES } from '@/scripts/mock-env/backend.mjs';
import { buildDemoRules } from '@/scripts/mock-env/demoRules.mjs';

const BASE = 5300;
const CANONICAL = 'localhost';
const FAT = `http://${CANONICAL}:${BASE + 2}`;
const DEV = `http://${CANONICAL}:${BASE + 1}`;

const preset = buildDemoRules({ base: BASE, canonical: CANONICAL, version: '0.0.0-test' });
const rules = preset.config.rules as ProxyRule[];

/** 按名字取规则；名字是这份夹具对外的唯一标识（触发页的「期望」也点它），查不到就应当直接红 */
function byName(fragment: string): ProxyRule {
  const found = rules.filter(r => r.name.includes(fragment));
  expect(found, `演示规则集里找不到名字含「${fragment}」的条目`).toHaveLength(1);
  return found[0];
}

/** 触发页与入库预设都在 tests/ 的上一层，按 import.meta.url 定位，不依赖起跑目录 */
const repoFile = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * `ROUTES` 的 path 形如 `/api/list?page=&size=`、`/api/status/:code`、`/api/v1/*`，
 * 截到第一个参数/占位标记之前就是「这条路由确实存在」的那段字面前缀。
 * 尾斜杠归一是必要的：`/api/v1/*` 截出 `/api/v1/`，而规则的前缀写作 `/api/v1`，
 * 两者说的是同一族路径，只是斜杠记法不同。
 */
function routePrefixes(): string[] {
  return ROUTES.map((r: { path: string }) => r.path.split(/[?:*]/)[0].replace(/\/$/, '')).filter(Boolean);
}

/** 规则的 matchPattern → 只留 origin 之后的路径（正则规则先剥掉锚点与捕获组） */
function rulePath(pattern: string): string {
  const body = pattern.replace(/^\^/, '').replace(/\$$/, '').split('(.*)')[0];
  const withoutProtocol = body.replace(/^[a-z]+:\/\//i, '');
  const slash = withoutProtocol.indexOf('/');
  return slash === -1 ? '/' : withoutProtocol.slice(slash);
}

/**
 * matchPattern → origin。正则那条带着 `^`、`$` 和 `reEscape` 留下的反斜杠，
 * 直接 `new URL()` 会抛，所以先按正则规则的记法剥回一条普通 URL。
 */
function patternOrigin(rule: ProxyRule): string {
  const bare =
    rule.matchType === 'regex'
      ? rule.matchPattern.replace(/^\^/, '').replace(/\$$/, '').replace(/\\/g, '')
      : rule.matchPattern;
  return new URL(bare).origin;
}

type NormalizeFn = (rawRules: unknown[]) => ProxyRule[];

describe('mock-env 演示规则集', () => {
  let normalizeImportedRules: NormalizeFn;

  beforeEach(async () => {
    // 与 tests/messageRouter.test.ts 同一套路：先 stub 再动态 import，
    // 这样「能不能被扩展导入」用的是导入链路那一份判据，不是这里重述的
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getURL: (path?: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path ?? ''}`,
        getManifest: () => ({ version: '0.0.0-test' }),
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
        onChanged: { addListener: vi.fn() },
      },
      declarativeNetRequest: { getMatchedRules: vi.fn(), getDynamicRules: vi.fn() },
    });
    vi.resetModules();
    const mod = await import('@/entrypoints/background/messageRouter');
    normalizeImportedRules = mod.normalizeImportedRules;
  });

  it('载荷形状过得了导入闸门：schemaVersion 不越界、rules 是数组', () => {
    expect(preset.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Array.isArray(preset.config.rules)).toBe(true);
    // 替换式导入下这个键决定总开关，缺省等于「导完就把代理关掉」
    expect(preset.config.enabled).toBe(true);
  });

  it('一条都不被 normalizeImportedRules 丢掉', () => {
    const normalized = normalizeImportedRules(rules);
    // 静默丢条是最难查的坏法：界面列表少一条，而导入回包的 invalid 是唯一证人
    expect(normalized).toHaveLength(rules.length);
    expect(rules).toHaveLength(18);
  });

  it('走网络层（DNR）的恰好是点名那四条，其余全在后台代发通道', () => {
    const netSide = rules.filter(isSimpleRule).map(r => r.name);
    expect([...netSide].sort()).toEqual(
      [
        'FAT → DEV（图片资源 · 网络层）',
        'FAT → DEV（纯重写 · 网络层）',
        'FAT → DEV（正则捕获组 · 网络层）',
        'FAT → PROD（纯重写 · 仍受 CORS 约束）',
      ].sort(),
    );
  });

  it('跨原点改写的落点只能是 wildcard 那一档，例外只有那条刻意的 CORS 对照', () => {
    // 实测：一条把请求改写到另一个原点的 DNR 规则，目标收到的 Origin 是 null（同原点内不受影响）。
    // 回显 Origin 的三档因此一律接不住，页面只剩 net::ERR_FAILED——落点写错不会报错，只会让那一格红。
    expect(ENVS.web.port).toBe(BASE);
    const tierAt = (url: string) => {
      const port = Number(new URL(url).port);
      const cfg = Object.values(ENVS).find((e: { port: number }) => e.port === port);
      return cfg?.cors as string | undefined;
    };
    const CORSENTIAL = 'FAT → PROD（纯重写 · 仍受 CORS 约束）';
    for (const rule of rules.filter(isSimpleRule)) {
      const from = new URL(patternOrigin(rule));
      const to = new URL(rule.targetUrl);
      if (from.origin === to.origin || rule.name === CORSENTIAL) continue;
      expect(tierAt(rule.targetUrl), `「${rule.name}」落在 ${to.origin}，那一档不是 wildcard`).toBe('wildcard');
    }
    // 例外必须仍然是「按名字点名的一条」，不能悄悄变成第二条
    expect(rules.filter(r => isSimpleRule(r) && r.name === CORSENTIAL)).toHaveLength(1);
  });

  it('网络层那几条编译得出来，且默认只有三条在装（对照组天然是关的）', () => {
    expect(buildDnrRules(rules, true).rules).toHaveLength(3);
    // 把「FAT → PROD（纯重写）」打开，它就该真的进 DNR——否则触发页那条对照格永远演不出来
    const allOn = rules.map(r => ({ ...r, enabled: true }));
    expect(buildDnrRules(allOn, true).rules).toHaveLength(4);
    // 总开关关闭时必须编译出空集，不然「关掉代理」后简单规则仍在重定向
    expect(buildDnrRules(rules, false).rules).toHaveLength(0);
  });

  it('编译出的 regexFilter / regexSubstitution 各自合法', () => {
    const { rules: dnr } = buildDnrRules(
      rules.map(r => ({ ...r, enabled: true })),
      true,
    );
    expect(dnr).toHaveLength(4);
    for (const dnrRule of dnr) {
      const filter = dnrRule.condition.regexFilter;
      const subst = dnrRule.action.redirect?.regexSubstitution;
      // 先断言两者都是字符串，再让类型收窄去喂 newRegExp/isSubstitutionValid——
      // 缺字段本身就是这条用例要抓的东西，不该用断言类型糊过去
      expect(typeof filter === 'string' && typeof subst === 'string', JSON.stringify(dnrRule)).toBe(true);
      if (typeof filter !== 'string' || typeof subst !== 'string') continue;
      expect(() => new RegExp(filter), filter).not.toThrow();
      expect(isSubstitutionValid(filter, subst), `${filter} → ${subst}`).toBe(true);
    }
  });

  it('每条规则的 matchPattern 都落在夹具真实存在的路由上', () => {
    const prefixes = routePrefixes();
    for (const rule of rules) {
      const path = rulePath(rule.matchPattern);
      expect(
        prefixes.some(p => path.startsWith(p)),
        `规则「${rule.name}」的 ${path} 在 ROUTES 里没有对应路由`,
      ).toBe(true);
    }
  });

  it('前缀规则：改写了地址的，落点就是 targetUrl；阻断的两条不改地址', () => {
    for (const rule of rules.filter(r => r.matchType === 'prefix')) {
      if (!rule.targetUrl) {
        expect(rewriteUrl(rule.matchPattern, rule), `「${rule.name}」是阻断规则，不该挪动地址`).toBe(rule.matchPattern);
        continue;
      }
      expect(rewriteUrl(rule.matchPattern, rule), `「${rule.name}」`).toBe(rule.targetUrl);
      // 带尾巴的那一笔：尾巴必须原样接过去，查询串也一样
      expect(rewriteUrl(`${rule.matchPattern}?x=1`, rule), `「${rule.name}」带查询`).toBe(`${rule.targetUrl}?x=1`);
    }
  });

  it('正则那条把捕获组接到目标路径，而不是整串丢掉', () => {
    const rule = byName('正则捕获组');
    const sample = `${FAT}/api/v2/orders/7`;
    expect(findMatchingRule(sample, rules)?.name).toBe(rule.name);
    expect(rewriteUrl(sample, rule)).toBe(`${DEV}/api/orders/7`);
  });

  it('两条长连接规则按 priority 分先后：带 block=1 的那一笔先撞上阻断', () => {
    const blocked = byName('阻断带 block=1');
    const rewritten = byName('WS FAT → UAT');
    expect(findMatchingRule(blocked.matchPattern, rules)?.name).toBe(blocked.name);
    expect(findMatchingRule(`ws://${CANONICAL}:${BASE + 2}/ws?src=harness`, rules)?.name).toBe(rewritten.name);
  });

  it('入库的那份 JSON 就是生成器在默认参数下的产物（version / exportTime 除外）', () => {
    const committed = JSON.parse(repoFile('scripts/mock-env/presets/demo-rules.json'));
    expect(committed.schemaVersion).toBe(preset.schemaVersion);
    expect(committed.config).toEqual(preset.config);
  });

  it('触发页点名的规则，presets 里都得真有这一条', () => {
    const harness = repoFile('scripts/mock-env/harness.mjs');
    const named = [...harness.matchAll(/「([^「」]+)」/g)].map(m => m[1]);
    const ruleNames = new Set(rules.map(r => r.name));
    // 触发页里被「」包住的不止规则名（还有通道名、界面措辞），只核对长得像规则名的那些
    const ruleLike = named.filter(n => n.includes('→') || n.includes('阻断'));
    expect(ruleLike.length).toBeGreaterThan(8); // 一条都没解析出来时这一版必须自己是空的，那不算通过
    for (const name of ruleLike) {
      expect(ruleNames.has(name), `触发页提到了「${name}」，presets 里没有这一条`).toBe(true);
    }
  });

  it('每条规则的 name 唯一，且导入后仍能按名字找回来', () => {
    const names = rules.map(r => r.name);
    expect(new Set(names).size).toBe(names.length);
    const normalized = normalizeImportedRules(rules);
    expect(normalized.map(r => r.name).sort()).toEqual([...names].sort());
  });
});

describe('mock-env 生成器与 DNR 构建器的接缝', () => {
  it('buildRegexFilter / buildRegexSubstitution 对网络层那几条都不抛', () => {
    for (const rule of rules.filter(isSimpleRule)) {
      expect(() => buildRegexFilter(rule), `「${rule.name}」filter`).not.toThrow();
      expect(() => buildRegexSubstitution(rule), `「${rule.name}」substitution`).not.toThrow();
    }
  });
});

/**
 * 2026-10-14 代码评审翻出来的两处，两处都是「夹具自己错、测试的人去怪扩展」的形状
 *
 * 1. 埋 Cookie 那一格原本用不带凭据的跨原点 `fetch`。Chrome 在这种响应上直接丢条 `Set-Cookie`
 *    （本机实测：200 得干干净净，jar 是空的），于是下一条 `sendCredentials` 用例的
 *    `hasCookie=true` 永远读不到，排查方向整个反过来。
 * 2. `/api/redirect` 的 `to` 只要 `startsWith('/')` 就放行，而 `//evil.com` 同样以 `/` 开头 ——
 *    浏览器把它解析成协议相对地址，这一跳就出了本机。这个夹具的前提是「全部流量留在 localhost」。
 */
describe('mock-env 自己踩过的两处', () => {
  it('埋 Cookie 那一格带 credentials，否则跨原点的 Set-Cookie 永远不落地', () => {
    const src = repoFile('scripts/mock-env/harness.mjs');
    const at = src.indexOf("case 'setcookie'");
    expect(at, '触发页里找不到 setcookie 那一格').toBeGreaterThan(-1);
    const body = src.slice(at, at + 700);
    expect(body).toContain("credentials: 'include'");
  });

  it('/api/redirect 拒绝协议相对地址，同机路径照旧放行', async () => {
    const { server } = createEnvServer({ env: 'fat', port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const port = (server.address() as { port: number }).port;
      const hit = async (to: string) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/redirect?to=${encodeURIComponent(to)}`, {
          redirect: 'manual',
        });
        return { status: res.status, location: res.headers.get('location') };
      };
      expect(await hit('//evil.com')).toMatchObject({ status: 400, location: null });
      expect(await hit('https://example.com/x')).toMatchObject({ status: 400, location: null });
      expect(await hit('/api/health')).toMatchObject({ status: 302, location: '/api/health' });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
