/**
 * 日志重放的副作用：把一条记录交回代理引擎，收回一份结局
 *
 * 只做三件事——发一笔 `PROXY_REQUEST`、把回包读成一档、把「正在路上 / 读到了 / 没读到」这三态
 * 交到界面上。发之前那句「这会真的再发一次」的确认归调用方（那是界面语言与 `ElMessageBox` 的事，
 * 不是这份状态的一部分），能不能发与怎么读那两个判据归 `utils/requestReplay.ts`。
 *
 * 为什么要单独一层：这个仓库里 Vue 组件的渲染与交互没有运行时对应物（node 环境、无 jsdom），
 * 而「换行之后旧回包不许盖到新行上」这类时序恰恰只有在运行时才看得见。放在 composable 里，
 * 它就能按假 `chrome` 测（见 `tests/composablesReplay.test.ts`），组件那边只剩装配。
 */
import { ref } from 'vue';
import type { RequestLogEntry } from '@/utils/types';
import { MessageType } from '@/utils/types';
import { generateId } from '@/utils/generateId';
import { logger } from '@/utils/logger';
import { planReplay, readReplayEnvelope } from '@/utils/requestReplay';
import type { ReplayReading } from '@/utils/requestReplay';

/** 屏幕上那一段重放状态（`null` = 这一屏根本没有重放这回事） */
export interface ReplayView {
  /** 这一次重放属于哪条日志：界面上只有它与当前行对上才画，避免把上一行的结局挂在下一行下面 */
  ownerId: string;
  /** 在途：这一趟往返还没有落定，任何读数都还没落地 */
  running: boolean;
  /** 发出去的时候，这条记录有没有留下请求头（没留下时界面必须点名，用户以为在重放原请求） */
  headersPresent: boolean;
  /** 同上，指的是请求体 */
  bodyPresent: boolean;
  /** 落定后读回的那一份；在途与「连信封都没拿到」时都是 `null` */
  reading: ReplayReading | null;
  /** 往返本身失败（SW 回收期、通道被关）：这与「服务器报错」不是一件事，与「没走代理」更不是 */
  transportFailed: boolean;
  /** 从发出到落定的毫秒数；在途时为 0，界面据此不画一个还没发生的数 */
  durationMs: number;
}

export function useRequestReplay() {
  const replayView = ref<ReplayView | null>(null);

  /**
   * 轮次令牌：只有最后那一次起点算数
   *
   * 与 `useDnrSupport` 的 `checkSeq` 同一族。这里要挡住的不是「并发点击」——按钮在途时是
   * `loading` 状态，点不动第二下——而是「在途期间换了行」：那一趟往返照样会落定，
   * 而它落下来的是一份属于已经看不见的哪一行的结果。
   */
  let round = 0;

  /**
   * 发这一笔。调用方负责先问用户（非幂等方法那一句确认）
   *
   * 记录本身发不出去（没有地址、不是 http、方法读不出）时**什么都不做**：界面上那颗按钮
   * 按同一份判据决定画不画，所以这里不是「静默失败」，而是「这条路本来就没入口」。
   */
  async function runReplay(entry: RequestLogEntry): Promise<void> {
    const plan = planReplay(entry);
    if (!plan.ok) return;

    const thisRound = ++round;
    const startedAt = Date.now();
    replayView.value = {
      ownerId: entry.id,
      running: true,
      headersPresent: plan.headersPresent,
      bodyPresent: plan.bodyPresent,
      reading: null,
      transportFailed: false,
      durationMs: 0,
    };

    try {
      // 刻意不带 `ruleId`：让后台按这份地址与 method 重新匹配一遍，才是「现在会怎么走」的答案。
      // 把当时那条规则的 id 递过去，等于替用户假定他现在关心的还是同一条。
      const raw: unknown = await chrome.runtime.sendMessage({
        type: MessageType.PROXY_REQUEST,
        data: { requestId: `replay-${generateId()}`, ...plan.payload },
      });
      if (thisRound !== round) return;
      replayView.value = {
        ...replayView.value,
        running: false,
        reading: readReplayEnvelope(raw),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (thisRound !== round) return;
      // 只记错误类型：这一条路径上的 message 可能带着目标地址，而重放的那一笔本来就带着凭据头
      logger.warn('重放请求没能拿到回包:', error instanceof Error ? error.name : typeof error);
      replayView.value = {
        ...replayView.value,
        running: false,
        transportFailed: true,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * 收回这一屏的重放读数
   *
   * 给了 `ownerId` 就只收那一行的账（换行时把上一行的结果留在原地是没有意义的，但把**新**那一行
   * 刚点出来的在途状态抹掉更没有意义）；不给就是整段丢弃（关抽屉、清空日志）。
   * 两种都要 `++round`：不然一趟还没落定的往返会在下一次别处点开时突然落在这屏上。
   */
  function clearReplay(ownerId?: string): void {
    if (ownerId && replayView.value?.ownerId !== ownerId) return;
    round++;
    replayView.value = null;
  }

  return { replayView, runReplay, clearReplay };
}
