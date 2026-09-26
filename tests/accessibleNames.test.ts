/**
 * 可访问名与语言声明（评审 L-13 / L-14：无可访问名的控件、指针独占的控件、非法 `lang`）
 *
 * 本环境 node 无 DOM、未装 `@vue/test-utils`，Vue 组件的渲染结果与读屏实际念出的名字没有运行时
 * 对应物（见 AGENTS.md「测试与验证」）。这里按源码契约钉的，正是那些**删掉之后界面照常、
 * 只有读屏用户会发现**的部分：
 *
 * 1. **`el-switch` 的名字**。EP 把 `aria-label` 原样透到内部那个 `role="switch"` 的
 *    `<input type="checkbox">` 上（`node_modules/element-plus/es/components/switch/src/switch.mjs`），
 *    而 `active-text` 渲染成的是**兄弟** `<span class="el-switch__label">`——它不是那个控件的名字，
 *    读屏报出的是「未命名，开关」。所以光有 `active-text` 不等于有名字。
 *    反例也要钉住：`RuleFormDialog` 里那 9 个开关**不该**各自加 `aria-label`——它们都包在
 *    `el-form-item` 里，EP 的 `useId` 逻辑在「表单项内只有一个可关联控件」时会把 `for` 指过去，
 *    名字本来就是那行标签；再叠一个 `aria-label` 反而把更有信息量的标签盖掉。
 * 2. **复制按钮**：可点击的东西以前是 `<el-icon>`（渲染成 `<i>`）＋ `opacity: 0` ＋ 只靠 `:hover` 显形。
 *    换成原生 `<button>` 只解决「Tab 到得了」，显形必须同时跟着焦点走，否则焦点落在一个隐形的控件上
 *    （WCAG 2.4.7），所以 `.copy-btn` 的 `:hover` 与 `:focus-within` 两条选择器都得在。
 * 3. **`lang`**。`zh_CN` 是 chrome.i18n 的目录名，不是合法 BCP 47 标签；且静态那份只是首帧兜底，
 *    切换语言后必须由 i18n 层把根元素的 `lang` 改到真正渲染的那种语言，否则「界面英文、文档声明中文」
 *    这种错位只有读屏用户看得见。
 * 4. **折叠的状态**（L-14）。`role="button"` 的折叠标题只报得出「按钮」，报不出它是开着还是关着、
 *    开了会多出什么来；而 `aria-controls` 只能指向**当时就在 DOM 里**的元素——`v-if` 的那类面板
 *    收起时目标根本不存在，配上它就是无效 IDREF，所以两处刻意不一样，这里把两种写法各自钉住。
 * 5. **焦点环看得见**（L-14）。「写了 `:focus-visible`」与「焦点看得见」是两件事：往外长的环会被
 *    带 `overflow: hidden` 的父级裁掉，而和它特异度相同、又写在后面的选中态规则会整条盖掉它用的属性。
 *    两条都是无报错的静默失效，判据只能落在「用的是哪个属性、排在哪一条之后」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const popupSrc = readFileSync('entrypoints/popup/App.vue', 'utf-8');
const headerBarSrc = readFileSync('components/options/HeaderBar.vue', 'utf-8');
const ruleTableSrc = readFileSync('components/options/RuleTable.vue', 'utf-8');
const logDrawerSrc = readFileSync('components/options/LogDrawer.vue', 'utf-8');
const settingsSrc = readFileSync('components/options/SettingsDialog.vue', 'utf-8');
const i18nSrc = readFileSync('utils/i18n/index.ts', 'utf-8');
const zhCommon = readFileSync('locales/zh_CN/common.json', 'utf-8');
const enCommon = readFileSync('locales/en/common.json', 'utf-8');
const zhOptions = readFileSync('locales/zh_CN/options.json', 'utf-8');
const enOptions = readFileSync('locales/en/options.json', 'utf-8');

/** components/ 与 entrypoints/ 下全部 .vue（递归），用来做「全仓不得有悬空 IDREF」这类横向检查 */
const vueFiles = ['components', 'entrypoints']
  .flatMap(dir => (readdirSync(dir, { recursive: true }) as unknown as string[]).map(f => `${dir}/${f}`))
  .filter(f => f.endsWith('.vue'));

/**
 * 取某个 SFC 的 `<style>` 正文并剥掉注释。
 *
 * 必须先剥注释：注释里会写到 `.theme-swatch.active` 这类选择器名，
 * 不剥的话「找规则」的正则会从注释中间起算，把解释文字当成声明读。
 */
const styleBlock = (src: string): string => {
  const start = src.indexOf('<style');
  expect(start, 'SFC 应有一个 <style> 块').toBeGreaterThan(-1);
  const body = src.slice(src.indexOf('>', start) + 1, src.lastIndexOf('</style>'));
  return body.replace(/\/\*[\s\S]*?\*\//g, '');
};

/**
 * 按源码顺序取出某个选择器的所有规则块。
 *
 * 选择器边界用 `(?![\w-])` 而不是 `\b`：`.rules-section\b` 会连 `.rules-section-header`
 * 一起命中（`-` 不是单词字符，边界在那儿就成立），那样「父级有没有 overflow: hidden」
 * 读到的其实是别的元素的。
 */
const rulesFor = (css: string, selector: string) =>
  [...css.matchAll(new RegExp(`\\${selector}(?![\\w-])([^{}]*)\\{([^}]*)\\}`, 'g'))].map(m => ({
    suffix: m[1].trim(),
    body: m[2],
    at: m.index ?? 0,
  }));

/** 从 `<el-switch ...>` 起始标签里读出它有没有 `aria-label`（跨行写法一并覆盖） */
const switchTags = (src: string): { tag: string; named: boolean }[] =>
  [...src.matchAll(/<el-switch\b([\s\S]*?)\/>/g)].map(m => ({
    tag: m[0],
    named: /:aria-label=|aria-label=/.test(m[1]),
  }));

describe('[开关的可访问名] 无标签可依托的 el-switch 必须显式 aria-label', () => {
  it('四处独立开关全部有名（它们不在 el-form-item 里，没有任何东西能替它命名）', () => {
    const sites: [string, string][] = [
      ['popup 总开关', popupSrc],
      ['HeaderBar 总开关', headerBarSrc],
      ['RuleTable 行内开关', ruleTableSrc],
    ];
    for (const [name, src] of sites) {
      const switches = switchTags(src);
      expect(switches.length, `${name}：一枚开关都不剩了？`).toBeGreaterThanOrEqual(1);
      for (const { tag, named } of switches) expect(named, `${name}：${tag}`).toBe(true);
    }
  });

  it('抽屉里的两枚靠 `active-text` 的开关同时带 aria-label（那不是名字，见文件头）', () => {
    const switches = switchTags(logDrawerSrc);
    expect(switches).toHaveLength(2);
    const withActiveText = switches.filter(s => /:active-text=/.test(s.tag));
    expect(withActiveText).toHaveLength(2);
    for (const { tag, named } of withActiveText) expect(named, tag).toBe(true);
  });

  it('名字全部走 i18n，不硬编码可见文案（本仓库铁律 9）', () => {
    const all = [
      ...switchTags(popupSrc),
      ...switchTags(headerBarSrc),
      ...switchTags(ruleTableSrc),
      ...switchTags(logDrawerSrc),
    ];
    for (const { tag } of all) expect(tag).toMatch(/:aria-label="t\('/);
  });

  it('新用的三个键中英两侧都在且占位符个数一致', () => {
    for (const key of ['enableRuleA11y']) {
      expect(zhCommon, key).toContain(`"${key}"`);
      expect(enCommon, key).toContain(`"${key}"`);
    }
    for (const key of ['proxyToggleA11y', 'logTableA11y', 'copyUrlA11y']) {
      expect(zhOptions, key).toContain(`"${key}"`);
      expect(enOptions, key).toContain(`"${key}"`);
    }
    const dollar = (json: string, key: string) =>
      (json.match(new RegExp(`"${key}":\\s*"[^"]*"`, 'g'))?.[0].match(/\$\d/g) ?? []).length;
    expect(dollar(enCommon, 'enableRuleA11y'), '$1 占位符个数必须中英一致').toBe(dollar(zhCommon, 'enableRuleA11y'));
  });
});

describe('[复制按钮] 从 <i> 换成原生 button，显形跟着焦点走', () => {
  it('两枚都是 <button type="button"> 且带 aria-label（图标在它里面，不是它自己）', () => {
    const buttons = [...logDrawerSrc.matchAll(/<button\b([\s\S]*?)>/g)].filter(m => /class="copy-btn"/.test(m[1]));
    expect(buttons).toHaveLength(2);
    for (const [, attrs] of buttons) {
      expect(attrs).toContain('type="button"');
      expect(attrs).toMatch(/:aria-label="t\('copyUrlA11y'\)"/);
    }
  });

  it('没有一枚 copy-btn 仍直接挂在 el-icon 上（那正是本次修掉的控件语义缺失）', () => {
    expect(logDrawerSrc).not.toMatch(/<el-icon\b[^>]*class="copy-btn"/);
    expect(logDrawerSrc).not.toMatch(/class="copy-btn"[^>]*\/>\s*<CopyDocument/);
  });

  it('`:focus-within` 与 `:hover` 同一条显形规则（只留 hover 就是焦点落在隐形控件上）', () => {
    const reveal = [...logDrawerSrc.matchAll(/\.el-table__row:(hover|focus-within) \.copy-btn/g)].map(m => m[0]);
    expect(reveal).toEqual(['.el-table__row:hover .copy-btn', '.el-table__row:focus-within .copy-btn']);
  });

  it('表格这个焦点位自己有可见焦点环，且用 inset 阴影（outline 会被抽屉的滚动容器裁掉）', () => {
    expect(logDrawerSrc).toContain('.log-table:focus-visible');
    expect(logDrawerSrc).toMatch(/\.log-table:focus-visible\s*\{[^}]*box-shadow:\s*inset/);
    expect(logDrawerSrc).not.toMatch(/\.log-table:focus-visible\s*\{[^}]*outline:/);
  });
});

describe('[键盘选行] 判据在 utils/logRowNavigation.ts，这里只钉界面侧的装配', () => {
  it('表格自身是焦点位并带 role + 名字（裸 div 上的 aria-label 不会被念出来）', () => {
    const table = logDrawerSrc.slice(logDrawerSrc.indexOf('<el-table'), logDrawerSrc.indexOf('<el-table-column'));
    expect(table).toContain('tabindex="0"');
    expect(table).toContain('role="group"');
    expect(table).toContain(':aria-label="t(\'logTableA11y\')"');
    expect(table).toContain('@keydown="handleTableKeydown"');
  });

  it('键盘与指针共用同一个展开出口（两条路不能长成两套逻辑）', () => {
    expect([...logDrawerSrc.matchAll(/function toggleLogDetail\(/g)]).toHaveLength(1);
    expect([...logDrawerSrc.matchAll(/toggleLogDetail\(row\)/g)]).toHaveLength(2);
    expect(logDrawerSrc).toMatch(/function handleRowClick[\s\S]*?toggleLogDetail\(row\)/);
  });

  it('方向键落点要滚进视野，且 currentTarget 在同步段就取走（返回后它是 null）', () => {
    const handler = logDrawerSrc.slice(logDrawerSrc.indexOf('function handleTableKeydown('));
    const capture = handler.indexOf('event.currentTarget');
    const tick = handler.indexOf('nextTick(');
    expect(capture).toBeGreaterThan(-1);
    expect(tick, '异步段里再读 currentTarget 就是 null').toBeGreaterThan(capture);
    expect(handler).toContain("scrollIntoView({ block: 'nearest' })");
  });
});

describe('[lang] 文档语言与屏幕上的语言必须是同一份', () => {
  it('两个入口 HTML 的静态 lang 是合法 BCP 47（下划线形式会被浏览器当未声明语言）', () => {
    for (const file of ['entrypoints/popup/index.html', 'entrypoints/options/index.html']) {
      const src = readFileSync(file, 'utf-8');
      const match = src.match(/<html[^>]*\blang="([^"]*)"/);
      expect(match, `${file} 没有 lang`).not.toBeNull();
      expect(match?.[1], file).toMatch(/^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
      expect(match?.[1], file).not.toContain('_');
    }
  });

  it('i18n 层把根元素 lang 跟着 currentLocale 改写，且首帧就写（immediate）', () => {
    const watchBlock = i18nSrc.slice(i18nSrc.indexOf('watch('), i18nSrc.indexOf('export function t('));
    expect(watchBlock).toContain('document.documentElement.lang');
    expect(watchBlock).toContain('DOCUMENT_LANGS[locale]');
    expect(watchBlock).toContain('currentLocale');
    expect(watchBlock).toContain('immediate: true');
  });

  it('映射表覆盖每一种 LocaleName，且值都是合法标签（新增语言时这里必须同步补）', () => {
    const block = i18nSrc.slice(i18nSrc.indexOf('const DOCUMENT_LANGS'), i18nSrc.indexOf('/**\n * 让根元素'));
    const declared = [...i18nSrc.matchAll(/export type LocaleName = ([^;]+);/g)][0][1];
    const locales = [...declared.matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
    // 先自证解析本身成立：`locales` 为空时下面两句都会「对Nothing成立」地绿过去
    expect(locales.length, 'LocaleName 的解析空转了').toBeGreaterThanOrEqual(2);
    // TS 里的键是不带引号的标识符（`zh_CN: 'zh-CN'`），所以按「标识符 : 字符串」匹配；
    // 上一版这里写成了 `/'\w+':/`，一条都匹配不上，于是整格是假牙（变异「值写成下划线」当场绿）。
    const pairs = [...block.matchAll(/([A-Za-z_]\w*)\s*:\s*'([^']*)'/g)].map(m => [m[1], m[2]] as const);
    expect(pairs.length, '映射表解析空转了').toBe(locales.length);
    expect(pairs.map(p => p[0]).sort(), '键集必须与 LocaleName 一一对应').toEqual(locales);
    for (const [name, value] of pairs) {
      expect(value, `${name} 的 lang 值`).toMatch(/^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
      expect(value, `${name} 的 lang 值`).not.toContain('_');
    }
  });

  it('后台与内容脚本没有 DOM，写 lang 的那一句必须有守卫', () => {
    const watchBlock = i18nSrc.slice(i18nSrc.indexOf('watch('), i18nSrc.indexOf('export function t('));
    expect(watchBlock).toContain("typeof document === 'undefined'");
  });
});

describe('[折叠语义] 折叠标题要报得出开合状态，aria-controls 不许指向不存在的元素', () => {
  const headerTag = popupSrc.slice(
    popupSrc.indexOf('<div\n        class="rules-section-header"'),
    popupSrc.indexOf('>', popupSrc.indexOf('class="rules-section-header"')),
  );

  it('规则列表标题：role=button + tabindex + aria-expanded + aria-controls 四件齐（少一件就是「按钮，未命名状态」）', () => {
    expect(headerTag).toContain('role="button"');
    expect(headerTag).toContain('tabindex="0"');
    expect(headerTag).toContain(":aria-expanded=\"rulesExpanded ? 'true' : 'false'\"");
    expect(headerTag).toContain('aria-controls="rules-section-collapse"');
  });

  it('折叠体始终在 DOM 里（不是 v-if），所以这一处的 IDREF 有效；它靠 visibility 收起，读屏与 Tab 都进不去', () => {
    expect(popupSrc).toContain('id="rules-section-collapse"');
    const collapse = popupSrc.slice(
      popupSrc.indexOf('id="rules-section-collapse"'),
      popupSrc.indexOf('class="rules-section-body"'),
    );
    expect(collapse, '折叠体若改成 v-if，上面那句 aria-controls 就成了悬空 IDREF').not.toContain('v-if');
    const bodyRules = rulesFor(styleBlock(popupSrc), '.rules-section-body');
    const body = bodyRules.find(r => r.suffix === '');
    expect(body, '折叠体自己的那条规则没扫到 = 这一格在空转').toBeDefined();
    expect(body?.body).toContain('visibility: hidden');
    expect(popupSrc).toContain('.rules-section-collapse.is-open .rules-section-body');
  });

  it('候选面板那处刻意只有 aria-expanded、没有 aria-controls（面板是 v-if，收起时没有目标可指）', () => {
    const card = popupSrc.slice(
      popupSrc.indexOf(':aria-expanded="apiPicker'),
      popupSrc.indexOf('>', popupSrc.indexOf(':aria-expanded="apiPicker')),
    );
    expect(card).toContain(':aria-expanded="apiPicker');
    expect(card).not.toContain('aria-controls');
    expect(popupSrc).toMatch(/<div\s+v-if="apiPicker"[\s\S]{0,200}?class="api-picker"/);
  });

  it('全仓每一条静态 aria-controls 都能在同一文件里找到对应 id（横向扫，别只盯改过的这两处）', () => {
    const sites = vueFiles.flatMap(file => {
      const src = readFileSync(file, 'utf-8');
      return [...src.matchAll(/aria-controls="([^"]+)"/g)].map(m => ({ file, id: m[1] }));
    });
    expect(sites.length, '一条 aria-controls 都没扫到 = 这一格在空转').toBeGreaterThanOrEqual(1);
    for (const { file, id } of sites) {
      expect(readFileSync(file, 'utf-8'), `${file} 指向不存在的 #${id}`).toContain(`id="${id}"`);
    }
  });
});

describe('[焦点环] 写了 :focus-visible 不等于焦点看得见', () => {
  it('折叠标题的环画在内侧：父级 `.rules-section` 带 overflow: hidden，往外长的环会被裁', () => {
    const css = styleBlock(popupSrc);
    const section = rulesFor(css, '.rules-section');
    expect(section.length, '没扫到 .rules-section = 这一格在空转').toBeGreaterThanOrEqual(1);
    expect(section[0].body, '父级不再裁剪时，这里的理由要重新判一次').toContain('overflow: hidden');
    const focus = rulesFor(css, '.rules-section-header:focus-visible');
    expect(focus).toHaveLength(1);
    expect(focus[0].body).toContain('outline: none');
    expect(focus[0].body, '只能靠 inset：外描边会被上面那条 overflow: hidden 裁掉').toMatch(/box-shadow:\s*inset/);
  });

  it('主题色板的环走 outline，不走会被选中态盖掉的 box-shadow', () => {
    const css = styleBlock(settingsSrc);
    const base = rulesFor(css, '.theme-swatch');
    expect(base.length, '没扫到 .theme-swatch = 这一格在空转').toBeGreaterThanOrEqual(1);
    expect(base[0].body, '基础规则里的 outline: none 正是把 UA 默认环也关掉的那一手').not.toMatch(/outline:\s*none/);

    const focus = rulesFor(css, '.theme-swatch:focus-visible');
    expect(focus).toHaveLength(1);
    expect(focus[0].body).toMatch(/outline:\s*\d+px solid/);
    expect(focus[0].body).toMatch(/outline-offset:/);
    expect(focus[0].body, 'box-shadow 会被 .active 整条盖掉，焦点环不能挂在它上面').not.toMatch(/box-shadow/);
  });

  it('.theme-swatch:focus-visible 之后不得再有同特异度规则规定 outline（顺序一换，焦点环就赢不回来）', () => {
    const css = styleBlock(settingsSrc);
    const focus = rulesFor(css, '.theme-swatch:focus-visible')[0];
    const later = rulesFor(css, '.theme-swatch').filter(r => r.at > focus.at);
    expect(later.length, '后面没有别的 .theme-swatch 规则 = 这一格在空转').toBeGreaterThanOrEqual(1);
    for (const rule of later) expect(rule.body, `选择器 ${rule.suffix}`).not.toMatch(/outline/);
  });

  it('焦点环用主色令牌而不是字面色值（跟随换肤，暗色档才不会糊底）', () => {
    const css = styleBlock(settingsSrc);
    expect(rulesFor(css, '.theme-swatch:focus-visible')[0].body).toContain('var(--cop-primary)');
  });
});
