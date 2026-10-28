/** 命令面板的动作 key：只收导航与安全动作，不含删除 / 清空 / 批量这类破坏性操作 */
export type CommandPaletteAction =
  | 'add-rule'
  | 'logs'
  | 'url-test'
  | 'import-export'
  | 'profiles'
  | 'settings'
  | 'self-check'
  | 'about'
  | 'focus-search'
  | 'clear-filters';

export interface CommandPaletteActionEntry {
  key: CommandPaletteAction;
  label: string;
}
