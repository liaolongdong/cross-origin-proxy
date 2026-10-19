/**
 * 批次六：行级过渡的判据 + 骨架屏的形状约束
 *
 * 分成两半是必要的。`utils/rowMotion.ts` 那四条判据是**纯函数**，按「输入 → 答案」逐个核；
 * 而量矩形、找元素、放 FLIP 那一半在全仓环境里没有运行时对应物（node 环境无 DOM，
 * `jsdom` / `@vue/test-utils` 未装），只能按源码契约钉住——包括最容易悄悄失效的那条：
 * CSS 阶梯的最高一档必须等于 JS 摘类名用的 `ROW_STAGGER_MAX_DELAY_MS`。
 *
 * 判据这边最值钱的不是「该动的时候动了」，而是「不该动的时候没动」：满负载那一格此前实测过
 * 500 行 → 首行出现要 3.7–4.9s，而筛选是用户一边打字一边触发的，少一条让路的规矩就是把
 * 一次重排放成六十次动画。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MAX_ANIMATED_ROWS, ROW_STAGGER_MAX_DELAY_MS } from '@/utils/constants';
import { flipFirstRect, freshRowIds, isSameRowSet, rowMotionAffordable } from '@/utils/rowMotion';

const ruleTable = readFileSync('components/options/RuleTable.vue', 'utf8');
const logDrawer = readFileSync('components/options/LogDrawer.vue', 'utf8');
const tableSkeleton = readFileSync('components/options/TableSkeleton.vue', 'utf8');
const tokens = readFileSync('assets/theme/tokens.css', 'utf8');

describe('rowMotionAffordable — 哪一档该动、哪一档绝不该动', () => {
  it('常规筛选动：两侧都在预算内且都不为空', () => {
    expect(rowMotionAffordable(30, 4)).toBe(true);
    expect(rowMotionAffordable(1, 1)).toBe(true);
    expect(rowMotionAffordable(MAX_ANIMATED_ROWS, MAX_ANIMATED_ROWS)).toBe(true);
  });

  it('上一屏空着不动：表格刚从骨架 / 空态 / 无匹配换进来，panel-swap 已经说过一次话', () => {
    expect(rowMotionAffordable(0, 5)).toBe(false);
    expect(rowMotionAffordable(0, 0)).toBe(false);
  });

  it('这一屏空着不动：表格整块交给「无匹配」面板，没有行可挪', () => {
    expect(rowMotionAffordable(5, 0)).toBe(false);
  });

  it('越过预算线就不动，两侧各自都算一遍', () => {
    // 这一屏越线：清掉筛选就是几百行动起来，代价落在新挂的那批上
    expect(rowMotionAffordable(3, MAX_ANIMATED_ROWS + 1)).toBe(false);
    // 上一屏越线：那一次重排本来要挪的就是六十多行，代价落在被挪的那批上
    expect(rowMotionAffordable(MAX_ANIMATED_ROWS + 1, 3)).toBe(false);
    expect(rowMotionAffordable(MAX_ANIMATED_ROWS * 4, MAX_ANIMATED_ROWS * 4)).toBe(false);
  });
});

describe('isSameRowSet — 拖拽落位那一次必须让路', () => {
  it('同一批行换了顺序判真：那份 FLIP 由 onTableDrop 放，重复放会把起点算到中间态上', () => {
    expect(isSameRowSet(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
  });

  it('换了一条就判假', () => {
    expect(isSameRowSet(['a', 'b', 'c'], ['a', 'b', 'd'])).toBe(false);
  });

  it('长度不同直接判假，不必排序', () => {
    expect(isSameRowSet(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
  });

  it('两侧都空判假：空对空不叫「同一批行」，那是一屏没有行', () => {
    expect(isSameRowSet([], [])).toBe(false);
  });
});

describe('freshRowIds — 谁是刚被筛回来的', () => {
  it('只交这一屏里上一屏不在的那些，且按这一屏的顺序', () => {
    expect(freshRowIds(['a', 'b'], ['b', 'c', 'a', 'd'])).toEqual(['c', 'd']);
  });

  it('纯重排一个新都没有（那一次整个归 FLIP 管）', () => {
    expect(freshRowIds(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual([]);
  });

  it('上一屏空着时这一屏全是新的 —— 让不让由 rowMotionAffordable 说，这里不越权', () => {
    expect(freshRowIds([], ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('flipFirstRect — 把版面位移换算回视口坐标', () => {
  it('行在表格里往上挪了 60，First 就落在当前视口位置往下 60', () => {
    // before.top 100 → now.top 40：版面往上挪了 60
    expect(flipFirstRect({ left: 0, top: 100 }, { left: 0, top: 40 }, { left: 12, top: 500 })).toEqual({
      left: 12,
      top: 560,
    });
  });

  it('版面没动就不动，哪怕整页滚了、或上方冒出的批量按钮把表格顶下去一截', () => {
    // 这一条就是用 `offsetTop` 而不是 `getBoundingClientRect()` 当 First 的全部理由：
    // 视口位置两次差 300，版面位置一分没动，就不该有任何行滑起来
    expect(flipFirstRect({ left: 0, top: 100 }, { left: 0, top: 100 }, { left: 8, top: 200 })).toEqual({
      left: 8,
      top: 200,
    });
  });

  it('横向也算（列宽随筛选变化时，行确实会左右挪）', () => {
    expect(flipFirstRect({ left: 200, top: 0 }, { left: 120, top: 0 }, { left: 40, top: 40 })).toEqual({
      left: 120,
      top: 40,
    });
  });
});

describe('骨架屏：只在「这一次还没读到过」那一段出现', () => {
  it('规则表的判据是「还在读」且「从来没读到过」', () => {
    expect(ruleTable).toContain('const firstReadPending = computed(() => props.loading && !props.everRead);');
  });

  it('日志抽屉是同一条判据，用的是 logsEverRead', () => {
    expect(logDrawer).toContain('const firstReadPending = computed(() => props.loading && !props.logsEverRead);');
  });

  it('骨架排在读取失败之前，读取失败仍排在空态引导之前', () => {
    const skeleton = ruleTable.indexOf('v-if="firstReadPending"');
    const failed = ruleTable.indexOf('v-else-if="rules.length === 0 && readFailed"');
    const guide = ruleTable.indexOf('v-else-if="rules.length === 0 && !hasAnyRules"');
    expect(skeleton, '骨架那一格不在了').toBeGreaterThan(-1);
    expect(failed, '读取失败那一格不再是 v-else-if（骨架没接进同一条链？）').toBeGreaterThan(skeleton);
    expect(guide, '空态引导不再排在读取失败之后').toBeGreaterThan(failed);
  });

  it('抽屉的遮罩只给「已经读到过一次」之后：首屏那一次交给骨架，不叠两层', () => {
    expect(logDrawer).toContain('v-loading="loading && logsEverRead"');
    expect(logDrawer).toMatch(/<TableSkeleton\s+v-if="firstReadPending"/);
  });

  it('两处共用同一份组件，而它自己不读任何状态（判据留在使用方）', () => {
    expect(ruleTable).toContain("import TableSkeleton from './TableSkeleton.vue';");
    expect(logDrawer).toContain("import TableSkeleton from './TableSkeleton.vue';");
    // 声明里不许出现 loading / everRead 这类状态位：骨架一旦自己判「在不在读」，
    // 两个界面的失败态就会各判各的。`computed(` 一起挡——自己算判据也是同一件事
    expect(tableSkeleton).not.toMatch(/\b(loading|everRead|failed)\s*:/);
    expect(tableSkeleton).not.toMatch(/computed\(/);
  });

  it('每一格都 aria-hidden，整块用 role=status 念一句「在等什么」', () => {
    expect(tableSkeleton).toContain('role="status"');
    expect(tableSkeleton).toContain(':aria-label="label"');
    expect(tableSkeleton).toContain('aria-hidden="true"');
    expect(tableSkeleton).toMatch(/v-for="row in rows"/);
  });

  it('中英各给了那两句读屏文案', () => {
    for (const file of ['locales/zh_CN/options.json', 'locales/en/options.json']) {
      const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      expect(json.rulesSkeletonA11y, `${file} 缺 rulesSkeletonA11y`).toBeTruthy();
      expect(json.logsSkeletonA11y, `${file} 缺 logsSkeletonA11y`).toBeTruthy();
    }
  });
});

describe('行级过渡的形状约束（失效全部无声，只能按源码钉）', () => {
  it('新行名单每次集合变化都重发，包括没有新行的那一次（否则旧名单会盖到重建的元素上）', () => {
    const assign = ruleTable.indexOf('settlingIds.value = new Set(fresh);');
    const gate = ruleTable.indexOf('if (fresh.length > 0)');
    expect(assign, '名单赋值不在无条件的那一层里了').toBeGreaterThan(-1);
    expect(assign, '赋值被挪回 `if (fresh.length > 0)` 里面：筛到空再筛回来会叠一次动画并被旧定时器掐掉').toBeLessThan(
      gate,
    );
    // 定时器同一层要先摘：留着上一只就是「后一次的变化被前一次的时限收走」
    expect(ruleTable).toContain('clearTimeout(settleTimer)');
    // 摘类名的时限两头都得是同一个来源：CSS 用 base 档 + 阶梯顶档，JS 也必须是这两个值
    expect(ruleTable).toContain("motionTokenToMs('--cop-duration-base', 220) + ROW_STAGGER_MAX_DELAY_MS");
  });

  it('三条让路的判据都在调用点上，不是在注释里', () => {
    expect(ruleTable).toContain('rowMotionAffordable(prevIds.length, ids.length)');
    expect(ruleTable).toContain('!isSameRowSet(prevIds, ids)');
    expect(ruleTable).toContain('freshRowIds(prevIds, ids)');
  });

  it('First 用的是版面位置，而且只在数量核对通过时才认这批元素', () => {
    expect(ruleTable).toContain('first.set(id, { left: el.offsetLeft, top: el.offsetTop })');
    expect(ruleTable).toContain('flipFirstRect(before, now,');
    // 这一条是真机量出来的教训：外层 panel-swap 用的是 out-in，新表格要等旧的退完才进 DOM，
    // 那一刻一行都量不到。跨帧存矩形的第一版就是在这里丢了快照，
    // 表现是「表格出现后第一次筛选永远不动」。
    expect(ruleTable).toContain('if (moved && beforeNodes.length === prevIds.length)');
    expect(ruleTable).toContain('if (first.size === 0) return;');
    const motionBlock = ruleTable.slice(
      ruleTable.indexOf('let renderedIds'),
      ruleTable.indexOf('/** 删除行的离场时长'),
    );
    expect(motionBlock, '筛选过渡又拿 readRects 当 First 了：滚动一次就全行齐飞').not.toContain('readRects');
    // 旧位置必须在重渲染之前现量（跨帧存的那一份会在面板交接那一帧丢掉）
    expect(motionBlock).toContain('const beforeNodes = moved ? visibleRowElements() : [];');
    expect(motionBlock.indexOf('const beforeNodes'), '旧位置被挪到 nextTick 之后才量').toBeLessThan(
      motionBlock.indexOf('await nextTick()'),
    );
  });

  it('两轮之间插进第三轮时整包作废（DOM 已经不属于这一次 key）', () => {
    expect(ruleTable).toContain("if (props.rules.map(rule => rule.id).join('\\u0000') !== key) return;");
    expect(ruleTable).toContain('if (nodes.length !== ids.length) return;');
  });

  it('新行类名排在最后：它比「刚保存的那一条」弱，同一行不许同时收到两种动画', () => {
    const fresh = ruleTable.indexOf("if (settlingIds.value.has(row.id)) return 'row-fresh';");
    const entering = ruleTable.indexOf(
      "if (props.highlightRuleId && row.id === props.highlightRuleId) return 'row-entering';",
    );
    expect(fresh, 'row-fresh 不在 rowClassName 里了').toBeGreaterThan(-1);
    expect(fresh, 'row-fresh 排到了 row-entering 之前').toBeGreaterThan(entering);
  });

  it('错峰阶梯每级写成 n + k，且最高一档等于 JS 摘类名用的那个数', () => {
    const rungs = [...ruleTable.matchAll(/\.row-fresh:nth-child\(([^)]*)\)\s*\)\s*\{\s*animation-delay:\s*(\d+)ms/g)];
    const ladder = rungs.map(m => ({ spec: m[1].replace(/\s+/g, ''), ms: Number(m[2]) }));
    expect(ladder.length, '一条错峰阶梯都没解析出来（CSS 写法变了？判据已空转）').toBeGreaterThanOrEqual(3);
    for (const rung of ladder) expect(rung.spec, `${rung.ms}ms 那一档不是 n + k 写法`).toMatch(/^n\+\d+$/);
    expect(Math.max(...ladder.map(r => r.ms)), 'CSS 阶梯的最高一档与 ROW_STAGGER_MAX_DELAY_MS 分家了').toBe(
      ROW_STAGGER_MAX_DELAY_MS,
    );
  });

  it('进场不写 fill: both / forwards（transform 冻在末帧会吃掉悬浮抬升，且无任何报错）', () => {
    const freshRule = /\.rule-table :deep\(\.row-fresh\)\s*\{\s*animation:\s*([^;]+);/.exec(ruleTable);
    expect(freshRule, '.row-fresh 的进场声明没了').toBeTruthy();
    expect(freshRule![1]).toContain('cop-rise-in');
    expect(freshRule![1]).toContain('backwards');
    expect(freshRule![1]).not.toMatch(/\b(both|forwards)\b/);
    expect(freshRule![1]).toMatch(/var\(--cop-duration-base\)/);
  });

  it('那道光的关键帧与时长都在令牌层，两处骨架共用同一个节拍', () => {
    expect(tokens).toContain('@keyframes cop-skeleton-sheen');
    expect(tokens).toMatch(/--cop-duration-sheen:/);
    expect(tableSkeleton).toContain('animation: cop-skeleton-sheen var(--cop-duration-sheen)');
    // `background-size: 200%` 是这条关键帧的前提：缺了它光斑一动不动，而没有任何报错
    expect(tableSkeleton).toContain('background-size: 200% 100%;');
  });

  it('摘类名那个定时器在卸载时被掐掉', () => {
    const start = ruleTable.indexOf('onBeforeUnmount(() => {');
    const unmount = ruleTable.slice(start, ruleTable.indexOf('});', start));
    expect(unmount.length, '没截到 onBeforeUnmount 这一段（写法变了？判据已空转）').toBeGreaterThan(0);
    expect(unmount, '卸载没把 settleTimer 摘掉').toContain('clearTimeout(settleTimer)');
  });
});
