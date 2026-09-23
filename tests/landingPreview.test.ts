/**
 * 落地页「重写预演」引擎的行为守卫
 *
 * `docs/assets/preview-engine.js` 是 `utils/urlMatcher.ts` + `utils/dnrRules.ts` 的手工副本，
 * 而它面对的是读者随手填进输入框的四个字符串——画错一次就是拿产品承诺开玩笑。文本 grep
 * 拦不住「抄的时候改了个条件」这个方向（改 `endsWith('/')` 为 `includes('/')`，两边都还在，
 * 只有答案不同），所以这里按**输入 → 答案**比对：同一批规则分别喂给真实现与这份副本，
 * 逐项核 `命中与否`、`走哪条通道`、`两通道各改写成了什么`、`网络层会不会被应用`。
 *
 * 唯一被允许不同的那一项，是仓库里已接受的通道差异（正则片段替换 vs 整体替换、
 * wildcard 捕获为空时的分隔斜杠）——它不是漂移，而是这份预演存在的意义，
 * 所以断言里把它写成「差异必须为真」，而不是加一句豁免。
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import { isPatternUsable, isSimpleRule, matchRule, rewriteUrl } from '@/utils/urlMatcher';
import { buildRegexFilter, buildRegexSubstitution, isSubstitutionValid } from '@/utils/dnrRules';
import type { ProxyRule } from '@/utils/types';

/** 匹配类型在 `ProxyRule` 里是内联字面量联合，预演的用例表按同一形状取。 */
type MatchType = ProxyRule['matchType'];

const ROOT = path.resolve(__dirname, '..');

interface PreviewResult {
  usable: boolean;
  matched: boolean;
  channel: string;
  codes: string[];
  extUrl: string;
  netUrl: string | null;
  netSkip: string | null;
  diverged?: boolean;
}

/** 在沙箱里跑那份零依赖脚本，取它挂到 `window` 上的唯一出口。 */
const loadEngine = (): { preview: (input: Record<string, string>) => PreviewResult } => {
  const code = fs.readFileSync(path.join(ROOT, 'docs/assets/preview-engine.js'), 'utf-8');
  const context = vm.createContext({ window: {} as Record<string, unknown> });
  vm.runInContext(code, context);
  const exported = (context.window as { copRewritePreview?: unknown }).copRewritePreview;
  if (!exported) throw new Error('preview-engine.js 没有挂出 window.copRewritePreview');
  return exported as { preview: (input: Record<string, string>) => PreviewResult };
};

const engine = loadEngine();

/** 预演只带这三项输入，其余能力一律「没配」——与引擎注释里的边界一致。 */
const asRule = (input: { matchType: MatchType; pattern: string; target: string }): ProxyRule =>
  ({
    id: 'preview',
    name: 'preview',
    enabled: true,
    matchType: input.matchType,
    matchPattern: input.pattern,
    targetUrl: input.target,
  }) as unknown as ProxyRule;

interface Case {
  name: string;
  matchType: MatchType;
  pattern: string;
  target: string;
  url: string;
}

const CASES: Case[] = [
  {
    name: '通配符末尾 *，带非空尾部',
    matchType: 'wildcard',
    pattern: 'https://fat-api.example.com/*',
    target: 'https://uat-api.example.com',
    url: 'https://fat-api.example.com/api/user/list',
  },
  {
    name: '通配符末尾 *，捕获为空（已接受的斜杠差异）',
    matchType: 'wildcard',
    pattern: 'https://fat-api.example.com/*',
    target: 'https://uat-api.example.com',
    url: 'https://fat-api.example.com/',
  },
  {
    name: '通配符模式与目标都带结尾斜杠',
    matchType: 'wildcard',
    pattern: 'https://fat.example.com/v2/*',
    target: 'https://uat.example.com/v2/',
    url: 'https://fat.example.com/v2/users/7',
  },
  {
    name: '通配符中间 * 且末尾不是 *（必然走后台）',
    matchType: 'wildcard',
    pattern: 'https://fat.example.com/*/x',
    target: 'https://uat.example.com',
    url: 'https://fat.example.com/a/b/x',
  },
  {
    name: '通配符完全没 *',
    matchType: 'wildcard',
    pattern: 'https://fat.example.com/api',
    target: 'https://uat.example.com',
    url: 'https://fat.example.com/api',
  },
  {
    name: '通配符命中不了这个地址',
    matchType: 'wildcard',
    pattern: 'https://fat.example.com/*',
    target: 'https://uat.example.com',
    url: 'https://other.example.com/api',
  },
  {
    name: '前缀带结尾斜杠',
    matchType: 'prefix',
    pattern: 'https://fat.example.com/v2/',
    target: 'https://uat.example.com/v2/',
    url: 'https://fat.example.com/v2/users',
  },
  {
    name: '前缀不带结尾斜杠',
    matchType: 'prefix',
    pattern: 'https://fat.example.com/v2',
    target: 'https://uat.example.com',
    url: 'https://fat.example.com/v2/users?x=1',
  },
  {
    name: '前缀里的 * 是字面量',
    matchType: 'prefix',
    pattern: 'https://fat.example.com/a*b',
    target: 'https://uat.example.com',
    url: 'https://fat.example.com/a*b/c',
  },
  {
    name: '前缀不覆盖这个地址',
    matchType: 'prefix',
    pattern: 'https://fat.example.com/v3',
    target: 'https://uat.example.com',
    url: 'https://fat.example.com/v2/users',
  },
  {
    name: '正则整体替换（带捕获组）',
    matchType: 'regex',
    pattern: '^https://fat\\.example\\.com/(.*)$',
    target: 'https://uat.example.com/$1',
    url: 'https://fat.example.com/api/list',
  },
  {
    name: '正则片段替换（已接受的片段 vs 整体差异）',
    matchType: 'regex',
    pattern: 'fat\\.example\\.com',
    target: 'uat.example.com',
    url: 'https://fat.example.com/api/list',
  },
  {
    name: '正则引用了不存在的捕获组',
    matchType: 'regex',
    pattern: 'https://fat\\.example\\.com/api',
    target: 'https://uat.example.com/$1',
    url: 'https://fat.example.com/api',
  },
  {
    name: '正则语法不过',
    matchType: 'regex',
    pattern: 'https://fat\\.example\\.com/(api',
    target: 'https://uat.example.com',
    url: 'https://fat.example.com/api',
  },
  {
    name: '嵌套量词（ReDoS 筛查拦下）',
    matchType: 'regex',
    pattern: '(a+)+$',
    target: 'https://uat.example.com',
    url: 'https://fat.example.com/aaaa',
  },
  {
    name: '非捕获组与命名组的计数差异',
    matchType: 'regex',
    pattern: '^https://fat\\.example\\.com/(?:v2/)(?<rest>.*)$',
    target: 'https://uat.example.com/$2',
    url: 'https://fat.example.com/v2/users',
  },
  {
    name: '通配符两个 *，替换串引用最后一个捕获组',
    matchType: 'wildcard',
    pattern: 'https://fat.example.com/*/x*',
    target: 'https://uat.example.com',
    url: 'https://fat.example.com/a/b/x/c',
  },
  {
    name: '目标留空：只代理转发',
    matchType: 'wildcard',
    pattern: 'https://fat.example.com/*',
    target: '',
    url: 'https://fat.example.com/api',
  },
  {
    name: 'WebSocket 规则只能走后台',
    matchType: 'wildcard',
    pattern: 'wss://fat.example.com/*',
    target: 'wss://uat.example.com',
    url: 'wss://fat.example.com/socket/1',
  },
  {
    name: '模式里带正则元字符',
    matchType: 'wildcard',
    pattern: 'https://fat.example.com/a.b+c/*',
    target: 'https://uat.example.com',
    url: 'https://fat.example.com/a.b+c/x',
  },
];

describe('落地页重写预演引擎', () => {
  it('沙箱里跑得起来，且只挂一个出口', () => {
    const result = engine.preview({
      matchType: 'wildcard',
      pattern: 'https://fat.example.com/*',
      target: 'https://uat.example.com',
      url: 'https://fat.example.com/api',
    });
    expect(result.matched).toBe(true);
    expect(result.netUrl).toBe('https://uat.example.com/api');
  });

  describe('与真实现逐个答案比对', () => {
    it.each(CASES)('$name', input => {
      const rule = asRule(input);
      const result = engine.preview({ ...input });

      // 1. 模式可用性：与 `isPatternUsable` 同一句判据（只有正则那一档可能被判「不会被接受」）
      expect(result.usable, '模式可用性').toBe(isPatternUsable(rule));

      // 2. 命中与否直接问 `matchRule`
      const matched = matchRule(input.url, rule);
      expect(result.matched, '命中与否').toBe(matched);
      if (!matched) return;

      // 3. 通道：`isSimpleRule` 为真才可能进网络层
      expect(result.channel, '通道').toBe(isSimpleRule(rule) ? 'net' : 'ext');

      // 4. 后台通道的改写结果必须逐字等于 `rewriteUrl`
      expect(result.extUrl, '后台通道结果').toBe(rewriteUrl(input.url, rule));

      // 5. 网络层：要么给出地址，要么给出「不会被应用」的理由
      if (result.channel === 'ext') {
        expect(result.netUrl, '后台通道的规则没有网络层结果').toBeNull();
        expect(result.netSkip).toBe('notSimple');
        return;
      }
      const filter = buildRegexFilter(rule);
      const substitution = buildRegexSubstitution(rule);
      if (!isSubstitutionValid(filter, substitution)) {
        expect(result.netSkip, '替换引用越界时要点名').toBe('substitutionInvalid');
        expect(result.netUrl).toBeNull();
        return;
      }
      // `notUrl` 是面板自己多加的那一档（扩展侧只查捕获引用越不越界），单独在下面钉；
      // 与真实现比对的这一圈只关心「扩展会不会应用这条网络层规则」。
      expect(result.netSkip === 'notUrl' ? null : result.netSkip, '可应用的规则不该被点名').toBeNull();
      // DNR 的语义是整个地址被替换成替换串，`\1`..`\9` 取捕获组——这里独立算一遍，不复用引擎
      const groups = new RegExp(filter).exec(input.url) ?? [''];
      expect(result.netUrl, '网络层结果').toBe(
        substitution.replace(/\\([0-9])/g, (_all, ref: string) => groups[Number(ref)] ?? ''),
      );
    });
  });

  describe('换不出一个地址时不许说「已改写」', () => {
    it('正则只匹配片段：那一行照旧画出来，但点名它不是一个地址', () => {
      const result = engine.preview({
        matchType: 'regex',
        pattern: 'fat\\.example\\.com',
        target: 'uat.example.com',
        url: 'https://fat.example.com/api/list',
      });
      // 展开结果本身与真实现的语义一致——错的不是算法，是这个结果没法跳转
      expect(result.netUrl).toBe('uat.example.com');
      expect(result.netSkip).toBe('notUrl');
    });

    it('引用越界时不重复点名，两通道一致时也不点名', () => {
      const overRef = engine.preview({
        matchType: 'regex',
        pattern: 'https://fat\\.example\\.com/api',
        target: 'https://uat.example.com/$1',
        url: 'https://fat.example.com/api',
      });
      expect(overRef.netSkip).toBe('substitutionInvalid');
      const same = engine.preview({
        matchType: 'wildcard',
        pattern: 'https://fat.example.com/*',
        target: 'https://uat.example.com',
        url: 'https://fat.example.com/api',
      });
      expect(same.netSkip).toBeNull();
    });

    /**
     * 引擎能点名的理由，页面里必须有对应的那句话。
     *
     * 装配脚本挑不到措辞就不画那一行（不画空盒子），代价是**新加一个理由码却忘了配句子**
     * 在浏览器里完全没有症状。所以这里按名字逐个核，`notUrl` 例外——它的话写在结论那一格。
     */
    it('每个理由码在中英两页都有对应的句子', () => {
      for (const file of ['docs/index.html', 'docs/en.html']) {
        const html = fs.readFileSync(path.join(ROOT, file), 'utf-8');
        for (const state of ['net', 'ext', 'miss', 'rejected', 'notapplied']) {
          expect(html, `${file} 的结论缺 data-${state}`).toContain(`data-${state}="`);
        }
        for (const skip of ['notsimple', 'substitutioninvalid', 'noturl']) {
          expect(html, `${file} 的网络层那一格缺 data-skip-${skip}`).toContain(`data-skip-${skip}="`);
        }
        for (const code of ['noTarget', 'wildcardNoStar', 'websocket']) {
          expect(html, `${file} 的理由清单缺 data-code="${code}"`).toContain(`data-code="${code}"`);
        }
      }
    });
  });

  describe('差异要说出来，不是抹平', () => {
    it('通配符捕获为空：后台省掉分隔斜杠，网络层补上', () => {
      const result = engine.preview({
        matchType: 'wildcard',
        pattern: 'https://fat.example.com/*',
        target: 'https://uat.example.com',
        url: 'https://fat.example.com/',
      });
      expect(result.extUrl).toBe('https://uat.example.com');
      expect(result.netUrl).toBe('https://uat.example.com/');
      expect(result.diverged).toBe(true);
    });

    it('正则片段替换 vs 整体替换：两通道各画一行', () => {
      const result = engine.preview({
        matchType: 'regex',
        pattern: 'fat\\.example\\.com',
        target: 'uat.example.com',
        url: 'https://fat.example.com/api/list',
      });
      expect(result.extUrl).toBe('https://uat.example.com/api/list');
      expect(result.netUrl).toBe('uat.example.com');
      expect(result.diverged).toBe(true);
    });

    it('两通道一致时不谎报差异', () => {
      const result = engine.preview({
        matchType: 'wildcard',
        pattern: 'https://fat.example.com/*',
        target: 'https://uat.example.com',
        url: 'https://fat.example.com/api/list',
      });
      expect(result.netUrl).toBe(result.extUrl);
      expect(result.diverged).toBe(false);
    });
  });

  describe('走后台通道的理由码', () => {
    const codesOf = (input: Record<string, string>): string[] => engine.preview(input).codes;

    it('目标留空 / 末尾非 * / WebSocket，各点各的名', () => {
      expect(
        codesOf({
          matchType: 'wildcard',
          pattern: 'https://a.example.com/*',
          target: '',
          url: 'https://a.example.com/x',
        }),
      ).toEqual(['noTarget']);
      expect(
        codesOf({
          matchType: 'wildcard',
          pattern: 'https://a.example.com/*/x',
          target: 'https://b.example.com',
          url: 'https://a.example.com/q/x',
        }),
      ).toEqual(['wildcardNoStar']);
      expect(
        codesOf({
          matchType: 'wildcard',
          pattern: 'wss://a.example.com/*',
          target: 'wss://b.example.com',
          url: 'wss://a.example.com/1',
        }),
      ).toEqual(['websocket']);
    });

    it('WebSocket 只写在目标地址里也算', () => {
      expect(
        codesOf({
          matchType: 'prefix',
          pattern: 'https://a.example.com/',
          target: 'wss://b.example.com',
          url: 'https://a.example.com/x',
        }),
      ).toEqual(['websocket']);
    });
  });

  /** 测试地址留空：这是输入框的一格还没填完，不是一条规则的判定。 */
  it('测试地址留空时不谈命中，也不画出改写结果', () => {
    const result = engine.preview({
      matchType: 'wildcard',
      pattern: 'https://fat.example.com/*',
      target: 'https://uat.example.com',
      url: '   ',
    });
    expect(result.matched).toBe(false);
    expect(result.channel).toBe('');
    expect(result.extUrl).toBe('');
    expect(result.diverged).toBe(false);
  });

  /** 中英两页都得真的把这份判据加载进来，且顺序在装配脚本之前。 */
  it('两份落地页都按「引擎在前、装配在后」加载脚本', () => {
    for (const file of ['docs/index.html', 'docs/en.html']) {
      const html = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      const engineAt = html.indexOf('assets/preview-engine.js');
      const wiringAt = html.indexOf('assets/landing.js');
      expect(engineAt, `${file} 没有引入 preview-engine.js`).toBeGreaterThan(-1);
      expect(wiringAt, `${file} 没有引入 landing.js`).toBeGreaterThan(-1);
      expect(engineAt, `${file} 的引擎必须在装配脚本之前`).toBeLessThan(wiringAt);
    }
  });

  /**
   * 四项输入的 `data-try-*` 只能属于输入控件。
   *
   * 预设按钮曾经也写 `data-try-pattern="…"`，而 `querySelector` 取的是文档顺序里的第一个
   * 匹配——按钮排在输入框之前，于是脚本把按钮当成输入框接线：`el.value` 恒为 `undefined`，
   * 整块面板从此只按默认值算，却照样画得满满当当。属性名再撞一次就是同一场静默失效，
   * 所以这里按「带值的四个属性一律不许出现」钉住，预设改用 `data-preset-*`。
   */
  it('预设按钮与四个输入框不共用属性名', () => {
    for (const file of ['docs/index.html', 'docs/en.html']) {
      const html = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      for (const key of ['matchtype', 'pattern', 'target', 'url']) {
        expect(html, `${file} 的 data-try-${key} 带了值，会抢在输入框之前被选中`).not.toContain(`data-try-${key}="`);
      }
      const presetButtons = html.match(/data-try-preset/g)?.length ?? 0;
      const presetValues = html.match(/data-preset-(matchtype|pattern|target|url)="/g)?.length ?? 0;
      // 每个按钮带满四项；少一项就是点下去有一格不会变，而面板照样能渲染。
      expect(presetValues, `${file} 的预设值个数应是按钮数的 4 倍`).toBe(presetButtons * 4);
      expect(presetButtons, `${file} 的预设按钮数变了，中英两页要一起改`).toBe(6);
    }
  });
});
