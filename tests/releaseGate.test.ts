import { describe, it, expect } from 'vitest';
import {
  APPROVAL_READINGS,
  STORE_SECRET_NAMES,
  approvalStateOf,
  decide,
  isValidVersion,
  renderSummary,
  secretPresenceOf,
  tagStateOf,
} from '@/scripts/release-gate.mjs';

/**
 * 商店发布闸门的判据（`scripts/release-gate.mjs`）
 *
 * 这套判据住在独立脚本里、而不是写进 YAML，唯一理由是它可以被真跑：`.github/**` 在本机
 * 无法实跑（无 `act`/`docker`），而这两件事错了的代价分别是「向 Google 重复提交审核」
 * （配额有限、不可撤回）与「合并即发版、没有任何人点头」——后者甚至不会留下任何报错。
 *
 * 覆盖的是**读数 → 结论 → 措辞**这条链，按外部可观察面断言：
 * - 读数：`curl -w '%{http_code}'` 的状态码原文 + 响应体原文（含 HTML、空串、数组这些形状）
 * - 结论：`{shouldPublish, hold, reason}` 三个字段，两个轴彼此独立
 * - 措辞：审批人打开那条 run 时看到的那一屏 Job Summary
 * 至于 HTTP 请求本身、以及「谁在什么事件下起跑哪个作业」，仍然只有 YAML 与文档那一份口径。
 */

/** 夹具刻意用一个开发中永远不会出现的号：`docs-consistency` 里那条「被跟踪的文本文件不许复述开发中的版本号」同样管着这份测试。 */
const VERSION = '9.9.9';
const TAG = 'v9.9.9';
const SHA = 'a'.repeat(40);

/** 审批闸门可能的五种读数；`APPROVAL_READINGS` 的键集就是它，下面有一支用例正对着账。 */
type ApprovalState = keyof typeof APPROVAL_READINGS;
const ALL_APPROVAL_STATES: readonly ApprovalState[] = [
  'configured',
  'not-found',
  'no-rule',
  'empty-reviewers',
  'unknown',
];
const UNCONFIGURED_STATES: readonly ApprovalState[] = ['not-found', 'no-rule', 'empty-reviewers', 'unknown'];

/** 一份「tag 确实存在」的真答复。 */
const tagBody = (ref = `refs/tags/${TAG}`): string =>
  JSON.stringify({ ref, node_id: 'REF_1', object: { sha: SHA, type: 'commit' } });

/** 一份「环境配了必需审查员」的真答复。 */
const envBody = (rules: unknown): string =>
  JSON.stringify({ name: 'chrome-web-store', url: 'https://api.github.com/x', protection_rules: rules });

describe('isValidVersion：号只从 package.json 取，形状不合法就不进 API 路径', () => {
  it('接受 X.Y.Z 与带预发布/构建元数据的那几种', () => {
    for (const ok of ['9.9.9', '0.0.1', '10.20.30', '9.9.9-beta.1', '9.9.9+build.7', '9.9.9-rc.1+20260101']) {
      expect(isValidVersion(ok), ok).toBe(true);
    }
  });

  it('拒绝带 v 的、缺位的、多段的、空串、非字符串，以及带换行的', () => {
    for (const bad of [
      'v9.9.9',
      '1.5',
      '9.9.9.1',
      '',
      '9.9.9\n',
      '9.9.9 || exit 1',
      '../../etc/passwd',
      undefined,
      null,
      15,
    ]) {
      expect(isValidVersion(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('tagStateOf：只有「这个标签的那条 ref 记录」才算已存在', () => {
  it('404 是唯一能读成「不存在」的答复', () => {
    expect(tagStateOf(404, tagBody(), TAG)).toBe('missing');
    expect(tagStateOf('404', '', TAG)).toBe('missing');
  });

  it('200 且 ref 原位对得上、object.sha 是字符串 → exists', () => {
    expect(tagStateOf(200, tagBody(), TAG)).toBe('exists');
    expect(tagStateOf('200', tagBody(), TAG)).toBe('exists');
  });

  it('200 但说的是别的 ref → unknown，不许读成已发过', () => {
    // 拿代理页/登录页/别的分支那份 200 当成「tag 已存在」，会把该发的这一版判成发过了；
    // 而界面上一句「这一版已经发过」和一句真话长得一模一样。
    expect(tagStateOf(200, tagBody('refs/heads/main'), TAG)).toBe('unknown');
    expect(tagStateOf(200, tagBody(`refs/tags/v${VERSION}.1`), TAG)).toBe('unknown');
  });

  it('200 但形状不对（缺 object、sha 非串、非 JSON、数组、空体）→ unknown', () => {
    expect(tagStateOf(200, JSON.stringify({ ref: `refs/tags/${TAG}` }), TAG)).toBe('unknown');
    expect(tagStateOf(200, JSON.stringify({ ref: `refs/tags/${TAG}`, object: { type: 'commit' } }), TAG)).toBe(
      'unknown',
    );
    expect(tagStateOf(200, '<html>login</html>', TAG)).toBe('unknown');
    expect(tagStateOf(200, '[]', TAG)).toBe('unknown');
    expect(tagStateOf(200, '', TAG)).toBe('unknown');
  });

  it('非 200/404 的答复（403 / 401 / 5xx / 000 / 空 / 非数字）全归 unknown', () => {
    for (const code of [403, 401, 422, 500, '000', '', 'abc', undefined, null]) {
      expect(tagStateOf(code as string | number, tagBody(), TAG), String(code)).toBe('unknown');
    }
  });
});

describe('approvalStateOf：环境在不在、闸门开没开、名单空不空，是三件事', () => {
  it('404 → not-found（环境压根不存在，隐式创建就是那条静默失败）', () => {
    expect(approvalStateOf(404, '')).toEqual({ state: 'not-found', reviewers: 0 });
  });

  it('200 + 带人的 required_reviewers → configured，人数如实报', () => {
    const rules = [
      { type: 'wait_timer', wait_timer: 0 },
      {
        type: 'required_reviewers',
        reviewers: [{ reviewer: { type: 'User', id: 1 } }, { reviewer: { type: 'Team', id: 2 } }],
      },
    ];
    expect(approvalStateOf(200, envBody(rules))).toEqual({ state: 'configured', reviewers: 2 });
  });

  it('200 + 只有别的规则 → no-rule', () => {
    expect(approvalStateOf(200, envBody([{ type: 'wait_timer', wait_timer: 5 }]))).toEqual({
      state: 'no-rule',
      reviewers: 0,
    });
    expect(approvalStateOf(200, envBody([]))).toEqual({ state: 'no-rule', reviewers: 0 });
  });

  it('200 + 规则开了但名单为空（或名单不是数组）→ empty-reviewers，与 no-rule 分开', () => {
    expect(approvalStateOf(200, envBody([{ type: 'required_reviewers', reviewers: [] }]))).toEqual({
      state: 'empty-reviewers',
      reviewers: 0,
    });
    expect(approvalStateOf(200, envBody([{ type: 'required_reviewers', reviewers: null }]))).toEqual({
      state: 'empty-reviewers',
      reviewers: 0,
    });
  });

  it('读不出形状时是 unknown，不是「没配审查员」', () => {
    // 这条区分是有承重的：把它读成 no-rule，一次 API 形状变更就变成「配置问题」，
    // 而处置完全不同（一个是去设置页勾选，一个是去看令牌能不能读这个端点）。
    expect(approvalStateOf(200, envBody(undefined))).toEqual({ state: 'unknown', reviewers: 0 });
    expect(approvalStateOf(200, JSON.stringify({ name: 'chrome-web-store' }))).toEqual({
      state: 'unknown',
      reviewers: 0,
    });
    expect(approvalStateOf(200, '<html>oops</html>')).toEqual({ state: 'unknown', reviewers: 0 });
    for (const code of [403, 500, '000', '']) {
      expect(approvalStateOf(code, envBody([{ type: 'required_reviewers', reviewers: [{}] }])), String(code)).toEqual({
        state: 'unknown',
        reviewers: 0,
      });
    }
  });

  it('每一种可能返回的状态都在 APPROVAL_READINGS 里有措辞，且 configured 不需要操作指引', () => {
    for (const state of ALL_APPROVAL_STATES) {
      expect(APPROVAL_READINGS[state], state).toBeDefined();
      expect(APPROVAL_READINGS[state].short, state).toBeTruthy();
    }
    expect(Object.keys(APPROVAL_READINGS).sort()).toEqual([...ALL_APPROVAL_STATES].sort());
    expect(APPROVAL_READINGS.configured.action).toBe('');
    // 那两句「要怎么改设置」的话不能是空的：拦下来那一格只有这几行字可给人看。
    for (const state of UNCONFIGURED_STATES) {
      expect(APPROVAL_READINGS[state].action, state).toBeTruthy();
    }
    // 环境不存在是唯一会「隐式创建裸环境」的那种，警告必须挂在它自己的那一条上。
    expect(APPROVAL_READINGS['not-found'].action).toContain('隐式创建');
    expect(APPROVAL_READINGS['not-found'].action).toContain('Required reviewers');
  });
});

describe('secretPresenceOf：只是给审批人看的一条线索', () => {
  it('四个都在 → missing 为空', () => {
    const body = JSON.stringify({ secrets: STORE_SECRET_NAMES.map(name => ({ name, updated_at: 'x' })) });
    expect(secretPresenceOf(200, body)).toEqual({ known: true, present: [...STORE_SECRET_NAMES], missing: [] });
  });

  it('缺两个就报两个，多出来的别的 Secrets 不混进 present', () => {
    const body = JSON.stringify({
      secrets: [{ name: 'CHROME_EXTENSION_ID' }, { name: 'CHROME_CLIENT_ID' }, { name: 'NPM_TOKEN' }],
    });
    expect(secretPresenceOf(200, body)).toEqual({
      known: true,
      present: ['CHROME_EXTENSION_ID', 'CHROME_CLIENT_ID'],
      missing: ['CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN'],
    });
  });

  it('读不到时 known=false 且 present/missing 都空——不许据此改变判定', () => {
    for (const bad of [JSON.stringify({ secrets: 'x' }), JSON.stringify({}), '<html>', '', '[]']) {
      expect(secretPresenceOf(200, bad)).toEqual({ known: false, present: [], missing: [] });
    }
    expect(secretPresenceOf(403, JSON.stringify({ secrets: [{ name: 'CHROME_EXTENSION_ID' }] }))).toEqual({
      known: false,
      present: [],
      missing: [],
    });
  });

  it('这份清单就是 release.yml 里那四个名字，顺序与拼写一致', () => {
    expect(STORE_SECRET_NAMES).toEqual([
      'CHROME_EXTENSION_ID',
      'CHROME_CLIENT_ID',
      'CHROME_CLIENT_SECRET',
      'CHROME_REFRESH_TOKEN',
    ]);
  });
});

describe('decide：「有东西要发」与「没人能点头」是两个独立的轴', () => {
  const pending = (approval: ApprovalState) => decide({ version: VERSION, tag: TAG, tagState: 'missing', approval });

  it('号不合法 → 不发、拦下，且理由点名「流水线不猜号」', () => {
    for (const version of ['v9.9.9', '1.5', '', 'x/../../y']) {
      const verdict = decide({ version, tag: `v${version}`, tagState: 'missing', approval: 'configured' });
      expect(verdict.shouldPublish, version).toBe(false);
      expect(verdict.hold, version).toBe(true);
      expect(verdict.reason, version).toContain('不是 MAJOR.MINOR.PATCH');
    }
  });

  it('tag 已在远端 → 不发、也不拦（这就是今天合并这条链路的实际表现）', () => {
    const verdict = decide({ version: VERSION, tag: TAG, tagState: 'exists', approval: 'not-found' });
    expect(verdict.shouldPublish).toBe(false);
    expect(verdict.hold).toBe(false);
    expect(verdict.reason).toContain('已经发过');
    // 闸门没配不该在这一格被提出来：这一版本来就没有要发的东西。
    expect(verdict.reason).not.toContain('Required reviewers');
  });

  it('tag 读不到 → 不发但拦下（事实不明时宁可红一次）', () => {
    const verdict = decide({ version: VERSION, tag: TAG, tagState: 'unknown', approval: 'configured' });
    expect(verdict.shouldPublish).toBe(false);
    expect(verdict.hold).toBe(true);
    expect(verdict.reason).toContain('可信答复');
  });

  it('四种「闸门没配好」的读数都：这一版确实待发，但不许自动往下走', () => {
    for (const approval of UNCONFIGURED_STATES) {
      const verdict = pending(approval);
      expect(verdict.shouldPublish, approval).toBe(true);
      expect(verdict.hold, approval).toBe(true);
      expect(verdict.reason, approval).toContain(APPROVAL_READINGS[approval].short);
    }
  });

  it('唯一放行的一组：tag 不在 + 闸门已配', () => {
    const verdict = pending('configured');
    expect(verdict.shouldPublish).toBe(true);
    expect(verdict.hold).toBe(false);
    expect(verdict.reason).toContain('人工确认');
    expect(verdict.reason).toContain('打 tag');
  });

  it('返回体永远带上 version，即使它不合法（调用方要能在摘要里指出是哪一个号）', () => {
    expect(decide({ version: '1.5', tag: 'v1.5', tagState: 'missing', approval: 'configured' }).version).toBe('1.5');
  });
});

describe('renderSummary：审批人打开那条 run 时看到的那一屏', () => {
  const base = {
    version: VERSION,
    tag: TAG,
    tagState: 'missing',
    approval: 'configured',
    reviewers: 2,
    environment: 'chrome-web-store',
    event: 'push',
    sha: SHA,
    repository: 'liaolongdong/cross-origin-proxy',
    shouldPublish: true,
    hold: false,
    reason: '走「校验 → 人工确认 → 打 tag → 发布」',
    secrets: { known: true, present: [...STORE_SECRET_NAMES], missing: [] as string[] },
  } as const;
  const render = (over: Partial<Record<string, unknown>> = {}): string =>
    renderSummary({ ...base, ...over } as Parameters<typeof renderSummary>[0]);
  /** 把「读数 → `decide` → 摘要」串起来：措辞断言不该测一份现实中组合不出的结论。 */
  const renderFor = (tagState: string, approval: string, over: Record<string, unknown> = {}): string => {
    const verdict = decide({ version: VERSION, tag: TAG, tagState, approval });
    return render({
      tagState,
      approval,
      shouldPublish: verdict.shouldPublish,
      hold: verdict.hold,
      reason: verdict.reason,
      ...over,
    });
  };

  it('三份事实与号都点名，短 sha 可核对', () => {
    const text = render();
    expect(text).toContain(TAG);
    expect(text).toContain('chrome-web-store');
    expect(text).toContain(SHA.slice(0, 7));
    expect(text).toContain('2 名必需审查员');
    expect(text).toContain('liaolongdong/cross-origin-proxy');
  });

  it('放行那一支必须把「点头之前什么都不动」写在点头之后要做的事之前', () => {
    const text = render();
    expect(text).toContain('审批人点头之前，refs 一个都不会动');
    expect(text.indexOf('点头之前')).toBeLessThan(text.indexOf('才打 tag'));
  });

  it('环境不存在时，隐式创建那句警告要出现在摘要里，而不只在排查文档里', () => {
    const text = renderFor('missing', 'not-found');
    expect(text).toContain('隐式创建');
    expect(text).toContain('Settings → Environments');
    expect(text).toContain('结论：拦下来');
  });

  it('卡点换成「tag 读不到」时配置指引就不再出现，但闸门读数本身仍然列出来', () => {
    const text = renderFor('unknown', 'not-found');
    expect(text).toContain('拦下来');
    expect(text).not.toContain('Settings → Environments');
    // 环境没配是真事，这一行照常报——只是它不是这一轮的卡点，不该抢走处置指引那一格。
    expect(text).toContain('审批闸门（环境 `chrome-web-store`）：环境不存在');
  });

  it('其余三种「没配好」各给各的那句处置，且只在自己那一轮出现', () => {
    const noRule = renderFor('missing', 'no-rule');
    expect(noRule).toContain('Protection rules');
    expect(noRule).not.toContain('Settings → Environments');
    const empty = renderFor('missing', 'empty-reviewers');
    expect(empty).toContain('至少添加一个审查员');
    expect(empty).not.toContain('Protection rules');
    const unreadable = renderFor('missing', 'unknown');
    expect(unreadable).toContain('令牌能不能读');
    expect(unreadable).not.toContain('至少添加一个审查员');
  });

  it('PR 上说清这是演练，并且不下「结论」', () => {
    const text = render({ event: 'pull_request', hold: false });
    expect(text).toContain('只演练判定');
    expect(text).not.toContain('**结论：');
    expect(text).not.toContain('点头之前');
  });

  it('说明切到了就说它是 Release 正文，没切到就点出商店那一栏是空的', () => {
    expect(render({ notesSource: 'changelog', notesLines: '12' })).toContain('12 行');
    const fallback = render({ notesSource: 'generated', notesLines: '0' });
    expect(fallback).toContain('没有');
    expect(fallback).toContain('更新说明');
    expect(fallback).not.toContain('12 行');
  });

  it('凭据那一行三种读数三种说法，缺的那几个要点名', () => {
    expect(render({ secrets: { known: false, present: [], missing: [] } })).toContain('读不到仓库 Secrets 名单');
    const missing = render({
      secrets: { known: true, present: ['CHROME_EXTENSION_ID'], missing: ['CHROME_REFRESH_TOKEN'] },
    });
    expect(missing).toContain('CHROME_REFRESH_TOKEN');
    expect(missing).toContain('GitHub Release 照发');
    expect(render()).toContain('别挪到环境级');
  });

  it('出口永远把教程指回 RELEASING.md 的那三节', () => {
    const text = render();
    expect(text).toContain('.github/docs/RELEASING.md');
    expect(text).toContain('§1.6');
    expect(text).toContain('§2');
    expect(text).toContain('§7');
  });
});
