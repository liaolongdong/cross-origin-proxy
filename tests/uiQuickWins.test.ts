import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 批次「扩展 UI 快赢」的源码契约（node 环境无 DOM，渲染与交互另有真机探针轮负责）。
 *
 * 钉四件事的形状：① 行内标签 chip 是「点这里筛它」的按钮且与下拉共用一份 `tagsFilter`；
 * ② 名称/优先级两列表头排序只排屏幕上的视图，不写回 storage；③ 弹窗两张内联面板有 Esc
 * 收口且探测在途有读数；④ 表单高级能力分组收起时六格仍在 DOM 里（`v-show`），初值由
 * 「有没有开着的」派生而不是恒关。
 */

const ruleTable = readFileSync('components/options/RuleTable.vue', 'utf-8');
const optionsApp = readFileSync('components/options/App.vue', 'utf-8');
const formDialog = readFileSync('components/options/RuleFormDialog.vue', 'utf-8');
const popupApp = readFileSync('entrypoints/popup/App.vue', 'utf-8');
const zhOptions = readFileSync('locales/zh_CN/options.json', 'utf-8');
const enOptions = readFileSync('locales/en/options.json', 'utf-8');
const zhPopup = readFileSync('locales/zh_CN/popup.json', 'utf-8');
const enPopup = readFileSync('locales/en/popup.json', 'utf-8');

/** 取两个锚点之间的那一段源码；锚点找不到就当场红，而不是 slice 出一段错位的文本继续断言 */
function between(source: string, fromNeedle: string, toNeedle: string, label = fromNeedle): string {
  const start = source.indexOf(fromNeedle);
  expect(start, `${label}：起点「${fromNeedle}」不见了`).toBeGreaterThan(-1);
  const end = source.indexOf(toNeedle, start);
  expect(end, `${label}：终点「${toNeedle}」不见了`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('规则列表行内标签 chip 点击筛选（源码契约）', () => {
  it('露出的 chip 是真 button 并把标签交给父层；+N 那枚仍是读数', () => {
    const chips = between(
      ruleTable,
      '<button\n                  v-for="tag in rowTags(row)',
      'v-if="rowTags(row).length > ROW_TAG_VISIBLE"',
    );
    expect(chips, 'chip 不再发 tagClick').toContain("$emit('tagClick', tag)");
    expect(chips).toContain('type="button"');
    expect(chips, 'chip 的无障碍名称丢了').toContain("t('filterByTagA11y', tag)");
    expect(chips, '点亮态不在这枚 chip 上').toContain("'rule-tag--active': isTagActive(tag)");
    expect(ruleTable, '+N 那枚不该变成按钮').toContain('class="rule-tag rule-tag--more"');
    expect(ruleTable).toContain('tagClick: [tag: string];');
    expect(ruleTable).toContain('activeTags?: string[];');
  });

  it('点亮态与筛选判据同一条口径：按小写键比对', () => {
    expect(ruleTable, '点亮态改成区分大小写了，`FAT`/`fat` 会一半亮一半不亮').toContain(
      '.map(tag => tag.toLowerCase())',
    );
  });

  it('容器层把它加进/移出与下拉共用的那一份 tagsFilter，并先归一拼法', () => {
    const handler = between(optionsApp, 'function handleTagChipClick', '\n}\n');
    expect(handler, 'chip 拼法没归一到下拉那一份').toContain('tagNames.value.find');
    expect(handler, '不是就地增删那一份选中集').toContain('tagsFilter.value');
    expect(optionsApp).toContain('@tag-click="handleTagChipClick"');
    expect(optionsApp).toContain(':active-tags="tagsFilter"');
  });

  it('中英各有一条带位点的无障碍文案', () => {
    expect(zhOptions).toContain('"filterByTagA11y": "按标签筛选 $1"');
    expect(enOptions).toMatch(/"filterByTagA11y": "Filter by tag \$1"/);
  });
});

describe('名称与优先级列的表头排序（源码契约）', () => {
  it('两列都声明了 sortable、比较器与「可还原」三档，排序不把顺序写回 storage', () => {
    expect(ruleTable).toContain(':sort-method="byRuleName"');
    expect(ruleTable).toContain(':sort-method="byRulePriority"');
    expect(ruleTable, '排序列没开 sortable').toMatch(/prop="name"[\s\S]{0,180}sortable/);
    expect(ruleTable).toMatch(/prop="priority"[\s\S]{0,180}sortable/);
    // README 那句「再点一次还原」靠的是档位表里的 null：EP 默认只在升/降之间循环，排过就退不回去
    expect(ruleTable).toContain(
      "const SORT_ORDERS: ('ascending' | 'descending' | null)[] = ['ascending', 'descending', null];",
    );
    expect(ruleTable, '名称列没接三档表').toMatch(/prop="name"[\s\S]{0,220}:sort-orders="SORT_ORDERS"/);
    expect(ruleTable, '优先级列没接三档表').toMatch(/prop="priority"[\s\S]{0,220}:sort-orders="SORT_ORDERS"/);
    // `@sort-change` 只许用来翻「排序在场」这一个本地旗标：排序视图与列表顺序是两本账，
    // 把 sort-change 接到重写上，就是让表头一次点击悄悄改写全体 priority
    expect(ruleTable).toContain('@sort-change="handleSortChange"');
    const sortHandler = between(ruleTable, 'function handleSortChange', '\n}\n');
    expect(sortHandler).toContain('sortActive.value =');
    expect(sortHandler, '排序事件不许 emit 任何东西').not.toContain('emit');
    // 排序在场时把手必须收回：`handleReorder` 的下标算在未排序那份数组上，落点与屏幕对不上
    expect(ruleTable, '排序时拖拽没有收口').toContain(":draggable=\"sortActive ? 'false' : 'true'\"");
    expect(ruleTable).toContain("t('dragDisabledWhileSorted')");
    expect(ruleTable, 'onDragStart 没挡排序态').toContain('if (sortActive.value) return;');
    expect(zhOptions).toContain('"dragDisabledWhileSorted"');
    expect(enOptions).toContain('"dragDisabledWhileSorted"');
    const byPriority = between(ruleTable, 'function byRulePriority', '\n}\n');
    expect(byPriority, '缺 priority 的存量数据要按默认档参与比较').toContain('DEFAULT_RULE_PRIORITY');
    expect(ruleTable).toContain("import { DEFAULT_RULE_PRIORITY, ROW_STAGGER_MAX_DELAY_MS } from '@/utils/constants';");
    expect(ruleTable).toContain('localeCompare');
  });
});

describe('弹窗内联面板的 Esc 收口与探测在途读数（源码契约）', () => {
  it('只接 Escape；收起次序从下往上，并把焦点交还给展开它的那张卡', () => {
    const handler = between(popupApp, 'function handlePopupKeydown', '\n}\n');
    expect(handler).toContain("if (event.key !== 'Escape') return;");
    const apiAt = handler.indexOf('apiPicker.value = null');
    const profileAt = handler.indexOf('profilePicker.value = false');
    expect(apiAt, 'Esc 不收「这一页在调谁」面板').toBeGreaterThan(-1);
    expect(profileAt, 'Esc 不收快照面板').toBeGreaterThan(-1);
    expect(apiAt, '「这一页在调谁」排在更下面，该先收它').toBeLessThan(profileAt);
    expect(handler).toContain('createRuleCardRef.value?.focus()');
    expect(handler).toContain('profileCardRef.value?.focus()');
    expect(handler, '收快照面板时不清「后果说明」，Esc 第一下等于什么都没做').toContain("pendingProfileId.value = ''");
  });

  it('监听器随挂载登记、随卸载摘掉，两张卡各有一只 ref', () => {
    expect(popupApp).toContain("window.addEventListener('keydown', handlePopupKeydown);");
    expect(popupApp).toContain("window.removeEventListener('keydown', handlePopupKeydown);");
    expect(popupApp).toContain('ref="createRuleCardRef"');
    expect(popupApp).toContain('ref="profileCardRef"');
  });

  it('探测在途：先挡住第二次点击，卡片下面有 role=status 的一句话，finally 一定收旗标', () => {
    const handler = between(popupApp, 'async function handleCreateRuleFromTab()', '\n}\n');
    const guardAt = handler.indexOf('if (apiProbePending.value) return;');
    const queryAt = handler.indexOf('chrome.tabs.query');
    expect(guardAt, '在途守卫不见了，探测期间可以叠第二轮').toBeGreaterThan(-1);
    expect(guardAt, '在途守卫排在第一次 await 之后——它必须是第一句话').toBeLessThan(queryAt);
    expect(handler).toContain('apiProbePending.value = true;');
    expect(handler, 'finally 里的复位丢了，卡片会永远说「正在看」').toContain(
      'finally {\n    apiProbePending.value = false;\n  }',
    );
    expect(popupApp).toContain('v-if="apiProbePending"');
    expect(popupApp).toContain("{{ t('apiPickerLoading') }}");
    expect(popupApp).toContain('role="status"');
    expect(popupApp, '卡片的忙态没交给辅助技术').toContain(":aria-busy=\"apiProbePending ? 'true' : 'false'\"");
  });

  it('中英各有一条探测在途文案', () => {
    expect(zhPopup).toContain('"apiPickerLoading": "正在看这一页在调哪些接口…"');
    expect(enPopup).toContain('"apiPickerLoading": "Checking which APIs this page calls…"');
  });
});

describe('规则表单的高级能力分组（源码契约）', () => {
  it('组头是带 aria-expanded/aria-controls 的按钮；面板用 v-show 收起——六格始终在 DOM 里，校验与 IDREF 都不悬空', () => {
    expect(formDialog).toContain('aria-controls="advanced-panel"');
    expect(formDialog).toContain(":aria-expanded=\"advancedOpen ? 'true' : 'false'\"");
    expect(formDialog, '面板没挂 v-show：收起即离场，校验与 IDREF 都悬空').toContain('v-show="advancedOpen"');
    expect(formDialog, '面板没有可指向的 id，aria-controls 落空').toContain('id="advanced-panel"');
    expect(formDialog, '面板被改成 v-if：收起时六格离场、焦点回不来').not.toContain('v-if="advancedOpen"');
  });

  it('六格全在面板之内、启用开关之外，顺序不变', () => {
    const toggleAt = formDialog.indexOf('class="advanced-toggle"');
    const transitionEndAt = formDialog.indexOf('</transition>', toggleAt);
    expect(toggleAt).toBeGreaterThan(-1);
    expect(transitionEndAt).toBeGreaterThan(toggleAt);
    const body = formDialog.slice(toggleAt, transitionEndAt);
    for (const label of [
      'requestBodyOverrideLabel',
      'responseOverridesLabel',
      'mockResponseLabel',
      'delayLabel',
      'retryLabel',
      'blockLabel',
    ]) {
      expect(body, `「${label}」没待在高级能力分组里`).toContain(`t('${label}')`);
    }
    // 「启用状态」那一格留在分组之外：它是这条规则开不开，不属于「高级能力」
    expect(formDialog.indexOf("t('enabledLabel')")).toBeGreaterThan(transitionEndAt);
  });

  it('折叠初值由六项派生、且在两支分派之后算；徽标与初值共用同一份判据', () => {
    const initAt = formDialog.indexOf('advancedOpen.value = advancedActiveCount.value > 0;');
    const elseEndAt = formDialog.indexOf('queryList.value = [];');
    expect(initAt, '打开弹窗时不再按「有没有开着的高级能力」决定初值').toBeGreaterThan(-1);
    expect(initAt, '初值排在分派之前，拿到的是上一条规则的残留').toBeGreaterThan(elseEndAt);
    const count = between(formDialog, 'const advancedActiveCount = computed', '\n);');
    for (const flag of [
      'enableRequestBodyOverride',
      'enableResponseOverrides',
      'enableMockResponse',
      'enableDelay',
      'enableRetry',
    ]) {
      expect(count, `${flag} 没被算进分组判据`).toContain(flag);
    }
    expect(count, '阻断没被算进分组判据').toContain('form.blocked');
  });

  it('中英各有分组标题/位点徽标/说明三句', () => {
    for (const [locale, zh] of [
      [zhOptions, true],
      [enOptions, false],
    ] as const) {
      const kind = zh ? '中文' : '英文';
      expect(locale, `${kind}缺分组标题`).toContain('"advancedSectionTitle"');
      expect(locale, `${kind}缺分组说明`).toContain('"advancedSectionHint"');
      expect(locale, `${kind}缺开项数徽标`).toMatch(/"advancedSectionCount": ".*\$1.*/);
    }
  });

  it('箭头旋转过渡用令牌，开合另有 aria-expanded 在说（不只靠旋转）', () => {
    expect(formDialog).toContain('transition: transform var(--cop-duration-fast) var(--cop-ease-standard);');
  });
});
