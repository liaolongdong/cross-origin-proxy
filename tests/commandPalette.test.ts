import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync('components/options/App.vue', 'utf-8');
const palette = readFileSync('components/options/CommandPalette.vue', 'utf-8');
const searchBar = readFileSync('components/options/SearchFilterBar.vue', 'utf-8');
const settings = readFileSync('components/options/SettingsDialog.vue', 'utf-8');

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

  it('空查询不铺规则；有查询最多 6 条', () => {
    expect(palette).toContain('if (!query.value) return [];');
    expect(palette).toContain('.slice(0, 6)');
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
