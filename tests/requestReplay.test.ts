/**
 * 日志重放的判据：一条记录能不能发、该不该先问一句、回包算哪一种结局
 *
 * 三张判读表都按「输入 → 答案」逐个核，因为它们各自会安静地变成一句谎话：
 * 计划表错了，用户点下去什么也没发生；确认表错了，一次点击变成两次下单；
 * 结局表错了，「站点名单之外」会被读成「服务器 500」。
 * 最后一条另有一支按源码对账的用例：那几个英文串住在 `proxyHandler.ts`，
 * 那一头改字面量而这一头没跟上时，界面上不会报错，只会把所有 bypass 都说成「没读到这一笔的答案」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MAX_LOG_BODY_SIZE } from '@/utils/constants';
import { needsReplayConfirm, planReplay, readReplayEnvelope, replayBodyUseful } from '@/utils/requestReplay';

const httpEntry = {
  originalUrl: 'https://fat.example.com/api/orders',
  method: 'POST',
  requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer {{TOKEN}}' },
  requestBody: '{"id":7}',
};

describe('planReplay — 这条记录发得出去吗', () => {
  it('http(s) 的记录交出一份可直接发给 PROXY_REQUEST 的载荷', () => {
    const plan = planReplay(httpEntry);
    expect(plan).toEqual({
      ok: true,
      payload: {
        url: 'https://fat.example.com/api/orders',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer {{TOKEN}}' },
        body: '{"id":7}',
      },
      headersPresent: true,
      bodyPresent: true,
    });
  });

  it('地址缺席或读不出，点名原因而不是发一笔空请求', () => {
    expect(planReplay({ ...httpEntry, originalUrl: '' })).toEqual({ ok: false, reason: 'noUrl' });
    expect(planReplay({ ...httpEntry, originalUrl: undefined })).toEqual({ ok: false, reason: 'noUrl' });
    // 被截断留痕截坏的、或手改过的原文：`new URL` 抛出去就是不能发
    expect(planReplay({ ...httpEntry, originalUrl: 'not a url' })).toEqual({ ok: false, reason: 'notHttp' });
  });

  it('长连接不重放：日志只有后台通道那一路，而 wss 交给 fetch 只会得到一个看不懂的失败', () => {
    for (const url of [
      'wss://fat.example.com/ws/orders',
      'ws://fat.example.com/ws',
      'ftp://a/b',
      'chrome-extension://x/y',
    ]) {
      expect(planReplay({ ...httpEntry, originalUrl: url })).toEqual({ ok: false, reason: 'notHttp' });
    }
  });

  it('方法空白就没法发（日志那侧只钳长度，不校验取值）', () => {
    expect(planReplay({ ...httpEntry, method: '  ' })).toEqual({ ok: false, reason: 'badMethod' });
    expect(planReplay({ ...httpEntry, method: 7 })).toEqual({ ok: false, reason: 'badMethod' });
  });

  it('方法按 HTTP 惯例归一成大写（小写 get 发出去还是 GET）', () => {
    const plan = planReplay({ ...httpEntry, method: ' get ' });
    expect(plan.ok === true && plan.payload.method).toBe('GET');
  });

  it('头表不是对象就当没有；对象里的非字符串值丢掉，但「留过头表」这件事照实报', () => {
    const asArray = planReplay({ ...httpEntry, requestHeaders: [['a', 'b']] });
    expect(asArray.ok && asArray.headersPresent).toBe(false);

    const mixed = planReplay({ ...httpEntry, requestHeaders: { a: '1', b: 2, c: null } });
    expect(mixed.ok && mixed.payload.headers).toEqual({ a: '1' });
    expect(mixed.ok && mixed.headersPresent).toBe(true);
  });

  it('没有正文的记录不带 body 字段（而不是带一个空串——那是「发了个空 body」这件事）', () => {
    const noBody = planReplay({ ...httpEntry, requestBody: undefined });
    expect(noBody.ok === true && 'body' in noBody.payload).toBe(false);
    expect(noBody.ok === true && noBody.bodyPresent).toBe(false);
    // 空串是「真的有正文，正文是空」，与「没正文」在两件事上不同
    const emptyBody = planReplay({ ...httpEntry, requestBody: '' });
    expect(emptyBody.ok === true && emptyBody.payload.body).toBe('');
    expect(emptyBody.ok === true && emptyBody.bodyPresent).toBe(true);
  });

  it('整份输入不是记录形状也不抛（storage 与消息都是不可信数据）', () => {
    expect(planReplay({})).toEqual({ ok: false, reason: 'noUrl' });
    expect(planReplay({ originalUrl: 42, method: null, requestHeaders: 'x', requestBody: {} })).toEqual({
      ok: false,
      reason: 'noUrl',
    });
  });
});

describe('needsReplayConfirm — 哪些方法点下去之前要先问一句', () => {
  it('GET / HEAD / OPTIONS 直接发', () => {
    for (const method of ['GET', 'get', ' HEAD ', 'OPTIONS']) {
      expect(needsReplayConfirm(method)).toBe(false);
    }
  });

  it('写方法、自定义动词与读不出的方法都要确认（认不准的按会改东西算）', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'PURGE', '', '   ', 7, undefined]) {
      expect(needsReplayConfirm(method)).toBe(true);
    }
  });
});

describe('readReplayEnvelope — 这一笔到底发生了什么', () => {
  const envelope = (over: Record<string, unknown> = {}) => ({
    requestId: 'r-1',
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: '{"env":"uat"}',
    isBase64: false,
    ...over,
  });

  it('有状态码的回包就是 answered，不看它是 2xx 还是 500', () => {
    for (const status of [200, 204, 404, 500, 503]) {
      const reading = readReplayEnvelope(envelope({ status }));
      expect(reading.outcome).toBe('answered');
      expect(reading.status).toBe(status);
    }
  });

  it('proxyHandler 那几句内部编码各归一档，而不是当成人话显示', () => {
    expect(readReplayEnvelope(envelope({ status: 200, statusText: 'Mock' })).outcome).toBe('mock');
    expect(readReplayEnvelope(envelope({ status: 0, statusText: 'Blocked' })).outcome).toBe('blocked');
    expect(
      readReplayEnvelope(
        envelope({ status: 0, statusText: 'Invalid Rule Headers', body: 'Rule contains invalid header override' }),
      ).outcome,
    ).toBe('invalidRuleHeaders');
    // 同一个状态文本，两个方向：发不出去与回包被掐，修法完全不同，所以是两档
    expect(
      readReplayEnvelope(
        envelope({ status: 0, statusText: 'Body Too Large', body: 'Request body exceeds 10485760 bytes' }),
      ).outcome,
    ).toBe('requestTooLarge');
    expect(
      readReplayEnvelope(
        envelope({ status: 0, statusText: 'Body Too Large', body: 'Response body exceeds 10485760 bytes' }),
      ).outcome,
    ).toBe('responseTooLarge');
    // 认不出前缀就不猜档：把一次未来的改动读成「回包太大」，比老实说「答案没读到」更难查
    expect(
      readReplayEnvelope(envelope({ status: 0, statusText: 'Body Too Large', body: 'Header Too Large' })).outcome,
    ).toBe('malformed');
    expect(
      readReplayEnvelope(envelope({ status: 0, statusText: 'Proxy Error', body: 'Failed to fetch' })).outcome,
    ).toBe('failed');
    expect(readReplayEnvelope(envelope({ status: 0, statusText: 'Proxy Bypass', body: 'Site excluded' })).outcome).toBe(
      'siteExcluded',
    );
    expect(
      readReplayEnvelope(envelope({ status: 0, statusText: 'Proxy Bypass', body: 'Proxy is disabled' })).outcome,
    ).toBe('disabled');
    // 「没有规则命中」与「这台站点不在名单里」在页面上是同一份信封，而它们的修法正好相反
    expect(
      readReplayEnvelope(envelope({ status: 0, statusText: 'Proxy Bypass', body: 'No matching rule' })).outcome,
    ).toBe('noRule');
    // 第三句 bypass 的文案（载荷形状不合法）不该被归进上面任何一档
    expect(
      readReplayEnvelope(envelope({ status: 0, statusText: 'Proxy Bypass', body: 'Invalid request payload' })).outcome,
    ).toBe('malformed');
  });

  it('形状不对就当「没读到答案」，不拿 0 当状态码报出去', () => {
    for (const raw of [undefined, null, 'nope', [], { success: false }, { status: '200' }, { status: NaN }]) {
      const reading = readReplayEnvelope(raw);
      expect(reading.outcome).toBe('malformed');
      expect(reading.status).toBe(0);
      expect(reading.body).toBe('');
    }
  });

  it('正文按显示上限截，并且把「截过」这件事与总长度一起交出去', () => {
    const long = 'x'.repeat(MAX_LOG_BODY_SIZE + 700);
    const reading = readReplayEnvelope(envelope({ body: long }));
    expect(reading.body).toHaveLength(MAX_LOG_BODY_SIZE);
    expect(reading.bodyLength).toBe(MAX_LOG_BODY_SIZE + 700);
    expect(reading.bodyTruncated).toBe(true);

    const short = readReplayEnvelope(envelope({ body: 'ok' }));
    expect(short.bodyTruncated).toBe(false);
    expect(short.bodyLength).toBe(2);
  });

  it('base64 与响应头条数原样带出（界面据此说「二进制正文不在这里展开」）', () => {
    const reading = readReplayEnvelope(envelope({ isBase64: true, headers: { a: '1', b: '2' } }));
    expect(reading.isBase64).toBe(true);
    expect(reading.headerCount).toBe(2);
    expect(readReplayEnvelope(envelope({ headers: null })).headerCount).toBe(0);
  });

  it('内部编码那几档不再贴英文原文，对面说的话与体积上限那句留着', () => {
    const shown = (statusText: string, body: string) => readReplayEnvelope(envelope({ status: 0, statusText, body }));
    // 这六档的英文原文已经被上面那句中文说完了，再贴一遍只是噪声（顺带把这六档的映射一起钉住）
    const internal = [
      shown('Proxy Bypass', 'Site excluded'),
      shown('Proxy Bypass', 'Proxy is disabled'),
      shown('Proxy Bypass', 'No matching rule'),
      shown('Blocked', 'Request blocked by proxy rule'),
      shown('Invalid Rule Headers', 'Rule contains invalid header override'),
      shown('Proxy Bypass', 'Invalid request payload'),
    ].map(r => r.outcome);
    expect(internal).toEqual(['siteExcluded', 'disabled', 'noRule', 'blocked', 'invalidRuleHeaders', 'malformed']);
    for (const outcome of internal) {
      expect(replayBodyUseful(outcome)).toBe(false);
    }

    // 这一组反过来：正文里就是用户要看的东西，或那句带着字节数的原因
    for (const useful of [
      readReplayEnvelope(envelope({ body: '{"env":"uat"}' })).outcome,
      readReplayEnvelope(envelope({ statusText: 'Mock', body: '{"mocked":true}' })).outcome,
      shown('Body Too Large', 'Request body exceeds 10485760 bytes').outcome,
      shown('Body Too Large', 'Response body exceeds 10485760 bytes').outcome,
      shown('Proxy Error', 'Failed to fetch').outcome,
    ]) {
      expect(replayBodyUseful(useful)).toBe(true);
    }
  });

  /**
   * 判读表与编码住在两个文件里，这是本支用例唯一真正危险的地方
   *
   * 那一头改名而这一头不动，全仓不会有任何一处变红——所有 bypass 会一起落到 `malformed`，
   * 界面说的是「没能读到这一笔的答案」，而答案其实好好地回来了。所以这里按源码把那几个串钉住。
   */
  it('后台那几句字面量原样存在（改了那一头必须回来同步这张判读表）', () => {
    const handler = readFileSync('entrypoints/background/proxyHandler.ts', 'utf-8');
    for (const literal of [
      "statusText: 'Mock'",
      "statusText: 'Blocked'",
      "statusText: 'Body Too Large'",
      "statusText: 'Invalid Rule Headers'",
      "statusText: 'Proxy Error'",
      "statusText: 'Proxy Bypass'",
      "body: 'Site excluded'",
      "body: 'Proxy is disabled'",
      "body: 'No matching rule'",
      'Request body exceeds',
      'Response body exceeds',
    ]) {
      expect(handler, `proxyHandler 里找不到 ${literal}`).toContain(literal);
    }
  });
});
