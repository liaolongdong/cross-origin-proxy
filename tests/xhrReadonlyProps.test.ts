import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * XHR 只读属性回填的可重复定义性
 *
 * 页面完全可以对同一个 `XMLHttpRequest` 实例再次 `open()` + `send()`（轮询库、
 * 手写重试都这么干），此时拦截器会第二遍回填 `readyState` / `status` / `response` 等
 * 只读属性。`Object.defineProperty` 只有在这两个属性**都**缺省时才会得到一份
 * `{ writable: false, configurable: false }` 的 own data 属性，第二次定义直接抛
 * `TypeError: Cannot redefine property`；抛出点落在 `.then` 里 → 进 `.catch`，
 * 而 `.catch` 又做同样的定义 → 再抛一次，于是 `error` / `loadend` 事件都派发不出来，
 * 页面那次请求永久 pending。
 *
 * 两个旗标并不对称，这一点由变异实测而非推断：只漏 `configurable: true` 就会让复用实例的
 * 第二遍回填抛错（新建的那份 own 属性不可重定义），只漏 `writable: true` 则不会——
 * `configurable: true` 还在时整份重定义本就允许改值。所以承重的是 `configurable`，
 * `writable` 是防御性的第二道（页面自己给 `xhr.status` 赋值时不至于在严格模式抛）。
 * 这个不对称由 `tests/interceptorXhr.test.ts` 按运行时分别摘掉两侧验证过。本用例只钉
 * `configurable: true` 那一侧（承重的就是它），别把它当冗余删掉。
 *
 * 拦截器跑在 MAIN world、自包含且无法 import，只能用源码契约守住（同 `channel-consistency`）；
 * 「回填到什么值、按什么顺序派发哪些事件」这类结局由 `tests/interceptorXhr.test.ts` 接手。
 */

const source = readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');

/** 抓出所有 `Object.defineProperty(xhr, 'name', { ... })` 调用（含跨行的属性对象） */
function xhrPropertyDefines() {
  return [...source.matchAll(/Object\.defineProperty\(\s*xhr\s*,\s*'(?<name>[^']+)'(?<props>[\s\S]*?\);)/g)].map(
    match => ({ name: match.groups!.name as string, props: match.groups!.props as string }),
  );
}

describe('[XHR reuse] 只读属性回填必须可重复定义', () => {
  const defines = xhrPropertyDefines();

  it('确实抓到了回填调用（正则失效时不要让本用例假绿）', () => {
    expect(defines.length).toBeGreaterThanOrEqual(15);
  });

  it('每一处都显式带 configurable: true', () => {
    for (const { name, props } of defines) {
      expect(props, `xhr.${name}`).toContain('configurable: true');
    }
  });

  it('被回填的属性名只出现在既有那批只读属性上', () => {
    const names = new Set(defines.map(d => d.name));
    expect([...names].sort()).toEqual([
      'readyState',
      'response',
      'responseText',
      'responseURL',
      'status',
      'statusText',
    ]);
  });

  it('失败/超时/阻断三条兜底路径同样在 defineProperty 之后才派发事件', () => {
    // 抛错就派发不出事件，正是这个 bug 的表现形式：顺序上必须先完成属性回填
    for (const marker of ["value: 'Proxy Error'", "value: '', writable: true"]) {
      const at = source.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      const dispatchAt = source.indexOf('xhr.dispatchEvent(new Event(', at);
      expect(dispatchAt).toBeGreaterThan(at);
    }
  });
});
