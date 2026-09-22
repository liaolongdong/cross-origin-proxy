import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * F5：同步 XHR 不得被异步化
 *
 * `xhr.open(method, url, false)` 的契约是「`send()` 返回时结果已在实例上」。代理要经
 * postMessage 往返 ISOLATED world 与 SW，响应只能在调用栈返回**之后**到达，于是页面读到的是
 * 空的 `status`/`response`——比报错更糟，因为它看起来像"服务端返回了空响应"。
 * 与「非字符串 body」同类：这类请求回退原生（等价于未装本扩展），只有阻断规则例外，
 * 因为回退等于把用户明确要求挡掉的请求真的发出去。
 *
 * 拦截器跑在 MAIN world、自包含且无法 import，这一支因此按源码契约守住判据写法与分支顺序；
 * 「回退有没有真的把请求发出去、告警是不是只打一次」这类结局由 `tests/interceptorXhr.test.ts`
 * 按运行时接手（同 `xhrReadonlyProps` 的分工）。
 */

const source = readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');

describe('[同步 XHR] open 必须记住 async 标志', () => {
  it('第三个实参显式为 false 才判定为同步（省略即异步，这是 XHR 的默认值）', () => {
    expect(source).toContain('(this as any).__proxySync = rest.length > 0 && rest[0] === false;');
  });

  it('记录标志不影响转给原生 open 的参数（原样 apply）', () => {
    expect(source).toContain('originalXHROpen.apply(this, [method, url, ...rest] as any)');
  });
});

describe('[同步 XHR] send 回退原生，但阻断规则不得回退', () => {
  /** 只取 XHR `send` 那一段：`fetch` 分支里有同样的 body 判断，全文比对会串台 */
  const sendSrc = (() => {
    const start = source.indexOf('XMLHttpRequest.prototype.send = function');
    const end = source.indexOf('// ---- Intercept WebSocket', start);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, end > start ? end : undefined);
  })();

  const syncAt = sendSrc.indexOf('if ((this as any).__proxySync && !rule.blocked) {');
  const bodyTypeAt = sendSrc.indexOf("if (body !== undefined && body !== null && typeof body !== 'string') {");

  it('同步分支的判据同时排除阻断规则（回退会让被阻断的请求真的发出）', () => {
    expect(syncAt).toBeGreaterThan(-1);
  });

  it('同步分支回退的是原生 send，且保留页面传入的 body', () => {
    const block = sendSrc.slice(syncAt, syncAt + 600);
    expect(block).toContain('originalXHRSend.call(this, body);');
  });

  it('同步判定发生在 body 判定之前（两条回退路径不会互相抢）', () => {
    expect(bodyTypeAt).toBeGreaterThan(syncAt);
  });

  it('body 判定里的阻断分支仍然是"不回退、模拟网络错误"', () => {
    expect(sendSrc).toContain('if (rule.blocked) {');
    expect(sendSrc).toContain('originalXHRSend.call(this, body);');
  });

  it('回退提示一个页面只打一次（同步 XHR 常在循环里）', () => {
    expect(source).toContain('let warnedSyncXhr = false;');
    expect(source).toContain('if (!warnedSyncXhr) {');
    expect(source.match(/warnedSyncXhr = true/g)).toHaveLength(1);
  });
});
