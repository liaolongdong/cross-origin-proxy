/**
 * 「这一笔为什么没走代理」归因链的单测
 *
 * 这里要钉住的是**编排**而不是判据：判据本身由 `tests/urlMatcher.test.ts`、
 * `tests/dnrSupport.test.ts` 等各自守着，本支测的是「同一个现场，最先说出来的必须是哪一件」。
 * 三组承重断言：
 * 1. **覆盖面**——每个 `DiagnosisCode` 都有一条用例走到，且顺序由断言而不是注释保证
 *    （两个成因同时成立时只有一句能出现）；
 * 2. **不替未知说话**——`dnrSkipped` / `pageSynced` 没传就必须跳过那一档，
 *    绝不能落到「一切正常」，这是这类聚合界面最容易撒谎的地方；
 * 3. **措辞侧不漏档**——`utils/diagnosis.ts` 每加一个编码，`composables/useDiagnosis.ts`
 *    就得有一支 `case`；漏了会一路走到 `default: return ''`，界面上那句归因静默消失。
 *
 * 措辞本身（每个 key 在中英两侧都存在且非空）由 `tests/i18n.test.ts` 扫源码守卫，这里不重复。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { diagnoseRequest } from '@/utils/diagnosis';
import type { DnrSkipReason } from '@/utils/dnrSupport';
import type { ProxyRule } from '@/utils/types';

/**
 * 夹具：每条规则都领一个新的 `updatedAt`
 *
 * `findMatchingRule` 内部有一层「按 `长度 + 每条 id:updatedAt` 缓存排序结果」的缓存
 * （`utils/urlMatcher.ts` 的 `buildRulesKey`），而 key **不含 `enabled`**。跨用例复用同一个
 * `id:updatedAt` 会读到上一支用例那份规则集——表现是断言拿到一条压根没传进去的规则。
 * 真实数据里 `updatedAt` 随每次修改前进，所以这是夹具的问题，不是实现的坑；
 * 但新增归因档位时若嫌麻烦想直接 `makeRule({...})` 复用默认 id，请记住这一行。
 */
let fixtureSeq = 0;

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  fixtureSeq += 1;
  return {
    id: 'r1',
    name: '规则一',
    enabled: true,
    matchType: 'wildcard',
    matchPattern: 'https://fat-api.example.com/*',
    targetUrl: 'https://uat-api.example.com/*',
    priority: 10,
    createdAt: 0,
    updatedAt: fixtureSeq,
    ...overrides,
  };
}

const URL_HIT = 'https://fat-api.example.com/api/users';

describe('diagnoseRequest —— 全局那两个覆盖一切的原因先说', () => {
  it('一条规则都没有：说「没有规则」，不说「这个地址没被覆盖」', () => {
    expect(diagnoseRequest({ url: URL_HIT, rules: [], proxyEnabled: true }).code).toBe('noRules');
  });

  it('总开关关闭：哪怕地址确实命中一条规则，也先说开关', () => {
    const diagnosis = diagnoseRequest({ url: URL_HIT, rules: [makeRule({})], proxyEnabled: false });
    expect(diagnosis.code).toBe('proxyDisabled');
  });

  it('空白地址不编造成任何成因，直接按「没有规则覆盖」处理', () => {
    expect(diagnoseRequest({ url: '   ', rules: [makeRule({})], proxyEnabled: true }).code).toBe('noMatch');
  });
});

describe('diagnoseRequest —— 命中了却说得出「为什么不生效」', () => {
  const dnrSkipped = (reason: DnrSkipReason, id = 'r1') => new Map<string, DnrSkipReason>([[id, reason]]);

  it('规则会应用、页面也已同步：一切正常，并说清走的是哪条通道', () => {
    const hit = diagnoseRequest({ url: URL_HIT, rules: [makeRule({})], proxyEnabled: true });
    expect(hit.code).toBe('ok');
    expect(hit.channel).toBe('dnr');
    expect(hit.rule?.name).toBe('规则一');

    const complex = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({ id: 'r2', matchPattern: 'https://fat-api.example.com/*', headerOverrides: { 'x-a': '1' } })],
      proxyEnabled: true,
    });
    expect(complex.code).toBe('ok');
    expect(complex.channel).toBe('sw');
  });

  it('浏览器不会应用这条网络层规则：这是第一答案，哪怕界面画着「已启用」', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({})],
      proxyEnabled: true,
      dnrSkipped: dnrSkipped('regexUnsupported'),
    });
    expect(diagnosis.code).toBe('ruleNotApplied');
    expect(diagnosis.rule?.id).toBe('r1');
  });

  it('后台通道的规则不在 dnrSkipped 的适用范围里：那份账只说网络层，不能拿来判复杂规则', () => {
    const complex = makeRule({ id: 'r9', headerOverrides: { 'x-a': '1' } });
    expect(
      diagnoseRequest({
        url: URL_HIT,
        rules: [complex],
        proxyEnabled: true,
        dnrSkipped: dnrSkipped('regexUnsupported', 'r9'),
      }).code,
    ).toBe('ok');
  });

  it('这一页还没收到最新配置：规则没问题，说的是页面', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({})],
      proxyEnabled: true,
      pageSynced: false,
    });
    expect(diagnosis.code).toBe('pageNotSynced');
  });

  it('未生效排在未同步之前：一句只说最该先知道的那件事', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({})],
      proxyEnabled: true,
      dnrSkipped: dnrSkipped('substitutionInvalid'),
      pageSynced: false,
    });
    expect(diagnosis.code).toBe('ruleNotApplied');
  });

  it('用户心里那条规则被更高优先级抢走：点名两条规则，各自是谁', () => {
    const mine = makeRule({ id: 'mine', name: '我的窄规则', matchPattern: 'https://fat-api.example.com/api/*' });
    const wide = makeRule({ id: 'wide', name: '那条宽的', priority: 1 });
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [wide, mine],
      proxyEnabled: true,
      expectedRuleId: 'mine',
    });
    expect(diagnosis.code).toBe('shadowedBy');
    expect(diagnosis.rule?.name).toBe('我的窄规则');
    expect(diagnosis.blocker?.name).toBe('那条宽的');
  });

  it('没给 expectedRuleId 就不谈遮蔽：那句「被抢走」只在用户确实指向某条规则时才说', () => {
    const mine = makeRule({ id: 'mine', matchPattern: 'https://fat-api.example.com/api/*' });
    const wide = makeRule({ id: 'wide', priority: 1 });
    expect(diagnoseRequest({ url: URL_HIT, rules: [wide, mine], proxyEnabled: true }).code).toBe('ok');
  });

  it('心里那条压根不覆盖这个地址：不谎报遮蔽，老老实实说命中了别的', () => {
    const unrelated = makeRule({ id: 'other', matchPattern: 'https://elsewhere.example.com/*' });
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({ id: 'wide' }), unrelated],
      proxyEnabled: true,
      expectedRuleId: 'other',
    });
    expect(diagnosis.code).toBe('ok');
    expect(diagnosis.rule?.id).toBe('wide');
  });
});

describe('diagnoseRequest —— 没命中时的四档，由近到远', () => {
  it('模式覆盖但它被禁用：说的是这条规则，不是「没有规则」', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({ name: '沉睡的规则', enabled: false })],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('disabledMatch');
    expect(diagnosis.rule?.name).toBe('沉睡的规则');
  });

  it('方法白名单挡下这一笔：点名那条规则与它自己声明的方法', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      method: 'GET',
      rules: [makeRule({ name: '只管写', methods: ['POST', 'PUT'] })],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('methodFiltered');
    expect(diagnosis.rule?.methods).toEqual(['POST', 'PUT']);
  });

  it('没传方法时不编造「方法被过滤」：按匹配层的同一口径说「会命中」', () => {
    // 与 `matchRule` 完全一致：没有方法信息就不拿白名单去收窄，于是这一档压根不该出现。
    // 反过来若在这里替用户假定一个方法，界面上就会指着一笔根本没发生的事说「方法不对」。
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({ name: '只管写', methods: ['POST'] })],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('ok');
    expect(diagnosis.rule?.methods).toEqual(['POST']);
  });

  it('坏正则报「模式没被接受」，不能报成「模式没覆盖这个地址」', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({ matchType: 'regex', matchPattern: '([', name: '写坏的正则' })],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('patternRejected');
    expect(diagnosis.rule?.name).toBe('写坏的正则');
  });

  it('嵌套量词同样算没被接受（ReDoS 筛查会拒掉它，它永远不会命中）', () => {
    expect(
      diagnoseRequest({
        url: URL_HIT,
        rules: [makeRule({ matchType: 'regex', matchPattern: '(a+)+$' })],
        proxyEnabled: true,
      }).code,
    ).toBe('patternRejected');
  });

  it('禁用项比坏正则更近：两种毛病都在时先说「把它打开」', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [
        makeRule({ id: 'bad', matchType: 'regex', matchPattern: '(a+)+$' }),
        makeRule({ id: 'off', enabled: false }),
      ],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('disabledMatch');
    expect(diagnosis.rule?.id).toBe('off');
  });

  it('规则确实一条都不覆盖：这才说「没有规则覆盖这个地址」', () => {
    expect(
      diagnoseRequest({ url: 'https://nothing.example.com/api', rules: [makeRule({})], proxyEnabled: true }).code,
    ).toBe('noMatch');
  });
});

describe('diagnoseRequest —— 「不知道」绝不写成「没问题」', () => {
  it('dnrSkipped 没传与传了空表，结果同为 ok：判定缺席不等于规则有问题', () => {
    const rules = [makeRule({})];
    expect(diagnoseRequest({ url: URL_HIT, rules, proxyEnabled: true }).code).toBe('ok');
    expect(diagnoseRequest({ url: URL_HIT, rules, proxyEnabled: true, dnrSkipped: new Map() }).code).toBe('ok');
    // 别的规则被跳过，不影响这一笔的结论
    const otherSkipped = new Map<string, DnrSkipReason>([['elsewhere', 'regexUnsupported']]);
    expect(diagnoseRequest({ url: URL_HIT, rules, proxyEnabled: true, dnrSkipped: otherSkipped }).code).toBe('ok');
  });

  it('pageSynced 为 undefined 时不等于 false：不凭空警告「这一页没同步」', () => {
    for (const pageSynced of [undefined, true]) {
      expect(diagnoseRequest({ url: URL_HIT, rules: [makeRule({})], proxyEnabled: true, pageSynced }).code).toBe('ok');
    }
  });

  it('没命中时送达账不参与：那一档说的是「命中了却不生效」', () => {
    expect(
      diagnoseRequest({
        url: 'https://nothing.example.com/api',
        rules: [makeRule({})],
        proxyEnabled: true,
        pageSynced: false,
      }).code,
    ).toBe('noMatch');
  });

  it('归因是纯函数：不吃调用方手里的规则，也不改它', () => {
    const rule = makeRule({});
    const snapshot = JSON.stringify(rule);
    diagnoseRequest({ url: URL_HIT, rules: [rule], proxyEnabled: true });
    expect(JSON.stringify(rule)).toBe(snapshot);
    expect(rule.enabled).toBe(true);
    expect(rule.methods).toBeUndefined();
  });
});

describe('判据与措辞必须成对：编码不能没有那句话', () => {
  const diagnosisSrc = readFileSync('utils/diagnosis.ts', 'utf-8');
  const wordingSrc = readFileSync('composables/useDiagnosis.ts', 'utf-8');

  const typeBlock = diagnosisSrc.slice(
    diagnosisSrc.indexOf('export type DiagnosisCode'),
    diagnosisSrc.indexOf('/** 归因的输入'),
  );
  const codes = [...typeBlock.matchAll(/^\s*\|\s*'(\w+)'/gm)].map(match => match[1]);

  it('编码清单不为空（正则一旦失配，下面的断言就是空转）', () => {
    expect(codes.length).toBeGreaterThanOrEqual(10);
    expect(codes).toContain('patternRejected');
  });

  it('每个编码在措辞侧都有一支 case（漏一支就是界面上静默少一句话）', () => {
    for (const code of codes) {
      expect(wordingSrc).toContain(`case '${code}':`);
    }
  });
});
