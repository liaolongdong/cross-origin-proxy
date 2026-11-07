/** 命令面板的动作 key：只收导航与安全动作，不含删除 / 清空 / 批量这类破坏性操作 */
export type CommandPaletteAction =
  | 'add-rule'
  | 'logs'
  | 'url-test'
  | 'env-diff'
  | 'import-export'
  | 'profiles'
  | 'settings'
  | 'self-check'
  | 'about'
  | 'focus-search'
  | 'clear-filters';

/**
 * 规则结果一屏最多列几条
 *
 * 住在这一层而不是组件里，是因为「最多 6 条」在 AGENTS.md 与 README 里都是被当契约说的：
 * 200 条规则全铺出来等于噪声，而面板只给一次方向键的射程。
 */
export const MAX_COMMAND_RULE_RESULTS = 6;

export interface CommandPaletteActionEntry {
  key: CommandPaletteAction;
  label: string;
}
