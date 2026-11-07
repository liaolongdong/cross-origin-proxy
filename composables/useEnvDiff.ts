/**
 * 环境响应对比的发送侧编排（配置页唯一读者）
 *
 * 两侧并发走同一条 `ENV_DIFF_REQUEST`，各带弹窗自己生成的 `requestId`；取消把
 * `ENV_DIFF_CANCEL` 交到后台那一次 `fetch` 的 signal 上——「用户已经关掉面板」不能
 * 等于「两个环境各收到一遍请求」。回包按外部可观察面收口：形状不对一律落成
 * `noAnswer`，而不是把「没读到」画成「请求没到达」。
 */
import { ref } from 'vue';
import { MessageType } from '@/utils/types';
import type { EnvDiffErrorCode, EnvDiffRequestPayload, EnvDiffResultPayload } from '@/utils/types';
import { generateId } from '@/utils/generateId';
import { logger } from '@/utils/logger';

/** 界面交给编排层的单侧输入：`requestId` 由这一层盖章，使用方不需要知道它 */
export type EnvDiffSideInput = Omit<EnvDiffRequestPayload, 'requestId'>;

export interface EnvDiffPairResult {
  a: EnvDiffResultPayload;
  b: EnvDiffResultPayload;
}

/** 把任意回包收成可画的形状；唯一的畸形来源是路由 bug 或消息层失败，两种都只有一句话 */
function normalizeEnvelope(raw: unknown, requestId: string): EnvDiffResultPayload {
  const invalid = (): EnvDiffResultPayload => ({
    requestId,
    ok: false,
    status: 0,
    statusText: '',
    headers: {},
    body: null,
    truncated: false,
    durationMs: 0,
    error: 'noAnswer' satisfies EnvDiffErrorCode,
  });
  if (typeof raw !== 'object' || raw === null) return invalid();
  const data = raw as Record<string, unknown>;
  if (typeof data.ok !== 'boolean' || typeof data.status !== 'number' || !Number.isFinite(data.status)) {
    return invalid();
  }
  return {
    requestId: typeof data.requestId === 'string' ? data.requestId : requestId,
    ok: data.ok,
    status: Math.trunc(data.status),
    statusText: typeof data.statusText === 'string' ? data.statusText : '',
    headers: typeof data.headers === 'object' && data.headers !== null ? (data.headers as Record<string, string>) : {},
    body: typeof data.body === 'string' ? data.body : null,
    truncated: data.truncated === true,
    durationMs: typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) ? data.durationMs : 0,
    error: typeof data.error === 'string' ? (data.error as EnvDiffErrorCode) : undefined,
  };
}

export function useEnvDiff() {
  const running = ref(false);
  /** 在途登记键：取消只发给这里还活着的笔，落定一笔摘一笔 */
  const inFlightIds = ref<string[]>([]);
  /** 轮次令牌：关面板之后迟到的回包整轮作废（与重放那条同一手法） */
  let round = 0;

  async function sendSide(input: EnvDiffSideInput): Promise<EnvDiffResultPayload> {
    const requestId = generateId();
    inFlightIds.value = [...inFlightIds.value, requestId];
    try {
      const raw: unknown = await chrome.runtime.sendMessage({
        type: MessageType.ENV_DIFF_REQUEST,
        data: { requestId, ...input },
      });
      return normalizeEnvelope(raw, requestId);
    } catch (error) {
      logger.warn('环境对比没能拿到回包:', error instanceof Error ? error.name : typeof error);
      return normalizeEnvelope(null, requestId);
    } finally {
      inFlightIds.value = inFlightIds.value.filter(id => id !== requestId);
    }
  }

  /**
   * 并发发出两侧，返回两份读数；`null` 表示这一轮已被作废（关面板或重新开始），迟到结果整包丢弃
   */
  async function runPair(a: EnvDiffSideInput, b: EnvDiffSideInput): Promise<EnvDiffPairResult | null> {
    const thisRound = ++round;
    running.value = true;
    try {
      const [resultA, resultB] = await Promise.all([sendSide(a), sendSide(b)]);
      if (thisRound !== round) return null;
      return { a: resultA, b: resultB };
    } finally {
      // 迟到的那一只也不许把旗标按下去：只有还是当前轮次时才收
      if (thisRound === round) running.value = false;
    }
  }

  /** 掐掉在途的每一笔；键对不上时后台安静回 false，界面上等各自的落定包 */
  function cancel(): void {
    const ids = inFlightIds.value;
    round++;
    running.value = false;
    for (const id of ids) {
      chrome.runtime.sendMessage({ type: MessageType.ENV_DIFF_CANCEL, data: { requestId: id } }).catch(() => undefined);
    }
  }

  return { running, runPair, cancel };
}
