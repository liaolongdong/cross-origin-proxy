/**
 * 「这一笔日志能不能当环境对比的输入」的唯一判据。
 *
 * 按外部可观察面测（输入 → 答案），不碰 chrome、不碰 Vue。承重点有三处：
 * 取的是 `originalUrl` 而不是 `proxiedUrl`（用户要比的是当初那一笔在两个环境各回什么）；
 * 截断过的记录一律拒绝（与日志重放、日志转 Mock 同一档取舍）；
 * 回包的头与正文绝不进草稿（那是结果，不是输入）。
 */
import { describe, it, expect } from 'vitest';
import { buildEnvDiffPickRows, planEnvDiffFromLog } from '@/utils/envDiffPrefill';
import { ENV_DIFF_PICK_LIMIT } from '@/utils/constants';
import type { RequestLogEntry } from '@/utils/types';

/** 一条什么都能改的夹具：各用例只覆盖自己在意的那一格 */
function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: 'log-1',
    timestamp: 1_700_000_000_000,
    ruleId: 'r1',
    ruleName: 'FAT → UAT',
    originalUrl: 'https://fat.example.com/api/users',
    proxiedUrl: 'https://uat.example.com/api/users',
    method: 'POST',
    proxyType: 'sw',
    requestHeaders: { 'Content-Type': 'application/json', Authorization: 'Bearer {{TOKEN}}' },
    requestBody: '{"q":1}',
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"env":"uat"}',
    ...overrides,
  };
}

describe('planEnvDiffFromLog — 这一笔当得了对比的输入吗', () => {
  it('正常条目：取原始地址、方法、请求头与正文，回包一律不带', () => {
    const result = planEnvDiffFromLog(entry());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.url).toBe('https://fat.example.com/api/users');
    expect(result.draft.method).toBe('POST');
    expect(result.draft.headers).toEqual([
      { key: 'Content-Type', value: 'application/json' },
      { key: 'Authorization', value: 'Bearer {{TOKEN}}' },
    ]);
    expect(result.draft.body).toBe('{"q":1}');
  });

  it('正文带截断标记 → 拒绝，理由是 truncated：半截 JSON 发出去只是把报错挪进对面的 parse', () => {
    const result = planEnvDiffFromLog(entry({ requestBody: '{"a":1\n…[truncated, original 99999 chars]' }));
    expect(result).toEqual({ ok: false, blocked: 'truncated' });
  });

  it('地址带截断标记 → 同样是 truncated（残缺地址连着真凭据出门，是本仓两处都选拒绝的那一格）', () => {
    const result = planEnvDiffFromLog(entry({ originalUrl: 'https://a.b/x\n…[truncated, original 9000 chars]' }));
    expect(result).toEqual({ ok: false, blocked: 'truncated' });
  });

  it('任一头值带截断标记 → 拒绝：少一个头的一次对比会被读成「两个环境一样」', () => {
    const result = planEnvDiffFromLog(entry({ requestHeaders: { 'X-Long': 'x\n…[truncated, original 40000 chars]' } }));
    expect(result).toEqual({ ok: false, blocked: 'truncated' });
  });

  it('地址不是 http(s) 或读不出协议 → unsupportedProtocol（与代发、重放共用那一把尺）', () => {
    expect(planEnvDiffFromLog(entry({ originalUrl: 'file:///etc/passwd' }))).toEqual({
      ok: false,
      blocked: 'unsupportedProtocol',
    });
    expect(planEnvDiffFromLog(entry({ originalUrl: '/api/users' }))).toEqual({
      ok: false,
      blocked: 'unsupportedProtocol',
    });
  });

  it('方法名读不出或不合法 → noMethod（后台那道会拒，界面先说比事后一句「方法名读不出来」好）', () => {
    expect(planEnvDiffFromLog(entry({ method: '' }))).toEqual({ ok: false, blocked: 'noMethod' });
    expect(planEnvDiffFromLog(entry({ method: 'g et' }))).toEqual({ ok: false, blocked: 'noMethod' });
  });

  it('整条记录读不出形状 → badUrl，绝不抛（日志来自 SW 回包，属不可信输入）', () => {
    expect(planEnvDiffFromLog(null)).toEqual({ ok: false, blocked: 'badUrl' });
    expect(planEnvDiffFromLog('https://a.b')).toEqual({ ok: false, blocked: 'badUrl' });
    expect(planEnvDiffFromLog({ ...entry(), originalUrl: 42 })).toEqual({ ok: false, blocked: 'badUrl' });
    expect(planEnvDiffFromLog({ ...entry(), requestHeaders: 'Authorization: x' })).toEqual({
      ok: false,
      blocked: 'badUrl',
    });
    expect(planEnvDiffFromLog({ ...entry(), requestBody: 7 })).toEqual({ ok: false, blocked: 'badUrl' });
  });

  it('没有正文与没有请求头都算合法（GET 一笔本来就没有这两样）', () => {
    const result = planEnvDiffFromLog(entry({ method: 'GET', requestBody: undefined, requestHeaders: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.headers).toEqual([]);
    expect(result.draft.body).toBe('');
  });

  it('头表里的空名项被丢掉，而不是带着一个空键进草稿（后台那道会整批拒）', () => {
    const result = planEnvDiffFromLog(entry({ requestHeaders: { '': 'x', Accept: '*/*' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.headers).toEqual([{ key: 'Accept', value: '*/*' }]);
  });
});

describe('buildEnvDiffPickRows — 弹窗里那几行', () => {
  it('非数组一律当空：这一格不许抛', () => {
    expect(buildEnvDiffPickRows(undefined)).toEqual([]);
    expect(buildEnvDiffPickRows({})).toEqual([]);
    expect(buildEnvDiffPickRows({ success: false })).toEqual([]);
  });

  it('按传入顺序取前 N 条，条数由常量收口（界面上不许再写裸数字）', () => {
    const many = Array.from({ length: 20 }, (_, i) => entry({ id: `log-${i}`, originalUrl: `https://a.b/${i}` }));
    const rows = buildEnvDiffPickRows(many);
    expect(rows).toHaveLength(ENV_DIFF_PICK_LIMIT);
    expect(rows[0].url).toBe('https://a.b/0');
  });

  it('被拒的那条带着理由留在行上：按钮不画时原因必须写在它该在的位置', () => {
    const rows = buildEnvDiffPickRows([entry({ method: '' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocked).toBe('noMethod');
    expect(rows[0].prefill.ok).toBe(false);
  });

  it('读不出 id 的项跳过——它连「是哪一行」都答不出，画出来就是一颗点了没反应的按钮', () => {
    expect(buildEnvDiffPickRows([{ timestamp: 1 }, entry()])).toHaveLength(1);
  });

  it('合法行的 blocked 是 undefined，界面据此决定画不画那颗按钮', () => {
    const rows = buildEnvDiffPickRows([entry()]);
    expect(rows[0].blocked).toBeUndefined();
  });
});
