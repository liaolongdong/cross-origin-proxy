/**
 * HAR 导入：`utils/har.ts` 的 `harEntriesToRules`
 *
 * 「外部文件 → 本机规则」有两条入口，只有 JSON 那条过 `normalizeImportedRules` 那道收口；
 * HAR 这条从 `IMPORT_HAR` 拿到条目数组后，规则的形状、去重、默认启停与头的清洗**全部**由这个函数
 * 自己定，界面上只留一句「已从 HAR 创建 N 条规则」（`importHarSuccess`）。所以它每改一件事，
 * 用户看到的只是数字变了，没有任何一处会报错——这正是需要运行时用例的那类「静默失效」面。
 *
 * 断言都按「这一格改了以后谁会受害」来选：
 * - 默认停用：「新规则默认停用、确认后自行启用」这句（英文 "those rules arrive disabled until you
 *   enable them"）在中英两侧各写着四处 —— `README` 两份、站点根落地页（`index.html` / `en.html`）、
 *   `docs/llms.txt`、`CHROMEWEBSTORE.md`，另外 `docs/llms-full.txt` 那一行里中英各还有一份；
 *   `docs/alternatives.html` 两份倒是都没提，别照着它以为这句只有一处。
 *   翻成 `true` 等于让一份在别的机器上抓的包当场接管这个 origin 的流量。
 * - 按 origin 去重、先到先得：Chrome DevTools 导出的 HAR 里同一个后端通常有几十条请求，
 *   不去重就是几十条同键规则（合并键 `name::matchPattern` 又恰好相同），一次导入把 200 条上限吃掉。
 * - 认证头白名单与清洗：三枚头名以外的头一律不进规则；含换行的值逐条丢；全丢时整个字段不设
 *   （空对象会让界面显示一条「已配置请求头覆盖」的空规则）。另有一条跨文件契约钉住这几枚头名
 *   与「分享模式」脱敏表的同源关系——抄进来的都是别人机器上的真凭据，导出是它们唯一的出口。
 *
 * 有两条是**现状记录**，不是验收（各自点名了要收口得先拍的那件事），修的时候它们会红，
 * 请连同这段注释一起更新，别只删断言。
 *
 * 刻意没断的两处：`name` 用的是 `url.hostname`，因此带端口的条目名字里没有端口（变异 M9 实测换成
 * `url.host` 不改变任何被钉的结果）——名字只是给人看的标签，端口的真正去处在 `matchPattern` 与
 * `targetUrl`，那一格有断言；`createdAt` 与 `updatedAt` 是不是同一个 `now`（变异 M10 实测把它换成
 * 第二次 `Date.now()` 不红 —— 界面不按导入时间排序，两种写法对用户没有差别，所以不补一条空转断言）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { harEntriesToRules } from '@/utils/har';
import { isSensitiveHeaderName } from '@/utils/exportSanitize';
import type { HarEntry } from '@/utils/types';

/** 造一条最小 HAR 条目；不传 `headers` 时连这个键都不出现（与不传空数组不是一回事） */
function entry(url: string, headers?: { name: string; value: string }[]): HarEntry {
  return {
    request: { method: 'GET', url, ...(headers ? { headers } : {}) },
    response: { status: 200 },
  };
}

describe('harEntriesToRules — HAR 条目转代理规则', () => {
  it('生成的规则是自映射、默认停用、固定优先级 100', () => {
    const [rule] = harEntriesToRules([entry('https://fat.example.com/api/user?page=2')]);

    expect(rule.matchType).toBe('wildcard');
    // 捕获段落在 origin 之后：`https://fat.example.com/` 与 `https://fat.example.com/api/x` 都命中这条
    expect(rule.matchPattern).toBe('https://fat.example.com/*');
    // 目标就是自己 —— 今天它不改写任何东西（自映射），用户必须编辑 `targetUrl` 才有用。
    // 这是「导入抓包 → 起点规则」的既有产品口径，不是缺陷；界面那句成功提示只报条数
    // （`importHarSuccess` = 「已从 HAR 创建 $1 条规则」），「确认后自行启用」是文档侧的承诺。
    expect(rule.targetUrl).toBe('https://fat.example.com');
    expect(rule.enabled).toBe(false);
    // 刻意不是 `DEFAULT_RULE_PRIORITY`（那个是 10）：导入进来的规则排在用户手写的默认规则之后生效。
    expect(rule.priority).toBe(100);
    expect(rule.name).toBe('Imported: fat.example.com');
    expect(rule.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('同一 origin 的多条请求只出一条规则，端口参与去重', () => {
    const rules = harEntriesToRules([
      entry('https://a.com/api/x', [{ name: 'Authorization', value: 'from-first' }]),
      entry('https://a.com/api/y', [{ name: 'Authorization', value: 'from-later' }]),
      entry('https://a.com:8443/api/z'),
      entry('https://b.com/x'),
    ]);

    expect(rules.map(r => r.matchPattern)).toEqual(['https://a.com/*', 'https://a.com:8443/*', 'https://b.com/*']);
    // 先到先得：去重若改成「后到的覆盖已生成那条」，`matchPattern` 这一格照样绿（两条同 origin 的
    // 目标地址本就相同），只有取值能把它分辨出来。
    expect(rules[0].headerOverrides).toEqual({ Authorization: 'from-first' });
    // id 逐条各异：按 id 查找的更新 / 启停 / 删除全靠它，重复 id 让一次点击改到别条
    expect(new Set(rules.map(r => r.id)).size).toBe(rules.length);
  });

  it('只把三枚认证头抄进规则，头名保留文件里的大小写', () => {
    const [rule] = harEntriesToRules([
      entry('https://a.com/x', [
        { name: 'Authorization', value: 'Bearer token-a' },
        { name: 'X-API-Key', value: 'key-a' },
        { name: 'Cookie', value: 'sid=1' },
        { name: 'content-type', value: 'application/json' },
        { name: 'User-Agent', value: 'Mozilla/5.0' },
      ]),
    ]);

    expect(rule.headerOverrides).toEqual({
      Authorization: 'Bearer token-a',
      'X-API-Key': 'key-a',
      Cookie: 'sid=1',
    });
    // 大小写不敏感地认名字：小写写法同样进得来
    const [lower] = harEntriesToRules([entry('https://c.com/x', [{ name: 'cookie', value: 'sid=2' }])]);
    expect(lower.headerOverrides).toEqual({ cookie: 'sid=2' });
  });

  it('含换行的头值逐条丢弃；三枚全脏时整个字段不设', () => {
    const [kept] = harEntriesToRules([
      entry('https://a.com/x', [
        { name: 'Cookie', value: 'sid=1\r\nX-Injected: 1' },
        { name: 'Authorization', value: 'Bearer ok' },
      ]),
    ]);
    expect(kept.headerOverrides).toEqual({ Authorization: 'Bearer ok' });

    const [none] = harEntriesToRules([entry('https://b.com/x', [{ name: 'Cookie', value: 'a\r\nb' }])]);
    // 关键在「没有这个键」而不是 `{}`：空对象会让规则带着一条看不见的「已配置请求头覆盖」
    expect('headerOverrides' in none).toBe(false);
  });

  it('非法或结构缺失的条目静默跳过，整批不抛', () => {
    const garbage: unknown[] = [
      entry('not a url'),
      entry(''),
      {},
      { request: {} },
      null,
      'oops',
      entry('https://ok.test/x'),
    ];

    const rules = harEntriesToRules(garbage as HarEntry[]);
    expect(rules.map(r => r.matchPattern)).toEqual(['https://ok.test/*']);
    expect(harEntriesToRules([])).toEqual([]);
  });

  /**
   * 现状记录（一）：`seenOrigins.add(origin)` 排在头的清洗**之前**，所以一条头形状坏掉的条目
   * 虽然自己没成为规则，却已经把这个 origin 占住了 —— 同 origin 后面那条完好的条目跟着一起丢。
   * DevTools 导出的文件里 `headers` 恒为数组，但这条路并非到不了：弹窗只 `JSON.parse` 并校
   * `log.entries` 是数组（`ImportExportDialog.vue`），条目内部长什么样它不看，
   * 「从界面选一个人手改过的 `.har`」正好就是这一格。
   * 收口办法是把 `add` 挪到 `rules.push` 旁边（或给 `headers` 加 `Array.isArray`），那属于改导入语义，
   * 先记不修。
   *
   * 这条不是钻牛角尖：变异 M8b 实测「把去重键从 Set 换成比已生成的规则」这一眼看上去等价的写法
   * 就会悄悄把它修掉（红的是下面那条用例的上半句 `toEqual([])`——坏条目不再占住 origin，
   * 后面那条好的于是进了结果），所以这格行为今天没有任何东西挡着一次顺手重构。
   */
  it('现状记录：头不是数组的条目会顺手吃掉同 origin 后面那条好的', () => {
    const broken = {
      request: { method: 'GET', url: 'https://a.com/x', headers: 'oops' },
      response: { status: 200 },
    };
    expect(harEntriesToRules([broken, entry('https://a.com/y')] as unknown as HarEntry[])).toEqual([]);
    // 换一个 origin 就不受影响：丢的是这一整批里那个被占住的 origin，不是整份文件
    expect(harEntriesToRules([broken, entry('https://b.com/y')] as unknown as HarEntry[])).toHaveLength(1);
  });

  /**
   * 现状记录（二）：`new URL()` 对 `file:` / `data:` / `chrome-extension:` 这类 URI 是成功的，
   * 而它们的 `origin` 是字符串 `'null'`（前一格连 `hostname` 都是空串），于是产出一条
   * `matchPattern: 'null/*'` 的规则。它永远匹配不到任何真实请求（`buildRegexFilter` 出来的
   * `^null/(.*)$` 是合法 RE2，注册不报错，但没有真实 URL 长成 `null/…`），且默认停用，
   * 所以是垃圾而不是漏洞；两条这样的条目因为 origin 相同还会塌成一条。
   * 顺带一句没测的：它的替换串是 `null/\1`，不是绝对 URL —— 用户若手动启用这样一条，
   * Chrome 的反应本机确证不了，今天挡住风险的是「匹配不到」而不是「构造合法」。
   * 收口要加协议闸门（只收 http/https），那是改导入的结果条数，先记不修。
   *
   * 但「非 http(s)」不等于「一律 null/*」：`ws` / `wss` 有自己像样的 origin，产出的是下一条
   * 看上去完全可用的长连接自映射规则（实测 `new URL('wss://a.com/socket').origin === 'wss://a.com'`）。
   * 那一格今天同样没有闸门，只是它坏了不会显得是垃圾，所以别拿这格当「非 http(s) 都这样」的依据。
   */
  it('现状记录：origin 读成字符串 null 的条目产出一条永不命中的 null/* 规则', () => {
    const rules = harEntriesToRules([entry('file:///etc/passwd'), entry('data:text/html,x')] as HarEntry[]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ matchPattern: 'null/*', targetUrl: 'null', name: 'Imported: ' });

    const [ws] = harEntriesToRules([entry('wss://a.com/socket')] as HarEntry[]);
    expect(ws.matchPattern).toBe('wss://a.com/*');
  });

  /**
   * 白名单与「分享模式」判据必须同源：这里抄进规则的是**别人机器上的真实凭据**，
   * 而它们离开本机的唯一关口就是 `utils/exportSanitize.ts` 那张敏感头表。
   * 两张表今天重合（`authorization` / `x-api-key` / `cookie` 都在表里），纯靠巧合——
   * 往白名单加一枚表外的头（`x-session-token`、`proxy-authorization` 之类），
   * 用户勾着默认的分享模式导出配置，就把那枚凭据原样带出去了。
   *
   * 按源码契约钉而不是按行为探测：行为的探针只能列出我想得到的头名，
   * 加一枚我想不到的就漏；而白名单在源码里是一串字面量，grep 得到全部。
   * 代价是这张表换成 `Set` 常量、或改用别的写法时会红 —— 那时请连这条一起改判据，别删。
   */
  it('HAR 抄进规则的头名，全部落在分享模式的敏感表里', () => {
    const src = readFileSync('utils/har.ts', 'utf-8');
    const whitelisted = [...src.matchAll(/name === '([^']+)'/g)].map(m => m[1]);

    // 抓不到东西就是这条契约失效（而不是通过）：白名单被换成了 grep 认不出的写法
    expect(whitelisted.length).toBeGreaterThanOrEqual(3);
    for (const name of whitelisted) {
      expect(isSensitiveHeaderName(name), `${name} 会被 HAR 导入写进规则，却不在导出脱敏表里`).toBe(true);
    }
  });
});
