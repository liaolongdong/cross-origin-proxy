/**
 * 2026-10-19 动效批：四处「状态变了但画面没有任何交代」的入场
 *
 * 范围刻意小：这三类面板（popup 的两个选择器与它的确认格、URL 预演的结论块、批量迁移的预览列表）
 * 此前是 `v-if` 瞬间出现的——点下去之后没有任何东西告诉用户「那一层是你刚叫出来的」。
 * 骨架屏、筛选时的行级过渡当时都在这一批之外：前者要动规则表那套四态面板切换（改交互，按铁律 10 待拍板），
 * 后者在满负载 500 行时是性能账不是体验账（见项目记忆那条容量满负载实测）。**这两件在 2026-10-19 的下一批做了**，
 * 形状与闸门见 `tests/rowMotion.test.ts` 与 `utils/rowMotion.ts`——这里那份「范围刻意小」的说明是这一批的历史，不是当前边界。
 *
 * 这里钉的是**形状约束**，因为这几条约束的失效全部无声：
 * - 时长与缓动必须来自令牌，否则同一种动作在两个界面差 130ms；
 * - 不许写 `fill: both`/`forwards`——那会把 `transform` 冻在末帧，而动画在级联里排在 `:hover` 之前，
 *   行内悬浮抬升当场失效且没有任何报错；
 * - 引用的关键帧必须真的存在（引用不存在的关键帧同样无报错，元素就停在静止态）。
 * `tests/designTokens.test.ts` 已经全仓核对过后两条，这里补的是**这几处新增**自己的那条。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const popup = readFileSync('entrypoints/popup/App.vue', 'utf8');
const urlTest = readFileSync('components/options/UrlTestDialog.vue', 'utf8');
const migrate = readFileSync('components/options/MigrateTargetsDialog.vue', 'utf8');
const filterBar = readFileSync('components/options/SearchFilterBar.vue', 'utf8');
const tokens = readFileSync('assets/theme/tokens.css', 'utf8');

/** 取某个类选择器的规则体（只取第一个匹配，这几处都是单类名块） */
function ruleOf(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} 不在了`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('}', start));
}

describe('入场动效 — 形状约束', () => {
  it('引用的关键帧在令牌层里真的存在', () => {
    expect(tokens).toContain('@keyframes cop-rise-in');
  });

  it.each([
    ['popup 的候选面板', () => ruleOf(popup, '.api-picker')],
    ['popup 的确认格', () => ruleOf(popup, '.profile-confirm')],
    ['URL 预演的结论块', () => ruleOf(urlTest, '.result-block')],
    ['批量迁移的预览列表', () => ruleOf(migrate, '.migrate-preview')],
    ['筛选栏的批量按钮组', () => ruleOf(filterBar, '.batch-action')],
    ['弹窗的送达账那一行', () => ruleOf(popup, '.config-sync-row')],
  ])('%s 用令牌阶梯、且不写 fill', (_label, read) => {
    const rule = read();
    const animation = rule.match(/animation:\s*([^;]+);/);
    expect(animation, '这一处没有入场动效了').toBeTruthy();
    expect(animation![1]).toContain('cop-rise-in');
    expect(animation![1]).toMatch(/var\(--cop-duration-(base|fast|slow)\)/);
    expect(animation![1]).toContain('var(--cop-ease-enter)');
    expect(animation![1]).not.toMatch(/\d+m?s/);
    expect(animation![1]).not.toMatch(/\b(both|forwards)\b/);
  });

  /**
   * 每一格走哪一档逐个钉住。上面那条只问「是不是阶梯里的一档」，
   * 所以把 `.result-block` 从 slow 悄悄降到 base 它照样绿——那一格的结论块是三行地址，
   * 慢一档是刻意让人读完；档位由「离用户的手多近」决定，改动必须是显式决定，不能是手滑。
   */
  it.each([
    ['popup 的候选面板', () => ruleOf(popup, '.api-picker'), 'slow'],
    ['popup 的确认格', () => ruleOf(popup, '.profile-confirm'), 'fast'],
    ['URL 预演的结论块', () => ruleOf(urlTest, '.result-block'), 'slow'],
    ['批量迁移的预览列表', () => ruleOf(migrate, '.migrate-preview'), 'slow'],
    ['筛选栏的批量按钮组', () => ruleOf(filterBar, '.batch-action'), 'base'],
    ['弹窗的送达账那一行', () => ruleOf(popup, '.config-sync-row'), 'base'],
  ])('%s 固定在 %s 档', (_label, read, rung) => {
    expect(read()).toContain(`var(--cop-duration-${rung})`);
  });

  it('新增的每一条都不在任何 :hover / :active 规则里（悬浮抬升被动画抢掉是无声失效）', () => {
    for (const source of [popup, urlTest, migrate, filterBar]) {
      const hoverRules = source.match(/:hover\s*\{[^}]*\}/g) ?? [];
      for (const rule of hoverRules) expect(rule).not.toContain('animation:');
    }
  });

  it('全仓这几份文件里没有新写的字面量时长（动效只住在令牌层）', () => {
    for (const [name, source] of [
      ['popup', popup],
      ['预演', urlTest],
      ['迁移', migrate],
      ['筛选栏', filterBar],
    ] as const) {
      const literals = (source.match(/(?:transition|animation):[^;]*\d+(?:\.\d+)?m?s/g) ?? []).filter(
        line => !line.includes('var(--cop-'),
      );
      expect(literals, `${name} 里出现了写死的时长`).toEqual([]);
    }
  });
});
