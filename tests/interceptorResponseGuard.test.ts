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
 * 3. 该语义与 `utils/proxyResponse.ts` 的 headers 整形同源（镜像约定，见 AGENTS.md
 *    「MAIN world 镜像必须同步」）。
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

  it('桥接层与 MAIN world 用同一套 ByteString 判据（镜像同步约定）', () => {
    expect(BRIDGE).toMatch(/0xff/);
    expect(BRIDGE).toMatch(/0x0a|0x0d/);
    // 两侧都必须把 headers 逐条判过再放行，而不是整体退回空对象了事
    expect(SRC).toMatch(/toByteStringHeaders/);
    expect(BRIDGE).toMatch(/isByteStringHeaderEntry|filter\(|for \(const \[name/);
  });
});
