/**
 * MAIN world 拦截器的响应构造安全契约（回归：中文响应头让页面永久 pending）
 *
 * `entrypoints/main-interceptor.content.ts` 自包含、跑在页面同源，无法 import `utils/*`；
 * 「不能在 node 里跑」已经不成立（`tests/interceptorFetch.test.ts` 与 `tests/interceptorXhr.test.ts`
 * 各挂了假 `window` 与假 XHR/fetch 把两条通道跑起来了），但这一支守的是**构造调用的位置关系**
 * ——过滤器在 `new Headers()` 之前、整段在 try 内、catch 里 reject——按结局测只能看出
 * 「有没有 pending」，看不出这几行的相对位置，因此仍按**源码契约**守三件事：
 *
 * 1. 交给 `new Headers()` 的实参必须来自本文件内的 ByteString 过滤器——用户在规则里
 *    手写的中文响应头（`utils/headerValidation.ts` 只挡 CR/LF 与头名字符集）码点 > 255，
 *    会让构造调用抛 TypeError；
 * 2. 抛出点在被 `pending.resolve()` 调用的回调里，且 `clearTimeout` 已经跑过——
 *    既不 reject 也不回退原生 ⇒ 页面 fetch/XHR **永久 pending**；所以构造 Response
 *    与 `atob` 必须整体落在 try 内、catch 里 reject；
 * 3. 「什么算一条合法的响应头」这份判据与 `utils/proxyResponse.ts` 镜像（CR/LF + 码点 ≤ 255），
 *    非字符串值那一支**刻意不镜像**（桥接层整份退回空对象，这里逐条剔）——镜像约定见 AGENTS.md
 *    「MAIN world 镜像必须同步」，两种情况各有一条用例，别把它们合成一句「同源」。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.resolve(__dirname, '../entrypoints/main-interceptor.content.ts'), 'utf8');
const BRIDGE = fs.readFileSync(path.resolve(__dirname, '../utils/proxyResponse.ts'), 'utf8');

describe('MAIN world 响应构造守卫（源码契约）', () => {
  it('存在本文件内的 headers 整型化函数，且头名与头值都过 ByteString 判定', () => {
    const helper = SRC.match(/function toByteStringHeaders\(raw: unknown\)[\s\S]*?\n {4}}\n/);
    expect(helper, '缺少 toByteStringHeaders(raw: unknown) 过滤器').toBeTruthy();
    expect(helper![0]).toMatch(/typeof value !== 'string'/);
    expect(helper![0]).toMatch(/codePointAt\(0\)/);
    expect(helper![0]).toMatch(/0xff/);
    expect(helper![0]).toMatch(/\\r|\\n|\[\\r\\n\]/);
  });

  it('new Headers() 只接受整型化后的结果，不得直喂后台载荷', () => {
    expect(SRC).toMatch(/headers: toByteStringHeaders\(data\.headers\)/);
    expect(SRC).not.toMatch(/new Headers\(data\.headers\)/);
  });

  it('构造 Response 与 atob 落在 try 内，catch 必须 reject（否则超时已摘 → 永久 pending）', () => {
    const resolveBody = SRC.slice(SRC.indexOf('resolve: (data: any) => {'), SRC.indexOf('reject: (err: any)'));
    expect(resolveBody, '没找到 resolve 回调区间').not.toBe('');
    const tryAt = resolveBody.indexOf('try {');
    expect(tryAt, 'resolve 回调内没有 try 包裹').toBeGreaterThan(-1);
    expect(resolveBody.indexOf('resolve(new Response('), 'new Response 不在 try 内').toBeGreaterThan(tryAt);
    expect(resolveBody.indexOf('atob('), 'atob 不在 try 内').toBeGreaterThan(tryAt);
    expect(resolveBody.indexOf('} catch'), '缺少 catch').toBeGreaterThan(tryAt);
    const after = resolveBody.slice(tryAt);
    expect(/catch[\s\S]*reject\(/.test(after), 'catch 里没有 reject').toBe(true);
  });

  it('两侧共用同一份「名与值都得是 ByteString」的判据', () => {
    const helper = SRC.match(/function toByteStringHeaders\(raw: unknown\)[\s\S]*?\n {4}}\n/);
    const bridge = BRIDGE.match(/function isByteStringHeaderEntry\([\s\S]*?\n}\n/);
    expect(helper, 'MAIN world 侧的过滤器不见了').toBeTruthy();
    expect(bridge, '桥接层侧的判据函数不见了').toBeTruthy();
    // 同一对 CR/LF 测试 + 同一个码点上界：漏任何一边，约束就只在桥接层生效，页面侧照样抛
    for (const [label, body] of [
      ['MAIN world', helper![0]],
      ['桥接层', bridge![0]],
    ]) {
      expect(body, `${label} 侧没有 CR/LF 判据`).toMatch(/\\r\\n/);
      expect(body, `${label} 侧没有 0xff 上界`).toContain('0xff');
      expect(body, `${label} 侧没有逐码点判`).toContain('codePointAt(0)');
    }
  });

  it('非字符串响应值的处置刻意分家：桥接层整份退回空对象，MAIN world 逐条剔', () => {
    // 上一用例守的是「判据同源」，这一条守的是它管不到的那一半：两侧对非字符串值的选法**不同**，
    // 而且不是漏同步——`normalizeProxyResponse` 先跑，交到页面 world 的 `headers` 必然全是字符串，
    // MAIN world 那一支只防消息被截断或伪造。任何一边被「顺手统一」都是改不可信回包的处理方式，
    // 所以两边各钉一句原话。
    expect(BRIDGE).toMatch(
      /entries\.every\(\(entry\): entry is \[string, string\] => typeof entry\[1\] === 'string'\)\) return \{\};/,
    );
    expect(SRC).toMatch(/if \(typeof value !== 'string'\) continue;/);
  });
});
