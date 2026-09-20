import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * XHR 只读属性回填的可重复定义性
 *
 * 页面完全可以对同一个 `XMLHttpRequest` 实例再次 `open()` + `send()`（轮询库、
 * 手写重试都这么干），此时拦截器会第二遍回填 `readyState` / `status` / `response` 等
 * 只读属性。`Object.defineProperty` 的 `configurable` 默认是 `false`，第二次定义直接抛
 * `TypeError: Cannot redefine property`；抛出点落在 `.then` 里 → 进 `.catch`，
 * 而 `.catch` 又做同样的定义 → 再抛一次，于是 `error` / `loadend` 事件都派发不出来，
 * 页面那次请求永久 pending。
 *
 * 拦截器跑在 MAIN world、自包含且无法 import，只能用源码契约守住（同 `channel-consistency`）。
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
