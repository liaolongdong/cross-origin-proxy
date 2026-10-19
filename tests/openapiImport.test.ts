/**
 * OpenAPI / Swagger 导入：`utils/openapi.ts` 的 `parseOpenApiSpec` + `openApiSpecToRules`
 *
 * 这条进口的输入是**别人写的文件**，而它的失败全都是静默的那一类：读不出来源就少一条规则、
 * 模板没展开就少一条、`schemes` 读错就产出一条永远匹配不上的 http 规则——界面只报一个数字，
 * 用户看不出少的是哪一条。所以判据必须在纯函数这一层被逐档钉住。
 *
 * 断言按「这一格改了以后谁会受害」来选：
 * - 留空目标时的自映射形状：那句「不填就照旧」的承诺（README、导入面板的说明、CHANGELOG 各写一遍）。
 * - 有 basePath 时目标要带上同一段：文档说这套 API 挂在 `/v3`，换环境后落到根路径等于换了另一个服务。
 * - `enabled` 只能随目标走：复选框不出现＝没勾，这条不变量一旦在纯函数里被绕过，
 *   界面上那个不出现的复选框就又开始替用户决定「要不要把整站流量当场指走」。
 * - 跳过的来源要计数并被界面点名：文档写了 5 个 server 却只出 3 条规则而不说，就是谎报。
 */
import { describe, it, expect } from 'vitest';
import { openApiSpecToRules, parseOpenApiSpec, type OpenApiSpec } from '@/utils/openapi';
import { MAX_OPENAPI_ORIGINS } from '@/utils/constants';

/** 一份最小可用的 OpenAPI 3 文档 */
function spec3(servers: unknown[], extras: Record<string, unknown> = {}): string {
  return JSON.stringify({
    openapi: '3.0.2',
    info: { title: 'Pet API' },
    servers,
    paths: { '/pet': { get: {} } },
    ...extras,
  });
}

/** 一份最小可用的 Swagger 2 文档 */
function spec2(host: unknown, basePath: unknown, schemes?: unknown): string {
  return JSON.stringify({ swagger: '2.0', info: { title: 'Legacy' }, host, basePath, schemes, paths: { '/a': {} } });
}

const okSpec = (text: string): OpenApiSpec => {
  const result = parseOpenApiSpec(text);
  if (!result.ok) throw new Error(`解析本应成功，实际失败：${result.reason}`);
  return result.spec;
};

describe('parseOpenApiSpec — 文档读数与拒绝原因', () => {
  it('四类失败各归各的原因（界面要按它挑文案）', () => {
    expect(parseOpenApiSpec('not json at all')).toEqual({ ok: false, reason: 'notJson' });
    expect(parseOpenApiSpec('"just a string"')).toEqual({ ok: false, reason: 'notObject' });
    expect(parseOpenApiSpec(JSON.stringify({ title: '随便一个 JSON' }))).toEqual({
      ok: false,
      reason: 'unsupportedSpec',
    });
    // 有版本标记却没有 paths：多半是别人的一段残片
    expect(parseOpenApiSpec(JSON.stringify({ openapi: '3.0.0', servers: [{ url: 'https://a.com' }] }))).toEqual({
      ok: false,
      reason: 'unsupportedSpec',
    });
    expect(parseOpenApiSpec(spec3([]))).toEqual({ ok: false, reason: 'noServers' });
    expect(parseOpenApiSpec(spec2(undefined, '/v1'))).toEqual({ ok: false, reason: 'noServers' });
  });

  it('OpenAPI 3：servers 折叠成 origin + basePath，重复的只留第一条', () => {
    const spec = okSpec(
      spec3([
        { url: 'https://fat.example.com/v3/' },
        { url: 'https://fat.example.com/v3' },
        { url: 'https://other.example.com' },
      ]),
    );
    expect(spec.origins.map(o => o.prefix)).toEqual(['https://fat.example.com/v3', 'https://other.example.com']);
    expect(spec.skipped).toBe(0);
  });

  it('根路径的 server 前缀不带末尾斜杠（否则匹配串与 rewriteUrl 的口径会分家）', () => {
    const spec = okSpec(spec3([{ url: 'https://a.com/' }, { url: 'https://b.com' }]));
    expect(spec.origins.map(o => o.prefix)).toEqual(['https://a.com', 'https://b.com']);
    expect(spec.origins.every(o => o.basePath === '')).toBe(true);
  });

  it('读不出 http(s) 的来源被跳过并计数，不产出坏规则', () => {
    const spec = okSpec(
      spec3([
        { url: 'ftp://files.example.com' },
        { url: 'ws://push.example.com' },
        { url: '  not a url  ' },
        { url: 'https://good.example.com/v1' },
      ]),
    );
    expect(spec.origins.map(o => o.prefix)).toEqual(['https://good.example.com/v1']);
    expect(spec.skipped).toBe(3);
  });

  it('非 http(s) 的协议大小写与多余空白都容忍（合法意图不该因为排版被丢掉）', () => {
    const spec = okSpec(spec3([{ url: 'HTTPS://Mixed.Example.com/V1' }, { url: ' https://spaced.example.com ' }]));
    // URL 会规范化主机大小写、保留路径大小写
    expect(spec.origins.map(o => o.prefix)).toEqual(['https://mixed.example.com/V1', 'https://spaced.example.com']);
  });

  it('server 变量模板：有 default 就展开，没有就跳过它并计数', () => {
    const spec = okSpec(
      spec3([
        { url: 'https://{region}.example.com/v1', variables: { region: { default: 'fat' } } },
        { url: 'https://{tenant}.example.com' },
      ]),
    );
    expect(spec.origins.map(o => o.prefix)).toEqual(['https://fat.example.com/v1']);
    expect(spec.skipped).toBe(1);
  });

  it('Swagger 2：host + basePath + schemes，缺 schemes 时按 https 兜底', () => {
    expect(okSpec(spec2('api.example.com', '/v2', ['https', 'http'])).origins[0].prefix).toBe(
      'https://api.example.com/v2',
    );
    expect(okSpec(spec2('api.example.com', '/v2', ['http'])).origins[0].prefix).toBe('http://api.example.com/v2');
    expect(okSpec(spec2('api.example.com:8443', '/v2')).origins[0].prefix).toBe('https://api.example.com:8443/v2');
    // basePath 写成 '/' 与没写是一回事：都不该在末尾留一个斜杠
    expect(okSpec(spec2('api.example.com', '/')).origins[0].prefix).toBe('https://api.example.com');
  });

  it('title 清洗：折行压平、超长掐断，缺省时规则叫 OpenAPI', () => {
    expect(okSpec(spec3([{ url: 'https://a.com' }], { info: { title: '  多行\n标题  ' } })).title).toBe('多行 标题');
    expect(okSpec(spec3([{ url: 'https://a.com' }], { info: { title: 'x'.repeat(200) } })).title).toHaveLength(49);
    expect(okSpec(JSON.stringify({ openapi: '3.0.0', servers: [{ url: 'https://a.com' }], paths: {} }))).toEqual({
      title: '',
      origins: [{ prefix: 'https://a.com', origin: 'https://a.com', basePath: '' }],
      skipped: 0,
    });
  });

  it('来源条数收在 MAX_OPENAPI_ORIGINS 内，多出来的计入 skipped 而不是静默丢掉', () => {
    const many = Array.from({ length: MAX_OPENAPI_ORIGINS + 7 }, (_, i) => ({ url: `https://s${i}.example.com` }));
    const spec = okSpec(spec3(many));
    expect(spec.origins).toHaveLength(MAX_OPENAPI_ORIGINS);
    expect(spec.skipped).toBe(7);
  });

  it('servers 不是数组、或条目不是对象时整份文档仍可用（只是少几条并计数）', () => {
    const spec = okSpec(
      spec3(['https://string-url.example.com', null, 42, { url: 1 }, { url: 'https://ok.example.com' }] as unknown[]),
    );
    expect(spec.origins.map(o => o.prefix)).toEqual(['https://ok.example.com']);
    expect(spec.skipped).toBe(4);
  });

  it('解析是纯函数：同样的文本两次给出同样的结果', () => {
    const text = spec3([{ url: 'https://a.com/v1' }]);
    expect(parseOpenApiSpec(text)).toEqual(parseOpenApiSpec(text));
  });
});

describe('openApiSpecToRules — 产出的规则形状', () => {
  const spec = okSpec(spec3([{ url: 'https://fat.example.com/v3' }, { url: 'https://other.example.com' }]));

  it('不传 opts 时是自映射、默认停用、固定优先级 100、prefix 匹配', () => {
    const rules = openApiSpecToRules(spec);
    expect(rules).toHaveLength(2);
    expect(rules[0].matchType).toBe('prefix');
    expect(rules[0].matchPattern).toBe('https://fat.example.com/v3');
    expect(rules[0].targetUrl).toBe('https://fat.example.com/v3');
    expect(rules[0].enabled).toBe(false);
    expect(rules[0].priority).toBe(100);
    expect(rules[0].name).toContain('Pet API');
    expect(rules[0].name).toContain('fat.example.com/v3');
  });

  it('空 targetOrigin 等于没填（产出与不传 opts 逐字节相同）', () => {
    expect(openApiSpecToRules(spec, { targetOrigin: '', enabled: true })).toEqual(openApiSpecToRules(spec));
    expect(openApiSpecToRules(spec, { enabled: true })).toEqual(openApiSpecToRules(spec));
  });

  it('填了目标：每条都指过去，并把各自的 basePath 带上', () => {
    const rules = openApiSpecToRules(spec, { targetOrigin: 'https://uat.example.com', enabled: true });
    expect(rules.map(r => r.targetUrl)).toEqual(['https://uat.example.com/v3', 'https://uat.example.com']);
    // 匹配侧仍然按文档声明的来源：换的是目标，不是「这一条管哪些请求」
    expect(rules.map(r => r.matchPattern)).toEqual(['https://fat.example.com/v3', 'https://other.example.com']);
    expect(rules.every(r => r.enabled)).toBe(true);
  });

  it('没填目标时 enabled 传什么都不算（界面上那个复选框此时不存在）', () => {
    expect(openApiSpecToRules(spec, { enabled: true })[0].enabled).toBe(false);
    expect(openApiSpecToRules(spec, { targetOrigin: '', enabled: true })[1].enabled).toBe(false);
  });

  it('规则 id 互不相同且时间戳一致（批量写入按 id 认条目）', () => {
    const rules = openApiSpecToRules(
      okSpec(spec3(Array.from({ length: 5 }, (_, i) => ({ url: `https://h${i}.com` })))),
    );
    expect(new Set(rules.map(r => r.id)).size).toBe(5);
    expect(new Set(rules.map(r => r.createdAt)).size).toBe(1);
    expect(rules.every(r => r.updatedAt === r.createdAt)).toBe(true);
  });

  it('不改入参：spec 被原样留着（同一份文档可能被连点两次导入）', () => {
    const snapshot = JSON.parse(JSON.stringify(spec));
    openApiSpecToRules(spec, { targetOrigin: 'https://uat.example.com', enabled: true });
    expect(spec).toEqual(snapshot);
  });
});
