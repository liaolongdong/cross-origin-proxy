/**
 * DNR 命中详情的聚合契约
 *
 * `getMatchedRules` 返回的是**逐条请求**的命中明细（同一个 DNR ruleId 会出现 N 次），
 * 界面要的是规则级计数。这段折叠逻辑原先埋在 `getDnrHitStats()` 里、依赖 chrome API 才能测，
 * 本文件把它作为纯函数钉住：映射回落、同 id 累加、按次数降序。
 * 末尾顺带覆盖 `formatClock`——popup 的「采样于 ……」小字用它渲染，是同一批可见性改动的一部分。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { aggregateMatchedInfo, setDnrRuleIdMap } from '@/entrypoints/background/dnrStats';
import { formatClock } from '@/utils/formatters';

type MatchedRuleInfo = chrome.declarativeNetRequest.MatchedRuleInfo;

/** 造一条命中明细：只有 rule.ruleId 参与折叠，其余字段填近真值 */
function hit(ruleId: number, tabId = -1): MatchedRuleInfo {
  return { rule: { ruleId, rulesetId: '_dynamic' }, tabId, timeStamp: 1_700_000_000_000 };
}

beforeEach(() => {
  // 模块级映射会被 dnrManager 覆写，每个用例自带一份，避免互相串味
  setDnrRuleIdMap(
    new Map([
      [10001, { ruleId: 'rule-a', ruleName: '规则 A' }],
      [10002, { ruleId: 'rule-b', ruleName: '规则 B' }],
    ]),
  );
});

describe('aggregateMatchedInfo', () => {
  it('同一 DNR ruleId 的多条命中累加为一个计数', () => {
    const stats = aggregateMatchedInfo([hit(10001), hit(10001), hit(10001)]);
    expect(stats).toEqual([{ ruleId: 'rule-a', ruleName: '规则 A', hitCount: 3 }]);
  });

  it('按 hitCount 降序排列，让界面第一眼看到真正在工作的规则', () => {
    const stats = aggregateMatchedInfo([hit(10002), hit(10001), hit(10001)]);
    expect(stats.map(s => [s.ruleId, s.hitCount])).toEqual([
      ['rule-a', 2],
      ['rule-b', 1],
    ]);
  });

  it('映射里没有的 ruleId 回落成 #<ruleId>，而不是整条丢弃', () => {
    const stats = aggregateMatchedInfo([hit(19999), hit(19999)]);
    expect(stats).toEqual([{ ruleId: '19999', ruleName: '#19999', hitCount: 2 }]);
  });

  it('无命中时返回空数组（调用方据此区分「零命中」与「未采样」）', () => {
    expect(aggregateMatchedInfo([])).toEqual([]);
  });
});

describe('formatClock', () => {
  it('本地时区 HH:MM:SS，单位数补零', () => {
    // 用本地时区构造，避免断言随机器时区漂移
    const ts = new Date(2026, 8, 19, 9, 5, 3).getTime();
    expect(formatClock(ts)).toBe('09:05:03');
  });

  it('非法时间戳返回空串，不渲染 Invalid Date', () => {
    expect(formatClock(Number.NaN)).toBe('');
  });
});
