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
  const TOKENS_SRC = readFileSync(TOKENS_FILE, 'utf-8');

  it('每个 --cop-*-rgb 通道令牌要么是空格分隔三元组，要么是指向同类三元组的 var()', () => {
    // 暗色基座里的 `--cop-primary-rgb: var(--cop-dark-primary-rgb)` 是合法的第二种形态
    // （主题块自带暗色取值，两条暗色路径共用）；三元组字面量仍然必须是空格分隔。
    const values = [...TOKENS_SRC.matchAll(/--cop-[a-z0-9-]+-rgb:\s*([^;]+);/g)].map(m => m[1].trim());
    expect(values.length).toBeGreaterThanOrEqual(8);
    const literal = values.filter(v => !v.startsWith('var('));
    // 「全都是 var()」不能通过：那意味着字面量被整体删掉，斜杠写法就没有落脚点了
    expect(literal.length).toBeGreaterThanOrEqual(7);
    for (const value of literal) expect(value).toMatch(/^\d+\s+\d+\s+\d+$/);
    for (const value of values.filter(v => v.startsWith('var('))) {
      expect(value).toMatch(/^var\(--cop-[a-z0-9-]+-rgb\)$/);
    }
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

describe('暗色下的品牌取值只能由主题块自带（此前五处覆盖只写了半个色系）', () => {
  /** 注释里也会写选择器与令牌名，剥掉再判，否则守卫会被自己的说明文字咬到 */
  const src = readFileSync(TOKENS_FILE, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const DARK_GROUP = [
    '--cop-dark-primary',
    '--cop-dark-primary-hover',
    '--cop-dark-primary-tint',
    '--cop-dark-primary-rgb',
    '--cop-dark-primary-shade',
  ];

  /** 按「选择器 → 声明体」拆出令牌层的每一条规则（本文件只用一层嵌套，媒体查询除外） */
  function declarationBodies(): Array<{ selector: string; body: string }> {
    return [...src.matchAll(/(^|\n)\s*([^\n{}]+)\s*\{([^{}]*)\}/g)].map(m => ({ selector: m[2].trim(), body: m[3] }));
  }

  const bodies = declarationBodies();

  it('默认主题与五个具名主题各带齐五个 --cop-dark-* 品牌令牌', () => {
    const themeBodies = bodies.filter(b => /\[data-theme='[a-z]+'\]/.test(b.selector) && !b.selector.includes('data-mode'));
    expect(themeBodies.map(b => b.selector)).toHaveLength(5);
    const root = bodies.find(b => b.selector === ':root');
    expect(root, '找不到 :root 基座（晴空蓝的暗色取值就住在它里面）').toBeDefined();
    for (const { selector, body } of [...themeBodies, { selector: ':root', body: root!.body }]) {
      const missing = DARK_GROUP.filter(token => !body.includes(`${token}:`));
      expect(missing, selector).toEqual([]);
    }
  });

  it('两条暗色路径的品牌令牌一律 var() 取用，不写死颜色（写死就是拿默认蓝盖掉主题）', () => {
    const darkBases = bodies.filter(b => /\[data-mode='dark'\]$/.test(b.selector) || /\[data-mode\]\)$/.test(b.selector));
    expect(darkBases).toHaveLength(2);
    for (const { selector, body } of darkBases) {
      const brandTokens = DARK_GROUP.concat('--cop-primary', '--cop-primary-rgb');
      const hardcoded = brandTokens.filter(token => {
        const declared = new RegExp(`${token}:\\s*([^;]+);`).exec(body);
        return declared !== null && declared[1].includes('#');
      });
      expect(hardcoded, selector).toEqual([]);
    }
  });

  it('不再存在按主题单独打的暗色补丁块（有则说明那份半个色系回来了）', () => {
    expect(src).not.toMatch(/\[data-mode='dark'\]\[data-theme=/);
  });
});

describe('--el-fill-color-lighter 没有暗色对应值，只能作 --cop-* 的内层兜底', () => {
  /**
   * 令牌层的两条暗色路径覆盖了 `--el-fill-color` / `-light` / `-blank`，唯独不含
   * `--el-fill-color-lighter`，而 Element Plus 只在 `:root` 里把它写成 `#fafafa`
   * （暗色变量表 `theme-chalk/dark/css-vars.css` 本扩展从不引入，因为界面从不打 `html.dark`）。
   * 于是裸用它的地方在暗色下是一块近白面板，配上同一处声明里的 `--el-text-color-regular`
   * （暗色 `#d0d0e0`）就是 1.46:1 的文字——面板与字都是「按亮色算的」。
   */
  const TOKENS_SRC = readFileSync(TOKENS_FILE, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const DARK_BASES = [
    ...TOKENS_SRC.matchAll(/(^|\n)\s*([^\n{}]+)\s*\{([^{}]*)\}/g),
  ]
    .map(m => ({ selector: m[2].trim(), body: m[3] }))
    .filter(b => /\[data-mode='dark'\]$/.test(b.selector) || /\[data-mode\]\)$/.test(b.selector));

  it('暗色基座确实不含这个令牌（含进去就说明下面那条契约可以松绑）', () => {
    expect(DARK_BASES).toHaveLength(2);
    for (const { selector, body } of DARK_BASES) {
      expect(body, selector).not.toMatch(/--el-fill-color-lighter\s*:/);
    }
  });

  it('UI 里每一处引用都紧跟在 `var(--cop-*, ` 之后（裸用即亮色面板漏进暗色）', () => {
    const GUARDED = /var\(--cop-[a-z0-9-]+,\s*$/;
    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(/var\(--el-fill-color-lighter/g)) {
        seen += 1;
        const before = src.slice(0, m.index);
        if (!GUARDED.test(before)) {
          offenders.push(`${file}:${before.split('\n').length} ${before.split('\n').pop()?.trim()}`);
        }
      }
    }
    // 数量级守卫：引用整体消失时上面的循环会假通过（三处改走 --cop-* 之后仍各留一份内层兜底）
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });
});

describe('两条暗色路径的令牌表必须一字不差（本轮 D1/D2 的根因就是它只写了半套）', () => {
  const src = readFileSync(TOKENS_FILE, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const bases = [...src.matchAll(/(^|\n)\s*([^\n{}]+)\s*\{([^{}]*)\}/g)]
    .map(m => ({ selector: m[2].trim(), body: m[3] }))
    .filter(b => /\[data-mode='dark'\]$/.test(b.selector) || /\[data-mode\]\)$/.test(b.selector));

  const decls = (body: string) =>
    new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  const manual = decls(bases[0]?.body ?? '');
  const system = decls(bases[1]?.body ?? '');

  it('两处覆盖同一批令牌（跟随系统暗色的用户不该拿到亮色那一份）', () => {
    expect(bases.map(b => b.selector)).toEqual([":root[data-mode='dark']", ':root:not([data-mode])']);
    // 数量级守卫：整块被清空时两边同为空集，下面的比对会假通过
    expect(manual.size).toBeGreaterThanOrEqual(35);
    expect([...manual.keys()].sort()).toEqual([...system.keys()].sort());
  });

  it('同一个令牌在两处的取值逐字相同', () => {
    const diff = [...manual.keys()].filter(k => manual.get(k) !== system.get(k));
    expect(diff).toEqual([]);
  });
});

describe('状态色浅档（surface 用的 light-N）必须在两条暗色路径都有值', () => {
  /**
   * `--el-color-*-light-N` 在 UI 里只出现在 `background` / `border` 上（没有一处当文字色用），
   * 也就是全都被当成「一块面板」用。而 Element Plus 的暗色变量表要 `html.dark` 才生效，
   * 本扩展从不打那个类，所以这些浅档在暗色下就是一块近白面板配暗色文字（实测 1.46:1）。
   */
  const src = readFileSync(TOKENS_FILE, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const darkBodies = [...src.matchAll(/(^|\n)\s*([^\n{}]+)\s*\{([^{}]*)\}/g)]
    .filter(m => /\[data-mode='dark'\]$/.test(m[2].trim()) || /\[data-mode\]\)$/.test(m[2].trim()))
    .map(m => m[3]);

  const usedTints = new Set<string>();
  for (const file of files) {
    if (file === TOKENS_FILE) continue;
    const s = readFileSync(file, 'utf-8');
    for (const m of s.matchAll(/(?:background|background-color|border|border-color)\s*:[^;]*var\((--el-color-[a-z]+-light-\d)/g)) {
      usedTints.add(m[1]);
    }
  }

  it('UI 确实在用这些浅档铺面（整体清零时本守卫会假通过）', () => {
    expect(usedTints.size).toBeGreaterThanOrEqual(5);
  });

  it.each([...usedTints].sort())('%s 在两条暗色路径都有暗档', token => {
    for (const [i, body] of darkBodies.entries()) {
      expect(body, `暗色基座 #${i + 1}`).toMatch(new RegExp(`${token}\\s*:`));
    }
  });
});

describe('a11y：扩展内 UI 尊重系统的减少动效偏好', () => {
  it('令牌层声明了 prefers-reduced-motion 降级（此前只有 docs/ 有）', () => {
    expect(readFileSync(TOKENS_FILE, 'utf-8')).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
