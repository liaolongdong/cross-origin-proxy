/**
 * 规则结构闸门：`utils/ruleValidation.ts` 的 `isValidRuleShape`
 *
 * 全仓唯一一份**运行时**的「这条未知数据能不能变成生效规则」判据，两个消费者共用：导入文件
 * （`messageRouter.ts` 的 `normalizeImportedRules`）与配置恢复点的读取侧（`storage.ts` 的
 * `sanitizeConfigHistory`）。一条未知数据留不留得下来全由这五个字段判据决定（去重与 200 名额是另外
 * 两道，跟这里无关），而两处面向用户的措辞都只到条数：
 * 导入侧那句「导入完成：新增 $1 条，跳过 $2 条重复，丢弃 $3 条非法」（`importSuccessDetail`）里，
 * `invalid` 取的正是 `payload.rules.length - validRules.length`——闸门自己窄一格，界面会把它说成
 * 「文件里有 N 条非法」；恢复点侧连这一句都没有：`ruleCount` 按过滤后的条数重算，
 * `restoreConfigHistory` 把过滤后的那份原样写库并回一句「已回退到 $1 条规则」（`restoreSuccess`），
 * 少掉的不是这一句里的数字，是用户那份快照里本来有、现在拿不回来的规则。
 *
 * 为什么这支测试必须存在：改动前没有任何用例 import 过它，两个消费者的间接覆盖喂进去的取值只有
 * `wildcard`、`prefix` 和一个明显的非法值，于是 `MATCH_TYPES` 里 `'regex'` 那一格没有任何东西钉着
 * ——把整行删掉，改动前的全量测试全绿（变异 M1 实测；本支落地后它一次红五格）。表现是：用户在另一台
 * 机器导入自己的导出文件，正则规则整批不见，得到的解释是「文件里有 N 条非法」；回退恢复点同样少几条，
 * 这一次连解释都没有。`matchType: 'regex'` 在 `tests/` 里（除本支以外）出现 44 次，没有一次经过这道闸。
 *
 * 断言都按「这一格改了以后谁会受害」来选：
 * - 三种取值逐个过闸，并在**两个消费者各自的行为上**再钉一遍（只看谓词钉不住「消费者不再调它」）。
 * - 四个字符串字段逐个缺、逐个换成非字符串：缺字段的规则落库后，DNR 同步与拦截器拿到的是 `undefined`
 *   的 pattern，所以这里必须是「拦下」而不是「补个默认值」。
 * - `matchType` 精确匹配（大小写敏感、不认识的新取值拦下）：加第四种取值是一次**成套改齐**的动作——
 *   白名单之外还有类型联合、表单 radio、表格的 tag 类型与案名两套映射、筛选下拉的选项，再加中英两套
 *   案名键，末尾那三条契约把「少改一处」变成会红的改动。
 *
 * 两条**现状记录**，不是验收（各自点名了要收口得先拍的那件事），修的时候它们会红，
 * 请连同这段注释一起更新，别只删断言：空串过闸（表单要求 `name`/`matchPattern` 必填，文件通道不要，
 * 收口会把今天算作合法的那几条挪进「丢弃 N 条非法」）、未知字段原样进 storage。
 *
 * `if (!rule || typeof rule !== 'object')` 里那半**不承重**，且刻意不为它补断言：JSON.parse 与
 * `storage.local` 能产出的输入里，函数、symbol 与带齐那五个属性的原始值都不存在，摘掉那半（M6）
 * 全绿就是这件事的证据。别把它当闸门依赖，也别指望有测试替它说话。
 *
 * 刻意没钉的两处：`enabled` / `priority` / 时间戳的归一化与 id 重生成（判据只看形状，那半住在
 * `normalizeImportedRules`，已由 `tests/round2-regression.test.ts` 逐条钉住）；头名与 CRLF 清洗
 * （`utils/headerValidation.ts`，由 `tests/requestGuard.test.ts` 与导入侧用例钉）。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isValidRuleShape } from '@/utils/ruleValidation';
import { isSimpleRule, matchRule, rewriteUrl } from '@/utils/urlMatcher';
import { buildDnrRules } from '@/utils/dnrRules';
import { ruleMergeKey } from '@/utils/ruleConflicts';
import type { ProxyRule } from '@/utils/types';

// 存储门面与被导入模块在加载时就挂 `chrome.storage.onChanged` 监听，桩必须先装（与 configHistory 同一写法）。
vi.stubGlobal('chrome', {
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) }, onChanged: { addListener: vi.fn() } },
});

const { normalizeImportedRules } = await import('@/entrypoints/background/messageRouter');
const { sanitizeConfigHistory } = await import('@/utils/storage');

/** 形状判据只看五个字段，所以这份夹具刻意不带 `enabled` / `priority`——带着反而会让人以为那两个也过闸 */
function shape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    name: 'fat-to-uat',
    matchPattern: 'https://fat.example.com/*',
    targetUrl: 'https://uat.example.com',
    matchType: 'wildcard',
    ...overrides,
  };
}

/** 正则规则的原文：两个消费者吃的都是 `unknown[]`，所以这份夹具不必假装是 `ProxyRule` */
function regexRule(): Record<string, unknown> {
  return shape({
    matchType: 'regex',
    matchPattern: '^https://fat\\.example\\.com/(.*)$',
    targetUrl: 'https://uat.example.com/$1',
  });
}

/** 一份恢复点快照（`sanitizeConfigHistory` 的入参形状），规则原文按手改数据对待 */
function snapshot(rules: unknown[]): Record<string, unknown> {
  return {
    id: 'h1',
    savedAt: 1700000000000,
    reason: 'replace-import',
    ruleCount: 99,
    config: { enabled: true, rules },
  };
}

/** 从 `utils/ruleValidation.ts` 的源码里取白名单本身——这是四份并行清单里唯一那份运行时的 */
function declaredMatchTypes(): string[] {
  const src = readFileSync('utils/ruleValidation.ts', 'utf-8');
  const list = src.match(/const MATCH_TYPES: readonly string\[\] = \[([^\]]*)\]/);
  // 锚点被改名或整行被删，等于契约失效，不能被下面比较集合时悄悄放过去
  expect(list, 'MATCH_TYPES 的字面量数组找不到，同步契约已失效').not.toBeNull();
  return [...(list as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

const SOURCE_DIRS = ['utils', 'entrypoints', 'components', 'composables'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|vue)$/.test(entry) ? [full] : [];
  });
}

describe('isValidRuleShape — 三种匹配类型逐个过闸', () => {
  it('wildcard / prefix / regex 都算合法形状', () => {
    for (const matchType of ['wildcard', 'prefix', 'regex']) {
      expect(isValidRuleShape(shape({ matchType })), matchType).toBe(true);
    }
  });

  it('导入侧真的把正则规则留在导回来的那一份里（`$1` 一个字符都不能动）', () => {
    // 混一条非法的进来：只喂合法数据的话，「消费者不再调这道闸」在本用例上是测不出来的
    const out = normalizeImportedRules([regexRule(), { id: 'no-shape', name: 'x' }]);
    expect(out).toHaveLength(1);
    const [imported] = out;
    expect(imported.matchType).toBe('regex');
    // 这两格是正则规则的全部价值：模式与替换引用被「顺手规范」一下，重写结果就不再是用户写的那个
    expect(imported.matchPattern).toBe('^https://fat\\.example\\.com/(.*)$');
    expect(imported.targetUrl).toBe('https://uat.example.com/$1');
  });

  it('恢复点侧同样收三种类型，`ruleCount` 按过滤后的条数算', () => {
    // 「逐条过滤 + 重算 ruleCount」那半 `tests/configHistory.test.ts` 已钉；这里加的是三种取值都收
    const [entry] = sanitizeConfigHistory([
      snapshot([regexRule(), shape(), shape({ id: 'r3', matchType: 'prefix' }), { id: 'no-pattern', name: 'x' }]),
    ]);
    expect(entry.ruleCount).toBe(3);
    expect(entry.config.rules.map(r => r.matchType)).toEqual(['regex', 'wildcard', 'prefix']);
  });
});

describe('isValidRuleShape — 拦下的是形状，不是它不认识的取值', () => {
  it('四个字符串字段缺任一都拦，且「值为 undefined」与「键不存在」同罪', () => {
    for (const key of ['id', 'name', 'matchPattern', 'targetUrl']) {
      const missing = shape();
      delete missing[key];
      expect(isValidRuleShape(missing), `缺 ${key}`).toBe(false);
      expect(isValidRuleShape({ ...shape(), [key]: undefined }), `${key}: undefined`).toBe(false);
    }
    expect(isValidRuleShape({ id: 'x', name: 'n', matchType: 'wildcard' })).toBe(false);
  });

  it('字段在但类型不对同样拦（数字 id、对象 pattern、非对象输入）', () => {
    expect(isValidRuleShape(shape({ id: 123 }))).toBe(false);
    expect(isValidRuleShape(shape({ matchPattern: 42 }))).toBe(false);
    expect(isValidRuleShape(shape({ matchPattern: {} }))).toBe(false);
    expect(isValidRuleShape(shape({ targetUrl: ['https://a'] }))).toBe(false);
    expect(isValidRuleShape(null)).toBe(false);
    expect(isValidRuleShape('https://a.com/*')).toBe(false);
    // 数组的四个键全是 undefined，但它 `typeof === 'object'`，这里要看到的是 false 而不是抛
    expect(isValidRuleShape([shape()])).toBe(false);
    expect(isValidRuleShape(() => 1)).toBe(false);
  });

  it('matchType 精确匹配：大小写不对、不认识的新取值一律拦', () => {
    expect(isValidRuleShape(shape({ matchType: 'REGEX' }))).toBe(false);
    expect(isValidRuleShape(shape({ matchType: 'Wildcard' }))).toBe(false);
    expect(isValidRuleShape(shape({ matchType: 'exact' }))).toBe(false);
    expect(isValidRuleShape(shape({ matchType: undefined }))).toBe(false);
    // 枚举没有一份「什么都不认」的失败模式：白名单若被清空，三种类型会一起变非法
    expect(declaredMatchTypes().length).toBeGreaterThanOrEqual(3);
  });
});

describe('现状记录 — 这道闸只管形状，内容交给下游各自判断', () => {
  it('空串过闸：落库以后是一条启用着、却什么都匹配不到的规则', () => {
    // 表单侧 `name` 与 `matchPattern` 都是 required（`RuleFormDialog.vue` 的 formRules），文件通道不要求。
    // 要收口得先拍：拦空串会让「导入 N 条」的 N 变小，属于改行为。
    expect(isValidRuleShape(shape({ matchPattern: '', targetUrl: '' }))).toBe(true);
    expect(normalizeImportedRules([shape({ matchPattern: '', targetUrl: '' })])).toHaveLength(1);

    // 直接 cast 一份过闸后的规则：真实管道还会补 priority 与时间戳，那两格与本用例无关
    const blank = { ...shape({ matchPattern: '' }), enabled: true } as ProxyRule;
    expect(matchRule('https://whatever.com/x', blank)).toBe(false);
    expect(rewriteUrl('https://whatever.com/x', blank)).toBe('https://whatever.com/x');
    // 空 pattern 的 wildcard 判不成简单规则，于是 DNR 侧编译不出规则、后台通道的匹配判据也认不到它：
    // 它占一个 200 名额、界面上像条规则，却什么都匹配不到。
    expect(isSimpleRule(blank)).toBe(false);
    expect(buildDnrRules([blank], true).rules).toEqual([]);
    // 合并键取的是原文，所以两条空 pattern 的同名规则会被当成同一条
    expect(ruleMergeKey(blank)).toBe('fat-to-uat::');
  });

  it('判据不认识也不拒绝额外字段，它们跟着 `...rule` 一路进 storage', () => {
    const [imported] = normalizeImportedRules([shape({ fromANewerVersion: 7 })]);
    expect(imported).toHaveProperty('fromANewerVersion', 7);
    const [entry] = sanitizeConfigHistory([snapshot([shape({ fromANewerVersion: 7 })])]);
    expect(entry.config.rules[0]).toHaveProperty('fromANewerVersion', 7);
    // 「按未知键整体拒绝」不是更安全的那个方向：v2 文件多写一个字段，v1 就会一条都导不进来。
    // `isSchemaTooNew` 已经在版本层拒掉更新的导出文件，这里放过的是同版本多余字段与手改文件。
  });
});

describe('同步契约 — 判据只有一份，取值集那几份并列清单对得上', () => {
  it('两个消费者各自调用这道闸，全仓没有第二份手写形状判据', () => {
    for (const file of ['utils/storage.ts', 'entrypoints/background/messageRouter.ts']) {
      expect(readFileSync(file, 'utf-8'), file).toContain('.filter(isValidRuleShape)');
    }
    // 抄一份判据进新消费者，比调用它更容易（也就更常发生）：那份字面量判据只允许存在于判据文件里。
    // 空数组同样是红——判据原文被改写或搬走时，这条契约的锚点就没了，得回来重认一次。
    const reimplementations = SOURCE_DIRS.flatMap(dir => sourceFiles(dir)).filter(file =>
      readFileSync(file, 'utf-8').includes("matchPattern === 'string'"),
    );
    expect(reimplementations, '这条同步契约的锚点数量不对，看数组是多了（有人抄了一份）还是少了').toEqual([
      'utils/ruleValidation.ts',
    ]);
  });

  it('白名单与类型联合、表单 radio、表格两套映射、筛选下拉是同一套取值', () => {
    const whitelist = declaredMatchTypes().slice().sort();

    const typesSrc = readFileSync('utils/types.ts', 'utf-8');
    const unionLine = typesSrc.match(/^\s*matchType: (.*)$/m);
    expect(unionLine, 'utils/types.ts 里那行 matchType 联合类型找不到').not.toBeNull();
    const union = [...(unionLine as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();

    const formSrc = readFileSync('components/options/RuleFormDialog.vue', 'utf-8');
    const radioGroup = formSrc.match(/v-model="form\.matchType">([\s\S]*?)<\/el-radio-group>/);
    expect(radioGroup, '表单那组 matchType radio 找不到').not.toBeNull();
    const radios = [...(radioGroup as RegExpMatchArray)[1].matchAll(/value="([^"]+)"/g)].map(m => m[1]).sort();

    const tableSrc = readFileSync('components/options/RuleTable.vue', 'utf-8');
    const tagMap = tableSrc.match(/const MATCH_TYPE_TAG_TYPES[^=]*= \{([\s\S]*?)\};/);
    expect(tagMap, 'RuleTable 的 MATCH_TYPE_TAG_TYPES 找不到').not.toBeNull();
    const tags = [...(tagMap as RegExpMatchArray)[1].matchAll(/^\s*(\w+):/gm)].map(m => m[1]).sort();

    // 案名那一套漏一格的代价是 `labelMap[matchType] || matchType` 掉到兜底：用户直接看到 "regex"
    const labelMap = tableSrc.match(/const labelMap[^=]*= \{([\s\S]*?)\};/);
    expect(labelMap, 'RuleTable 的 matchTypeLabel labelMap 找不到').not.toBeNull();
    const labels = [...(labelMap as RegExpMatchArray)[1].matchAll(/^\s*(\w+):/gm)].map(m => m[1]).sort();

    const filterSrc = readFileSync('components/options/SearchFilterBar.vue', 'utf-8');
    const optionsBlock = filterSrc.match(/class="match-type-select"[\s\S]*?<\/el-select>/);
    expect(optionsBlock, 'SearchFilterBar 那个按匹配类型筛选的下拉找不到').not.toBeNull();
    const options = [...(optionsBlock as RegExpMatchArray)[0].matchAll(/^\s+value="([^"]+)"/gm)].map(m => m[1]).sort();

    expect(union).toEqual(whitelist);
    expect(radios).toEqual(whitelist);
    expect(tags).toEqual(whitelist);
    expect(labels).toEqual(whitelist);
    expect(options).toEqual(whitelist);
  });

  it('每个取值都有中英两套案名（表格标签与表单 radio 各读一个键）', () => {
    const zh = JSON.parse(readFileSync('locales/zh_CN/options.json', 'utf-8')) as Record<string, string>;
    const en = JSON.parse(readFileSync('locales/en/options.json', 'utf-8')) as Record<string, string>;
    const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);
    for (const value of declaredMatchTypes()) {
      for (const [locale, dict] of [
        ['zh_CN', zh],
        ['en', en],
      ] as const) {
        // 少一个键不是「少一句翻译」那么轻：`RuleTable` 的 labelMap 拿 `t()` 的返回值建索引，
        // 缺键时界面直接掉回原始取值（用户看到 "regex" 而不是「正则」）。
        expect(dict[`matchType${cap(value)}`], `${locale} 少了 ${value} 的列表案名`).toBeTruthy();
        expect(dict[`matchType${cap(value)}Full`], `${locale} 少了 ${value} 的表单案名`).toBeTruthy();
      }
    }
  });
});
