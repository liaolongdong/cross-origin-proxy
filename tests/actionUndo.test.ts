/**
 * 三类批量操作的「操作前旧值」快照与回写计划。
 *
 * 这一格承重的不是形状而是**方向**：`BATCH_UPDATE_TARGETS` / `BATCH_TOGGLE_RULES` / `REORDER_RULES`
 * 按既有口径根本不落配置恢复点（只有替换式导入、加载快照、真正删掉东西的批量删除才落），
 * 所以内存里那份旧值是这三类操作唯一的退路。快照拿错一棵树，界面就会说一句「已改回」
 * 而存储里一动没动——那种红字比不撤销更糟。
 *
 * 全部按「输入 → 答案」测：这些函数不碰 chrome、不碰 Vue、不落存储，所以它们各自会安静地
 * 变成一句谎的那几面都能在这里钉住：
 * ① 只收这次涉及的 id（多收一条就把没参与操作的那条也改了）；
 * ② 列表里根本没有的 id 不编造旧值；
 * ③ 混合的旧状态必须拆成至多两笔（一笔盖不回两种状态）；
 * ④ 空快照不产生任何写入（否则界面上会出现一颗点了没反应的撤销按钮）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  captureEnabled,
  captureOrder,
  captureTargets,
  planRevertToggles,
  type EnabledSnapshot,
} from '@/utils/actionUndo';
import type { ProxyRule } from '@/utils/types';

const rule = (id: string, targetUrl: string, enabled = true): ProxyRule =>
  ({
    id,
    name: id,
    enabled,
    matchType: 'wildcard',
    matchPattern: 'https://a/*',
    targetUrl,
  }) as ProxyRule;

describe('captureTargets — 迁移目标地址的旧值', () => {
  it('只收这次涉及的 id，顺序按传入的 id 列表', () => {
    const rules = [rule('a', 'https://old/1'), rule('b', 'https://old/2'), rule('c', 'https://old/3')];
    expect(captureTargets(rules, ['c', 'a'])).toEqual([
      { id: 'c', targetUrl: 'https://old/3' },
      { id: 'a', targetUrl: 'https://old/1' },
    ]);
  });

  it('列表里根本没有的 id 不编造旧值：那一条既不写也不报', () => {
    expect(captureTargets([rule('a', 'https://old/1')], ['ghost'])).toEqual([]);
  });

  it('重复的 id 不重复收：否则回写会把同一条盖两遍，条数也跟着说谎', () => {
    expect(captureTargets([rule('a', 'https://old/1')], ['a', 'a'])).toEqual([{ id: 'a', targetUrl: 'https://old/1' }]);
  });

  it('目标地址读不出就当空串——与用户自己清空目标是同一件事，比抛错诚实', () => {
    const broken = { id: 'a', name: 'a', enabled: true } as unknown as ProxyRule;
    expect(captureTargets([broken], ['a'])).toEqual([{ id: 'a', targetUrl: '' }]);
  });
});

describe('captureEnabled — 批量启停的旧状态', () => {
  it('读得出布尔就照收', () => {
    const rules = [rule('a', '', true), rule('b', '', false)];
    expect(captureEnabled(rules, ['a', 'b'])).toEqual([
      { id: 'a', enabled: true },
      { id: 'b', enabled: false },
    ]);
  });

  it('读不出布尔就当 false，而不是留 undefined——回写计划里不允许出现第三种状态', () => {
    const broken = { id: 'x', name: 'x' } as unknown as ProxyRule;
    expect(captureEnabled([broken], ['x'])).toEqual([{ id: 'x', enabled: false }]);
  });
});

describe('captureOrder — 拖拽排序的旧顺序', () => {
  it('收的是操作前那一份完整 id 顺序，含没参与拖拽的规则', () => {
    expect(captureOrder([rule('a', ''), rule('b', ''), rule('c', '')])).toEqual(['a', 'b', 'c']);
  });

  it('空列表回空数组：调用方据此不画那颗撤销按钮', () => {
    expect(captureOrder([])).toEqual([]);
  });
});

describe('planRevertToggles — 一笔盖不回两种旧状态', () => {
  it('旧值全同 → 恰好一笔', () => {
    const snapshot: EnabledSnapshot[] = [
      { id: 'a', enabled: true },
      { id: 'b', enabled: true },
    ];
    expect(planRevertToggles(snapshot)).toEqual([{ ruleIds: ['a', 'b'], enabled: true }]);
  });

  it('旧值混合 → 恰好两笔，各自分到自己那一组且顺序按快照', () => {
    const snapshot: EnabledSnapshot[] = [
      { id: 'a', enabled: true },
      { id: 'b', enabled: false },
      { id: 'c', enabled: true },
    ];
    expect(planRevertToggles(snapshot)).toEqual([
      { ruleIds: ['a', 'c'], enabled: true },
      { ruleIds: ['b'], enabled: false },
    ]);
  });

  it('全同的旧值不许拆成两笔：多一笔写入就是一次没必要的存储往返', () => {
    expect(planRevertToggles([{ id: 'a', enabled: false }])).toEqual([{ ruleIds: ['a'], enabled: false }]);
  });

  it('空快照不产生任何写入', () => {
    expect(planRevertToggles([])).toEqual([]);
  });
});

describe('判据只有一份来源（源码契约）', () => {
  const appSrc = fs.readFileSync('components/options/App.vue', 'utf-8');

  it('三个接入点各自只把快照交给同一个外壳，回写只走已有的那三条消息', () => {
    expect(appSrc).toContain('captureTargets(');
    expect(appSrc).toContain('captureEnabled(');
    expect(appSrc).toContain('captureOrder(');
    expect(appSrc).toContain('planRevertToggles(');
  });

  it('四个接入点各画一次撤销提示：一处定义 + 四处调用（迁移、批量启停、全部启停、拖拽排序）', () => {
    const calls = appSrc.match(/runRevertUndo\(/g) ?? [];
    expect(calls.length).toBe(5);
  });

  it('每一条回写都留着纯结果那句兜底：快照为空时界面不许一声不响', () => {
    const fallbacks = appSrc.match(/if \(\s*!runRevertUndo/g) ?? [];
    expect(fallbacks.length).toBe(4);
  });

  it('撤销路径不碰恢复点：一个动作两份账就是下一次翻列表时的谜', () => {
    expect(appSrc).not.toContain('pushConfigHistory');
  });
});
