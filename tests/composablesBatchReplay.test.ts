/**
 * 批量重放的运行层：串行、对号、分档、上限、重入
 *
 * 这一层的四条承诺各自会安静地坏掉，所以逐条核：
 * - **串行**：并发把 N 笔真请求同时打向同一环境，与「重放要回答现在会怎么走」不是一回事，
 *   并吃掉非幂等确认那道闸门的全部意义；
 * - **对号**：从 `getReplayView()` 收快照，`ownerId` 对上才收——对不上时按「没读到答案」入账，
 *   不把别人的结局记在这一笔头上；
 * - **分档**：成功 / 失败 / 无法判定三档决定汇总那句 toast 与行内 tag，档位错了界面就在说谎；
 * - **上限与重入**：超限整轮不发、在途中重复触发不跑第二趟（否则两轮交错 = 双倍真请求）。
 *
 * `runReplay` 在这里是桩：真实实现（轮次令牌 + `PROXY_REQUEST` 往返）由
 * `tests/requestReplay.test.ts` 与 `tests/composablesReplay.test.ts` 守着，本文件只管编排。
 */
import { describe, it, expect, vi } from 'vitest';
import { useBatchReplay } from '@/composables/useBatchReplay';
import type { BatchReplaySummary, ReplayViewLike } from '@/composables/useBatchReplay';
import type { RequestLogEntry } from '@/utils/types';
import type { ReplayReading } from '@/utils/requestReplay';
import { BATCH_REPLAY_LIMIT } from '@/utils/constants';

function entry(id: string, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id,
    timestamp: 0,
    method: 'GET',
    originalUrl: `https://api.example.com/${id}`,
    status: 200,
    error: undefined,
    ...overrides,
  } as RequestLogEntry;
}

/** 立刻落定的桩：按 id 给出结局，view 与真实实现同一形状（落定即读得到 reading） */
function makeHarness(readingFor: (id: string) => ReplayReading | null) {
  let view: ReplayViewLike = null;
  const calls: string[] = [];
  const runReplay = vi.fn(async (e: RequestLogEntry) => {
    calls.push(e.id);
    const reading = readingFor(e.id);
    view = {
      ownerId: e.id,
      running: false,
      reading,
      transportFailed: reading === null,
      durationMs: 1,
    };
  });
  const batch = useBatchReplay(runReplay, () => view);
  return { batch, calls, runReplay };
}

const answered200 = { outcome: 'answered', status: 200 } as ReplayReading;

describe('串行与进度', () => {
  it('第二笔在第一笔落定前不会被调用（串行是真承诺，不是恰好）', async () => {
    let release: () => void = () => {};
    let view: ReplayViewLike = null;
    const calls: string[] = [];
    const runReplay = async (e: RequestLogEntry) => {
      calls.push(e.id);
      await new Promise<void>(resolve => (release = resolve));
      view = { ownerId: e.id, running: false, reading: answered200, transportFailed: false, durationMs: 1 };
    };
    const batch = useBatchReplay(runReplay, () => view);

    const running = batch.runBatch([entry('a'), entry('b')]);
    // 第一条已进入 await，第二条一个都还没起
    await vi.waitFor(() => expect(calls).toEqual(['a']));
    release();
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b']));
    release();

    const summary = await running;
    expect(summary).toMatchObject({ total: 2, ok: 2, failed: 0, unknown: 0, refused: 0 });
  });

  it('一轮开始就把 total 写对，不被清账抹成 0（回归：clearBatch 曾覆盖刚设的 progress）', async () => {
    // 只让第一笔真的等一次闸门：断言「第一条落定前 total 已是 3」就是这条用例的全部靶心。
    // 三笔各自挂起会让释放器被逐条覆盖，测的就不再是这件事了
    // 初值给 noop 而不是 null：赋值只发生在闭包里，TS 不追踪闭包写入，
    // 声明成 `| null` 会让 `release?.()` 当场编译不过
    let release: () => void = () => {};
    let gated = true;
    const batch = useBatchReplay(
      async () => {
        if (!gated) return;
        await new Promise<void>(resolve => (release = resolve));
      },
      () => null,
    );

    const running = batch.runBatch([entry('a'), entry('b'), entry('c')]);
    expect(batch.batchProgress.value).toEqual({ done: 0, total: 3 });
    gated = false;
    release();
    await running;
    expect(batch.batchProgress.value.done).toBe(3);
  });

  it('每条落定后 done 前进一格，结束时 done === total', async () => {
    const { batch } = makeHarness(() => answered200);
    const summary = await batch.runBatch([entry('a'), entry('b')]);
    expect(summary?.total).toBe(2);
    expect(batch.batchProgress.value).toEqual({ done: 2, total: 2 });
    expect(batch.batchRunning.value).toBe(false);
  });
});

describe('对号：快照不属于这一笔时不编结局', () => {
  it('ownerId 对不上号 → 记成「没读到答案」', async () => {
    let view: ReplayViewLike = null;
    const batch = useBatchReplay(async () => {
      // 别人的结局：既不是这一笔的回包，也不该照抄
      view = { ownerId: 'someone-else', running: false, reading: answered200, transportFailed: false, durationMs: 1 };
    }, () => view);

    const summary = await batch.runBatch([entry('a')]);
    expect(summary).toMatchObject({ total: 1, ok: 0, unknown: 1 });
    expect(batch.batchResults.value['a']).toMatchObject({ transportFailed: true, reading: null, running: false });
  });

  it('落定时 running 仍为真 → 同样不收（没等到落定就取快照）', async () => {
    let view: ReplayViewLike = null;
    const batch = useBatchReplay(async (e: RequestLogEntry) => {
      view = { ownerId: e.id, running: true, reading: null, transportFailed: false, durationMs: 0 };
    }, () => view);

    const summary = await batch.runBatch([entry('a')]);
    expect(summary).toMatchObject({ unknown: 1 });
  });

  it('transportFailed 记为无答案而非失败（往返没走完不等于环境报错）', async () => {
    const { batch } = makeHarness(() => null);
    const summary = await batch.runBatch([entry('a')]);
    expect(summary).toMatchObject({ ok: 0, failed: 0, unknown: 1 });
  });
});

describe('分档：三档汇总与行内 tag 同源', () => {
  it.each<[string, ReplayReading, Partial<BatchReplaySummary>]>([
    ['2xx 回包算成功', { outcome: 'answered', status: 200 } as ReplayReading, { ok: 1 }],
    ['4xx/5xx 回包算失败', { outcome: 'answered', status: 500 } as ReplayReading, { failed: 1 }],
    ['failed 结局算失败', { outcome: 'failed' } as ReplayReading, { failed: 1 }],
    ['mock 算无法判定（代理替这一笔做了主）', { outcome: 'mock' } as ReplayReading, { unknown: 1 }],
    ['blocked 算无法判定', { outcome: 'blocked' } as ReplayReading, { unknown: 1 }],
    ['noRule 算无法判定（没有规则接住它）', { outcome: 'noRule' } as ReplayReading, { unknown: 1 }],
  ])('%s', async (_label, reading, expected) => {
    const { batch } = makeHarness(() => reading);
    const summary = await batch.runBatch([entry('a')]);
    expect(summary).toMatchObject({ total: 1, ok: 0, failed: 0, unknown: 0, ...expected });
  });
});

describe('闸门：形拒、上限、重入', () => {
  it('planReplay 形拒的条目不进结果表，只在汇总里计数', async () => {
    const { batch, runReplay } = makeHarness(() => answered200);
    const summary = await batch.runBatch([
      entry('ok'),
      entry('bad', { originalUrl: '' }),
      entry('relative', { originalUrl: 'not a url' }),
    ]);
    expect(runReplay).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ total: 1, ok: 1, refused: 2 });
    expect(Object.keys(batch.batchResults.value)).toEqual(['ok']);
  });

  it(`超过 ${BATCH_REPLAY_LIMIT} 条整轮拒绝：一笔都不发，也不留在途态`, async () => {
    const { batch, runReplay } = makeHarness(() => answered200);
    const entries = Array.from({ length: BATCH_REPLAY_LIMIT + 1 }, (_, i) => entry(`e${i}`));
    await expect(batch.runBatch(entries)).resolves.toBeNull();
    expect(runReplay).not.toHaveBeenCalled();
    expect(batch.batchRunning.value).toBe(false);
  });

  it('上限以内照常放行（边界值本身合法）', async () => {
    const { batch, runReplay } = makeHarness(() => answered200);
    const entries = Array.from({ length: BATCH_REPLAY_LIMIT }, (_, i) => entry(`e${i}`));
    const summary = await batch.runBatch(entries);
    expect(runReplay).toHaveBeenCalledTimes(BATCH_REPLAY_LIMIT);
    expect(summary).toMatchObject({ total: BATCH_REPLAY_LIMIT, ok: BATCH_REPLAY_LIMIT });
  });

  it('在途时重复触发返回 null，不跑第二趟（否则两轮交错 = 双倍真请求）', async () => {
    let release: () => void = () => {};
    let view: ReplayViewLike = null;
    const calls: string[] = [];
    const runReplay = async (e: RequestLogEntry) => {
      calls.push(e.id);
      await new Promise<void>(resolve => (release = resolve));
      view = { ownerId: e.id, running: false, reading: answered200, transportFailed: false, durationMs: 1 };
    };
    const batch = useBatchReplay(runReplay, () => view);

    const first = batch.runBatch([entry('a')]);
    await vi.waitFor(() => expect(calls).toEqual(['a']));
    await expect(batch.runBatch([entry('b')])).resolves.toBeNull();
    expect(calls).toEqual(['a']);
    release();
    await first;
    expect(batch.batchRunning.value).toBe(false);
  });

  it('clearBatch 清掉上一轮的结果与进度', async () => {
    const { batch } = makeHarness(() => answered200);
    await batch.runBatch([entry('a')]);
    expect(Object.keys(batch.batchResults.value)).toHaveLength(1);
    batch.clearBatch();
    expect(batch.batchResults.value).toEqual({});
    expect(batch.batchProgress.value).toEqual({ done: 0, total: 0 });
  });

  it('在途清账（关抽屉 / 清空日志）：剩下的条目一笔都不再发，在途态自行落回', async () => {
    let release: () => void = () => {};
    let view: ReplayViewLike = null;
    const calls: string[] = [];
    const runReplay = async (e: RequestLogEntry) => {
      calls.push(e.id);
      await new Promise<void>(resolve => (release = resolve));
      view = { ownerId: e.id, running: false, reading: answered200, transportFailed: false, durationMs: 1 };
    };
    const batch = useBatchReplay(runReplay, () => view);

    const running = batch.runBatch([entry('a'), entry('b'), entry('c')]);
    await vi.waitFor(() => expect(calls).toEqual(['a']));
    // 用户在这一刻清账：在途那一笔落定后，b / c 不许出门
    batch.clearBatch();
    release();
    const summary = await running;

    expect(calls).toEqual(['a']);
    expect(summary).toMatchObject({ total: 3 });
    expect(batch.batchRunning.value).toBe(false);
    // 账已被清，结果表是空的（记账不再回到这一屏）
    expect(batch.batchResults.value).toEqual({});
  });

  it('起跑前清账不会误杀这一轮（runBatch 自己开闸）', async () => {
    const { batch, runReplay } = makeHarness(() => answered200);
    batch.clearBatch();
    const summary = await batch.runBatch([entry('a'), entry('b')]);
    expect(runReplay).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ total: 2, ok: 2 });
  });
});
