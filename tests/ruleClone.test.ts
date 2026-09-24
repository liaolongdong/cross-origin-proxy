import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ref } from 'vue';
import { cloneRule } from '@/utils/ruleClone';
import { buildDuplicateRuleData } from '@/utils/ruleDuplicate';
import type { ProxyRule } from '@/utils/types';

/**
 * 「删除规则」与「复制规则」曾经当场抛 DataCloneError（2026-09-24 真浏览器测出来的，不是推断）：
 * 点删除 → 确认之后界面什么都不发生（App.vue 那处没有 try/catch，异常被 popconfirm 的处理器吞掉），
 * 点复制 → 被 catch 兜住、弹一句「添加失败」。两句的共同根因是同一件事：
 * 从 `rules.value` 里取出来的规则是 Vue 的响应式 Proxy，而 `structuredClone` 不认 Proxy。
 *
 * 所以这里断的不是「深拷贝字段对不对」（那部分 `full-verification` 已在），而是
 * **喂进去的必须是一个响应式元素**——只有这样才能重现修复前的失败。
 */

const seed = (): ProxyRule =>
  ({
    id: 'r-1',
    name: '原规则',
    matchType: 'wildcard',
    matchPattern: 'https://fat.example.com/*',
    targetUrl: 'https://uat.example.com/*',
    enabled: true,
    priority: 3,
    methods: ['GET', 'POST'],
    headerOverrides: { 'X-Tenant': 'a' },
    queryOverrides: { v: '1' },
    mockResponse: { status: 200, body: '{"ok":1}' },
    responseOverrides: { status: 201 },
    delayMs: 120,
    blocked: false,
    retryCount: 2,
    createdAt: 1,
    updatedAt: 2,
  }) as ProxyRule;

/** 真实调用方拿到的永远是这个形状：ref 数组里的一条 = 响应式 Proxy */
const reactiveRule = () => ref<ProxyRule[]>([seed()]).value[0];

describe('[cloneRule] 响应式里的规则必须能被深拷贝', () => {
  it('先确认陷阱还在：裸 structuredClone 拿到 Proxy 就是抛（Vue 改了语义这条会红，届时判据要重估）', () => {
    const rule = reactiveRule();
    // 只看 name：Node 与 Chrome 都把这一族的 message 写成「#<Object> could not be cloned.」，
    // 串里没有 DataCloneError 这个词
    const err = (() => {
      try {
        structuredClone(rule);
        return null;
      } catch (e) {
        return e as { name: string; message: string };
      }
    })();
    expect(err?.name).toBe('DataCloneError');
    expect(cloneRule(rule).name).toBe('原规则');
  });

  it('cloneRule 不抛，且与 structuredClone 同样深（嵌套对象不共享引用）', () => {
    const rule = reactiveRule();
    const copy = cloneRule(rule);
    expect(copy).not.toBe(rule);
    expect(copy.headerOverrides).not.toBe(rule.headerOverrides);
    expect(copy.methods).not.toBe(rule.methods);
    expect(copy).toMatchObject({ id: 'r-1', name: '原规则', methods: ['GET', 'POST'] });
  });

  it('显式写成 undefined 的可选字段整键留着（这就是不用 JSON 往返的理由）', () => {
    const withUndefined = { ...seed(), retryDelay: undefined };
    const copy = cloneRule(withUndefined);
    expect('retryDelay' in copy).toBe(true);
    expect(JSON.parse(JSON.stringify(withUndefined))).not.toHaveProperty('retryDelay');
  });

  it('喂普通对象同样可用（调用方不一定经过响应式）', () => {
    expect(cloneRule(seed())).toEqual(seed());
  });
});

describe('[buildDuplicateRuleData] 「复制规则」拿到响应式规则时不再当场抛', () => {
  it('响应式规则可直接复制（修复前这一步是 DataCloneError）', () => {
    expect(() => buildDuplicateRuleData(reactiveRule(), ' - 副本')).not.toThrow();
  });

  it('副本默认停用、名字带后缀，且不携带原 id 与时间戳', () => {
    const data = buildDuplicateRuleData(reactiveRule(), ' - 副本');
    expect(data.name).toBe('原规则 - 副本');
    expect(data.enabled).toBe(false);
    expect(data).not.toHaveProperty('id');
    expect(data).not.toHaveProperty('createdAt');
  });

  it('嵌套覆盖字段是深拷贝：改副本碰不到原规则', () => {
    const rule = reactiveRule();
    const data = buildDuplicateRuleData(rule, ' - 副本');
    data.headerOverrides!['X-Tenant'] = 'b';
    data.methods!.push('DELETE');
    expect(rule.headerOverrides).toEqual({ 'X-Tenant': 'a' });
    expect(rule.methods).toEqual(['GET', 'POST']);
  });
});

describe('[源码契约] SFC 那一层没法实例化，只能按源码钉', () => {
  const appSrc = readFileSync('components/options/App.vue', 'utf-8');

  it('App.vue 不再直接 structuredClone（撤销那份快照走 cloneRule）', () => {
    expect(appSrc).not.toContain('structuredClone(');
    expect(appSrc).toContain('cloneRule(rules.value[index])');
  });

  it('全仓不再有第二处对响应式数据裸用 structuredClone 的地方', () => {
    const offenders = [
      'utils/ruleDuplicate.ts',
      'composables/useRuleManagement.ts',
      'components/options/RuleTable.vue',
    ].filter(f => readFileSync(f, 'utf-8').includes('structuredClone('));
    expect(offenders).toEqual([]);
  });
});
