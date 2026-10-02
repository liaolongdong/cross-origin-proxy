/**
 * 「这一页哪些来源像是被 CORS 拦下了」——判据、装配，与两份手工副本
 *
 * 承重面按「这个功能会不会对用户说谎」来排：
 * 1. 判据（`parseCorsSuspects`）——非法项逐条丢弃、口径只认归一化后的 http(s) origin、笔数与来源数
 *    都有上界。漏任何一条，界面上就会出现一个点不动的地址或一句画不出来的数。
 * 2. 装配（`buildPickerRows`）——带标记的行必须在最前，且**永远不会被无标记的行挤掉**；
 *    只在疑似那侧的来源也要成行（资源计时读不到不等于没报过错）。
 * 3. 两份手工副本——MAIN world 那份常量与 origin 判据、以及「观测只挂在没有规则的那条路径上」
 *    与「fetch 那条路径一行都没动」。最后这组最要紧：给 fetch 挂拒绝处理器会**削掉页面自己的
 *    `unhandledrejection`**，那是 Sentry 一类前端监控唯一的上报口，代价远超一个显示用的读数。
 *
 * 本环境测不到的两件事（node 无 DOM，`jsdom` / `@vue/test-utils` 未装）：
 * 真实 XHR 的 `error` 事件形状，与那一列行在 320px 里的排版。前者按源码契约钉，
 * 后者只能在真浏览器里目测（见交付说明）。
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { MessageType } from '@/utils/types';
import {
  CORS_SUSPECTS,
  CORS_SUSPECT_LIMIT,
  CORS_SUSPECT_MAX_COUNT,
  CORS_SUSPECT_CACHE_SIZE,
  PAGE_CORS_PROBE,
} from '@/utils/constants';
import { buildPickerRows, parseCorsSuspects } from '@/utils/corsSuspects';

const A = 'https://a.example.com';
const B = 'https://b.example.com';
const C = 'https://c.example.com';

describe('parseCorsSuspects：非法项逐条丢弃，合法项照单收下', () => {
  it('正常回包原样收下并按笔数降序', () => {
    expect(
      parseCorsSuspects({
        suspects: [
          { origin: A, count: 1 },
          { origin: B, count: 5 },
        ],
      }),
    ).toEqual([
      { origin: B, count: 5 },
      { origin: A, count: 1 },
    ]);
  });

  it('不是 `{ suspects: [...] }` 的形状一律当没读到（后台信封、别的扩展抢答、字符串）', () => {
    for (const value of [undefined, null, {}, [], 'nope', { suspects: {} }, { suspects: 'x' }, { origins: [] }]) {
      expect(parseCorsSuspects(value)).toEqual([]);
    }
  });

  it('一条非法项只丢它自己，不牵连其余（候选行彼此无关，与那四个必须整包丢弃的计数不同）', () => {
    const packet = {
      suspects: [null, 7, 'x', { origin: A }, { count: 3 }, { origin: 42, count: '3' }, { origin: B, count: 2 }],
    };
    expect(parseCorsSuspects(packet)).toEqual([{ origin: B, count: 2 }]);
  });

  it('origin 必须**本身就是一个归一化后的 http(s) origin**：带路径/查询的把那些内容一起丢', () => {
    // 路径与查询串常带 id、token；它们不该画到界面上，更不该跟着下一次点击进 Options
    expect(parseCorsSuspects({ suspects: [{ origin: `${A}/api/users?token=secret`, count: 2 }] })).toEqual([]);
    for (const origin of [
      'http://localhost',
      'chrome-extension://other',
      'ws://a.example.com',
      'null',
      '//a.example.com',
    ]) {
      const rows = parseCorsSuspects({ suspects: [{ origin, count: 2 }] });
      expect(rows.map(r => r.origin)).toEqual(origin === 'http://localhost' ? ['http://localhost'] : []);
    }
  });

  it('笔数必须是有限正数；小数向下取整，越界钳制而不是丢弃', () => {
    expect(parseCorsSuspects({ suspects: [{ origin: A, count: 2.7 }] })).toEqual([{ origin: A, count: 2 }]);
    for (const count of [0, -1, NaN, Infinity, '3', null, undefined]) {
      expect(parseCorsSuspects({ suspects: [{ origin: A, count }] })).toEqual([]);
    }
    expect(parseCorsSuspects({ suspects: [{ origin: A, count: 5000 }] })).toEqual([
      { origin: A, count: CORS_SUSPECT_MAX_COUNT },
    ]);
  });

  it('同一来源重复出现取最大笔数，不重复成两行', () => {
    expect(
      parseCorsSuspects({
        suspects: [
          { origin: A, count: 3 },
          { origin: A, count: 1 },
          { origin: A, count: 9 },
        ],
      }),
    ).toEqual([{ origin: A, count: 9 }]);
  });

  it('并列笔数按 origin 升序（Map 的插入序随页面加载顺序变化，不稳定排序会把换序画成界面在抖动）', () => {
    const shuffled = {
      suspects: [
        { origin: C, count: 4 },
        { origin: A, count: 4 },
        { origin: B, count: 4 },
      ],
    };
    expect(parseCorsSuspects(shuffled).map(row => row.origin)).toEqual([A, B, C]);
  });

  it('来源数与伪造包都有上界：一万个不同来源也只留 CORS_SUSPECT_CACHE_SIZE 个', () => {
    const flood = {
      suspects: Array.from({ length: 10_000 }, (_, i) => ({ origin: `https://p${i}.example.com`, count: 1 })),
    };
    expect(parseCorsSuspects(flood)).toHaveLength(CORS_SUSPECT_CACHE_SIZE);
  });

  it('越界的伪造包留的是**最先见到的那几个**（写端就地收口，不是排完序再截）', () => {
    // 合法包永远到不了这一档（MAIN world 自己就只累计 CORS_SUSPECT_CACHE_SIZE 个来源），
    // 所以这条钉的是收口发生在哪一侧：把那句 `counts.size >= CAP` 的早退挪掉，剩下的是
    // 「笔数最大（并列则 origin 最小）的那几个」——两种都自洽，但只有一种是这里承诺过的。
    const flood = {
      suspects: Array.from({ length: CORS_SUSPECT_CACHE_SIZE + 3 }, (_, i) => ({
        origin: `https://p${i}.example.com`,
        count: i === CORS_SUSPECT_CACHE_SIZE + 2 ? 9 : 1,
      })),
    };
    expect(parseCorsSuspects(flood).map(row => row.origin)).toEqual(
      Array.from({ length: CORS_SUSPECT_CACHE_SIZE }, (_, i) => `https://p${i}.example.com`),
    );
  });

  it('卡片那句总数的口径 = 面板里带标记的行数：读端那一档不得高过显示那一档', () => {
    // 一旦 CACHE_SIZE > LIMIT，「检测到 N 个来源」就会画出用户数不出来的 N（被挤掉的是带标记的行）。
    expect(CORS_SUSPECT_CACHE_SIZE).toBeLessThanOrEqual(CORS_SUSPECT_LIMIT);
  });
});

describe('buildPickerRows：两份读数拼成一列，标记行永远在最前', () => {
  it('没有疑似时就是原来那一列（旧行为一字不动）', () => {
    const choices = [
      { origin: A, count: 5 },
      { origin: B, count: 2 },
    ];
    expect(buildPickerRows(choices, [])).toEqual([
      { origin: A, count: 5, suspect: 0 },
      { origin: B, count: 2, suspect: 0 },
    ]);
  });

  it('带标记的行排在最前，即使它的请求条数最少', () => {
    const rows = buildPickerRows(
      [
        { origin: A, count: 99 },
        { origin: B, count: 1 },
      ],
      [{ origin: B, count: 1 }],
    );
    expect(rows.map(row => row.origin)).toEqual([B, A]);
    expect(rows[0]).toEqual({ origin: B, count: 1, suspect: 1 });
  });

  it('只在疑似那侧的来源照样成行，条数记 0（计时记录读不到不等于没报过错）', () => {
    expect(buildPickerRows([{ origin: A, count: 3 }], [{ origin: B, count: 2 }])).toEqual([
      { origin: B, count: 0, suspect: 2 },
      { origin: A, count: 3, suspect: 0 },
    ]);
  });

  it('同一来源不会出现在两行里（候选与疑似交集只留一行，带上两份数）', () => {
    const rows = buildPickerRows([{ origin: A, count: 7 }], [{ origin: A, count: 2 }]);
    expect(rows).toEqual([{ origin: A, count: 7, suspect: 2 }]);
  });

  it('行数收在 CORS_SUSPECT_LIMIT，且被挤掉的只可能是没有标记的行', () => {
    // 候选那一侧故意超出那一档，逼出「挤掉」这件事；被挤的必须是 suspect === 0 的那些行
    const choices = Array.from({ length: CORS_SUSPECT_LIMIT + 4 }, (_, i) => ({
      origin: `https://c${i}.example.com`,
      count: 50 - i,
    }));
    const suspects = [
      { origin: 'https://s1.example.com', count: 1 },
      { origin: 'https://s2.example.com', count: 1 },
    ];
    const rows = buildPickerRows(choices, suspects);
    expect(rows).toHaveLength(CORS_SUSPECT_LIMIT);
    expect(rows.filter(row => row.suspect > 0)).toHaveLength(suspects.length);
  });

  it('满档疑似时一个标记都不吞（读端那一档就是显示那一档）', () => {
    const suspects = Array.from({ length: CORS_SUSPECT_CACHE_SIZE }, (_, i) => ({
      origin: `https://s${i}.example.com`,
      count: 1,
    }));
    const choices = Array.from({ length: CORS_SUSPECT_LIMIT }, (_, i) => ({
      origin: `https://c${i}.example.com`,
      count: 9,
    }));
    const rows = buildPickerRows(choices, suspects);
    expect(rows.filter(row => row.suspect > 0)).toHaveLength(CORS_SUSPECT_CACHE_SIZE);
  });
});

// ─── 两份手工副本与接线（按源码契约钉）───────────────────────────────────

const mainSrc = readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');
const bridgeSrc = readFileSync('entrypoints/content.ts', 'utf-8');
const originsSrc = readFileSync('utils/pageApiOrigins.ts', 'utf-8');
const popupSrc = readFileSync('entrypoints/popup/App.vue', 'utf-8');

/** 按花括号配对取出函数体并压平空白（同 `tests/channel-consistency.test.ts` 的那一份判据） */
function bodyOf(text: string, name: string): string {
  const at = text.indexOf(`function ${name}(`);
  expect(at, `源码里找不到 function ${name}`).toBeGreaterThan(-1);
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0)
        return text
          .slice(open + 1, i)
          .replace(/\s+/g, ' ')
          .trim();
    }
  }
  throw new Error(`function ${name} 的函数体没有闭合`);
}

/** 取出 `const NAME = <字面量>;` 的值（手工副本与共享常量对账用） */
function literalOf(text: string, name: string): string | undefined {
  return text.match(new RegExp(`const ${name} = (\\S+);`))?.[1];
}

describe('[MAIN world] 手工副本与共享常量同源', () => {
  it('频道内的消息名与两条上限都抄对了', () => {
    expect(literalOf(mainSrc, 'CORS_SUSPECTS')).toBe(`'${CORS_SUSPECTS}'`);
    expect(Number(literalOf(mainSrc, 'CORS_SUSPECT_MAX_COUNT'))).toBe(CORS_SUSPECT_MAX_COUNT);
    expect(Number(literalOf(mainSrc, 'CORS_SUSPECT_ORIGIN_CAP'))).toBe(CORS_SUSPECT_CACHE_SIZE);
  });

  it('origin 判据逐字同源：只改一边就红，两边一起等价改写保持绿', () => {
    // 两侧口径一旦分叉，「带标记的那一行」就可能不在候选那套判据里——界面画出一个点不动的地址。
    expect(bodyOf(mainSrc, 'httpOriginOf')).toBe(bodyOf(originsSrc, 'apiOriginOf'));
  });

  it('副本里不许冒出 `chrome.*` 或 import（该 world 必须自包含）', () => {
    const at = mainSrc.indexOf('// ---- 疑似被 CORS 拦下的原生请求');
    const end = mainSrc.indexOf('// Pending requests waiting for response', at);
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    const block = mainSrc.slice(at, end);
    expect(block).not.toMatch(/\bchrome\./);
    expect(block).not.toMatch(/\bimport\s/);
  });
});

describe('[MAIN world] 观测只挂在没有规则的那条路径，fetch 一行都没动', () => {
  it('没有规则的那一笔先挂观测、再交给原生 send', () => {
    const at = mainSrc.indexOf('watchNativeXhr(this, url);');
    expect(at).toBeGreaterThan(-1);
    expect(mainSrc.slice(at, at + 120)).toContain('originalXHRSend.call(this, body);');
  });

  it('观测只此一处：命中规则后的三类回退都不算「这一页还值得建规则」', () => {
    expect(mainSrc.match(/watchNativeXhr\(this, url\);/g)).toHaveLength(1);
    expect(mainSrc.match(/noteCorsOrigin\(/g)).toHaveLength(2); // 定义处 + error 回调里那一笔
  });

  it('fetch 那条无规则路径保持裸调用（挂任何拒绝处理器都会削掉页面的 unhandledrejection）', () => {
    const flat = mainSrc.replace(/\s+/g, ' ');
    expect(flat).toContain(
      'const rule = findMatchingRule(url, method); if (!rule) { return originalFetch.call(window, input, init); }',
    );
    expect(flat).not.toMatch(/originalFetch\.call\(window, input, init\)\s*\.\s*(catch|then)/);
    expect(flat).not.toMatch(/addEventListener\(\s*['"]unhandledrejection/);
    // 上面两条是**全文件**的禁令，不只那一条无规则路径：代理失败回退原生那两处同样把 promise
    // 交回页面，挂上 `.catch` 一样会把它标成已处理。三处共用同一个理由，所以共用同一条判据。
  });

  it('判据是 error 事件 + status === 0，且同源与非 http(s) 都被排除在外', () => {
    const block = bodyOf(mainSrc, 'watchNativeXhr');
    expect(block).toContain("addEventListener('error'");
    expect(block).toContain('xhr.status === 0');
    expect(block).toContain('origin === window.location.origin');
    // 计数不得反过来影响请求路径：观测函数不返回任何东西、也不抛
    expect(block).not.toMatch(/\breturn\s+(true|false|null)\b/);
  });

  it('上报只走既有 channel 与 origin 受限的 postMessage，不新增网络请求', () => {
    const block = bodyOf(mainSrc, 'reportCorsSuspects');
    expect(block).toContain('channel: CHANNEL');
    expect(block).toContain('type: CORS_SUSPECTS');
    expect(block).toContain('window.location.origin');
    expect(block).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
  });

  it('节流与那四个既有计数同一档：首报立即、此后每满 1s，尾差由定时器补报', () => {
    const block = bodyOf(mainSrc, 'noteCorsOrigin');
    expect(block).toContain('corsLastReportAt === 0 ||');
    expect(block).toContain('sinceLast >= CORS_REPORT_MIN_INTERVAL_MS');
    expect(block).toContain('setTimeout(reportCorsSuspects,');
    expect(block).not.toContain('try {');
    expect(block).not.toContain('catch');
  });
});

describe('[桥接层] 快照只存内存，一次只读探测交出去，其余什么都不做', () => {
  it('入站那支只写本地变量：不转 SW、不落 storage、不碰配置', () => {
    const at = bridgeSrc.indexOf(`if (event.data?.type === ${'CORS_SUSPECTS'})`);
    const end = bridgeSrc.indexOf('// 页面取消了自己那笔代发', at);
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    const block = bridgeSrc.slice(at, end);
    expect(block).toContain('corsSuspects = parseCorsSuspects(event.data.data)');
    expect(block).not.toMatch(/chrome\.(runtime|storage)/);
  });

  it('探测回包是同步的 `{ suspects }`，既不等 `return true` 也不带别的字段', () => {
    const at = bridgeSrc.indexOf(`if (message.type === ${'PAGE_CORS_PROBE'})`);
    expect(at).toBeGreaterThan(-1);
    const block = bridgeSrc.slice(at, bridgeSrc.indexOf('});', at) + 3);
    expect(block).toContain('sendResponse({ suspects: corsSuspects })');
    expect(block).not.toContain('return true');
  });

  it('两条新消息都不在 `MessageType` 里（不占 gate 分档、不给那四个出口添一个）', () => {
    expect(Object.values(MessageType)).not.toContain(CORS_SUSPECTS);
    expect(Object.values(MessageType)).not.toContain(PAGE_CORS_PROBE);
  });

  it('回包里的内容只可能来自页面自报：那份快照在本 world 只有一处赋值、初值是空数组', () => {
    // 别处再给 `corsSuspects` 赋一次值（比如从配置或存储里「补」一份），回包就不再是页面的话了。
    // 数次数而不是只看第一处：同一件事写在两处，`toContain` 是看不见的。
    expect(bridgeSrc.match(/\bcorsSuspects\s*=/g)).toHaveLength(1);
    expect(bridgeSrc).toContain('let corsSuspects: CorsSuspect[] = [];');
  });
});

describe('[popup] 只在说得出这件事时说话', () => {
  /** 取某个锚点起、到下一个 `closer` 之前的片段（锚点缺失时直接红，避免断言空转） */
  function sliceFrom(anchor: string, closer: string): string {
    const start = popupSrc.indexOf(anchor);
    expect(start, `popup 源码里找不到锚点：${anchor}`).toBeGreaterThan(-1);
    const end = popupSrc.indexOf(closer, start);
    expect(end).toBeGreaterThan(start);
    return popupSrc.slice(start, end);
  }

  /**
   * 钉模板与单行表达式一律走这份压平过的源码
   *
   * prettier 会把多属性的标签拆成一行一个（`<span` / `v-if=` / `class=` / `>{{ … }}</span`），
   * 也会把过长的三元换成缩进续行；两种写法承载的是同一句判据，按原始行匹配的锚点会在其中
   * 一种下当场失效——而失效方向恰好是「找不到锚点」，正是要红的那种，不能让格式决定断言。
   */
  const popupFlat = popupSrc.replace(/\s+/g, ' ');

  function sliceFlat(anchor: string, closer: string): string {
    const start = popupFlat.indexOf(anchor);
    expect(start, `popup 模板里找不到锚点：${anchor}`).toBeGreaterThan(-1);
    const end = popupFlat.indexOf(closer, start);
    expect(end).toBeGreaterThan(start);
    return popupFlat.slice(start, end);
  }

  it('挂载时就顺带问一次：卡片那行说明要在点击**之前**就说得出这件事', () => {
    const block = sliceFrom('if (proxiable) {', '}');
    expect(block).toContain('void fetchCorsSuspects(tab?.id);');
  });

  it('卡片那句只在非空时换成「检测到 N 个来源」，空与问不到都沿用旧文案', () => {
    const block = sliceFlat('const createRuleFromTabDesc = computed(', ');');
    expect(block).toContain('corsSuspects.value.length > 0');
    expect(block).toContain("t('actionCreateRuleFromTabSuspect'");
    expect(block).toContain("t('actionCreateRuleFromTabDesc')");
  });

  it('点击时重新问一次并与候选并发发出，面板用的就是刷新后那份（两处数不会打架）', () => {
    const block = sliceFrom('async function handleCreateRuleFromTab()', '\n}');
    expect(block).toContain('Promise.all([probePageApiOrigins(tab?.id), fetchCorsSuspects(tab?.id)])');
    expect(block).toContain('buildPickerRows(choices, corsSuspects.value)');
    // 两份都读不到才退回旧行为（按页面文档地址预填），有疑似行时不能提前 return
    expect(block).toContain('if (rows.length === 0) {');
  });

  it('标记行画「疑似 N 笔」而不是「N 次」，且解释挂在悬停上', () => {
    const cell = sliceFlat('<span v-if="row.suspect > 0"', '</span>');
    expect(cell).toContain('api-picker-count--suspect');
    expect(cell).toContain("t('apiPickerSuspect', String(row.suspect))");
    expect(cell).toContain("t('apiPickerSuspectHint', String(row.suspect))");
    // 没标记的那一格必须还是原来那句「N 次」：这一格讲什么只由有没有标记决定
    expect(sliceFlat('<span v-else class="api-picker-count"', '</span>')).toContain(
      "t('apiPickerCount', String(row.count))",
    );
    // 整行的可点语义没被顺手改掉：点的仍是这一行的来源
    expect(popupFlat).toContain(`:class="{ 'api-picker-row--suspect': row.suspect > 0 }"`);
    expect(popupFlat).toContain('@click="chooseApiDraft(row.origin)"');
  });

  it('那句「这是线索不是结论」只在真有标记时出现（没标记不许自证清白）', () => {
    const block = sliceFlat('<p v-if="apiPickerSuspectVisible" class="api-picker-suspect-note"', '</p>');
    expect(block).toContain("t('apiPickerSuspectNote')");
    // 同一个闸门在两种写法下都要成立：面板没开 = 不说；开了但没有标记行 = 也不说。
    // 按压平文本取到语句结尾，prettier 把它折成一行的三元还是换行成 `computed(\n  …,\n);` 都钉得住。
    const gate = sliceFlat('const apiPickerSuspectVisible = computed(', ');');
    expect(gate).toContain('apiPicker.value ?');
    expect(gate).toContain('row.suspect > 0');
    expect(gate).toContain(': false');
  });

  it('界面上没有一句「这一页没有跨域问题」：读不到与读到空都不许画成负结论', () => {
    // 只查会画出来的那两处：模板区与两份语言包。公共 JSDoc 里那句「不许说什么」不是界面文案，
    // 把它一起扫进来，这条断言第一次跑就红在自己的注释上。
    const template = popupSrc.slice(0, popupSrc.indexOf('</template>'));
    expect(template).not.toMatch(/apiPickerNoSuspect|noCorsSuspect|corsHealthy/);
    for (const locale of ['zh_CN', 'en']) {
      const values = Object.values(
        JSON.parse(readFileSync(`locales/${locale}/popup.json`, 'utf-8')) as Record<string, string>,
      ).join(' ');
      expect(values).not.toMatch(/没有跨域|无跨域|未发现跨域|不受跨域影响|no CORS|not blocked|without CORS/i);
    }
  });
});
