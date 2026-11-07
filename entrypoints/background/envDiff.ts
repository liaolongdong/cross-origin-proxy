/**
 * 环境响应对比的执行侧（SW）
 *
 * 一笔 `ENV_DIFF_REQUEST` 就是一次原样出门的 fetch：不匹配规则、不写日志、不碰 `swProxied`
 * 那本交叉校验的账，也不落 `request_logs`——它说的是「这两个环境对同一输入各回了什么」，
 * 把它记进日志会让规则命中统计多出一笔任何规则都没命中的请求，而弹窗与列表都会拿那个数说话。
 * 承重的那几件事全部复用代发那一条路现成的判据：出站协议白名单（两道）、头名/CRLF（展开后
 * 再判一遍，与 `proxyHandler` 的 `Invalid Rule Headers` 同一形状）、回包体积按流读取
 * （`readBodyWithinCap`，越界掐流）、取消交进 `fetch` 的 signal。
 */

import { exceedsBodyCap, decodeBodyText, readBodyWithinCap } from './proxyHandler';
import { prepareEnvDiffRequest, type EnvDiffPrepared } from '@/utils/envDiff';
import { protocolOf, isProxyableUrl } from '@/utils/proxyProtocol';
import { isValidHeaderEntry } from '@/utils/headerValidation';
import { extractVariableRefs, resolveVariableMap, resolveVariableRefs } from '@/utils/variables';
import { getVariables } from '@/utils/storage';
import { logger } from '@/utils/logger';
import type { EnvDiffErrorCode, EnvDiffRequestPayload, EnvDiffResultPayload } from '@/utils/types';

/** 与代发同一档：30 秒读不满就掐。对比的两侧并发跑，慢的那一头决定这一次等待 */
const ENV_DIFF_TIMEOUT_MS = 30000;

/** 在途登记：键是弹窗自己 `generateId` 出来的 requestId，全扩展唯一，不像页面拦截器那样按 frame 从头数 */
const inFlightEnvDiffs = new Map<string, AbortController>();

function failure(requestId: string, error: EnvDiffErrorCode, startedAt: number): EnvDiffResultPayload {
  return {
    requestId,
    ok: false,
    status: 0,
    statusText: 'Env Diff',
    headers: {},
    body: null,
    truncated: false,
    durationMs: Date.now() - startedAt,
    error,
  };
}

/**
 * 载荷 → 可发形状：界面判过一遍不算数，这一层是后台侧的重判
 *
 * 变量展开排在协议白名单**第二道**之前——`{{BASE}}/api` 让「进门那串是 https」挡不住
 * 「出门那串是 file://」，`proxyHandler` 的双道闸是同一个理由（AGENTS「出站协议白名单」条）。
 * 头表同理：展开可能把 CR/LF 带进值里，所以 `isValidHeaderEntry` 在展开后必须再过一遍；
 * 这一格选**整表拒绝**而不是静默跳过（跳过等于让用户拿一份「那条头其实没发」的结果去比环境）。
 */
async function prepareForDispatch(
  data: EnvDiffRequestPayload,
): Promise<{ ok: true; prepared: EnvDiffPrepared } | { ok: false; reject: EnvDiffErrorCode }> {
  const prepared = prepareEnvDiffRequest(data);
  if ('reject' in prepared) return { ok: false, reject: prepared.reject };

  const refs = [
    ...extractVariableRefs(prepared.url),
    ...(prepared.body !== undefined ? extractVariableRefs(prepared.body) : []),
    ...Object.values(prepared.headers).flatMap(value => extractVariableRefs(value)),
  ];
  if (refs.length === 0) return { ok: true, prepared };

  const store = await getVariables();
  const url = resolveVariableRefs(prepared.url, store).value;
  if (!isProxyableUrl(url)) {
    logger.warn(`环境对比拒绝非 http(s) 目标: ${protocolOf(url) || '(读不出协议)'}`);
    return { ok: false, reject: 'url' };
  }
  const headers = resolveVariableMap(prepared.headers, store)?.resolved ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isValidHeaderEntry(key, value)) return { ok: false, reject: 'headers' };
  }
  const body = prepared.body === undefined ? undefined : resolveVariableRefs(prepared.body, store).value;
  return { ok: true, prepared: { ...prepared, url, headers, body } };
}

/**
 * 发送并读取一侧的响应；每个返回形状都自带 `requestId`，界面按 id 对号入座
 *
 * 204/205/304 与空响应回 `body: null`；真状态码（含 4xx/5xx）原样交回——那正是对比要看的东西。
 */
export async function runEnvDiff(data: EnvDiffRequestPayload): Promise<EnvDiffResultPayload> {
  const startedAt = Date.now();
  const requestId = typeof data?.requestId === 'string' ? data.requestId.slice(0, 128) : '';
  if (!requestId) return failure('', 'url', startedAt);

  const prepared = await prepareForDispatch(data);
  if (!prepared.ok) return failure(requestId, prepared.reject, startedAt);
  const { url, method, headers, body, sendCredentials } = prepared.prepared;

  // GET/HEAD 不可携带 body（fetch 直接抛 TypeError）；方法在这一层已经归一成大写
  const outgoingBody = method === 'GET' || method === 'HEAD' ? undefined : body;
  // 上限量的是**真正要出门那一份**（展开之后）的 UTF-8 字节数，与代发同一把尺
  if (outgoingBody !== undefined && exceedsBodyCap(outgoingBody)) {
    return failure(requestId, 'body', startedAt);
  }

  const controller = new AbortController();
  inFlightEnvDiffs.set(requestId, controller);
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ENV_DIFF_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(outgoingBody !== undefined ? { body: outgoingBody } : {}),
      credentials: sendCredentials ? 'include' : 'omit',
      signal: controller.signal,
    });

    const bodyBytes = await readBodyWithinCap(response);
    const contentType = response.headers.get('content-type') || '';
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    if (bodyBytes === null) {
      // 与代发不同，这里不翻成失败信封：状态、头与耗时都是真的，只有正文越界。
      // 「这个环境回了 200 加一份读不完的正文」正是对比要说的话，把整笔判死反而丢信息。
      return {
        requestId,
        ok: true,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: null,
        truncated: true,
        durationMs: Date.now() - startedAt,
        error: 'bodyTooLarge',
      };
    }

    return {
      requestId,
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: bodyBytes.length === 0 ? null : decodeBodyText(bodyBytes, contentType),
      truncated: false,
      durationMs: Date.now() - startedAt,
    };
  } catch (error: unknown) {
    if (controller.signal.aborted) return failure(requestId, timedOut ? 'timeout' : 'cancelled', startedAt);
    logger.warn('环境对比请求失败:', error instanceof Error ? error.name : String(error));
    return failure(requestId, 'network', startedAt);
  } finally {
    clearTimeout(timeoutId);
    inFlightEnvDiffs.delete(requestId);
  }
}

/**
 * 掐掉在途的一侧对比
 *
 * 与代发那本账分开的理由写在文件头；相同的是取舍：「页面已经放弃」不能等于
 * 「服务端收到两遍」，abort 交进那一次 `fetch`。键对不上（已落定或从未在途）安静返回 false。
 */
export function cancelEnvDiff(requestId: string): boolean {
  const controller = inFlightEnvDiffs.get(requestId);
  if (!controller) return false;
  controller.abort();
  return true;
}
