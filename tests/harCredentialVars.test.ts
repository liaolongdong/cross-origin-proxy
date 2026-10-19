/**
 * `utils/harCredentialVars.ts` —— 把 HAR 抓到的凭据头改成 `{{名称}}` 引用
 *
 * 这一格修的是全仓最后一处「真值写进规则」：`harEntriesToRules` 会把别人机器上抓来的
 * `Authorization` / `Cookie` / `x-api-key` 原值抄进 `headerOverrides`，而其余通路（导出脱敏、
 * 日志、下发给页面 world 的配置、恢复点）都按「规则里只放引用」成立。
 *
 * 承重的是那三条**降级路径**：装不下、名字不合用、值本来就是引用。它们都必须退回今天的行为
 * （保留原值）并交出计数，而不是造一条引用不存在的规则——后者运行时会把 `{{HAR_x}}` 原样发出、
 * 被上游 401，比少搬一次凭据难查得多。第二条用例钉的就是「不修改入参」：同一批规则对象还会被
 * 交去别处（成功提示按数量说话），就地改会让调用方看到两份不一致的形状。
 */
import { describe, it, expect } from 'vitest';
import { relocateHarCredentialHeaders } from '@/utils/harCredentialVars';
import { isVariableName } from '@/utils/variables';
import { MAX_VARIABLES, MAX_VARIABLE_VALUE_LENGTH } from '@/utils/constants';
import type { ProxyRule, VariableStore } from '@/utils/types';

function rule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r1',
    name: 'Imported: fat.example',
    enabled: false,
    matchPattern: 'https://fat.example/*',
    targetUrl: 'https://fat.example',
    matchType: 'wildcard',
    priority: 100,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const TOKEN = 'Bearer eyJhbGciOi.dead.beef';

describe('relocateHarCredentialHeaders — 正常路径', () => {
  it('三枚凭据头都改成引用，变量表拿到原值', () => {
    const input = [rule({ headerOverrides: { Authorization: TOKEN, Cookie: 'a=1', 'x-api-key': 'k9' } })];
    const result = relocateHarCredentialHeaders(input, {}, 10);
    expect(result.relocated).toBe(3);
    expect(result.keptRaw).toBe(0);
    expect(Object.keys(result.variables)).toHaveLength(3);
    expect(Object.values(result.variables)).toEqual([TOKEN, 'a=1', 'k9']);
    const headers = result.rules[0].headerOverrides ?? {};
    for (const value of Object.values(headers)) expect(value).toMatch(/^\{\{.+\}\}$/);
  });

  it('生成的名字合 `VARIABLE_NAME_RE`、带来源域名、且不超长', () => {
    const result = relocateHarCredentialHeaders([rule({ headerOverrides: { Authorization: TOKEN } })], {}, 10);
    const [name] = Object.keys(result.variables);
    expect(isVariableName(name)).toBe(true);
    expect(name).toContain('fat_example');
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it('端口参与域名：两个端口是两个环境，不该共用一个名字', () => {
    const two = [
      rule({ matchPattern: 'https://fat.example:8443/*', headerOverrides: { Authorization: 'A' } }),
      rule({ matchPattern: 'https://fat.example/*', headerOverrides: { Authorization: 'B' } }),
    ];
    const result = relocateHarCredentialHeaders(two, {}, 10);
    expect(Object.keys(result.variables)).toHaveLength(2);
    expect(new Set(Object.keys(result.variables)).size).toBe(2);
  });

  it('非凭据头一个字都不动（白名单与 har.ts 的采集侧同一份含义）', () => {
    const input = [rule({ headerOverrides: { 'content-type': 'application/json', Authorization: TOKEN } })];
    const result = relocateHarCredentialHeaders(input, {}, 10);
    expect(result.rules[0].headerOverrides?.['content-type']).toBe('application/json');
    expect(result.relocated).toBe(1);
  });

  it('没有 headerOverrides 的规则原样交出（连对象身份都不换）', () => {
    const input = [rule()];
    const result = relocateHarCredentialHeaders(input, {}, 10);
    expect(result.rules[0]).toBe(input[0]);
    expect(result.variables).toEqual({});
  });

  it('不修改入参', () => {
    const input = [rule({ headerOverrides: { Authorization: TOKEN } })];
    relocateHarCredentialHeaders(input, {}, 10);
    expect(input[0].headerOverrides?.Authorization).toBe(TOKEN);
  });
});

describe('relocateHarCredentialHeaders — 复用与去重', () => {
  it('变量表里已有同值变量就复用名字，不新增条目', () => {
    const existing: VariableStore = { UAT_TOKEN: TOKEN };
    const result = relocateHarCredentialHeaders([rule({ headerOverrides: { Authorization: TOKEN } })], existing, 10);
    expect(result.variables).toEqual({});
    expect(result.rules[0].headerOverrides?.Authorization).toBe('{{UAT_TOKEN}}');
    expect(result.relocated).toBe(1);
  });

  it('同一批里两条规则共享一个真值时只建一条变量', () => {
    const input = [
      rule({ matchPattern: 'https://a.example/*', headerOverrides: { Authorization: TOKEN } }),
      rule({ matchPattern: 'https://b.example/*', headerOverrides: { Authorization: TOKEN } }),
    ];
    const result = relocateHarCredentialHeaders(input, {}, 10);
    expect(Object.keys(result.variables)).toHaveLength(1);
    expect(result.rules[0].headerOverrides?.Authorization).toBe(result.rules[1].headerOverrides?.Authorization);
  });

  it('值本来就是引用时不动它，也不再建一条变量', () => {
    const input = [rule({ headerOverrides: { Authorization: '{{ALREADY}}' } })];
    const result = relocateHarCredentialHeaders(input, {}, 10);
    expect(result.rules[0].headerOverrides?.Authorization).toBe('{{ALREADY}}');
    expect(result.variables).toEqual({});
    expect(result.relocated).toBe(0);
    expect(result.keptRaw).toBe(0);
  });

  it('与既有变量重名时往后缀避让，两条都在表里', () => {
    const takenName = 'HAR_fat_example_authorization';
    const result = relocateHarCredentialHeaders(
      [rule({ headerOverrides: { Authorization: TOKEN } })],
      { [takenName]: 'other' },
      10,
    );
    const [name] = Object.keys(result.variables);
    expect(name).not.toBe(takenName);
    expect(result.rules[0].headerOverrides?.Authorization).toBe(`{{${name}}}`);
  });
});

describe('relocateHarCredentialHeaders — 三条降级都退回今天的形状', () => {
  it('变量表已满：保留原值并计数，绝不留下引用不存在的规则', () => {
    const input = [rule({ headerOverrides: { Authorization: TOKEN, Cookie: 'a=1' } })];
    const result = relocateHarCredentialHeaders(input, {}, 0);
    expect(result.keptRaw).toBe(2);
    expect(result.relocated).toBe(0);
    expect(result.variables).toEqual({});
    expect(result.rules[0].headerOverrides).toEqual({ Authorization: TOKEN, Cookie: 'a=1' });
  });

  it('容量只够一条时按遍历顺序装，剩下的退原值（不是整批放弃）', () => {
    const input = [rule({ headerOverrides: { Authorization: 'A', Cookie: 'B' } })];
    const result = relocateHarCredentialHeaders(input, {}, 1);
    expect(result.relocated).toBe(1);
    expect(result.keptRaw).toBe(1);
    expect(Object.keys(result.variables)).toHaveLength(1);
  });

  it('默认容量按 MAX_VARIABLES 与现有条数算', () => {
    const existing = Object.fromEntries(
      Array.from({ length: MAX_VARIABLES }, (_u, i) => [`V${i}`, `v${i}`]),
    ) as VariableStore;
    const result = relocateHarCredentialHeaders([rule({ headerOverrides: { Authorization: TOKEN } })], existing);
    expect(result.keptRaw).toBe(1);
    expect(result.variables).toEqual({});
  });

  it('空值不搬（空凭据既不是凭据也不值得占一条变量）', () => {
    const result = relocateHarCredentialHeaders([rule({ headerOverrides: { Authorization: '  ' } })], {}, 10);
    expect(result.keptRaw).toBe(0);
    expect(result.relocated).toBe(0);
    expect(result.rules[0].headerOverrides?.Authorization).toBe('  ');
  });

  it('超长的值不搬：`sanitizeVariables` 会把超长条目丢掉，那时规则已经写上引用了', () => {
    const huge = `Bearer ${'x'.repeat(MAX_VARIABLE_VALUE_LENGTH)}`;
    const input = [rule({ headerOverrides: { Authorization: huge, Cookie: 'short-cookie' } })];
    const result = relocateHarCredentialHeaders(input, {}, 10);
    expect(result.keptRaw).toBe(1);
    expect(result.relocated).toBe(1);
    expect(result.rules[0].headerOverrides?.Authorization).toBe(huge);
    expect(result.rules[0].headerOverrides?.Cookie).toMatch(/^\{\{.+\}\}$/);
    expect(Object.values(result.variables)).toEqual(['short-cookie']);
  });
});
