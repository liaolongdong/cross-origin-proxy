import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync('components/options/App.vue', 'utf-8');
const palette = readFileSync('components/options/CommandPalette.vue', 'utf-8');
const commandPalette = readFileSync('utils/commandPalette.ts', 'utf-8');
const searchBar = readFileSync('components/options/SearchFilterBar.vue', 'utf-8');
const settings = readFileSync('components/options/SettingsDialog.vue', 'utf-8');
const zh = readFileSync('locales/zh_CN/options.json', 'utf-8');
const en = readFileSync('locales/en/options.json', 'utf-8');

describe('⌘K 命令面板（源码契约）', () => {
  it('快捷键分支排在编辑态早退之前：面板自己的搜索框也是 INPUT', () => {
    const shortcut = app.indexOf("modKey && (e.key === 'k' || e.key === 'K')");
    const editableGuard = app.indexOf("if (isEditable && e.key !== 'Escape') return;");
    expect(shortcut, '⌘K 分支不见了').toBeGreaterThan(-1);
    expect(editableGuard, '编辑态早退不见了').toBeGreaterThan(-1);
    expect(shortcut, '⌘K 被编辑态早退挡在后面：面板打开后关不掉').toBeLessThan(editableGuard);
  });

  it('面板计入 anyOverlayOpen，并在 Escape 级联里排最前', () => {
    const overlayStart = app.indexOf('const anyOverlayOpen = computed(');
    expect(overlayStart).toBeGreaterThan(-1);
    expect(app.slice(overlayStart, app.indexOf(');', overlayStart))).toContain('showCommandPalette.value');

    const escapeStart = app.indexOf("if (e.key === 'Escape')");
    const escapeEnd = app.indexOf('\n}\n', escapeStart);
    expect(escapeStart).toBeGreaterThan(-1);
    expect(escapeEnd).toBeGreaterThan(escapeStart);
    const escape = app.slice(escapeStart, escapeEnd);
    const paletteAt = escape.indexOf('showCommandPalette.value');
    const ruleDialogAt = escape.indexOf('showRuleDialog.value');
    expect(paletteAt, 'Escape 级联里没有面板').toBeGreaterThan(-1);
    expect(ruleDialogAt, 'Escape 级联里没有规则弹窗').toBeGreaterThan(-1);
    expect(paletteAt, '面板不在最上层：Escape 会先关掉背后的弹窗').toBeLessThan(ruleDialogAt);
  });

  it('面板只收导航与安全动作，不含删除 / 清空', () => {
    expect(palette).toContain("'add-rule'");
    expect(palette).toContain("'clear-filters'");
    expect(palette).not.toContain("'delete");
    expect(palette).not.toContain("'clear-logs'");
    expect(palette).not.toContain('BATCH_');
  });

  it('空查询不铺规则；有查询最多 `MAX_COMMAND_RULE_RESULTS` 条', () => {
    expect(palette).toContain('if (!query.value) return [];');
    // 上限只住 `utils/commandPalette.ts` 一个出口：AGENTS.md 与 README 把「最多 6 条」当契约说，
    // 组件里再写一遍裸 6，就是下一次改数时界面与文档分家的地方。
    expect(palette).toContain("import { MAX_COMMAND_RULE_RESULTS } from '@/utils/commandPalette';");
    expect(palette).toContain('.slice(0, MAX_COMMAND_RULE_RESULTS)');
    expect(palette).not.toMatch(/\.slice\(0, 6\)/);
    expect(commandPalette).toContain('export const MAX_COMMAND_RULE_RESULTS = 6;');
  });

  it('规则那半没说上话时，面板不许说「没有匹配」', () => {
    // 三种事实三句话：没搜规则（不说话）/ 读失败 / 首屏还在路上——都排在「没有匹配的规则或命令」之前。
    // SW 冷启动时立刻按 ⌘K 打字，手里那份空 `rules` 既不是「一条都没有」也不是「都没匹配」；
    // 读失败那一档更直白：同一屏规则表正在说「暂时读不到」，面板指着同一条空列表说「没匹配」就是自相矛盾。
    expect(palette).toContain("if (props.rulesReadFailed) return t('readFailed');");
    expect(palette).toContain(
      "if (props.rulesLoading && !props.rulesEverRead) return t('commandPaletteRulesReading');",
    );
    // 判据与 `RuleTable` 同一条（`loading && !everRead`），不许面板自己发明「刷新也算在读取」
    expect(palette).toContain('rulesLoading: boolean;');
    expect(palette).toContain('rulesEverRead: boolean;');
    expect(palette).toContain('rulesReadFailed: boolean;');
    // 空态那句必须在「规则那半没说话」时被顶掉，而不是并排出现两句互相打脸的话
    expect(palette).toContain('v-if="ruleItems.length === 0 && actionItems.length === 0 && !rulesNoteText"');
    // 容器那三个旗标必须真的接进来：只加 prop 不传值，等于面板永远读到 false
    expect(app).toContain(':rules-loading="ruleLoading"');
    expect(app).toContain(':rules-ever-read="configEverRead"');
    expect(app).toContain(':rules-read-failed="configReadFailed"');
    // 中英各一句，缺一档就是屏幕上裸出键名
    expect(zh).toContain('"commandPaletteRulesReading"');
    expect(en).toContain('"commandPaletteRulesReading"');
  });

  it('进场补焦只留一枚在途定时器，卸载即掐', () => {
    // EP 的焦点还原与进场动画谁先落地不保证，80ms 兜底必须有；但 `reset()` 与 `@opened` 各下一拍时
    // 不互相掐掉，一次打开就叠出两枚定时器抢焦点，组件卸载后那枚还会继续跑。
    expect(palette).toContain('let focusTimer: number | undefined;');
    expect(palette).toContain('if (focusTimer !== undefined) window.clearTimeout(focusTimer);');
    expect(palette).toContain('onUnmounted(() => {');
    expect(palette).toMatch(
      /onUnmounted\(\(\) => \{\s*\n\s*if \(focusTimer !== undefined\) window\.clearTimeout\(focusTimer\);/,
    );
  });

  it('有 listbox 语义与活动项，键盘操作可达', () => {
    expect(palette).toContain('role="listbox"');
    expect(palette).toContain('aria-activedescendant');
    expect(palette).toContain(':aria-selected=');
    expect(palette).toContain("event.key === 'ArrowDown'");
    expect(palette).toContain("event.key === 'Enter'");
  });

  it('搜索框有鼠标入口，设置页有快捷键说明', () => {
    expect(searchBar).toContain("$emit('openCommandPalette')");
    expect(searchBar).toContain('command-hint');
    expect(app).toContain(':command-shortcut-label="commandShortcutLabel"');
    expect(settings).toContain("t('shortcutCommandPalette')");
  });

  it('规则筛选走共用判据，不在面板里另写一套字段', () => {
    expect(palette).toContain("import { ruleMatchesKeyword } from '@/utils/ruleSearch';");
    expect(palette).toContain('ruleMatchesKeyword(rule, query.value)');
  });
});
