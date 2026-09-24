import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * F6：WS 的能力面不得在文案与徽章上超出拦截器真正做到的事
 *
 * `wsRuleHint` 原先只写「此规则也适用于 WebSocket 连接」，读起来像整条规则原样作用到长连接上。
 * 实际只有三件事：`rewriteWsUrl`（内含 `queryOverrides` 注入）、`blocked`（连向必然拒绝的
 * 本地端口）、把握手视为 `GET` 的方法过滤。请求头/请求体/响应改写、Mock、延迟、重试、
 * `sendCredentials`（携带 Cookie）都不经过这条路径——长连接没有可替换的响应体，
 * 也没有"再试一次"的语义，Cookie 由浏览器自己按握手请求发出。
 *
 * 文案与实现分处两地，正是它分叉的原因，所以两端一起钉住：先证明能力面（源码契约），
 * 再要求文案点名「生效项」与「无效项」。拦截器自包含、无法 import，只能读源码。
 *
 * 「先阻断后重写」这类**顺序**与「哪几个字段根本不经过这条路径」的缺席断言留在这里；
 * 「交给原生构造器的到底是哪个地址、带不带 protocols、阻断连到哪个端口」这些结局，
 * 已由 `tests/interceptorWebSocket.test.ts` 按运行时接手（批次 L）。本文件继续守的是
 * 说出来的那两侧——文案与规则列表的能力徽章，它们都没有运行时对应物。
 */

const source = readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');
const zhHint = JSON.parse(readFileSync('locales/zh_CN/options.json', 'utf-8')).wsRuleHint as string;
const enHint = JSON.parse(readFileSync('locales/en/options.json', 'utf-8')).wsRuleHint as string;

/** 只取 WS 构造器那一段：HTTP 分支里出现同样的字段名，全文比对会串台 */
const wsStart = source.indexOf('function ProxyWebSocket');
const wsSrc = source.slice(wsStart, source.indexOf('window.WebSocket = ProxyWebSocket', wsStart));

describe('[WS 能力面] 拦截器对长连接只做这三件事', () => {
  it('命中规则后先处理阻断，再做地址重写（顺序反了被阻断的连接会真的建立）', () => {
    const blockedAt = wsSrc.indexOf('if (rule.blocked) {');
    const rewriteAt = wsSrc.indexOf('rewriteWsUrl(wsUrl, rule)');
    expect(blockedAt).toBeGreaterThan(-1);
    expect(rewriteAt).toBeGreaterThan(blockedAt);
    expect(wsSrc).toContain("new OriginalWebSocket('ws://127.0.0.1:1')");
  });

  it('未命中规则时原样交给原生 WebSocket，且保留 protocols', () => {
    expect(wsSrc).toContain('return protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);');
  });

  it('查询参数注入住在重写函数内部（它随地址一起生效，不是另一条通道）', () => {
    const rewriter = source.slice(source.indexOf('function rewriteWsUrl'), wsStart);
    expect(rewriter).toContain('rule.queryOverrides');
  });

  it('构造器这一段不引用其余能力字段', () => {
    for (const field of [
      'headerOverrides',
      'requestBodyOverride',
      'responseOverrides',
      'mockResponse',
      'delayMs',
      'retryCount',
      'sendCredentials',
    ]) {
      expect(wsSrc, field).not.toContain(field);
    }
  });
});

describe('[RuleTable 徽章] 界面画的徽章用的是同一份能力面', () => {
  /**
   * 徽章是这条规则「有什么能力」的唯一视觉声明，而上面那份无效项清单此前只约束了文案：
   * 一条带 `headerOverrides` 的 WS 规则照旧亮着 H，两格之后 WS 那一枚又把这话收回去，
   * 同一行里先承诺七次再撤销一次。现在七个无效项各由 `showsHttpOnlyBadge(row)` 收口。
   */
  const tableSrc = readFileSync('components/options/RuleTable.vue', 'utf-8');
  const inertBadges: ReadonlyArray<readonly [string, string]> = [
    ['headerOverrides', 'h'],
    ['sendCredentials', 'c'],
    ['requestBodyOverride', 'b'],
    ['responseOverrides', 'r'],
    ['mockResponse', 'm'],
    ['delayMs', 'd'],
    ['retryCount', 're'],
  ];

  it.each(inertBadges)('%s 那枚（--%s）在 WS 规则上不画', (field, mod) => {
    expect(tableSrc, field).toMatch(new RegExp(`v-if="showsHttpOnlyBadge\\(row\\) && row\\.${field}`));
    expect(tableSrc, mod).toContain(`class="rule-badge rule-badge--${mod}"`);
  });

  it('收口的枚数正好七个（多一枚就是阻断被误收，少一枚就是留了个空承诺）', () => {
    expect([...tableSrc.matchAll(/v-if="showsHttpOnlyBadge\(row\)/g)]).toHaveLength(7);
  });

  it('阻断与 WS 本身不受收口（长连接上它们是生效项）', () => {
    expect(tableSrc).toMatch(/v-if="row\.blocked"/);
    expect(tableSrc).toMatch(/v-if="isWsRule\(row\)"/);
  });
});

describe('[wsRuleHint] 文案必须同时说清生效项与无效项', () => {
  /** 生效侧 / 无效侧关键词，按语言各列一份 */
  const applies = { zh: ['重写', '查询', '阻断'], en: ['rewrite', 'query', 'block'] };
  const notApplies = {
    zh: ['请求头', '响应', 'Mock', '延迟', '重试', '携带 Cookie'],
    en: ['header', 'response', 'mock', 'delay', 'retry', 'sending cookies'],
  };
  const hints = { zh: zhHint, en: enHint };

  it.each(Object.keys(hints) as (keyof typeof hints)[])('%s 侧点名了长连接上真正生效的能力', locale => {
    for (const word of applies[locale]) {
      expect(hints[locale].toLowerCase(), `${locale}: ${word}`).toContain(word.toLowerCase());
    }
  });

  it.each(Object.keys(hints) as (keyof typeof hints)[])('%s 侧点名了不生效的能力', locale => {
    for (const word of notApplies[locale]) {
      expect(hints[locale].toLowerCase(), `${locale}: ${word}`).toContain(word.toLowerCase());
    }
  });

  it('笼统的「此规则也适用于 WebSocket 连接」不得回来（那正是本次修掉的谎报）', () => {
    expect(zhHint).not.toBe('此规则也适用于 WebSocket 连接');
    expect(enHint).not.toBe('This rule also applies to WebSocket connections');
  });
});
