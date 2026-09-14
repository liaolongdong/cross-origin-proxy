/**
 * 出站请求硬限制的单元测试。
 *
 * `SECURITY.md` 的「已知缺口」曾指出：头名/CRLF 校验与请求体上限都是 `proxyHandler.ts`
 * 里的私有函数，行为存在但改不动——没有回归测试能接住。本轮把它们导出（仅可见性变化），
 * 本文件即补上的那层网。响应信封侧的同类守卫见 `proxyResponseGuard.test.ts`。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubGlobal('chrome', {
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { getURL: vi.fn(() => 'chrome-extension://test/') },
});

const addRequestLog = vi.fn(async (_entry: Record<string, unknown>) => {});
let configToReturn: { enabled: boolean; rules: unknown[] } = { enabled: true, rules: [] };

vi.mock('@/utils/storage', () => ({
  getProxyConfig: vi.fn(async () => configToReturn),
  addRequestLog: (entry: Record<string, unknown>) => addRequestLog(entry),
  getRequestLogs: vi.fn(async () => []),
}));

const {
  isValidHeaderEntry,
  filterIncomingHeaders,
  validateRuleHeaders,
  exceedsBodyCap,
  handleProxyRequest,
  MAX_BODY_SIZE,
} = await import('@/entrypoints/background/proxyHandler');

describe('头名与 CRLF 校验（isValidHeaderEntry）', () => {
  it('接受 RFC 7230 token 字符集中常见的头名', () => {
    for (const name of ['Authorization', 'X-Custom-Auth', 'content-type', 'If-None-Match', 'Mk-calendar']) {
      expect(isValidHeaderEntry(name, 'v')).toBe(true);
    }
  });

  it('拒绝含分隔符的头名（空格、冒号、换行都无法成为合法 token）', () => {
    for (const name of ['X Bad', 'X-Bad: y', 'X\rBad', 'X\nBad', '', 'X-Badé']) {
      expect(isValidHeaderEntry(name, 'v')).toBe(false);
    }
  });

  it('拒绝值里的换行，防止拼出第二个头或响应头', () => {
    expect(isValidHeaderEntry('X-A', 'Bearer xyz\r\nX-Admin: 1')).toBe(false);
    expect(isValidHeaderEntry('X-A', 'line1\nline2')).toBe(false);
    expect(isValidHeaderEntry('X-A', 'line1\rline2')).toBe(false);
    expect(isValidHeaderEntry('X-A', 'plain value')).toBe(true);
  });
});

describe('页面传入头：宽容跳过（filterIncomingHeaders）', () => {
  it('个别脏头不会带走其余请求头', () => {
    const out = filterIncomingHeaders({
      Accept: 'application/json',
      'X Bad': 'v',
      'X-Injected': 'a\r\nSet-Cookie: session=1',
    });
    expect(out).toEqual({ Accept: 'application/json' });
  });

  it('非字符串值（页面构造的畸形消息）被丢弃', () => {
    expect(filterIncomingHeaders({ A: 'ok', B: 1 as unknown as string })).toEqual({ A: 'ok' });
  });
});

describe('规则配置头：严格整体拒绝并指名道姓（validateRuleHeaders）', () => {
  it('全部合法时原样返回，且不带拒绝原因', () => {
    expect(validateRuleHeaders({ Accept: 'application/json' })).toEqual({
      headers: { Accept: 'application/json' },
    });
  });

  it('任一非法即整体拒绝，并给出该条的头名，供日志指出该改哪一条', () => {
    const res = validateRuleHeaders({ Accept: 'application/json', 'X Bad': 'v' });
    expect(res.headers).toEqual({});
    expect(res.invalidKey).toBe('X Bad');
  });

  it('被拒原因里只有头名，不含可能作为凭据的值', () => {
    const secret = 'Bearer super-secret-token';
    const res = validateRuleHeaders({ Authorization: secret, 'X-Bad\r': 'v' });
    expect(res.invalidKey).toBe('X-Bad\r');
    expect(JSON.stringify(res)).not.toContain(secret);
  });
});

describe('请求体上限按 UTF-8 字节判定（exceedsBodyCap）', () => {
  it('ASCII 边界：恰好等于上限放行，多一字节拒绝', () => {
    expect(exceedsBodyCap('a'.repeat(MAX_BODY_SIZE))).toBe(false);
    expect(exceedsBodyCap('a'.repeat(MAX_BODY_SIZE + 1))).toBe(true);
  });

  it('非 ASCII 不再被按码元数低估（码元远未超限、字节已越界）', () => {
    // 1 个中文字符 = 1 个 UTF-16 码元 = 3 个 UTF-8 字节
    const cjk = '中'.repeat(Math.floor(MAX_BODY_SIZE / 3) + 1);
    expect(cjk.length).toBeLessThan(MAX_BODY_SIZE);
    expect(exceedsBodyCap(cjk)).toBe(true);
  });

  it('空串与日常小 body 一律放行', () => {
    expect(exceedsBodyCap('')).toBe(false);
    expect(exceedsBodyCap('{"a":1}')).toBe(false);
  });
});

describe('被拒请求必须留下本地日志，但不改页面侧契约', () => {
  const fetchSpy = vi.fn();
  const baseRequest = {
    requestId: 'q1',
    url: 'https://fat.example.com/api/users',
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: '{"small":1}',
  };

  beforeEach(() => {
    addRequestLog.mockClear();
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function useRule(rule: Record<string, unknown>) {
    configToReturn = { enabled: true, rules: [{ ...rule }] };
  }

  it('规则头非法：请求不发出、日志指名道姓、页面信封文案原样', async () => {
    useRule({
      id: 'r1',
      name: '带坏头的规则',
      enabled: true,
      matchType: 'wildcard',
      matchPattern: 'https://fat.example.com/*',
      targetUrl: 'https://uat.example.com/',
      priority: 10,
      headerOverrides: { Authorization: 'Bearer ok', 'X Bad': 'v' },
    });

    const res = await handleProxyRequest(baseRequest);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.statusText).toBe('Invalid Rule Headers');
    expect(res.body).toBe('Rule contains invalid header override');
    const entry = addRequestLog.mock.calls[0][0] as { error: string; ruleName: string; status: number };
    expect(entry.error).toBe('Rule header override rejected: "X Bad"');
    expect(entry.ruleName).toBe('带坏头的规则');
    expect(entry.status).toBe(0);
  });

  it('仅由规则覆盖 body 撑爆上限：同样被拦下并留痕（此前规则侧完全绕过上限）', async () => {
    useRule({
      id: 'r2',
      name: '超大请求体',
      enabled: true,
      matchType: 'wildcard',
      matchPattern: 'https://fat.example.com/*',
      targetUrl: 'https://uat.example.com/',
      priority: 10,
      requestBodyOverride: '中'.repeat(Math.floor(MAX_BODY_SIZE / 3) + 1),
    });

    const res = await handleProxyRequest(baseRequest);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.statusText).toBe('Body Too Large');
    expect(res.body).toBe(`Request body exceeds ${MAX_BODY_SIZE} bytes`);
    expect((addRequestLog.mock.calls[0][0] as { error: string; ruleName: string }).error).toContain('exceeds');
  });

  it('上限之内的 body 正常发出，且带上规则覆盖后的内容', async () => {
    useRule({
      id: 'r3',
      name: '普通改写',
      enabled: true,
      matchType: 'wildcard',
      matchPattern: 'https://fat.example.com/*',
      targetUrl: 'https://uat.example.com/',
      priority: 10,
      requestBodyOverride: '{"replaced":true}',
    });
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{"done":1}',
    });

    const res = await handleProxyRequest(baseRequest);

    expect(res.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"replaced":true}');
  });
});
