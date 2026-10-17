/**
 * 环境快照的读侧判据：`utils/profileValidation.ts`
 *
 * 这支文件钉的是「快照坏在哪一格」与「哪一条根本不寻址」两件事，两个消费者
 * （`utils/storage.ts` 与 `composables/useProfiles.ts`）共用同一份判据：
 * - 后台三条写入路径都要在快照数组上走 `findIndex` / `filter`，`null` 元素会让它们当场抛；
 * - 加载是**整套替换 + 打开总开关**，坏规则必须拒绝而不是当空数组写下去；
 * - 界面渲染 `rules.length` 早于后台那一步，`rules` 不是数组时它先抛，连「这份坏了」都说不出。
 *
 * 因此这里按「谁会受害」逐格断言：不可寻址的条目被剔掉、可寻址但规则坏掉的条目保留（用户删得掉），
 * 只有逐条过闸的规则集才交出 `rules` 让调用方写库。
 */
import { describe, it, expect } from 'vitest';
import { inspectProfileRules, isStoredProfileEntry } from '@/utils/profileValidation';
import { MAX_RULES } from '@/utils/constants';
import type { ProxyRule } from '@/utils/types';

function rule(id = 'r1', overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: 'https://fat.example.com/*',
    targetUrl: 'https://uat.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('inspectProfileRules — 坏规则拒绝加载，且说得出坏在哪一条', () => {
  it('rules 不是数组：原因码 + 条数为 null（「读不出」不能画成 0 条）', () => {
    for (const rules of [undefined, null, 'oops', { 0: rule() }, 42]) {
      const inspection = inspectProfileRules({ rules });
      expect(inspection.code, String(rules)).toBe('invalid-rules');
      expect(inspection.ruleCount).toBeNull();
      expect(inspection.rules).toBeUndefined();
    }
  });

  it('数组里混进非法条目：整包拒绝，并点名第一个非法下标', () => {
    const inspection = inspectProfileRules({ rules: [rule('ok'), { id: 'bad' }] });
    expect(inspection.code).toBe('invalid-rules');
    expect(inspection.ruleCount).toBe(2);
    expect(inspection.firstInvalidIndex).toBe(1);
    // 一条合法的都不能被「顺手留下」：整套替换只接受全合法或全拒绝
    expect(inspection.rules).toBeUndefined();
  });

  it('methods 形状不合法同样算坏规则（与导入/恢复点共用同一份 isValidRuleShape）', () => {
    const inspection = inspectProfileRules({ rules: [rule('ok'), { ...rule('bad'), methods: 'GET' }] });
    expect(inspection.code).toBe('invalid-rules');
    expect(inspection.firstInvalidIndex).toBe(1);
  });

  it('超过 MAX_RULES：原因码是 too-many-rules，不是 invalid-rules', () => {
    const inspection = inspectProfileRules({
      rules: Array.from({ length: MAX_RULES + 1 }, (_, i) => rule(`n${i}`)),
    });
    expect(inspection.code).toBe('too-many-rules');
    expect(inspection.ruleCount).toBe(MAX_RULES + 1);
    expect(inspection.rules).toBeUndefined();
  });

  it('全合法：交出同一个数组引用（写库用的就是这份）', () => {
    const rules = [rule('a'), rule('b')];
    const inspection = inspectProfileRules({ rules });
    expect(inspection.code).toBeUndefined();
    expect(inspection.ruleCount).toBe(2);
    expect(inspection.firstInvalidIndex).toBe(-1);
    expect(inspection.rules).toBe(rules);
  });

  it('空数组是合法现状：加载它是把规则清空，不该被当成坏数据', () => {
    const inspection = inspectProfileRules({ rules: [] });
    expect(inspection.code).toBeUndefined();
    expect(inspection.ruleCount).toBe(0);
    expect(inspection.rules).toEqual([]);
  });
});

describe('isStoredProfileEntry — 剔掉既渲染不了也删不掉的条目', () => {
  it('完整条目通过，并保留 rules 的原文形状（坏 rules 仍要出现在列表里，用户才删得掉）', () => {
    const brokenRules = { id: 'p', name: 'P', createdAt: 1, rules: 'oops' };
    expect(isStoredProfileEntry(brokenRules)).toBe(true);
    // rules 缺失同样可寻址：列表照常显示、加载被 inspectProfileRules 拒绝
    expect(isStoredProfileEntry({ id: 'p', name: 'P', createdAt: 1 })).toBe(true);
  });

  it.each([
    ['null', null],
    ['字符串', 'profile'],
    ['数组', []],
    ['缺 id', { name: 'P', createdAt: 1 }],
    ['空 id', { id: '', name: 'P', createdAt: 1 }],
    ['id 不是字符串', { id: 1, name: 'P', createdAt: 1 }],
    ['name 不是字符串', { id: 'p', name: 1, createdAt: 1 }],
    ['createdAt 不是数字', { id: 'p', name: 'P', createdAt: '2026-01-01' }],
    ['createdAt 是 NaN', { id: 'p', name: 'P', createdAt: NaN }],
    ['createdAt 是 Infinity', { id: 'p', name: 'P', createdAt: Infinity }],
  ])('%s：不寻址', (_label, value) => {
    expect(isStoredProfileEntry(value)).toBe(false);
  });
});
