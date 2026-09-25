/**
 * 规则级统计的两个纯函数（`utils/ruleStats.ts`）里，此前没有主人的那两格
 *
 * 两个读端都是界面读数：`computeLogStats` 供日志抽屉的统计条（`LogDrawer.vue` 的 `logStats`，
 * 吃的是**筛选后的全量**而不是按帧续载的那一截，这条由 `tests/renderWindow.test.ts` 钉），
 * `groupHitStatsByRule` 供规则列表的命中列（`App.vue` 把两条通道折成 `{ net, ext }`、**分两格
 * 显示、绝不相加**）。两个函数在 `tests/full-verification.test.ts` 里都有 describe，本轮只补
 * 那份喂不到的形状。
 *
 * **区间那一格：为什么既有那份等于没钉。** `computeLogStats` 的 JSDoc 对外承诺「200-399 视为
 * success（包含 3xx 重定向成功）」，而既有那份唯一碰到 301 的用断的是 `success + error === total`
 * ——那是一条恒等式：无论怎么划分状态码都成立。它的自证就是盲测轮的 P9：把 `total: logs.length`
 * 改成 `total: success + error`，那一轮 1606 用例（彼时还没有本文件）全绿。于是 3xx 那一半与上
 * 边界从来没被钉过（P3 掐到 299、P5 把 400 划进来、P6 只认 200，三条都不红），有主人的只有下
 * 边界那一边（P4「200 掉出 success」红，因为有一句 `status=200` 的单独断言）。
 *
 * **归并那一格：为什么这里钉的是契约而不是可复现的坏数。** `touch(id).net += n` 与
 * `touch(id).ext += n` 在两个读端各自的当前数据下都不会被区分：扩展通道那本账自己就按
 * `ruleId` 归并（`tests/swHitStats.test.ts` 钉过），网络层那条 `aggregateMatchedInfo` 折叠的是
 * DNR 的数字 id、而 `utils/dnrRules.ts` 按 index 一对一分配，UI 与导入两侧都不产生重复的
 * 代理规则 id（连「复制规则」都刻意不回传 `id`）。要同一条规则落进两条 DNR 规则，得让 `rules`
 * 数组里出现两个相同的 `id`——手改过的 storage、或外来文件，正是本仓在 `configRules()` 与恢复点
 * 读侧各挡一道的同一个威胁模型。所以这两条钉的是「归并」这个函数名自己的含义：喂进重复读数时
 * 它是累加而不是覆盖，两侧各钉各的，因为两份循环是同一个 `touch` 的两半，只改一边不会有任何
 * 编译期或运行期的连带。
 *
 * 刻意没断的两处（盲测 P7、P9 与最终表 M7、M8 因此必须保持活）：`log.status ?? 0` 里那个
 * `?? 0`（`undefined >= 200` 本身就是 `false`，两种写法在唯一的下游判据上同形）、
 * `total: logs.length` 与 `success + error`（划分是穷尽的，两者恒等）。为等价改写写断言，
 * 钉住的是拼写而不是落点。
 *
 * 落证在 `.test-tmp/probe-r20.py`（盲测九格）与 `.test-tmp/mutate-r20.py`（最终表 M1–M10，均不入库）：
 * 基线是 HEAD（`5cb7dac`）的 77 文件 / 1618 用例 / 0 红，十条变异逐条跑完复测仍是这一组数。
 * 盲测轮 P1、P2、P3、P5、P6 全 ALIVE，只有 P4 与对照 P8 红（P8 红 4 条）；最终表 M1–M6 每条都红，
 * 且除 M4 外只红在本文件的用例上——M4（200 掉出 success）连带红了 `full-verification` 那句
 * `status=200`，那恰好是「既有那份只钉得住下边界」的形状。两处等价改写 M7（去掉 `?? 0`）、
 * M8（`total` 改成求和）保持 ALIVE。两条**已知有主人**的对照各红在既有用例上：M9（`touch` 不落
 * Map）红 7 条、其中 4 条是 `full-verification` 的既有 describe；M10（徽章的 3xx 画成绿）只红它
 * 那一句 `getStatusColor`。M10 另证一件事：本轮没有把徽章那一格挪成自己的主人。
 *
 * 顺带记下一处**刻意不同**的口径，别被「顺手统一」：状态码徽章（`utils/formatters.ts` 的
 * `getStatusColor`）把 300-399 画成中性色（既不是 success 也不是 danger），而统计条把 3xx 计入
 * success。一个说的是「这一行长什么样」，一个说的是「这一笔算不算成」。后半句一直写在
 * `computeLogStats` 的 JSDoc 里，前半句却连一句注释都没有——读代码的人只看到一侧，就会以为
 * 另一侧写错了，本轮给徽章补上那一句。
 */

import { describe, it, expect } from 'vitest';
import { computeLogStats, groupHitStatsByRule } from '@/utils/ruleStats';
import type { RequestLogEntry } from '@/utils/types';

function makeLog(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: 'log-1',
    timestamp: 1_700_000_000_000,
    ruleId: 'rule-1',
    ruleName: '规则 A',
    originalUrl: 'https://api.example.com/users',
    proxiedUrl: 'https://uat.example.com/users',
    method: 'GET',
    proxyType: overrides.proxyType ?? 'sw',
    ...overrides,
  };
}

describe('computeLogStats — 200-399 都算 success，两端点各一格', () => {
  // 逐个状态码单独量：一次混合断言只能证「分到了哪一边」，点名不了是哪个端点翻了。
  const table: Array<[number | undefined, 'success' | 'error']> = [
    [0, 'error'], // 被阻断的那一笔
    [200, 'success'],
    [299, 'success'],
    [300, 'success'], // 文档明写「包含 3xx」，从这一格起那半段才算数
    [399, 'success'],
    [400, 'error'],
    [500, 'error'],
    [undefined, 'error'], // 读不到状态码 ≠ 成功
  ];

  for (const [status, kind] of table) {
    it(`status=${status ?? 'undefined'} 算 ${kind}`, () => {
      const stats = computeLogStats([makeLog({ status })]);
      expect(stats).toEqual({ total: 1, success: kind === 'success' ? 1 : 0, error: kind === 'success' ? 0 : 1 });
    });
  }

  it('一份混合日志里三个数各自累加，success 含 3xx', () => {
    const logs = [200, 301, 399, 0, 404, undefined].map(status => makeLog({ status }));
    expect(computeLogStats(logs)).toEqual({ total: 6, success: 3, error: 3 });
  });
});

describe('groupHitStatsByRule — 同规则多条读数是累加而不是覆盖', () => {
  it('扩展通道同一条规则的两条读数相加，网络层不受牵连', () => {
    const stats = groupHitStatsByRule(
      [{ ruleId: 'r1', hitCount: 10 }],
      [
        { ruleId: 'r1', hitCount: 3 },
        { ruleId: 'r1', hitCount: 4 },
      ],
    );
    expect(stats.get('r1')).toEqual({ net: 10, ext: 7 });
  });

  it('网络层同一条规则的两条读数相加，扩展通道不受牵连', () => {
    const stats = groupHitStatsByRule(
      [
        { ruleId: 'r1', hitCount: 3 },
        { ruleId: 'r1', hitCount: 4 },
      ],
      [{ ruleId: 'r1', hitCount: 10 }],
    );
    expect(stats.get('r1')).toEqual({ net: 7, ext: 10 });
  });

  it('重复读数不额外产生条目，也不把没出现过的那一侧画成 undefined', () => {
    const stats = groupHitStatsByRule(
      [
        { ruleId: 'r1', hitCount: 1 },
        { ruleId: 'r1', hitCount: 2 },
      ],
      [],
    );
    expect(stats.size).toBe(1);
    expect(stats.get('r1')).toEqual({ net: 3, ext: 0 });
  });
});
