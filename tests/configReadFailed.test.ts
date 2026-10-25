import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import type { ProxyConfig, ProxyRule } from '@/utils/types';

/**
 * `configReadFailed` —— 读取失败不许被画成「还没有规则」（评审 M-11）
 *
 * 界面侧读配置只有一个出口（`GET_PROXY_CONFIG`），而失败有三种形状：消息抛错（SW 正在重启）、
 * 回包不是对象、回包有但没有可用的 `rules` 数组。旧实现在这三条上都是 `return`，于是
 * `rules` 停在初值 `[]`，`RuleTable` 的空态判据（`rules.length === 0 && !hasAnyRules`）成立，
 * 首屏直接给一张「新增规则 / 导入配置」的引导卡——用户可能本来有三十条规则，这张卡等于邀请他
 * 重复创建。同页 DNR 那一格早就定了口径：「不确定」绝不画成「没有」。
 *
 * 这里只测 composable 这一层（假 `chrome` ＋ 真实现，断言的是外部可观察的三件事：旗标、列表、
 * loading）。面板的**先后顺序**是另一件承重的东西——排在引导卡之后它就永远不出现——而 Vue 的渲染
 * 在本环境没有对应物（无 DOM），因此那半按源码契约钉在同文件末尾。
 */

// 本测试在组件实例外调用 composable（生命周期只负责首轮 fetchConfig 与 storage 监听，
// 这两件事由测试手动驱动），因此 Vue 必然抱怨 onMounted/onUnmounted。
// 只吞掉这两条，其余警告照常输出，避免把真实告警也一起静音。
const nativeWarn = console.warn;
vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  const head = String(args[0]);
  if (head.startsWith('[Vue warn]: onMounted') || head.startsWith('[Vue warn]: onUnmounted')) return;
  nativeWarn.apply(console, args);
});

const { useRuleManagement } = await import('@/composables/useRuleManagement');

function makeRule(id: string): ProxyRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: `https://api.${id}.com/*`,
    targetUrl: 'https://target.example.com',
    matchType: 'wildcard',
    priority: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 按队列依次回包；队列元素可以是值（含 `undefined`）或 Error（表示 sendMessage 抛出） */
function stubResponses(responses: unknown[]) {
  const queue = [...responses];
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async () => {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      }),
    },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
}

const okConfig = (ids: string[]): ProxyConfig => ({
  enabled: true,
  rules: ids.map(makeRule),
});

describe('configReadFailed — 三种失败形状都只置旗标，不清空列表', () => {
  it('消息抛错：旗标立起，loading 收口，列表停在空', async () => {
    stubResponses([new Error('Receiving end does not exist')]);
    const mgmt = useRuleManagement();
    await mgmt.fetchConfig();

    expect(mgmt.configReadFailed.value).toBe(true);
    expect(mgmt.loading.value).toBe(false);
    expect(mgmt.rules.value).toEqual([]);
  });

  it('回包为 undefined / 非对象 / rules 不是数组：同样算失败，且不算「读到空表」', async () => {
    for (const bad of [undefined, null, 'boom', {}, { enabled: true }, { enabled: true, rules: 'x' }]) {
      stubResponses([bad]);
      const mgmt = useRuleManagement();
      await mgmt.fetchConfig();
      expect(mgmt.configReadFailed.value, `回包 ${JSON.stringify(bad)} 应判为读取失败`).toBe(true);
      expect(mgmt.rules.value).toEqual([]);
    }
  });

  it('成功读过以后再次失败：留着上一次的三十条，只把旗标立起来', async () => {
    stubResponses([okConfig(['a', 'b']), undefined]);
    const mgmt = useRuleManagement();
    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(false);
    expect(mgmt.rules.value).toHaveLength(2);

    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(true);
    // 这一条是整个修复的正面：失败那一刻列表**不**被清空，界面继续显示已读到的规则
    expect(mgmt.rules.value.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('失败以后恢复：旗标落回 false，列表按新读数刷新', async () => {
    stubResponses([new Error('SW recycling'), okConfig(['a']), okConfig(['a', 'b'])]);
    const mgmt = useRuleManagement();

    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(true);
    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(false);
    expect(mgmt.rules.value.map(r => r.id)).toEqual(['a']);
    // 存疑期间的成功读数必须把旗标洗掉，否则那句提示会挂在界面上不走
    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(false);
    expect(mgmt.rules.value).toHaveLength(2);
  });

  it('确实读到空表：那是「没有规则」，不是失败', async () => {
    stubResponses([okConfig([])]);
    const mgmt = useRuleManagement();
    await mgmt.fetchConfig();

    expect(mgmt.configReadFailed.value).toBe(false);
    expect(mgmt.rules.value).toEqual([]);
  });
});

describe('configEverRead — 只回答「从来没有过读数」', () => {
  it('首轮失败仍是 false；读到一份空表也算读到过', async () => {
    stubResponses([undefined, okConfig([])]);
    const mgmt = useRuleManagement();
    expect(mgmt.configEverRead.value).toBe(false);

    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(true);
    // 「没读到」与「读到空」在这一格上必须分开：顶栏画「未知」只在真的没有读数时成立
    expect(mgmt.configEverRead.value).toBe(false);

    await mgmt.fetchConfig();
    expect(mgmt.configEverRead.value).toBe(true);
  });

  it('成功读过之后再失败不回落：界面上留着最近一次的事实', async () => {
    stubResponses([okConfig(['a']), new Error('SW recycling')]);
    const mgmt = useRuleManagement();
    await mgmt.fetchConfig();
    expect(mgmt.configEverRead.value).toBe(true);
    expect(mgmt.enabled.value).toBe(true);

    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(true);
    expect(mgmt.configEverRead.value).toBe(true);
    expect(mgmt.enabled.value).toBe(true);
  });
});

describe('读取失败面板排在空态引导之前（源码契约）', () => {
  // 与仓内其他源码契约同一读法（`tests/full-verification.test.ts` 用 `fs.readFileSync` 相对路径）：
  // 本环境无 DOM，`.vue` 只能按文本核对，不能 import。
  const table = fs.readFileSync('components/options/RuleTable.vue', 'utf8');
  const app = fs.readFileSync('components/options/App.vue', 'utf8');

  it('两块面板的 key 都在，且失败面板在前', () => {
    const failedAt = table.indexOf('key="read-failed"');
    const guideAt = table.indexOf('key="empty-guide"');

    expect(failedAt).toBeGreaterThan(-1);
    expect(guideAt).toBeGreaterThan(-1);
    // 顺序承重：引导卡在前时，首轮失败（rules 为空 **且** hasAnyRules 为 false）会先命中它，
    // 失败面板一次都画不出来——修了个寂寞。
    expect(failedAt).toBeLessThan(guideAt);
  });

  it('失败面板的判据是「列表为空且读取失败」，刷新按钮接回 fetchConfig', () => {
    const head = table.slice(0, table.indexOf('key="read-failed"'));
    // 2026-10-19 起这一串多了一格：`key="read-failed"` 之前是「首屏还没读到过」的骨架，
    // 所以挂在失败面板上的那条不再是串里的第一个条件。取**离那个 key 最近**的一条——
    // 判据本身一个字没改，改的是它前面多出来的那一格。
    const guards = [...head.matchAll(/v-(?:else-)?if="([^"]+)"/g)];
    expect(guards.length, '找不到挂在 read-failed 那一格上的条件（那一格被写死了？）').toBeGreaterThanOrEqual(1);

    expect(guards[guards.length - 1][1].replace(/\s+/g, ' ')).toBe('rules.length === 0 && readFailed');
    expect(table).toMatch(/@click="\$emit\('refresh'\)"/);
    expect(app).toMatch(/@refresh="fetchConfig"/);
  });

  it('引导卡仍是那句判据，App.vue 把旗标传下来', () => {
    expect(table).toMatch(/v-else-if="rules\.length === 0 && !hasAnyRules"/);
    expect(app).toMatch(/:read-failed="configReadFailed"/);
  });
});

/**
 * 「筛完一行不剩」那一格：说对话，并且给得出下一步（2026-10-24）
 *
 * 这一格此前借用了 `noMatch`——那句是「规则不匹配此 URL」，它的读者是 URL 测试弹窗与规则表单里
 * 那条「测试这条 pattern」的临时规则；而这一格没有 URL 参与：`rules` 是筛选后的、`hasAnyRules`
 * 是筛选前的总数，走到这里只可能是搜索/状态/类型/标签把行全筛掉了。说错话之外还没有出口——
 * 四格筛选里只有搜索与类型带 ×，读者得自己回想动过哪一格。
 *
 * 钉四件事，缺一件这句话就画不圆：措辞按「谁筛的」说；那颗按钮只交出一个意图；父组件真的清四格
 * **且不动勾选**（清了勾选就是替用户撤了他没做过的事——筛选一撤，那几行本来就要回到屏幕上）；
 * 搜索框必须回读父组件的值（否则表格里全是行、输入框还留着旧关键词，界面当着用户自相矛盾）。
 */
describe('筛选无结果那一格说对了话，而且有出口（源码契约）', () => {
  const table = fs.readFileSync('components/options/RuleTable.vue', 'utf8');
  const app = fs.readFileSync('components/options/App.vue', 'utf8');
  const bar = fs.readFileSync('components/options/SearchFilterBar.vue', 'utf8');
  const form = fs.readFileSync('components/options/RuleFormDialog.vue', 'utf8');
  const zh = JSON.parse(fs.readFileSync('locales/zh_CN/options.json', 'utf8')) as Record<string, string>;
  const en = JSON.parse(fs.readFileSync('locales/en/options.json', 'utf8')) as Record<string, string>;

  it('那一格不再出现「规则不匹配此 URL」，改按筛选说话；而 noMatch 这个 key 没被顺手删', () => {
    const panel = table.slice(table.indexOf('key="no-match"'), table.indexOf('</el-table>'));
    expect(panel, '这一格还在校验一条 URL 的地方说 URL').not.toContain("t('noMatch')");
    expect(panel).toContain("t('filterNoMatch')");
    expect(panel).toContain("t('filterNoMatchKeyword'");
    // 有 keyword 与没 keyword 是两件事：只有状态/类型/标签在场时，报一个空关键词就是句坏话。
    expect(panel).toMatch(/searchText\.trim\(\)\s*\?\s*t\('filterNoMatchKeyword'/);
    // 反过来，那句 URL 措辞在它的两个真读者那里必须还在——删掉它就是改了无关界面的文案。
    expect(form).toContain("t('noMatch')");
    expect(zh.noMatch).toContain('URL');
    expect(en.noMatch).toContain('URL');
  });

  it('中英两边都有那三把 key，且都是成对的非空句子', () => {
    for (const key of ['filterNoMatch', 'filterNoMatchKeyword', 'clearFilters']) {
      expect(zh[key], `中文少了 ${key}`).toBeTruthy();
      expect(en[key], `英文少了 ${key}`).toBeTruthy();
    }
    // 占位符必须两边都在：i18n 是单轮替换，少一处就是英文界面画出一个字面量 $1。
    expect(zh.filterNoMatchKeyword).toContain('$1');
    expect(en.filterNoMatchKeyword).toContain('$1');
  });

  it('按钮只交出一个意图，声明与接线成对存在', () => {
    expect(table).toMatch(/@click="\$emit\('clearFilters'\)"/);
    expect(table).toMatch(/clearFilters: \[\];/);
    expect(app).toMatch(/@clear-filters="clearRuleFilters"/);
  });

  it('父组件清的是那四格，且刻意不碰勾选', () => {
    const body = /function clearRuleFilters\(\) \{([\s\S]*?)\n\}/.exec(app);
    expect(body, 'App.vue 里找不到 clearRuleFilters 的函数体').not.toBeNull();
    const lines = body![1].replace(/\s+/g, ' ');
    for (const [name, blank] of [
      ['searchText', "''"],
      ['statusFilter', "''"],
      ['matchTypeFilter', "''"],
      ['tagsFilter', '[]'],
    ]) {
      expect(lines, `清除筛选漏了 ${name}`).toContain(`${name}.value = ${blank}`);
    }
    // 这一条是承重的反判据，理由真机量过：0 行那一格把 `<el-table>` 整个换掉（`panel-swap` 是
    // `mode="out-in"`），表格实例重建后 EP 自己发一次空的 `selection-change`，勾选本来就活不过
    // 这次替换。所以这里再清一次是拿一行代码去赌一个已经发生的事实——而它一旦哪天变成承重的
    // （那一格不再替换表格实例），就必须是**用户没有要求**的删除，因此宁可钉住「不许动」。
    expect(lines, '这里不该动勾选').not.toContain('clearRuleSelection');
  });

  it('搜索框回读父组件的值：外部清了筛选，输入框不许还留着旧关键词', () => {
    expect(bar).toMatch(/watch\(\s*\(\) => props\.searchText,/);
    // 只有两边说的不是同一件事才动它——否则自己 emit 出去的回声会把打字中的光标与输入法合成态拽走。
    expect(bar).toMatch(/if \(val !== localSearchText\.value\) localSearchText\.value = val;/);
  });
});
