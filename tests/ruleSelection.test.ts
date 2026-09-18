import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import type { ProxyRule } from '@/utils/types';
import { resolveSelectedRules } from '@/utils/ruleSelection';

function makeRule(id: string, targetUrl = 'https://old.example.com'): ProxyRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: `https://api-${id}.example.com/*`,
    targetUrl,
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('resolveSelectedRules — reserve-selection 下的勾选换算', () => {
  it('勾选全部仍存在时原样保留，顺序沿用勾选顺序', () => {
    const a = makeRule('a');
    const b = makeRule('b');
    expect(resolveSelectedRules([b, a], [a, b, makeRule('c')])).toEqual([b, a]);
  });

  it('剔除已从规则集消失的勾选（批量删除 / 导入 / 切换环境后的残留）', () => {
    const a = makeRule('a');
    const ghost = makeRule('gone');
    const result = resolveSelectedRules([a, ghost], [a, makeRule('b')]);
    expect(result.map(r => r.id)).toEqual(['a']);
  });

  it('按 id 换回列表里的当前对象，不沿用勾选里的旧引用', () => {
    const stale = makeRule('a', 'https://stale.example.com');
    const current = makeRule('a', 'https://fresh.example.com');
    const result = resolveSelectedRules([stale], [current]);
    expect(result).toHaveLength(1);
    // 批量迁移预览读的就是这个字段：拿到旧引用会展示并写入过期目标
    expect(result[0]).toBe(current);
    expect(result[0].targetUrl).toBe('https://fresh.example.com');
  });

  it('空勾选 / 空规则集都不报错', () => {
    expect(resolveSelectedRules([], [makeRule('a')])).toEqual([]);
    expect(resolveSelectedRules([makeRule('a')], [])).toEqual([]);
  });
});

describe('[P3] 跨筛选保留勾选的两端契约', () => {
  const tableSrc = fs.readFileSync('components/options/RuleTable.vue', 'utf-8');
  const appSrc = fs.readFileSync('components/options/App.vue', 'utf-8');

  it('选择列开启 reserve-selection，且 el-table 带 row-key（缺 row-key 会直接抛错）', () => {
    expect(tableSrc).toContain(':reserve-selection="true"');
    const selectionCol = tableSrc.slice(
      tableSrc.indexOf('type="selection"'),
      tableSrc.indexOf('</el-table-column>', tableSrc.indexOf('type="selection"')),
    );
    expect(selectionCol).toContain('reserve-selection');
    expect(tableSrc).toContain('row-key="id"');
  });

  it('表格把 clearSelection 暴露出去，并在表格分支被卸载时补发空勾选', () => {
    expect(tableSrc).toContain('defineExpose({ clearSelection })');
    expect(tableSrc).toContain('tableRef.value?.clearSelection()');
    expect(appSrc).toContain('ruleTableRef.value?.clearSelection()');
    // 「筛选无结果」时 v-else 会整个卸载表格（含内部保留勾选），而 RuleTable 本身常驻不卸载，
    // 所以复位必须挂在表格渲染条件上，不能只靠 onBeforeUnmount
    expect(tableSrc).toMatch(
      /watch\(\s*\(\) => props\.rules\.length > 0,[\s\S]*?emit\('selectionChange', \[\]\);[\s\S]*?\{ flush: 'post' \},/,
    );
  });

  it('规则集整体替换的每个入口都清两侧状态', () => {
    const handlerNames = ['handleBatchDelete', 'handleMigrateApply', 'handleImported', 'handleProfilesLoaded'];
    for (const name of handlerNames) {
      const start = appSrc.indexOf(`async function ${name}`);
      expect(start, `${name} 应存在`).toBeGreaterThan(-1);
      // 函数内部的块都有缩进，第一个行首 `}` 即函数结束
      const body = appSrc.slice(start, appSrc.indexOf('\n}', start));
      expect(body, `${name} 需要 clearRuleSelection()`).toContain('clearRuleSelection()');
    }
  });

  it('勾选源写入原始 ref，计数与批量操作读换算后的结果', () => {
    expect(appSrc).toContain('const tableSelection = ref<ProxyRule[]>([])');
    expect(appSrc).toMatch(
      /function handleSelectionChange\(selection: ProxyRule\[\]\) \{\s*tableSelection\.value = selection;/,
    );
    expect(appSrc).toContain('resolveSelectedRules(tableSelection.value, rules.value)');
    // selectedRules 已是计算属性，任何回写都会编译期报错，这里守住不再出现赋值
    expect(appSrc).not.toContain('selectedRules.value =');
  });
});
