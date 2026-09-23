/**
 * 「这一笔为什么没走代理」归因链的单测
 *
 * 这里要钉住的是**编排**而不是判据：判据本身由 `tests/urlMatcher.test.ts`、
 * `tests/dnrRules.test.ts` 等各自守着，本支测的是「同一个现场，最先说出来的必须是哪一件」，
 * 以及**哪些话它不许说**。四组承重断言：
 * 1. **覆盖面**——每个 `DiagnosisCode` 都有一条用例走到，且顺序由断言而不是注释保证
 *    （两个成因同时成立时只有一句能出现）；
 * 2. **射程**——命中了却不生效的那几档一律交回 `noMatch`，本模块不许再算一份出口；
 * 3. **点名要保守**——「把它打开就生效」得先过这一笔自己的方法白名单，「这条模式是坏的」
 *    得先证明那句话头像是在说这个地址。宁可少说一句，也不多说一句；
 * 4. **措辞侧不漏档**——`utils/diagnosis.ts` 每加一个编码，`composables/useDiagnosis.ts`
 *    就得有一支 `case`；漏了会一路走到 `default: return ''`，界面上那句归因静默消失。
 *    唯一的例外是明写在 `SILENT_CODES` 里的那一个。
 *
 * 措辞本身（每个 key 在中英两侧都存在且非空）由 `tests/i18n.test.ts` 扫源码守卫，这里不重复。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { diagnoseRequest } from '@/utils/diagnosis';
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

/** 一条编译不过、但**话说这个地址**的正则（嵌套量词，`isRegexSafe` 必拒） */
const BROKEN_RELATED: Partial<ProxyRule> = {
  matchType: 'regex',
  matchPattern: '^https://fat-api\\.example\\.com/(a+)+$',
};

/** 一条语法就不合法、同样**话说这个地址**的正则（未闭合的捕获组） */
const SYNTAX_BROKEN_RELATED: Partial<ProxyRule> = {
  matchType: 'regex',
  matchPattern: 'https://fat-api\\.example\\.com/([',
  name: '写坏的正则',
};

/** 一条编译不过、但说的是**别处**的正则——它坏着，却与这一笔不相干 */
const BROKEN_UNRELATED: Partial<ProxyRule> = {
  matchType: 'regex',
  matchPattern: '^https://uat-old\\.internal/(b+)+$',
};

describe('diagnoseRequest —— 覆盖一切的那个全局原因先说', () => {
  it('一条规则都没有：说「没有规则」，不说「这个地址没被覆盖」', () => {
    expect(diagnoseRequest({ url: URL_HIT, rules: [], proxyEnabled: true }).code).toBe('noRules');
  });

  it('空白地址不编造成任何成因，直接按「没有规则覆盖」处理', () => {
    expect(diagnoseRequest({ url: '   ', rules: [makeRule({})], proxyEnabled: true }).code).toBe('noMatch');
  });
});

describe('diagnoseRequest —— 射程之外的三种情形，一律交回 noMatch', () => {
  it('总开关关闭：这里一个字都不说，那一句话是开关那一行自己的', () => {
    // 哪怕这一笔确实命中，也不能在这里说「规则不会生效」——那只讲了一半，
    // 而界面顶部那一行正在讲另一半。
    const diagnosis = diagnoseRequest({ url: URL_HIT, rules: [makeRule({})], proxyEnabled: false });
    expect(diagnosis.code).toBe('noMatch');
  });

  it('命中了：遮蔽、未生效、未同步那三档由界面上已有的三个出口说，这里不另算一份', () => {
    const mine = makeRule({ id: 'mine', name: '我的窄规则', matchPattern: 'https://fat-api.example.com/api/*' });
    const wide = makeRule({ id: 'wide', name: '那条宽的', priority: 1 });
    expect(diagnoseRequest({ url: URL_HIT, rules: [wide, mine], proxyEnabled: true }).code).toBe('noMatch');
  });

  it('命中且只有一条规则：同样是 noMatch，不因为「一切都好」就编出一句结论', () => {
    expect(diagnoseRequest({ url: URL_HIT, rules: [makeRule({})], proxyEnabled: true }).code).toBe('noMatch');
  });
});

describe('diagnoseRequest —— 没命中时的三档，由近到远', () => {
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

  it('坏正则报「模式没被接受」，不能报成「模式没覆盖这个地址」', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule(SYNTAX_BROKEN_RELATED)],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('patternRejected');
    expect(diagnosis.rule?.name).toBe('写坏的正则');
  });

  it('嵌套量词同样算没被接受（ReDoS 筛查会拒掉它，它永远不会命中）', () => {
    expect(diagnoseRequest({ url: URL_HIT, rules: [makeRule(BROKEN_RELATED)], proxyEnabled: true }).code).toBe(
      'patternRejected',
    );
  });

  it('禁用项比坏正则更近：两种毛病都在时先说「把它打开」', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({ id: 'bad', ...BROKEN_RELATED }), makeRule({ id: 'off', enabled: false })],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('disabledMatch');
    expect(diagnosis.rule?.id).toBe('off');
  });

  it('规则确实一条都不覆盖：这一句没有可补充的信息', () => {
    expect(
      diagnoseRequest({ url: 'https://nothing.example.com/api', rules: [makeRule({})], proxyEnabled: true }).code,
    ).toBe('noMatch');
  });
});

describe('点名要保守：宁可少说一句，也不多说一句', () => {
  it('禁用的规则只管 POST，这一笔是 GET：不说「打开即可生效」——那是半份修法', () => {
    // 「启用它」在这条规则上并不足以让这一笔走代理，点名等于把用户支到一条死路上。
    // 宁可退回 noMatch，让界面维持它本来那句「未命中」。
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      method: 'GET',
      rules: [makeRule({ name: '沉睡且只管写', enabled: false, methods: ['POST'] })],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('noMatch');
  });

  it('同一禁用规则，方法对得上（大小写不敏感）：这时才说「打开即可生效」', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      method: 'post',
      rules: [makeRule({ name: '沉睡的规则', enabled: false, methods: ['POST'] })],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('disabledMatch');
  });

  it('没传方法时不拿白名单收窄：与匹配层同一口径，「打开即可生效」依然成立', () => {
    // 反过来若在这里替用户假定一个方法，就会指着一笔根本没发生的事说「它不处理这个」。
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({ name: '沉睡的规则', enabled: false, methods: ['POST'] })],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('disabledMatch');
  });

  it('库里有一条坏正则，但说的是别处：不把它递到这一笔脸上', () => {
    // 200 条规则里某条正则坏着，与「这一笔为什么没走代理」可以毫无关系。
    // 只凭「它是坏的」就点名，等于把不相干的毛病当成这一笔的成因。
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [
        makeRule({ id: 'elsewhere', ...BROKEN_UNRELATED }),
        makeRule({ id: 'unrelated', matchPattern: 'https://other.example.com/*' }),
      ],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('noMatch');
  });

  it('地址解析不出来（还没带协议的草稿）：不点名任何坏正则', () => {
    // 连主机名都读不出，就没有任何依据说「这条规则是在讲它」。
    const diagnosis = diagnoseRequest({
      url: 'fat-api.example.com/api/users',
      rules: [makeRule(BROKEN_RELATED)],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('noMatch');
  });

  it('禁用的规则说的是别处：不拿它解释这一笔', () => {
    const diagnosis = diagnoseRequest({
      url: URL_HIT,
      rules: [makeRule({ name: '别处的沉睡规则', matchPattern: 'https://other.example.com/*', enabled: false })],
      proxyEnabled: true,
    });
    expect(diagnosis.code).toBe('noMatch');
  });
});

describe('归因是纯函数，且不替未知说话', () => {
  it('不吃调用方手里的规则，也不改它', () => {
    const rule = makeRule({});
    const snapshot = JSON.stringify(rule);
    diagnoseRequest({ url: URL_HIT, rules: [rule], proxyEnabled: true });
    expect(JSON.stringify(rule)).toBe(snapshot);
    expect(rule.enabled).toBe(true);
    expect(rule.methods).toBeUndefined();
  });

  it('说出的规则必须是传进去的那一份本身（同一引用，不是克隆）', () => {
    const disabled = makeRule({ enabled: false, name: '沉睡的规则' });
    expect(diagnoseRequest({ url: URL_HIT, rules: [disabled], proxyEnabled: true }).rule).toBe(disabled);
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

  /** 唯一不许有措辞的编码：它的意思就是「这一句没有可补充的信息」，两个界面各自在渲染前滤掉 */
  const SILENT_CODES = ['noMatch'];

  it('编码清单就是这五档（加一档会红，逼你回来补用例与措辞）', () => {
    expect(codes).toEqual(['noRules', 'disabledMatch', 'methodFiltered', 'patternRejected', 'noMatch']);
  });

  it('每个非静默编码在措辞侧都有一支 case（漏一支就是界面上静默少一句话）', () => {
    for (const code of codes.filter(item => !SILENT_CODES.includes(item))) {
      expect(wordingSrc).toContain(`case '${code}':`);
    }
  });

  it('静默编码在措辞侧没有 case，也不许有那句现成的话', () => {
    for (const code of SILENT_CODES) {
      expect(wordingSrc).not.toContain(`case '${code}':`);
      expect(wordingSrc).not.toContain(`diagnosis${code[0].toUpperCase()}${code.slice(1)}`);
    }
  });
});
