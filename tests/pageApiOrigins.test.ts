/**
 * 「这一页在调哪些接口」的候选清单：判据与回包形状
 *
 * popup 的「为当前页创建规则」按页面文档地址预填规则，而用户要代理的常常是这一页发出去的
 * 接口请求。候选来自页面自己的资源计时（`entrypoints/content.ts` 只读一次
 * `performance.getEntriesByType('resource')`），本模块负责三件事：只把 fetch/XHR 算成接口、
 * 只留 origin 与条数、以及 popup 侧把回包收成能画出来的行。
 *
 * 三处承重约束单独钉：
 * 1. **路径与查询串一条都不许漏出去**——它们常带 id、token，而通配符规则用不到；
 * 2. **同一份输入永远同一个列表**（`Map` 的插入序跟着加载顺序走，不稳定排序会画成界面在抖）；
 * 3. **两端形状同源**：`summarize` 的输出必须原样过 `parse`，否则改了任一侧就是
 *    「页面答得出来、popup 全丢了」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  summarizeApiOrigins,
  parsePageApiOrigins,
  PAGE_API_ORIGIN_LIMIT,
  type ResourceTimingLike,
} from '@/utils/pageApiOrigins';

const entry = (name: string, initiatorType?: string): ResourceTimingLike => ({ name, initiatorType });

/** 只关心接口的那几类发起类型；其余都是「页面还加载了别的东西」 */
const NON_API_TYPES = ['script', 'css', 'img', 'font', 'link', 'navigation', 'audio', 'video', 'other', ''];

describe('summarizeApiOrigins：只把接口调用算成来源', () => {
  it('只认 fetch 与 xmlhttprequest', () => {
    const result = summarizeApiOrigins([
      entry('https://uat-api.example.com/user/1', 'fetch'),
      entry('https://fat-api.example.com/session', 'xmlhttprequest'),
    ]);
    expect(result).toEqual([
      { origin: 'https://fat-api.example.com', count: 1 },
      { origin: 'https://uat-api.example.com', count: 1 },
    ]);
  });

  it.each(NON_API_TYPES)('发起类型「%s」不参与（它不是要代理的对象）', type => {
    expect(summarizeApiOrigins([entry('https://cdn.example.com/app.js', type)])).toEqual([]);
  });

  it('缺发起类型的条目不要', () => {
    expect(summarizeApiOrigins([{ name: 'https://uat-api.example.com/a' }])).toEqual([]);
  });

  it('同一 origin 的路径与查询串合并成一条，且一个字都不带出去', () => {
    const result = summarizeApiOrigins([
      entry('https://uat-api.example.com/api/list?page=2', 'fetch'),
      entry('https://uat-api.example.com/api/user/token-secret/detail', 'fetch'),
      entry('https://uat-api.example.com/', 'xmlhttprequest'),
    ]);

    expect(result).toEqual([{ origin: 'https://uat-api.example.com', count: 3 }]);
    // 断言的是「整份输出里没有那些内容」，而不只是条数对：这一份要跨 world 送到 popup，
    // 而路径与查询串正是最可能带着 id、token 的那一段。
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('token-secret');
    expect(serialized).not.toContain('page=2');
    expect(serialized).not.toContain('/api');
  });

  it('本页自己的 origin 同样是候选（前端调自家 /api 再转出去，是最常见的那一条）', () => {
    expect(
      summarizeApiOrigins([
        entry('https://fat.example.com/api/list', 'fetch'),
        entry('https://fat.example.com/api/me', 'fetch'),
      ]),
    ).toEqual([{ origin: 'https://fat.example.com', count: 2 }]);
  });

  it.each([
    ['不可解析的地址', 'not-a-url'],
    ['空串', ''],
    ['data: 内联资源', 'data:application/json,{"a":1}'],
    ['blob: 资源', 'blob:https://fat.example.com/8f2b'],
    ['扩展自己的地址', 'chrome-extension://abcdefghijklmnop/script.js'],
    ['协议相对写法', '//uat-api.example.com/a'],
  ])('%s 不要（它给不出一条能建规则的来源）', (_label, name) => {
    expect(summarizeApiOrigins([entry(name, 'fetch')])).toEqual([]);
  });

  it('http 与 https 是两个来源，不合并', () => {
    expect(
      summarizeApiOrigins([entry('http://uat.internal/a', 'fetch'), entry('https://uat.internal/a', 'fetch')]),
    ).toEqual([
      { origin: 'http://uat.internal', count: 1 },
      { origin: 'https://uat.internal', count: 1 },
    ]);
  });

  it('排序：条数降序、同数按 origin 升序', () => {
    const entries = [
      entry('https://b.example.com/1', 'fetch'),
      entry('https://a.example.com/1', 'fetch'),
      entry('https://a.example.com/2', 'fetch'),
      entry('https://c.example.com/1', 'fetch'),
      entry('https://c.example.com/2', 'fetch'),
      entry('https://c.example.com/3', 'fetch'),
    ];
    expect(summarizeApiOrigins(entries).map(item => item.origin)).toEqual([
      'https://c.example.com',
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('列表与条目的到达顺序无关（同一页面点两次不该给出两份候选）', () => {
    const entries = [
      entry('https://a.example.com/1', 'fetch'),
      entry('https://b.example.com/1', 'fetch'),
      entry('https://b.example.com/2', 'fetch'),
      entry('https://c.example.com/1', 'fetch'),
      entry('https://c.example.com/2', 'fetch'),
    ];
    expect(summarizeApiOrigins([...entries].reverse())).toEqual(summarizeApiOrigins(entries));
  });

  it(`默认只列 ${PAGE_API_ORIGIN_LIMIT} 个，且截的是条数最少的（不是最先出现的那个）`, () => {
    // g 只有 1 条却排在输入最前：如果实现先截断再排序，活下来的就是 g 而不是 f
    const many = (origin: string, times: number) =>
      Array.from({ length: times }, (_, i) => entry(`${origin}/${i}`, 'fetch'));
    const result = summarizeApiOrigins([
      ...many('https://g.example.com', 1),
      ...many('https://a.example.com', 9),
      ...many('https://b.example.com', 8),
      ...many('https://c.example.com', 7),
      ...many('https://d.example.com', 6),
      ...many('https://e.example.com', 5),
      ...many('https://f.example.com', 4),
      ...many('https://h.example.com', 3),
    ]);
    expect(result).toHaveLength(PAGE_API_ORIGIN_LIMIT);
    expect(result.map(item => item.origin)).toEqual([
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
      'https://d.example.com',
      'https://e.example.com',
      'https://f.example.com',
    ]);
  });

  it('limit 可以更小（同一判据，别处要用窄面板时不必自己再截一次）', () => {
    const entries = [
      entry('https://a.example.com/1', 'fetch'),
      entry('https://b.example.com/1', 'fetch'),
      entry('https://c.example.com/1', 'fetch'),
    ];
    expect(summarizeApiOrigins(entries, 2).map(item => item.origin)).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('空列表给空数组', () => {
    expect(summarizeApiOrigins([])).toEqual([]);
  });
});

describe('parsePageApiOrigins：popup 只收下画得出来的行', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'https://a.example.com'],
    ['没有 origins 字段的对象', { hits: 1 }],
    ['origins 是对象', { origins: { a: 1 } }],
    ['origins 是字符串', { origins: 'https://a.example.com' }],
  ])('%s 一律回空数组（那是「问不到」，不是「这一页没在调接口」）', (_label, value) => {
    expect(parsePageApiOrigins(value)).toEqual([]);
  });

  it('空 origins 数组原样回空', () => {
    expect(parsePageApiOrigins({ origins: [] })).toEqual([]);
  });

  it('逐条判合法：非法的那条不要，合法的那条照收', () => {
    expect(
      parsePageApiOrigins({
        origins: [
          { origin: 'https://a.example.com', count: 3 },
          null,
          'https://b.example.com',
          { origin: 'https://no-count.example.com' },
          { origin: 'data:text/plain,x', count: 1 },
          { origin: 42, count: 1 },
          { origin: 'https://c.example.com', count: 1 },
        ],
      }),
    ).toEqual([
      { origin: 'https://a.example.com', count: 3 },
      { origin: 'https://c.example.com', count: 1 },
    ]);
  });

  it.each([
    ['0 次（一条请求都没有的来源不该占一行）', 0],
    ['负数', -3],
    ['小数', 1.5],
    ['字符串', '3'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('count 为 %s 的条目不要', (_label, count) => {
    expect(parsePageApiOrigins({ origins: [{ origin: 'https://a.example.com', count }] })).toEqual([]);
  });

  it('带路径或查询串的回包条目归一化成 origin（那些内容不进界面，也不跟去下一次点击）', () => {
    expect(parsePageApiOrigins({ origins: [{ origin: 'https://a.example.com/api/me?token=abc', count: 2 }] })).toEqual([
      { origin: 'https://a.example.com', count: 2 },
    ]);
  });

  it(`越界的条目数同样收口（最多 ${PAGE_API_ORIGIN_LIMIT} 行）`, () => {
    const origins = Array.from({ length: 40 }, (_, i) => ({ origin: `https://h${i}.example.com`, count: 1 }));
    expect(parsePageApiOrigins({ origins })).toHaveLength(PAGE_API_ORIGIN_LIMIT);
  });
});

describe('两端形状同源：页面答的与 popup 收的是同一份判据', () => {
  it('summarize 的输出原样通过 parse', () => {
    const entries = [
      entry('https://a.example.com/1', 'fetch'),
      entry('https://a.example.com/2', 'fetch'),
      entry('https://b.example.com/1', 'xmlhttprequest'),
    ];
    const summarized = summarizeApiOrigins(entries);
    expect(parsePageApiOrigins({ origins: summarized })).toEqual(summarized);
  });

  it('桥接层那一支只读资源计时、只回 origins 一个键', () => {
    const bridgeSrc = readFileSync('entrypoints/content.ts', 'utf-8');
    const at = bridgeSrc.indexOf('if (message.type === PAGE_API_PROBE)');
    expect(at, '桥接层不再处理 PAGE_API_PROBE——探测挪了位置就同步这里').toBeGreaterThan(-1);
    const branch = bridgeSrc.slice(at, bridgeSrc.indexOf('});', at));
    expect(branch).toContain("getEntriesByType('resource')");
    // 换成 getEntries()（连 navigation 一起给）、或把条目原文回出去，都会越过「只回 origin」这条线
    expect(branch).not.toMatch(/getEntries\s*\(\s*\)/);
    expect(branch).toContain('origins:');
    expect(branch).not.toContain('.name');
  });
});
