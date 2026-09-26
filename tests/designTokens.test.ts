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
    const themeBodies = bodies.filter(
      b => /\[data-theme='[a-z]+'\]/.test(b.selector) && !b.selector.includes('data-mode'),
    );
    expect(themeBodies.map(b => b.selector)).toHaveLength(5);
    const root = bodies.find(b => b.selector === ':root');
    expect(root, '找不到 :root 基座（晴空蓝的暗色取值就住在它里面）').toBeDefined();
    for (const { selector, body } of [...themeBodies, { selector: ':root', body: root!.body }]) {
      const missing = DARK_GROUP.filter(token => !body.includes(`${token}:`));
      expect(missing, selector).toEqual([]);
    }
  });

  it('两条暗色路径的品牌令牌一律 var() 取用，不写死颜色（写死就是拿默认蓝盖掉主题）', () => {
    const darkBases = bodies.filter(
      b => /\[data-mode='dark'\]$/.test(b.selector) || /\[data-mode\]\)$/.test(b.selector),
    );
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
  const DARK_BASES = [...TOKENS_SRC.matchAll(/(^|\n)\s*([^\n{}]+)\s*\{([^{}]*)\}/g)]
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
    for (const m of s.matchAll(
      /(?:background|background-color|border|border-color)\s*:[^;]*var\((--el-color-[a-z]+-light-\d)/g,
    )) {
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

  it('降级段落把 delay 也归零（只压时长会让错峰进场变成「延迟闪一下」）', () => {
    // 只取这一节自己的花括号体（到第一个顶格的 `}` 为止）——抓到文件末尾就等于
    // 「后面任何地方出现过 animation-delay」也算通过，那是假牙
    const block =
      readFileSync(TOKENS_FILE, 'utf-8').match(
        /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/,
      )?.[1] ?? '';
    expect(block, '没截到降级段落本身（格式变了？]').toMatch(/animation-duration/);
    // 错峰进场用的是 animation-delay（空态页那 2 张引导卡 + 4 张模板卡），入场过渡也可能用
    // transition-delay，两者都留在原地时「时长 0.01ms」只是把动效推到后面去，用户要的「别动」没有兑现。
    expect(block).toMatch(/animation-delay\s*:\s*0s\s*!important/);
    expect(block).toMatch(/transition-delay\s*:\s*0s\s*!important/);
    // 时长压到 0.01ms 而不是 0：0s 永不触发 `transitionend`，而 Element Plus 的折叠、弹窗与
    // 消息过渡靠那个事件收尾——归零会把内容停在半开状态。
    expect(block).toMatch(/transition-duration\s*:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/animation-duration\s*:\s*0\.01ms\s*!important/);
  });
});

/**
 * 动效层的两条静默契约（第三条——降级段落连 delay 一起归零——住在上面那个 a11y 小节里）。
 *
 * 它们和上面那批令牌契约同一类毛病：**错了不报错，只是那一下动效没了（或多了）**。
 * 引用一个不存在的关键帧，Chrome 既不进 console 也不改布局，元素直接停在静止态；
 * `transition: all` 更隐蔽——它让每一个没人打算动的属性都能动，于是筛选一改、
 * 面板尺寸一变就滑出一段并不存在的动画，而这句「哪里怪怪的」极难归因到一行声明上。
 */
describe('动效层：关键帧有名、过渡有清单、不用 all', () => {
  /**
   * 去注释但**保持长度与换行位置不变**：上一版直接 `replace(..., '')`，于是拿剥完的文本
   * 算行号会与真实行号错位（报出来的 `file:12` 指不到那一行），而更要紧的是它让下面的
   * 逐行扫描看不见注释与被注释掉的声明之间的差别。
   */
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  /** 按「括号外的逗号」切分多组动画取值（`cubic-bezier(0.16, 1, 0.3, 1)` 里的逗号不算分隔符）。 */
  const splitTopLevel = (decl: string): string[] => {
    const groups: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of decl) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        groups.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    groups.push(current);
    return groups;
  };
  /**
   * 上面那批令牌契约只该管扩展自己的 UI（`docs/` 的 `rgb()` 字面量与 `--cop-*` 无关，
   * 混进去会把斜杠写法契约打在错误的对象上），但「动效写没写对」这件事对产品站同样成立，
   * 所以这一节多扫一份落地页样式。落地页没有内联 `<style>`，CSS 全在这一个文件里。
   */
  const motionFiles = [...files, 'docs/assets/landing.css'];

  it('每个被引用的 animation 名都在同一文件或 tokens.css 里有 @keyframes', () => {
    const globalFrames = new Set(
      [...readFileSync(TOKENS_FILE, 'utf-8').matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]),
    );
    const missing: string[] = [];
    let referenced = 0;
    for (const file of motionFiles) {
      const src = stripComments(readFileSync(file, 'utf-8'));
      const own = new Set([...src.matchAll(/@keyframes\s+([\w-]+)/g)].map(m => m[1]));
      for (const [, decl] of src.matchAll(/\banimation(?:-name)?\s*:\s*([^;{}]+)/g)) {
        // 简写里各段顺序可变，但本仓库（以及 recess-order 那套约定）一律把名字写在最前面；
        // 多组动画用逗号分隔，取每一组的首个 token。`none` 是关动效，不是关键帧名。
        // 分组只能按「括号外的逗号」切——`cubic-bezier(0.16, 1, 0.3, 1)` 自己就带逗号，
        // 直接 split 会把 `1`、`0.3`、`1)` 当成三个关键帧名。
        for (const group of splitTopLevel(decl)) {
          const name = group.trim().split(/\s+/)[0];
          if (!name || name === 'none' || name === 'inherit' || name === 'initial' || name === 'unset') continue;
          referenced += 1;
          if (!own.has(name) && !globalFrames.has(name)) missing.push(`${file}: ${name}`);
        }
      }
    }
    // 数量级守卫：所有 `animation:` 声明整体消失时上面的循环空转，本用例会同罪假通过
    // （扩展侧 10 处 + 落地页侧 10 处）
    expect(referenced).toBeGreaterThanOrEqual(18);
    expect(missing).toEqual([]);
  });

  it('全仓没有 `transition: all`（注释里点名它的历史写法不算）', () => {
    const offenders: string[] = [];
    for (const file of motionFiles) {
      const src = stripComments(readFileSync(file, 'utf-8'));
      /**
       * 按**整条声明**扫，不按行扫。本仓库的 prettier 就会把过渡清单折成
       * `transition:` + 换行列值（`docs/assets/landing.css` 里有这种形状），逐行匹配时
       * `transition:` 那行没有值、值那行没有属性名，`all 0.2s ease` 正好从缝里过去。
       */
      for (const match of src.matchAll(/\btransition(?:-property)?\s*:\s*([^;{}]+)/g)) {
        const value = match[1].trim();
        const hit = splitTopLevel(value).some(group =>
          /^(all|inherit|initial|revert|unset)$/.test(group.trim().split(/\s+/)[0] ?? ''),
        );
        if (!hit) continue;
        const line = src.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${line} transition: ${value.replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * 错峰进场的阶梯不许有「顶」。
 *
 * `nth-child(2)`、`nth-child(3)` 这种逐个点名的写法，失效方式是静默的：将来从 `templates`
 * 里多加一张卡，它没有规则命中，`animation-delay` 回落到 `0`、跟第一张同时进场，阶梯走到末尾
 * 倒着跳一次——而写代码时数的是「今天这几张排得开」。空态页现在是 2 张引导卡 + 4 张模板卡，
 * 正是这种「数目还会变」的地方。所以这里按**数据源**数张数（静态 `class="guide-card"` 与
 * `templates` 数组里的 `titleKey:`），再按 CSS 里的 `:nth-child(...)` 规则重建每一张的实际
 * 延迟，断言第 2 张起全部 > 0、逐级不下降，并且**多出来的那一张也一样**（量到 total + 1）。
 */
describe('空态页的错峰阶梯不许有「顶」', () => {
  const SRC = readFileSync('components/options/EmptyGuide.vue', 'utf-8');
  const STYLE = SRC.slice(SRC.indexOf('<style'));
  /** 先按「选择器列表 { 声明 }」把样式切成块——`A:nth-child(2), B:nth-child(2) { delay }` 这种
   *  共用一块的写法很常见，直接拿 `.cls:nth-child(...)\s*{` 去匹配只会认出写在 `{` 前面的那一个。 */
  const BLOCKS = [...STYLE.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    delay: /animation-delay:\s*(\d+)ms/.exec(body)?.[1],
  }));

  /** 重建第 index（1 起）张卡的 animation-delay：按文件顺序覆盖，与 CSS 的层叠同向 */
  const delayAt = (cls: string, index: number): number => {
    let delay = 0;
    for (const block of BLOCKS) {
      if (block.delay === undefined) continue;
      for (const selector of block.selectors) {
        const spec = new RegExp(`^\\.${cls}:nth-child\\((.+)\\)$`).exec(selector)?.[1]?.replace(/\s+/g, '');
        if (!spec) continue;
        const span = spec.match(/^n\+(\d+)$/);
        const covered = span ? index >= Number(span[1]) : spec === String(index);
        if (covered) delay = Number(block.delay);
      }
    }
    return delay;
  };

  const guideCards = (SRC.match(/class="guide-card"/g) ?? []).length;
  const templateCards = (SRC.match(/titleKey:\s*'/g) ?? []).length;
  // 数量级守卫：两个张数若都读成 0，说明解析失效而不是「恰好不需要阶梯」——那必须红
  expect(guideCards).toBeGreaterThanOrEqual(2);
  expect(templateCards).toBeGreaterThanOrEqual(3);

  it.each([
    ['guide-card', '引导卡', guideCards],
    ['template-card', '模板卡', templateCards],
  ])('%s：第 2 张起逐级非 0、不下降，且阶梯对「再多一张」依然成立', (cls, label, total) => {
    const steps: number[] = [];
    // 量到 total + 1 那一格：这一条契约说的不是「今天这几张排得开」，而是「将来从
    // `templates` 里多加一张、或往 `.guide-cards` 里再插一张，它不会掉回 0 延迟」。
    // 逐个点名（`:nth-child(4)`）在今天完全正确，却正是这条检查要拦的写法。
    for (let index = 2; index <= Number(total) + 1; index += 1) steps.push(delayAt(String(cls), index));
    expect(steps, `${label}：一张都不该少（读到的张数 ${total}）`).toHaveLength(Number(total));
    expect(
      steps.filter(d => d <= 0),
      `${label}：有张卡没被阶梯覆盖 ${JSON.stringify(steps)}`,
    ).toEqual([]);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i], `${label}：阶梯在第 ${i + 2} 张倒回去了 ${JSON.stringify(steps)}`).toBeGreaterThanOrEqual(
        steps[i - 1],
      );
    }
  });
});

/**
 * 覆盖 Element Plus 自带节奏的那几条，不能只靠「我的样式表排在后面」赢。
 *
 * 它们编译进 options 首屏最后一个 `<link>`，而 EP 组件自己的 CSS 跟着**异步 chunk**
 * （弹窗 / 抽屉那几分片）在运行时追加到 `<head>` 末尾。同特异度时后到者赢，于是「写了覆盖」
 * 与「覆盖生效」是两件事，而且失效静默：抽屉照样滑 300ms，只是不再是令牌层那一档。
 * 2026-09-26 按真实产物在真 Chrome 里量过：抬特异度之前 8 条里只有 3 条生效（其余全是
 * `all 0.3s`）。这里钉住修法——每条选择器都必须严格高于单类名，胜负不再由加载顺序决定。
 */
describe('EP 节奏覆盖必须靠特异度赢，而不是靠加载顺序', () => {
  const GLOBAL_CSS = 'entrypoints/options/styles.css';

  it('凡覆盖 .el-* 的 transition/animation，选择器都不能只是单个类名', () => {
    const src = readFileSync(GLOBAL_CSS, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
    const tooWeak: string[] = [];
    let checked = 0;
    for (const [, selectorList, body] of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|[;{\s])(transition|animation)/.test(body) || !/\.el-/.test(selectorList)) continue;
      for (const part of selectorList.split(',')) {
        const selector = part.trim();
        if (!selector || selector.startsWith('@')) continue;
        checked += 1;
        const classes = (selector.match(/[.#[]|:(?!:)/g) ?? []).length;
        const types = selector
          .replace(/[.#[][-\w]+/g, '')
          .replace(/::?[a-z-]+(\([^)]*\))?/g, '')
          .split(/[\s>+~]+/)
          .filter(Boolean).length;
        // EP 侧最重的对手是两级（`.el-input__wrapper.is-focus`），但那只管 box-shadow；
        // 节奏那几条对手全是单类名，`body .el-drawer`(0,1,1) 与 `.el-input .el-input__wrapper`(0,2,0) 都严格更高
        if (classes >= 2 || (classes >= 1 && types >= 1)) continue;
        tooWeak.push(`${selector} { ${body.trim().replace(/\s+/g, ' ')} }`);
      }
    }
    // 数量级守卫：正则若整体失配（改了写法、块结构变了）这里会静默通过，所以先把「查了几条」钉住
    expect(checked).toBeGreaterThanOrEqual(12);
    expect(tooWeak).toEqual([]);
  });
});
