import { describe, it, expect } from 'vitest';
import { buildRegexFilter, buildRegexSubstitution, buildDnrRules, toDnrPriority } from '@/utils/dnrRules';
import { DNR_RULE_ID_PREFIX } from '@/utils/constants';
import type { ProxyRule } from '@/utils/types';

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: 'https://fat-api.example.com/*',
    targetUrl: 'https://uat-api.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildRegexFilter', () => {
  it('wildcard 转义特殊字符并将 * 转为捕获组', () => {
    const rule = makeRule({ matchPattern: 'https://fat-api.example.com/*' });
    expect(buildRegexFilter(rule)).toBe('^https://fat-api\\.example\\.com/(.*)$');
  });

  it('prefix 锚定前缀并捕获剩余部分', () => {
    const rule = makeRule({ matchType: 'prefix', matchPattern: 'https://fat-api.example.com' });
    expect(buildRegexFilter(rule)).toBe('^https://fat-api\\.example\\.com(.*)');
  });

  it('regex 原样使用用户正则', () => {
    const rule = makeRule({ matchType: 'regex', matchPattern: '^https://fat/(.*)$' });
    expect(buildRegexFilter(rule)).toBe('^https://fat/(.*)$');
  });
});

describe('buildRegexSubstitution', () => {
  it('wildcard 以 /* 结尾时补回分隔斜杠并引用捕获组', () => {
    const rule = makeRule({});
    expect(buildRegexSubstitution(rule)).toBe('https://uat-api.example.com/\\1');
  });

  it('wildcard 目标 URL 末尾斜杠被规整', () => {
    const rule = makeRule({ targetUrl: 'https://uat-api.example.com/' });
    expect(buildRegexSubstitution(rule)).toBe('https://uat-api.example.com/\\1');
  });

  it('prefix 引用 \\1', () => {
    const rule = makeRule({ matchType: 'prefix', matchPattern: 'https://fat-api.example.com' });
    expect(buildRegexSubstitution(rule)).toBe('https://uat-api.example.com\\1');
  });

  it('regex 将 $n 转为 DNR 的 \\n 语法', () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: '^https://fat/(.*)$',
      targetUrl: 'https://uat/$1',
    });
    expect(buildRegexSubstitution(rule)).toBe('https://uat/\\1');
  });
});

describe('toDnrPriority', () => {
  it('反转业务优先级（数值小 → DNR 优先级高），下限为 1', () => {
    expect(toDnrPriority(1)).toBeGreaterThan(toDnrPriority(10));
    expect(toDnrPriority(9999)).toBe(1);
  });

  it('小数优先级被取整（DNR 的 priority 只接受整数，一个小数会让整批规则被拒）', () => {
    for (const priority of [2.5, 1.4, 2.6, 998.6, -0.4, 0.5]) {
      expect(Number.isInteger(toDnrPriority(priority)), `priority=${priority}`).toBe(true);
    }
    expect(toDnrPriority(2.5)).toBe(998);
    expect(toDnrPriority(2.6)).toBe(997);
  });
});

describe('buildDnrRules：优先级整数化', () => {
  it('整批 DNR 规则的 priority 一律为整数（混入小数也不能打穿整批）', () => {
    const rules = [
      makeRule({ id: 'a', priority: 1 }),
      makeRule({ id: 'b', priority: 2.5 }),
      makeRule({ id: 'c', priority: 3.499 }),
    ];

    const { rules: dnrRules } = buildDnrRules(rules, true);

    expect(dnrRules).toHaveLength(3);
    for (const dnrRule of dnrRules) {
      expect(Number.isInteger(dnrRule.priority), `rule=${dnrRule.id}`).toBe(true);
    }
  });
});

describe('buildDnrRules', () => {
  it('只转换启用中的简单规则，并生成 id 映射', () => {
    const simple = makeRule({ id: 'simple' });
    const disabled = makeRule({ id: 'disabled', enabled: false });
    const complex = makeRule({ id: 'complex', headerOverrides: { 'X-Env': 'uat' } });

    const { rules, idMap } = buildDnrRules([simple, disabled, complex], true);

    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe(DNR_RULE_ID_PREFIX);
    expect(rules[0].condition.regexFilter).toBe('^https://fat-api\\.example\\.com/(.*)$');
    expect(rules[0].action.redirect?.regexSubstitution).toBe('https://uat-api.example.com/\\1');
    expect(idMap.get(DNR_RULE_ID_PREFIX)).toEqual({ ruleId: 'simple', ruleName: 'test' });
  });

  it('排除 WebSocket / 方法过滤 / 查询参数规则（非简单，不进 DNR）', () => {
    const ws = makeRule({ id: 'ws', matchPattern: 'wss://fat.example.com/*', targetUrl: 'wss://uat.example.com' });
    const method = makeRule({ id: 'm', targetUrl: 'https://uat.example.com', methods: ['POST'] });
    const query = makeRule({ id: 'q', targetUrl: 'https://uat.example.com', queryOverrides: { env: 'uat' } });

    const { rules } = buildDnrRules([ws, method, query], true);
    expect(rules).toHaveLength(0);
  });

  it('总开关关闭时不编译任何 DNR 规则（否则关代理后网络层仍在重定向）', () => {
    const { rules, idMap } = buildDnrRules([makeRule({ id: 'simple' })], false);

    expect(rules).toHaveLength(0);
    expect(idMap.size).toBe(0);
  });
});
