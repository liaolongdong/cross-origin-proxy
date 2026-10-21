/**
 * 自检面板的判读：每一行「读到的是什么形状 → 该说哪一档」逐个核
 *
 * 这一屏唯一的产品就是「诚实」，所以用例全部盯着那三种会把谎话说圆的形状：
 * 1. **没读到 ≠ 正常**：每一行的 `unknown` 都必须与 `ok` 分开（本仓在 `statusEverRead` /
 *    `logsEverRead` / `dnrSupportRead` 上立过三次同样的规矩，这是第四格）。
 * 2. **没读到 ≠ 没有**：规则集没读到时不能报「没有任何规则命中」——那一句话会把用户推去新建一条
 *    本来就已经在的规则。
 * 3. **还没落定 ≠ 已经落定**：装载那一格在同步还在排队时不作结论；skip 判定没落到过时，
 *    也不许把「都没被跳过」当成「浏览器都会应用」。
 *
 * `parseSelfCheckTab` 住在这个文件里测：它是地址栏里可编辑的那一串，按不可信输入处理。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ProxyRule } from '@/utils/types';
import {
  buildSelfCheckRows,
  checkDeliveryRow,
  checkInstallRow,
  checkMatchRow,
  checkSiteRow,
  checkSwitchRow,
  parseSelfCheckTab,
} from '@/utils/selfCheck';

const rule = (over: Partial<ProxyRule> = {}): ProxyRule => ({
  id: 'r1',
  name: 'FAT → UAT',
  enabled: true,
  matchType: 'wildcard',
  matchPattern: 'https://fat.example.com/*',
  targetUrl: 'https://uat.example.com',
  priority: 1,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('开关那一行', () => {
  it('开着就是开着，并带上启用条数', () => {
    expect(checkSwitchRow({ enabled: true, activeRuleCount: 3 } as never)).toEqual({
      key: 'switch',
      level: 'ok',
      params: ['3'],
    });
  });

  it('关着是「挡住」而不是「看一眼」——它确实让每一条规则都不生效', () => {
    expect(checkSwitchRow({ enabled: false, activeRuleCount: 3 } as never).level).toBe('fail');
  });

  it('没读到就是没读到，不替后台说「关着」也不说「开着」', () => {
    expect(checkSwitchRow(null).level).toBe('unknown');
    expect(checkSwitchRow({ activeRuleCount: 2 } as never).level).toBe('unknown');
  });

  it('开关读了、条数没读到时也整行不算读到——那一格宁可空着，也不报「0 条」', () => {
    expect(checkSwitchRow({ enabled: true } as never)).toEqual({ key: 'switch', level: 'unknown' });
  });
});

describe('站点生效范围那一行', () => {
  it('名单模式与排除模式都说得出自己是哪一种（两句话的修法正好相反）', () => {
    expect(checkSiteRow({ mode: 'site-only', hosts: ['fat.example.com'] }, 'fat.example.com')).toEqual({
      key: 'site',
      level: 'ok',
      params: ['site-only'],
    });
    expect(checkSiteRow({ mode: 'site-only', hosts: ['other.com'] }, 'fat.example.com').level).toBe('fail');
    expect(checkSiteRow({ mode: 'site-off', hosts: ['fat.example.com'] }, 'fat.example.com').level).toBe('fail');
    expect(checkSiteRow({ mode: 'all', hosts: [] }, 'fat.example.com').level).toBe('ok');
  });

  it('那一页的主机名读不出时不作结论——这一行问的是「那一页在不在范围内」，没有那一页就没有答案', () => {
    // 执行侧那一份 `siteAllows(state, '')` 回答的是「没有发起页时该怎么办」，与这里不是同一个问题：
    // 拿它回一句「在生效范围内」，就是替一台不存在的主机作确认（`selfCheckNoTab` 说的正是这三行只能「不知道」）
    expect(checkSiteRow({ mode: 'all', hosts: [] }, '')).toEqual({ key: 'site', level: 'unknown' });
    expect(checkSiteRow({ mode: 'site-only', hosts: ['a.com'] }, '').level).toBe('unknown');
  });

  it('名单没读到 ≠ 名单里没有这台：那一格不作结论', () => {
    expect(checkSiteRow(null, 'fat.example.com')).toEqual({ key: 'site', level: 'unknown', params: undefined });
  });
});

describe('送达账那一行', () => {
  const host = 'fat.example.com';

  it('只有「后台真的记下了这一页没接到」才是 warn', () => {
    expect(checkDeliveryRow(true, host).level).toBe('ok');
    expect(checkDeliveryRow(false, host).level).toBe('warn');
  });

  it('没问到、没读到，都算「不知道」而不是「正常」', () => {
    expect(checkDeliveryRow(null, host).level).toBe('unknown');
  });

  it('那一页本身读不出主机名时，账上写着「没记录」也不算数——它从来就不在广播的射程里', () => {
    // 反面形状是真机量出来过的一屏：`{synced:true}` 对扩展页与已关掉的标签页同样回「没有这笔账」，
    // 于是屏幕上会同时出现「这一页收到了推送」和「没有对应的网页标签页」。
    expect(checkDeliveryRow(true, '')).toEqual({ key: 'delivery', level: 'unknown' });
  });
});

describe('网络层装载那一行', () => {
  it('装着条数与「该装着」一致才算正常，差一条就是挡住', () => {
    const ok = { readable: true, syncing: false, installed: 4, expected: 4 };
    const off = { readable: true, syncing: false, installed: 0, expected: 4 };
    expect(checkInstallRow(ok)).toEqual({ key: 'install', level: 'ok', params: ['4', '4'] });
    expect(checkInstallRow(off)).toEqual({ key: 'install', level: 'fail', params: ['0', '4'] });
    // 反方向（装得比该装的还多）同罪：这一格说的是「两边对不上」，不是替它认其中一个原因
    expect(checkInstallRow({ readable: true, syncing: false, installed: 5, expected: 4 }).level).toBe('fail');
  });

  it('同步还在排队时不作结论，但**不把它说成读不到**——两个数都读到了，只是差还没落定', () => {
    expect(checkInstallRow({ readable: true, syncing: true, installed: 0, expected: 4 })).toEqual({
      key: 'install',
      level: 'pending',
      params: ['0', '4'],
    });
  });

  it('读不出时两个 0 不是「0 对 0，一切正常」；数读不出也一样，不拿 0 去补', () => {
    expect(checkInstallRow(null).level).toBe('unknown');
    expect(checkInstallRow({ readable: false, syncing: false, installed: 0, expected: 0 }).level).toBe('unknown');
    expect(checkInstallRow({ readable: true, syncing: false, installed: undefined, expected: 3 } as never).level).toBe(
      'unknown',
    );
  });
});

describe('命中那一行', () => {
  const url = 'https://fat.example.com/api/x';

  it('命中就报规则名与它走的通道（转发通道不需要那份 RE2 判定，所以判定没落到也照说「正常」）', () => {
    // 注头规则必然是转发通道（`isSimpleRule` 的那份判据，这里不另算）。
    // 换 id 是必须的：`findMatchingRule` 的排序缓存按「条数 + id:updatedAt」认，
    // 同 id 同 updatedAt 的两条规则会被当成同一份快照——那正是写路径每次都 bump updatedAt 的原因
    const complex = rule({ id: 'r-complex', headerOverrides: { 'x-a': '1' } });
    expect(checkMatchRow([complex], url, null)).toEqual({
      key: 'match',
      level: 'ok',
      params: ['FAT → UAT', 'forward'],
    });
  });

  it('赢的那条正是浏览器不会应用的那一条 → 单独一档「挡住」', () => {
    expect(checkMatchRow([rule()], url, new Set(['r1'])).level).toBe('fail');
    // 而被跳过的是另一条（被这条遮蔽的、或压根没命中的）→ 不该抢这个结论
    expect(checkMatchRow([rule(), rule({ id: 'r2', enabled: false })], url, new Set(['r2'])).level).toBe('ok');
  });

  it('判定**落到过且没有规则被跳过**（空集合）才是「都会应用」；一次都没落到只能停「还没定」', () => {
    // 这两档以前合成一句：`null`（还没判完）与「判过了，没人被跳过」交进来的都是「没有跳过项」，
    // 于是那一格会替浏览器说一句它还没说过的话——与 URL 匹配预演那格堵过的是同一个方向。
    expect(checkMatchRow([rule()], url, new Set())).toEqual({
      key: 'match',
      level: 'ok',
      params: ['FAT → UAT', 'network'],
    });
    expect(checkMatchRow([rule()], url, null)).toEqual({
      key: 'match',
      level: 'pending',
      params: ['FAT → UAT', 'network'],
    });
  });

  it('没有规则命中是「看一眼」；这一格压根没被问过（读不到）才是「不知道」', () => {
    expect(checkMatchRow([], url, new Set()).level).toBe('warn');
    expect(checkMatchRow(null, url, null).level).toBe('unknown');
    expect(checkMatchRow([rule()], '', null).level).toBe('unknown');
  });
});

describe('整屏的顺序与形状', () => {
  const facts = {
    status: { enabled: true, activeRuleCount: 1 } as never,
    siteState: { mode: 'all', hosts: [] } as never,
    configSynced: true,
    install: { readable: true, syncing: false, installed: 1, expected: 1 },
    rules: [rule()] as ProxyRule[],
    probeUrl: 'https://fat.example.com/api/x',
    host: 'fat.example.com',
  };

  it('五行按排查顺序摆，键唯一（模板拿 key 当 v-for 的稳定标识）', () => {
    const rows = buildSelfCheckRows(facts);
    expect(rows.map(r => r.key)).toEqual(['switch', 'site', 'delivery', 'match', 'install']);
    expect(new Set(rows.map(r => r.key)).size).toBe(5);
    expect(rows.every(r => r.level !== 'unknown')).toBe(true);
  });

  it('什么都没读到时整屏是「不知道」，不是整屏「正常」', () => {
    const rows = buildSelfCheckRows({
      status: null,
      siteState: null,
      configSynced: null,
      install: null,
      rules: null,
      probeUrl: '',
      host: '',
    });
    expect(rows.map(r => r.level)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  });

  it('那一页读不出（扩展页、已关的标签页）时，问「那一页」的三行全停「不知道」', () => {
    // 这一格是真机量出来的反面：账上「没有这笔记录」被抄成了「这一页收到了推送」，
    // 而同一屏的页面那一格写着「没有对应的网页标签页」——两句同时出现就是这一屏在自相矛盾。
    const rows = buildSelfCheckRows({
      status: { enabled: true, activeRuleCount: 1 } as never,
      siteState: { mode: 'all', hosts: [] } as never,
      configSynced: true,
      install: { readable: true, syncing: false, installed: 1, expected: 1 },
      rules: [rule()] as ProxyRule[],
      probeUrl: '',
      host: '',
    });
    expect(rows.map(r => `${r.key}:${r.level}`)).toEqual([
      'switch:ok',
      'site:unknown',
      'delivery:unknown',
      'match:unknown',
      'install:ok',
    ]);
  });
});

describe('界面把判据能产出的每一档都接住了', () => {
  /** 判据侧实际会产出的 `key.level` 组合：把每行的输入面各摆一遍，收它吐出来的档位 */
  function reachableLevels(): string[] {
    const url = 'https://fat.example.com/api/x';
    const host = 'fat.example.com';
    const complex = rule({ id: 'r-complex', headerOverrides: { 'x-a': '1' } });
    const rows = [
      checkSwitchRow(null),
      checkSwitchRow({ enabled: true, activeRuleCount: 1 } as never),
      checkSwitchRow({ enabled: false, activeRuleCount: 0 } as never),
      checkSiteRow(null, host),
      checkSiteRow({ mode: 'all', hosts: [] } as never, host),
      checkSiteRow({ mode: 'site-off', hosts: [host] } as never, host),
      checkDeliveryRow(null, host),
      checkDeliveryRow(true, host),
      checkDeliveryRow(false, host),
      checkMatchRow(null, url, null),
      checkMatchRow([], url, new Set()),
      checkMatchRow([rule()] as ProxyRule[], url, null),
      checkMatchRow([rule()] as ProxyRule[], url, new Set(['r1'])),
      checkMatchRow([complex] as ProxyRule[], url, null),
      checkInstallRow(null),
      checkInstallRow({ readable: true, syncing: true, installed: 0, expected: 1 }),
      checkInstallRow({ readable: true, syncing: false, installed: 1, expected: 1 }),
      checkInstallRow({ readable: true, syncing: false, installed: 0, expected: 1 }),
    ];
    return [...new Set(rows.map(r => `${r.key}.${r.level}`))];
  }

  const dialog = readFileSync('components/options/SelfCheckDialog.vue', 'utf-8');
  const handled = [...dialog.matchAll(/case '([a-z]+\.[a-z]+)':/g)].map(m => m[1]);

  it('判据产出的每一档都有一条字面量文案接着（少一条就画成那句通用的「这一格没读到」）', () => {
    const missing = reachableLevels().filter(key => !handled.includes(key));
    expect(missing, `这些档位没有对应的文案分支：${missing.join(', ')}`).toEqual([]);
  });

  it('界面里不许留着判据已经产不出的档位（留着就是没人能看见的死文案）', () => {
    const reachable = reachableLevels();
    const stale = handled.filter(key => !reachable.includes(key));
    expect(stale, `这些文案分支对应的档位已不可达：${stale.join(', ')}`).toEqual([]);
  });

  it('每一句都是字面量 t() 调用，不是拼出来的键（拼出来的键 i18n 的源码扫描查不到）', () => {
    const switchBlock = dialog.slice(dialog.indexOf('function rowText'), dialog.indexOf('function viaWord'));
    expect(switchBlock).not.toMatch(/t\(\s*[`'"]?selfCheck\$\{/);
    expect(switchBlock).not.toMatch(/t\(`\$\{/);
  });
});

describe('首屏与重跑的那两种「还没落定」在界面上各有形状', () => {
  const dialog = readFileSync('components/options/SelfCheckDialog.vue', 'utf-8');

  it('第一次读数还在路上时画一句「正在检查」，不许画一个空列表', () => {
    // 与本仓「骨架 → 读失败 → 空态」同一条次序：`rows` 的初值是空数组，
    // 少了这一条判据，首屏那一闪就是「什么都没查出来」
    expect(dialog).toMatch(/v-if="readout\.reading && !everSettled"/);
    expect(dialog).toContain("t('selfCheckRowsReading')");
    expect(dialog).toMatch(/self-check-loading[\s\S]*?role="status"/);
  });

  it('重跑在途时手里那五行必须被点破是上一轮的', () => {
    expect(dialog).toMatch(/v-if="readout\.reading && everSettled"/);
    expect(dialog).toContain("t('selfCheckRowsRefreshing')");
  });

  it('换到另一页时先摘掉上一台的那五行，落定之后才记在谁名下', () => {
    expect(dialog).toContain('if (rowsOwner.value !== target) rows.value = [];');
    expect(dialog).toContain('if (seq !== runSeq) return;');
    expect(dialog).toContain('rowsOwner.value = target;');
  });
});

describe('parseSelfCheckTab — 地址栏里那一串按不可信输入处理', () => {
  it('只认非负整数', () => {
    expect(parseSelfCheckTab('42')).toBe(42);
    expect(parseSelfCheckTab('0')).toBe(0);
  });

  it('别的都当「没带」，包括负数、小数、科学计数、超长与别人的字符串', () => {
    for (const raw of [
      null,
      undefined,
      '',
      '-1',
      '1.5',
      '1e999',
      ' 7',
      '7 ',
      '99999999999999',
      'chrome://settings',
      '-0',
    ]) {
      expect(parseSelfCheckTab(raw)).toBeNull();
    }
  });
});
