/**
 * 设计令牌层的静态契约
 *
 * 令牌引用失效是**静默**的：未定义或写法错误的 `var()` 让整条声明在进入计算值阶段后
 * 被丢弃（或退化成继承值 / 初始值），界面照常渲染，只是少了一层阴影、一个底色、
 * 一处字色——没有报错，也没有测试接得住。本轮修掉的四处正是这样藏着的
 * （`rgb(var(--cop-primary-rgb, 64, 158, 255), 0.15)` 与三个未定义令牌），
 * 所以这里把这三类写法固定成回归用例。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TOKENS_FILE = 'assets/theme/tokens.css';
const UI_DIRS = ['components', 'entrypoints', 'assets'];

/** 递归收集 UI 目录下的样式载体（SFC 与 CSS），与 stylelint 的覆盖范围保持一致 */
function collectStyleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collectStyleFiles(full);
    return /\.(vue|css)$/.test(entry) ? [full] : [];
  });
}

const files = UI_DIRS.flatMap(collectStyleFiles);
const definedTokens = new Set(
  [...readFileSync(TOKENS_FILE, 'utf-8').matchAll(/(--cop-[a-z0-9-]+)\s*:/g)].map(m => m[1]),
);

describe('令牌引用必须能在 tokens.css 里找到定义', () => {
  it('tokens.css 自身定义了整套 --cop-* 令牌', () => {
    // 数量级守卫：误删整个语义层时，下面的逐文件比对会因为「引用恰好为 0」而假通过
    expect(definedTokens.size).toBeGreaterThanOrEqual(25);
  });

  it('UI 里不存在未定义的 --cop-* 引用（未定义即声明失效，静默丢样式）', () => {
    const dangling: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const [, token] of src.matchAll(/var\((--cop-[a-z0-9-]+)/g)) {
        if (!definedTokens.has(token)) dangling.push(`${file}: ${token}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});

describe('rgb() 通道令牌必须用斜杠 alpha 写法', () => {
  it('--cop-primary-rgb 存的是空格分隔通道', () => {
    const value = [...readFileSync(TOKENS_FILE, 'utf-8').matchAll(/--cop-primary-rgb:\s*([^;]+);/g)].pop()?.[1];
    expect(value).toBeDefined();
    expect(value).toMatch(/^\d+\s+\d+\s+\d+$/);
  });

  it('每条用到 -rgb 通道的 rgb() 都是 rgb(var(--cop-*-rgb) / NN%) 形状', () => {
    const CANONICAL = /^rgb\(var\(--cop-[a-z0-9-]+-rgb\) \/ \d+%\)$/;
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const call of src.match(/rgb\([^;{}]*\)/g) ?? []) {
        if (call.includes('-rgb') && !CANONICAL.test(call)) offenders.push(`${file}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('不给 -rgb 通道写逗号兜底（逗号写法与空格分隔的通道值拼不出合法 rgb()）', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const call of src.match(/rgb\([^;]*;/g) ?? []) {
        if (/var\(--cop-[a-z0-9-]+-rgb\s*,/.test(call)) offenders.push(`${file}: ${call.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('a11y：扩展内 UI 尊重系统的减少动效偏好', () => {
  it('令牌层声明了 prefers-reduced-motion 降级（此前只有 docs/ 有）', () => {
    expect(readFileSync(TOKENS_FILE, 'utf-8')).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
