/**
 * 批量重放：把一串日志按顺序交回代理引擎，逐条收回一份结局
 *
 * 与 `useRequestReplay` 的关系：那一层只养一个 `replayView`（单笔在途状态 + 轮次令牌），
 * 这一层**不新开第二条发请求的路**——每一笔仍然走 `runReplay`，串行 `await`，落定一条
 * 收一条快照。串行是刻意的：并发把 N 笔请求同时打向同一个环境，与「重放」要回答的
 * 「现在会怎么走」不是一回事，也吃掉了非幂等确认那道闸门的全部意义。
 *
 * 快照从 `replayView` 读而不是给 `runReplay` 加返回值：那一层的落定路径有两支
 * （正常回包 / transportFailed），改签名要动三处调用方，而落定后 `replayView` 本来
 * 就带着全部答案——`ownerId` 对上号才收，对不上（理论上只有插队才会发生）按
 * 「没读到答案」入账，不编。
 */
import { ref } from 'vue';
import type { RequestLogEntry } from '@/utils/types';
import { planReplay } from '@/utils/requestReplay';
import type { ReplayReading } from '@/utils/requestReplay';
import { BATCH_REPLAY_LIMIT } from '@/utils/constants';

/** 单条批量结果（`running` 那一档画在行内；被 `planReplay` 拒掉的条目不进这张表，只在汇总里计数） */
export interface BatchReplayRowResult {
  logId: string;
  running: boolean;
  reading: ReplayReading | null;
  transportFailed: boolean;
  durationMs: number;
}

/** 一轮批量重放的汇总（toast 那一句的原料） */
export interface BatchReplaySummary {
  total: number;
  ok: number;
  failed: number;
  unknown: number;
  refused: number;
}

/** `useRequestReplay` 落定后的视图形状（只取本层要读的那几个字段） */
export type ReplayViewLike = {
  ownerId: string;
  running: boolean;
  reading: ReplayReading | null;
  transportFailed: boolean;
  durationMs: number;
} | null;

/**
 * @param runReplay 单笔重放（`useRequestReplay` 的同名函数，串行复用它的轮次令牌）
 * @param getReplayView 落定快照的读取口：传 getter 而不是 ref，让本层在测试里能被普通函数桩替换
 */
export function useBatchReplay(
  runReplay: (entry: RequestLogEntry) => Promise<void>,
  getReplayView: () => ReplayViewLike,
) {
  const batchRunning = ref(false);
  const batchProgress = ref({ done: 0, total: 0 });
  const batchResults = ref<Record<string, BatchReplayRowResult>>({});

  /**
   * 取消闸门：清账（关抽屉 / 清空日志）即请求停
   *
   * 在途的那一笔已经真实发出了，取消不了——「页面已经放弃」不该等于「服务端收到两遍」这条
   * 由 `useRequestReplay` 的 `CANCEL_REQUEST` 尽力而为；这里管的是**剩下的条目**：用户清空
   * 日志或关掉抽屉之后，队列里还没开始的那些一笔都不许再出门。每轮开头检查一次，
   * 已在途的那笔按「没读到答案」落定后循环即停。
   */
  let cancelled = false;

  /** 清账，并让在途的一轮在下一轮开始前停下（`batchRunning` 由循环自己落回，避免两轮交错） */
  function clearBatch(): void {
    cancelled = true;
    batchResults.value = {};
    batchProgress.value = { done: 0, total: 0 };
  }

  /**
   * 跑一轮。上限拦截（`BATCH_REPLAY_LIMIT`）与确认弹窗归调用方——那是界面语言的事；
   * 这里只认「已经在跑就不跑第二趟」这一条。
   *
   * @returns 汇总；批量被拒（在途中重复触发）返回 `null`
   */
  async function runBatch(entries: RequestLogEntry[]): Promise<BatchReplaySummary | null> {
    if (batchRunning.value || entries.length === 0) return null;

    const usable = entries.filter(entry => planReplay(entry).ok);
    const summary: BatchReplaySummary = {
      total: usable.length,
      ok: 0,
      failed: 0,
      unknown: 0,
      refused: entries.length - usable.length,
    };
    if (usable.length === 0) return summary;
    // 兜底：调用方的那道上限闸门漏了（或未来新增入口忘了接），这里仍然不跑超限的一轮
    if (usable.length > BATCH_REPLAY_LIMIT) return null;

    batchRunning.value = true;
    // 这一轮自己开闸：调用方起跑前可能刚清过账（clearBatch 置了取消闸门）
    cancelled = false;
    batchResults.value = {};
    batchProgress.value = { done: 0, total: usable.length };

    for (const entry of usable) {
      // 清账发生在中途（关抽屉 / 清空日志）：这一笔不发了，账也不再记在这屏上
      if (cancelled) break;
      batchResults.value[entry.id] = {
        logId: entry.id,
        running: true,
        reading: null,
        transportFailed: false,
        durationMs: 0,
      };
      await runReplay(entry);
      // 落定前后各查一次：在途这一笔的落定发生在清账之后时，不把它记回已经空掉的表
      if (cancelled) break;
      const view = getReplayView();
      const settled: BatchReplayRowResult =
        view && view.ownerId === entry.id && !view.running
          ? {
              logId: entry.id,
              running: false,
              reading: view.reading,
              transportFailed: view.transportFailed,
              durationMs: view.durationMs,
            }
          : // 快照对不上号（插队 / 没等到落定）：按「没读到答案」入账，不替这一笔编结局
            { logId: entry.id, running: false, reading: null, transportFailed: true, durationMs: 0 };
      batchResults.value[entry.id] = settled;
      batchProgress.value = { done: batchProgress.value.done + 1, total: usable.length };

      if (settled.transportFailed || settled.reading === null) {
        summary.unknown++;
      } else if (settled.reading.outcome === 'failed') {
        summary.failed++;
      } else if (settled.reading.outcome === 'answered' && (settled.reading.status ?? 0) >= 400) {
        summary.failed++;
      } else if (settled.reading.outcome === 'answered') {
        summary.ok++;
      } else {
        // mock / blocked / noRule / siteExcluded / disabled / protocolUnsupported / …
        // 「代理替这一笔做了主」：既不是环境回话，也不是环境报错
        summary.unknown++;
      }
    }

    batchRunning.value = false;
    return summary;
  }

  return { batchRunning, batchProgress, batchResults, runBatch, clearBatch };
}
