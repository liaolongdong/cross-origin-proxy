import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 这里收的是「日志耗时从哪来」那一条契约。
 *
 * 它的前身是 `tests/bugfixes-and-features.test.ts` 里的一段，那个文件整体是
 * 「在测试里重写一遍被测逻辑、再断言那份副本」——六段用例在任何生产改动下都不会变红，
 * 其中「按 ruleId 合并 DNR 与 SW 命中数」那段还断言了与实现相反的契约（相加＝13，
 * 而 `utils/ruleStats.ts` 的口径是两条通道窗口不同、**绝不相加**）。已整支删除，
 * 对应主题的真实覆盖在：`tests/urlMatcher.test.ts`（WS 判据）、
 * `tests/full-verification.test.ts`（命中数分通道、冲突与遮蔽）、
 * `tests/build-verification.test.ts`（manifest 命令与按键）、
 * `tests/interceptorXhr.test.ts`（XHR 代理失败的事件派发）。
 * 留下来的这一条则是此前**没有任何测试提到**的那件事：`duration` 的来源。
 */
describe('日志耗时的来源', () => {
  it('每条日志的 duration 都是量出来的耗时，没有一处回落到规则里配的 delayMs', () => {
    const src = readFileSync('entrypoints/background/proxyHandler.ts', 'utf8');
    expect(src).not.toMatch(/duration:\s*rule\.delayMs/);
    // 写日志的分支不止一处，用的却是同一句判据；`toContain` 只看得到第一处，所以数次数
    const measured = src.match(/duration:\s*Date\.now\(\) - startTime/g) ?? [];
    expect(measured.length).toBe(4);
  });
});
