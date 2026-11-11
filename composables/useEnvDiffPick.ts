/**
 * 环境对比弹窗那份「最近请求」读数
 *
 * 与 `composables/useRequestLog.ts` 分着两份而不是共用，理由是两屏要的事不同：
 * 抽屉要的是全量 + 四轴筛选 + 按帧续载，这里要的是「最新一屏、点一下就填」。
 * 共用会把抽屉那套每轮重判的语义搬进一个低频入口，等于每次打开对比弹窗都读一遍整把日志表。
 *
 * 三条不变量：
 * ① 只有折叠区真的展开才发第一条 `GET_REQUEST_LOG`（本 composable 不挂 `onMounted`，
 *    「展开才拉」那半接线住在组件里）；弹窗再次打开且上一次是展开的会重读一次——
 *    不重读就是把上一屏那几条当现状画回去；
 * ② 读失败时那一格整个换成「暂时读不到」+ 重试，**旧行不画**。这与日志抽屉那一处刻意相反：
 *    抽屉是一屏要读的行，点破「这是上一次的」就能继续用；这里是一笔要发往两个环境的**输入**，
 *    挑一条不知道还在不在的旧记录，代价比少列几行大。`rows` 留着不抹只为下一次成功能整批换掉
 *    （先清空再填会让那一屏闪一次），它不参与「画什么」的判断；
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
