import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import type { ProxyRule } from '@/utils/types';
import {
  isVariableName,
  extractVariableRefs,
  resolveVariableRefs,
  resolveVariableMap,
  collectRuleVariableRefs,
  findUndefinedVariableRefs,
  sanitizeVariables,
} from '@/utils/variables';
import { isSimpleRule } from '@/utils/urlMatcher';
import { MAX_VARIABLES, MAX_VARIABLE_VALUE_LENGTH } from '@/utils/constants';

// ═══════════════════════════════════════════════════════════════════════════════
// 凭据变量库：规则里的凭据位点写 `{{名称}}`，真值单独存 storage.local 的 `variables`
//
// 要守住的三件事：
// 1. 展开只发生在后台侧出站请求组装前——真值既不进导出文件（规则里存的就是引用），
//    也不进页面世界（下发前不展开），也不进本地日志（日志记未展开形态）。
// 2. 一次格式错误不等于清空整张表：`saveVariables` 对非键值对象抛错拒写。
// 3. 引用规则必须是 SW 通道（`headerOverrides` / `queryOverrides` 已让 `isSimpleRule` 为假）。
// ═══════════════════════════════════════════════════════════════════════════════

function makeRule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r1',
    name: 'FAT → UAT',
    enabled: true,
    matchPattern: 'https://api.example.com/*',
    targetUrl: 'https://uat.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 真实 `chrome.storage.local.get` 每次返回反序列化副本，桩必须同样如此 */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

describe('isVariableName — 变量名字法', () => {
  it('字母开头，允许数字 / _ / . / -', () => {
    expect(isVariableName('UAT_TOKEN')).toBe(true);
    expect(isVariableName('a')).toBe(true);
    expect(isVariableName('X-Api-Key.1')).toBe(true);
  });

  it('空串、数字或符号开头、含空格与中文一律不合法', () => {
    expect(isVariableName('')).toBe(false);
    expect(isVariableName('1TOKEN')).toBe(false);
    expect(isVariableName('_TOKEN')).toBe(false);
    expect(isVariableName('UAT TOKEN')).toBe(false);
    expect(isVariableName('令牌')).toBe(false);
  });

  it('长度上限 64（与 MAX_VARIABLE_NAME_LENGTH 同口径）', () => {
    expect(isVariableName('A'.repeat(64))).toBe(true);
    expect(isVariableName('A'.repeat(65))).toBe(false);
  });
});

describe('extractVariableRefs — 认出引用', () => {
  it('取值里的名字，容忍花括号内的空白', () => {
    expect(extractVariableRefs('Bearer {{UAT_TOKEN}}')).toEqual(['UAT_TOKEN']);
    expect(extractVariableRefs('{{ UAT_TOKEN }}')).toEqual(['UAT_TOKEN']);
  });

  it('去重且保持首次出现顺序', () => {
    expect(extractVariableRefs('{{B}}/{{A}}/{{B}}')).toEqual(['B', 'A']);
  });

  it('空值与不成形的花括号不算引用', () => {
    expect(extractVariableRefs(undefined)).toEqual([]);
    expect(extractVariableRefs('')).toEqual([]);
    expect(extractVariableRefs('{{}} {{a b}} {{1A}}')).toEqual([]);
    expect(extractVariableRefs('{"json": 1}')).toEqual([]);
  });
});

describe('resolveVariableRefs / resolveVariableMap — 展开', () => {
  const store = { TOKEN: 'abc123', BRACE: '{{TOKEN}}' };

  it('命中就替换，未命中保留字面量并回报名字', () => {
    expect(resolveVariableRefs('Bearer {{TOKEN}}', store)).toEqual({ value: 'Bearer abc123', missing: [] });
    expect(resolveVariableRefs('Bearer {{NOPE}}', store)).toEqual({
      value: 'Bearer {{NOPE}}',
      missing: ['NOPE'],
    });
  });

  it('不含引用的文本一次正则都不跑（原样返回）', () => {
    expect(resolveVariableRefs('application/json', store)).toEqual({ value: 'application/json', missing: [] });
  });

  it('不递归展开：真值里的 {{x}} 不会被二次解释', () => {
    // 否则一个变量就能引用整张表，也能造出无限套娃
    expect(resolveVariableRefs('{{BRACE}}', store)).toEqual({ value: '{{TOKEN}}', missing: [] });
  });

  it('只认表里自己的键：{{constructor}} / {{toString}} 是「没配」，不是「配了一段函数源码」', () => {
    // 这两个名字都过 `isVariableName`，裸下标却会顺原型链命中 Object.prototype 上的函数，
    // 于是未展开的引用被换成 `function Object() { [native code] }` 发出去
    expect(resolveVariableRefs('Bearer {{constructor}}', {})).toEqual({
      value: 'Bearer {{constructor}}',
      missing: ['constructor'],
    });
    expect(resolveVariableRefs('{{toString}}', {})).toEqual({ value: '{{toString}}', missing: ['toString'] });
    // 真的把变量取名叫 constructor 时照样展开（自有属性优先，这条修法不误伤）
    expect(resolveVariableRefs('{{constructor}}', { constructor: 'real-token' })).toEqual({
      value: 'real-token',
      missing: [],
    });
  });

  it('空表与未配置返回 undefined，保持「本规则没有这一项」的形态', () => {
    expect(resolveVariableMap(undefined, store)).toBeUndefined();
    expect(resolveVariableMap({}, store)).toBeUndefined();
  });

  it('只展开值，键名原样保留（头名里放引用不是本功能的语义）', () => {
    const result = resolveVariableMap({ 'X-{{TOKEN}}': 'v{{TOKEN}}' }, store);
    expect(result?.resolved).toEqual({ 'X-{{TOKEN}}': 'vabc123' });
  });

  it('跨条目回报缺失名字并去重', () => {
    const result = resolveVariableMap({ A: '{{X}}', B: '{{X}}', C: '{{Y}}' }, store);
    expect(result?.missing).toEqual(['X', 'Y']);
  });
});

describe('collectRuleVariableRefs / findUndefinedVariableRefs — 表单侧口径', () => {
  it('请求头与查询参数两个位点都算，跨位点去重', () => {
    expect(
      collectRuleVariableRefs({
        headerOverrides: { Authorization: '{{A}}' },
        queryOverrides: { t: '{{B}}', u: '{{A}}' },
      }),
    ).toEqual(['A', 'B']);
  });

  it('只回报变量表里没有的名字', () => {
    expect(findUndefinedVariableRefs({ headerOverrides: { Authorization: '{{A}} {{MISSING}}' } }, { A: 'x' })).toEqual([
      'MISSING',
    ]);
  });

  it('原型链上的名字要点名，而不是让保存侧的拼写检查放行', () => {
    // 这一格漏了，表单就会放过 `Bearer {{constructor}}`：存下去表现为一次看不懂的上游 401，
    // 而这句话正是本函数存在的理由
    expect(
      findUndefinedVariableRefs(
        { headerOverrides: { Authorization: 'Bearer {{constructor}}' }, queryOverrides: { t: '{{toString}}' } },
        {},
      ),
    ).toEqual(['constructor', 'toString']);
  });
});

describe('sanitizeVariables — 写入与读取共用的那道闸门', () => {
  it('非键值对象返回 null（调用方必须拒写，而不是当成空表）', () => {
    expect(sanitizeVariables(undefined)).toBeNull();
    expect(sanitizeVariables(null)).toBeNull();
    expect(sanitizeVariables('TOKEN')).toBeNull();
    expect(sanitizeVariables([])).toBeNull();
    expect(sanitizeVariables(42)).toBeNull();
  });

  it('裁两端空白：粘贴 token 常带换行，而 HTTP 本来也会折掉头值两端空白', () => {
    expect(sanitizeVariables({ TOKEN: '  abc\n' })?.store).toEqual({ TOKEN: 'abc' });
  });

  it('丢掉非法名字、非字符串值、空白值与超长值，并如实计数', () => {
    const result = sanitizeVariables({
      GOOD: 'v',
      '1BAD': 'v',
      NUM: 42,
      EMPTY: '   ',
      LONG: 'z'.repeat(MAX_VARIABLE_VALUE_LENGTH + 1),
    });
    expect(result?.store).toEqual({ GOOD: 'v' });
    expect(result?.dropped).toBe(4);
  });

  it('超长值是丢弃而不是截断（半把 token 比少一把更难查）', () => {
    const long = 'z'.repeat(MAX_VARIABLE_VALUE_LENGTH);
    expect(sanitizeVariables({ OK: long })?.store.OK).toBe(long);
  });

  it('超出条数上限的部分丢弃，保留先写入的 MAX_VARIABLES 条', () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < MAX_VARIABLES + 5; i++) input[`V${i}`] = `value-${i}`;
    const result = sanitizeVariables(input);
    expect(Object.keys(result?.store ?? {})).toHaveLength(MAX_VARIABLES);
    expect(result?.dropped).toBe(5);
  });
});

describe('storage.getVariables / saveVariables — 真值表的读写', () => {
  let store: Record<string, unknown> = {};
  let changeListeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];

  beforeEach(() => {
    store = {};
    changeListeners = [];
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string | string[] | null) => {
            if (key === null) return clone(store);
            if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, clone(store[k])]));
            return { [key]: clone(store[key]) };
          }),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, clone(obj));
          }),
        },
        onChanged: { addListener: vi.fn(fn => changeListeners.push(fn)) },
      },
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未设置过时读出空表而不是 undefined', async () => {
    const { getVariables } = await import('@/utils/storage');
    expect(await getVariables()).toEqual({});
  });

  it('存储被手改成非键值对象时按空表处理（引用原样发出，不至于让代理整体失效）', async () => {
    store['variables'] = 'UAT_TOKEN=abc';
    const { getVariables } = await import('@/utils/storage');
    expect(await getVariables()).toEqual({});
  });

  it('写入前收口：非法条目落不了地', async () => {
    const { saveVariables, getVariables } = await import('@/utils/storage');
    const { dropped } = await saveVariables({ TOKEN: ' abc ', '1BAD': 'x', EMPTY: '' });
    expect(dropped).toBe(2);
    expect(store['variables']).toEqual({ TOKEN: 'abc' });
    expect(await getVariables()).toEqual({ TOKEN: 'abc' });
  });

  it('非法载荷抛错拒写，绝不清空已有的整张表', async () => {
    store['variables'] = { TOKEN: 'keep-me' };
    const { saveVariables } = await import('@/utils/storage');
    await expect(saveVariables(undefined)).rejects.toThrow('INVALID_VARIABLES_PAYLOAD');
    await expect(saveVariables(['TOKEN'])).rejects.toThrow('INVALID_VARIABLES_PAYLOAD');
    expect(store['variables']).toEqual({ TOKEN: 'keep-me' });
  });

  it('写失败时缓存作废，下一次读回到存储里的事实', async () => {
    const { saveVariables, getVariables } = await import('@/utils/storage');
    await getVariables();
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('QUOTA'));
    await expect(saveVariables({ TOKEN: 'x' })).rejects.toThrow('QUOTA');
    expect(store['variables']).toBeUndefined();
  });

  it('variables 变更后缓存失效，同上下文重读拿到新值', async () => {
    const { getVariables } = await import('@/utils/storage');
    store['variables'] = { TOKEN: 'first' };
    expect(await getVariables()).toEqual({ TOKEN: 'first' });

    store['variables'] = { TOKEN: 'second' };
    expect(await getVariables()).toEqual({ TOKEN: 'first' }); // 仍是缓存
    changeListeners.forEach(fn => fn({ variables: { newValue: store['variables'] } }, 'local'));
    expect(await getVariables()).toEqual({ TOKEN: 'second' });
  });
});

describe('handleProxyRequest — 展开只进出站请求，不进日志', () => {
  const store: Record<string, unknown> = {};
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    fetchMock.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string | string[] | null) => {
            if (key === null) return clone(store);
            if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, clone(store[k])]));
            return { [key]: clone(store[key]) };
          }),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
    });
    vi.stubGlobal(
      'fetch',
      fetchMock.mockImplementation(async () => new Response('upstream', { status: 200, statusText: 'OK' })),
    );
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function request(url = 'https://api.example.com/users') {
    const { handleProxyRequest } = await import('@/entrypoints/background/proxyHandler');
    return handleProxyRequest({ requestId: 'req-1', url, method: 'GET', headers: {} });
  }

  /** 日志是缓冲写入的，断言前先落盘 */
  async function loggedEntries() {
    const { flushLogs, getRequestLogs } = await import('@/utils/storage');
    await flushLogs();
    return getRequestLogs();
  }

  it('请求头引用换出真值，而记进日志的那份里没有真值', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ headerOverrides: { Authorization: 'Bearer {{UAT_TOKEN}}' } })],
    };
    store['variables'] = { UAT_TOKEN: 'super-secret-value' };

    const resp = await request();
    expect(resp.status).toBe(200);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer super-secret-value' } });

    const logs = await loggedEntries();
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('super-secret-value');
  });

  it('查询参数引用：出站 URL 带真值，日志里只有未展开的引用', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ queryOverrides: { access_token: '{{UAT_TOKEN}}' } })],
    };
    store['variables'] = { UAT_TOKEN: 'secret-query-token' };

    await request();
    expect(String(fetchMock.mock.calls[0][0])).toContain('access_token=secret-query-token');

    const logs = await loggedEntries();
    // `applyQueryOverrides` 会编码值，所以画出来的是百分号编码的 `{{UAT_TOKEN}}`——
    // 形态丑一点，但和展开态一样不含真值，这条边界才是本功能要守的
    expect(logs[0].proxiedUrl).toContain('access_token=%7B%7BUAT_TOKEN%7D%7D');
    expect(JSON.stringify(logs)).not.toContain('secret-query-token');
  });

  it('未定义的引用原样发出：上游 401 比整条规则静默失效可读', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ headerOverrides: { Authorization: 'Bearer {{NOPE}}' } })],
    };
    store['variables'] = { OTHER: 'x' };

    const resp = await request();
    expect(resp.status).toBe(200);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer {{NOPE}}' } });
  });

  it('不含引用的规则不去读变量表（少一次存储读，也不把表喂给无关请求）', async () => {
    store['proxy_config'] = { enabled: true, rules: [makeRule({ headerOverrides: { 'X-Plain': 'v' } })] };
    store['variables'] = { UAT_TOKEN: 'secret-should-not-be-read' };
    const getSpy = chrome.storage.local.get as ReturnType<typeof vi.fn>;

    await request();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(getSpy.mock.calls)).not.toContain('variables');
  });

  it('手改进存储的换行值在展开后被拒（展开出来的值同样要过头校验）', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ headerOverrides: { Authorization: '{{BAD}}' } })],
    };
    store['variables'] = { BAD: 'x\r\nX-Injected: 1' };

    const resp = await request();
    expect(resp.status).toBe(0);
    expect(resp.statusText).toBe('Invalid Rule Headers');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不递归展开：一把变量的值里含另一把的名字，也不会被换出去', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ headerOverrides: { Authorization: '{{INDIRECT}}' } })],
    };
    store['variables'] = { INDIRECT: '{{UAT_TOKEN}}', UAT_TOKEN: 'never-exposed' };

    await request();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: '{{UAT_TOKEN}}' } });
    expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain('never-exposed');
  });
});

describe('分流与世界边界（源码契约）', () => {
  it('引用变量所需的两个位点都已让 isSimpleRule 为假，DNR 侧不需要展开', () => {
    expect(isSimpleRule(makeRule({ headerOverrides: { Authorization: '{{T}}' } }))).toBe(false);
    expect(isSimpleRule(makeRule({ queryOverrides: { t: '{{T}}' } }))).toBe(false);
  });

  it('两个页面世界都不引用展开逻辑，也不读变量表', () => {
    for (const file of ['entrypoints/main-interceptor.content.ts', 'entrypoints/content.ts']) {
      const src = fs.readFileSync(file, 'utf-8');
      expect(src, file).not.toContain('resolveVariableRefs');
      expect(src, file).not.toContain('resolveVariableMap');
      expect(src, file).not.toContain('getVariables');
      expect(src, file).not.toContain('@/utils/variables');
    }
  });

  it('DNR 规则构建里不存在变量展开的痕迹（引用规则根本到不了这里）', () => {
    const src = fs.readFileSync('utils/dnrRules.ts', 'utf-8');
    expect(src).not.toContain('VariableStore');
    expect(src).not.toContain('{{');
  });

  it('表单两道拦截都在，且变量表拉不到时不把保存变成死路', () => {
    const src = fs.readFileSync('components/options/RuleFormDialog.vue', 'utf-8');
    expect(src).toContain('findUndefinedVariableRefs');
    expect(src).toContain('variableWsQueryUnsupportedError');
    // WS 的查询参数由 MAIN world 拼接，那一侧永远读不到表 → 保存处直接拒
    expect(src).toContain('if (variableNamesLoaded.value)');
  });

  it('凭据读取类消息与状态修改类消息同侧受 gate 保护', () => {
    const src = fs.readFileSync('entrypoints/background/messageRouter.ts', 'utf-8');
    expect(src).toContain('CREDENTIAL_READING_TYPES');
    expect(src).toContain('MessageType.GET_VARIABLES');
  });
});
