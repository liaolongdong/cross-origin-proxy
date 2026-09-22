import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * F6：WS 徽标的文案不得超出拦截器真正做到的能力
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
 * 文案那一侧——它没有任何运行时对应物。
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
