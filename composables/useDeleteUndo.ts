import type { Ref } from 'vue';
import type { ProxyRule } from '@/utils/types';
import { cloneRule } from '@/utils/ruleClone';
import { DELETE_UNDO_WINDOW_MS } from '@/utils/constants';
import { isFailureEnvelope } from '@/utils/messageResult';
import { logger } from '@/utils/logger';

/**
 * 删除的「乐观移除 + 延时提交」撤销窗口
 *
 * 单条删除与批量删除共用这一份时序：先把行从列表里摘掉并登记进 `pendingDeleteIds`
 * （窗口期内存储里还在，任何一次 `fetchConfig` 都会把它捞回来，见 `useRuleManagement`），
 * 到 `DELETE_UNDO_WINDOW_MS` 才真正落库；期间点「撤销」只是把行插回原位，一次存储写入都不发生。
 *
 * 这里刻意不放文案与 `ElMessage`（与 `useProfiles` 同一口径）：措辞与渲染归调用方，
 * 本模块只管「抓到什么、放回哪儿、什么时候算提交」这三件事，因此能在 node 环境按外部可观察面测。
 */

/** 撤销窗口抓住的一份快照：规则原文与它原先在列表里的位置。 */
interface CapturedRule {
  rule: ProxyRule;
  index: number;
}

export interface DeleteUndoWindow {
  /** 这次真正从列表移除的条数（提示文案与「已恢复 N 条」都要按它说话） */
  readonly count: number;
  /**
   * 用户点「撤销」。返回 `false` 表示窗口已结束、删除已落库，
   * 此时**绝不**再本地插回——那只会得到一行随后被 `storage.onChanged` 抹掉的幽灵数据。
   */
  undo: () => boolean;
}

/** 窗口的三条出口，都由调用方提供（它们只关乎界面，不影响判据）。 */
export interface DeleteUndoHandlers {
  /** 到期后真正落库的动作；抛错或回包 `success: false` 都算失败 */
  send: () => Promise<unknown>;
  /** 提交前收起撤销入口：收起与落库之间不留可点击的窗口 */
  close: () => void;
  /** 落库失败、行已放回列表之后通知用户 */
  failed: (count: number) => void;
}

export interface DeleteUndoDeps {
  rules: Ref<ProxyRule[]>;
  beginPendingDelete: (ruleId: string) => void;
  endPendingDelete: (ruleId: string) => void;
}

export function useDeleteUndo(deps: DeleteUndoDeps) {
  /**
   * 开一个撤销窗口：乐观移除 `ruleIds` 对应的行并起计时器。
   *
   * 每次都各自持有自己的快照与定时器，因此连续删多条、单条与批量交错进行都互不干扰
   * （单例状态会被后一次删除覆盖，导致漏删或误删）。
   *
   * @returns 一个都没抓到时返回 `null` —— 列表里已经没有这些 id（例如同一批被点了两次），
   *   此时既不提示也不落库，调用方直接返回即可。
   */
  function openDeleteUndo(ruleIds: string[], handlers: DeleteUndoHandlers): DeleteUndoWindow | null {
    const { rules, beginPendingDelete, endPendingDelete } = deps;
    const wanted = new Set(ruleIds);
    const captured: CapturedRule[] = [];
    rules.value.forEach((rule, index) => {
      // 按列表顺序收集，于是 `index` 天然递增；插回时按同一顺序即可复原原有相对位置。
      // 快照必须过 `cloneRule`：嵌套的 headerOverrides / queryOverrides / mockResponse 不能与
      // 原规则共享引用，否则撤销回来的会是被人改过的那一份。也不能裸用 structuredClone——
      // `rules.value` 里取出来的是响应式 Proxy，克隆它会抛 DataCloneError。
      if (wanted.has(rule.id)) captured.push({ rule: cloneRule(rule), index });
    });
    if (captured.length === 0) return null;

    for (const { rule } of captured) beginPendingDelete(rule.id);
    rules.value = rules.value.filter(rule => !wanted.has(rule.id));

    let committed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** 把快照放回原位（索引越界则钳到末尾——窗口期内可能有人新增或重排了列表）。 */
    function restore(): void {
      for (const { rule, index } of captured) {
        rules.value.splice(Math.min(index, rules.value.length), 0, rule);
      }
    }

    /** 两条出口（撤销、提交回包）都要注销登记，否则删除成功后该行被永久屏蔽。 */
    function unwatch(): void {
      for (const { rule } of captured) endPendingDelete(rule.id);
    }

    async function expire(): Promise<void> {
      committed = true;
      timer = null;
      handlers.close();
      try {
        // 「没抛」不等于「删成了」：respondAsync 会把后台的 reject 转成 resolved 的失败信封，
        // 判据只认 success === false（见 utils/messageResult.ts），否则列表消失而存储里那条还在代理
        const resp = await handlers.send();
        if (isFailureEnvelope(resp)) throw new Error(resp.error || 'DELETE_REJECTED');
        unwatch();
      } catch (error) {
        logger.error('Delayed delete failed, rows restored:', error);
        // 落库没成，行就得回到列表——否则界面说「已删除」而存储里那条还在继续代理
        unwatch();
        restore();
        handlers.failed(captured.length);
      }
    }

    timer = setTimeout(() => void expire(), DELETE_UNDO_WINDOW_MS);

    return {
      count: captured.length,
      undo: () => {
        if (committed) return false;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        unwatch();
        restore();
        return true;
      },
    };
  }

  return { openDeleteUndo };
}
