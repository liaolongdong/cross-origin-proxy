/**
 * 环境对比弹窗那份「最近请求」读数
 *
 * 与 `composables/useRequestLog.ts` 分着两份而不是共用，理由是两屏要的事不同：
 * 抽屉要的是全量 + 四轴筛选 + 按帧续载，这里要的是「最新一屏、点一下就填」。
 * 共用会把抽屉那套每轮重判的语义搬进一个低频入口，等于每次打开对比弹窗都读一遍整把日志表。
 *
 * 三条不变量：
 * ① 只有折叠区真的展开才发第一条 `GET_REQUEST_LOG`（本 composable 不挂 `onMounted`，
 *    「展开才拉」那半接线住在组件里）；
 * ② 读失败维持上一轮读数——那几行明明还在屏幕上，说得出「这是上一次的」比清空更诚实；
 * ③ 轮次令牌丢弃迟到的那一轮，避免慢的一次盖掉新的一次。
 */
import { ref } from 'vue';
import { MessageType } from '@/utils/types';
import { logger } from '@/utils/logger';
import { buildEnvDiffPickRows } from '@/utils/envDiffPrefill';
import type { EnvDiffPickRow } from '@/utils/envDiffPrefill';

export function useEnvDiffPick() {
  const rows = ref<EnvDiffPickRow[]>([]);
  /** 这一次往返在途 */
  const loading = ref(false);
  /** 最近一次读没读到（非标回包与抛错同一档） */
  const readFailed = ref(false);
  /** 这一次打开弹窗有没有成功读到过至少一次——四档判据里「从来没有读数」那一半 */
  const everRead = ref(false);
  /** 每一轮一个号：只有最新那一轮有权落读数与收 loading */
  let round = 0;

  async function load(): Promise<void> {
    const ticket = ++round;
    loading.value = true;
    try {
      const result: unknown = await chrome.runtime.sendMessage({ type: MessageType.GET_REQUEST_LOG });
      if (ticket !== round) return;
      if (!Array.isArray(result)) {
        // 只记形状，不记载荷：非标回包可能带着日志原文（地址、头、正文），那里面正是凭据展开的位置
        logger.warn('EnvDiff pick: unexpected request-log response', result === null ? 'null' : typeof result);
        readFailed.value = true;
        return;
      }
      rows.value = buildEnvDiffPickRows(result);
      readFailed.value = false;
      everRead.value = true;
    } catch (error) {
      if (ticket !== round) return;
      logger.warn('EnvDiff pick: failed to read the request log:', error);
      readFailed.value = true;
    } finally {
      if (ticket === round) loading.value = false;
    }
  }

  return { rows, loading, readFailed, everRead, load };
}
