import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * 键盘可达性三处（2026-09 评审轮）
 *
 * 本环境 node 无 DOM、未装 @vue/test-utils，Vue 组件的渲染与交互只能按源码契约钉
 * （见 AGENTS.md「测试与验证」）。这里钉的三件事都没有运行时对应物：
 *
 * 1. **Space 键**。`role="button" + tabindex="0"` 的 div 能被 Tab 聚焦，但浏览器**不会**
 *    像原生 `<button>` 那样把 Space 映射成激活——只写 `@keydown.enter` 的卡片，键盘用户
 *    按空格只会滚页面。这类元素全仓散在两个文件，所以判据按「枚数」而不是「某一行还在」。
 * 2. **Esc 级联**。`window` 上的全局监听看不见模态层级：确认框（ElMessageBox）在场时按
 *    Escape，EP 自己关掉确认框，级联照样把背后整个弹窗一起关掉。所以让位必须排在级联**之前**
 *    ——写在后面等于没写，故顺序也钉。
 * 3. **删除提示里的「撤销」**。原先渲染的是没有 `href` 的 `<a>`：看得见、点得动（鼠标），
 *    却拿不到焦点，键盘上根本走不到。换成原生 `<button>` 才有焦点与 Enter/Space。
 */

const optionsSrc = readFileSync('components/options/App.vue', 'utf-8');

/** 递归列出 components/ 与 entrypoints/ 下的 .vue，避免「第三个文件新增 role=button 就漏判」 */
const vueFiles = ['components', 'entrypoints']
  .flatMap(dir => (readdirSync(dir, { recursive: true }) as unknown as string[]).map(f => `${dir}/${f}`))
  .filter(f => f.endsWith('.vue'));

const keyboardSites = vueFiles
  .map(file => {
    const src = readFileSync(file, 'utf-8');
    return {
      file,
      focusable: [...src.matchAll(/role="button"/g)].length,
      bothKeys: [...src.matchAll(/@keydown\.enter\.space\.prevent=/g)].length,
      enterOnly: [...src.matchAll(/@keydown\.enter="/g)].length,
    };
  })
  .filter(s => s.focusable > 0 || s.enterOnly > 0);

describe('[Space 键] 可聚焦的 role="button" 元素必须 Enter 与 Space 都能触发', () => {
  it('这类元素只存在于这两个文件（出现第三个文件时回来一起判，别让它漏在清单外）', () => {
    expect(keyboardSites.map(s => s.file).sort()).toEqual([
      'components/options/EmptyGuide.vue',
      'entrypoints/popup/App.vue',
    ]);
  });

  it.each(keyboardSites)('$file：role="button" 的枚数 == Enter+Space 监听枚数', site => {
    expect(site.bothKeys, site.file).toBe(site.focusable);
  });

  it('没有任何一处退回 enter-only（换写法也要连 Space 一起带上）', () => {
    for (const site of keyboardSites) expect(site.enterOnly, site.file).toBe(0);
  });

  it('.prevent 不能丢（少了它 Space 就是把页面滚走，等于没激活）', () => {
    const both = keyboardSites.reduce((n, s) => n + s.bothKeys, 0);
    expect(both).toBeGreaterThanOrEqual(9);
    expect([...optionsSrc.matchAll(/@keydown\.enter=/g)]).toHaveLength(0);
  });
});

describe('[Esc 级联] 确认框在场时不得连背后的弹窗一起关', () => {
  const escStart = optionsSrc.indexOf("if (e.key === 'Escape') {");
  const escBranch = optionsSrc.slice(escStart);

  it('级联之前先看有没有 ElMessageBox 在场', () => {
    expect(escStart).toBeGreaterThan(-1);
    const guard = escBranch.indexOf("document.querySelector('.el-message-box')");
    const cascade = escBranch.indexOf('if (showRuleDialog.value)');
    expect(guard).toBeGreaterThan(-1);
    expect(cascade, '让位必须排在级联之前').toBeGreaterThan(guard);
  });

  it('让位之后那套级联一枚都不能少（收口不能顺手砍掉某个弹窗）', () => {
    expect([...escBranch.matchAll(/^ {6}show[A-Za-z]+\.value = false;$/gm)].length).toBeGreaterThanOrEqual(7);
    for (const panel of [
      'showRuleDialog',
      'showImportExport',
      'showProfiles',
      'showSettings',
      'showUrlTest',
      'showMigrate',
      'showLogs',
    ]) {
      expect(escBranch, panel).toContain(`${panel}.value = false;`);
    }
  });
});

describe('[撤销入口] 删除提示里的「撤销」必须是原生可聚焦按钮', () => {
  const start = optionsSrc.indexOf('const message = ElMessage({');
  const undoBlock = optionsSrc.slice(start, optionsSrc.indexOf('duration: 5000', start));

  it('渲染的是 button 且显式声明 type（表单外的按钮也按语义写全）', () => {
    expect(start).toBeGreaterThan(-1);
    expect(undoBlock).toMatch(/h\(\s*'button',/);
    expect(undoBlock).toContain("type: 'button'");
  });

  it('没有 href 的 <a> 不得回来（那正是本次修掉的键盘死角）', () => {
    expect(undoBlock).not.toMatch(/h\(\s*'a',/);
  });

  it('外观仍按链接画：颜色与下划线留在原处（换成实心按钮就是另一次视觉改动）', () => {
    expect(undoBlock).toContain('text-decoration: underline');
    expect(undoBlock).toContain('var(--cop-primary');
    expect(undoBlock).toContain('font: inherit');
  });
});
