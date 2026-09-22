import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import type { ImportPlan, ProxyRule } from '@/utils/types';
import { MAX_RULES, STORAGE_KEYS } from '@/utils/constants';

// 内存版 chrome.storage.local mock（在导入被测模块前安装）
let store: Record<string, unknown> = {};
const setSpy = vi.fn(async (items: Record<string, unknown>) => {
  Object.assign(store, items);
});
const sendMessageSpy = vi.fn();

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async () => store),
      set: setSpy,
    },
    onChanged: { addListener: vi.fn() },
  },
  runtime: {
    sendMessage: sendMessageSpy,
  },
});

const { importProxyConfig, getProxyConfig, invalidateConfigCache } = await import('@/utils/storage');
const { useImportExport } = await import('@/composables/useImportExport');
const { logger } = await import('@/utils/logger');

function makeRule(id: string, overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: `https://api-${id}.example.com/*`,
    targetUrl: 'https://target.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function fillStore(rules: ProxyRule[], enabled: boolean): void {
  store = { [STORAGE_KEYS.PROXY_CONFIG]: { enabled, rules } };
}

function storedConfig(): { enabled: boolean; rules: ProxyRule[] } {
  return store[STORAGE_KEYS.PROXY_CONFIG] as { enabled: boolean; rules: ProxyRule[] };
}

describe('importProxyConfig — 替换模式补上限', () => {
  beforeEach(() => {
    store = {};
    setSpy.mockClear();
    invalidateConfigCache();
  });

  it('整体替换现有规则', async () => {
    fillStore([makeRule('old')], true);
    const result = await importProxyConfig([makeRule('new')], { mode: 'replace', enabled: true });

    expect(result).toEqual({ success: true, added: 1, skipped: 0 });
    const config = await getProxyConfig();
    expect(config.rules.map(r => r.id)).toEqual(['new']);
    expect(config.enabled).toBe(true);
  });

  it(`文件本身超过 MAX_RULES(${MAX_RULES}) 时拒绝，且不落任何写入`, async () => {
    fillStore([makeRule('old')], true);
    const incoming = Array.from({ length: MAX_RULES + 1 }, (_, i) => makeRule(`n${i}`));

    const result = await importProxyConfig(incoming, { mode: 'replace', enabled: false });
    expect(result).toEqual({ success: false, error: 'MAX_RULES_EXCEEDED' });
    expect(setSpy).not.toHaveBeenCalled();
    // 原配置原样保留：拒绝不是「先清空再失败」
    expect(storedConfig().rules.map(r => r.id)).toEqual(['old']);
    expect(storedConfig().enabled).toBe(true);
  });

  it('恰好等于上限时允许写入（边界与 batchAddRules 相反方向的语义：替换后总数=上限合法）', async () => {
    fillStore([makeRule('old')], true);
    const incoming = Array.from({ length: MAX_RULES }, (_, i) => makeRule(`n${i}`));

    const result = await importProxyConfig(incoming, { mode: 'replace', enabled: false });
    expect(result.success).toBe(true);
    expect((await getProxyConfig()).rules).toHaveLength(MAX_RULES);
  });

  it('未显式给出开关时替换模式关闭总开关（既有键语义）', async () => {
    fillStore([makeRule('old')], true);
    await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect((await getProxyConfig()).enabled).toBe(false);
  });
});

describe('importProxyConfig — 合并模式去重与上限', () => {
  beforeEach(() => {
    store = {};
    setSpy.mockClear();
    invalidateConfigCache();
  });

  it('按 name + matchPattern 去重，并回报新增/跳过数', async () => {
    const dup = makeRule('e1', { name: 'rule-d', matchPattern: 'https://dup.example.com/*' });
    fillStore([dup], false);

    const incoming = [
      makeRule('i1', { name: 'rule-d', matchPattern: 'https://dup.example.com/*' }),
      makeRule('i2', { name: 'rule-new', matchPattern: 'https://new.example.com/*' }),
    ];
    const result = await importProxyConfig(incoming, { mode: 'merge' });

    expect(result).toEqual({ success: true, added: 1, skipped: 1 });
    const config = await getProxyConfig();
    expect(config.rules.map(r => r.id)).toEqual(['e1', 'i2']);
  });

  it('开关缺省时沿用当前值', async () => {
    fillStore([makeRule('e1')], true);
    await importProxyConfig([makeRule('i2')], { mode: 'merge' });
    expect((await getProxyConfig()).enabled).toBe(true);
  });

  it('合并后超限则整体拒绝，现有规则不变', async () => {
    const existing = Array.from({ length: MAX_RULES }, (_, i) => makeRule(`e${i}`));
    fillStore(existing, true);

    const result = await importProxyConfig([makeRule('i1', { name: 'extra' })], { mode: 'merge' });
    expect(result).toEqual({ success: false, error: 'MAX_RULES_EXCEEDED' });
    expect(setSpy).not.toHaveBeenCalled();
    expect((await getProxyConfig()).rules).toHaveLength(MAX_RULES);
  });

  it('上限按去重后的数量校验：文件超长但全是重复项时仍可导入', async () => {
    const existing = Array.from({ length: MAX_RULES - 1 }, (_, i) => makeRule(`e${i}`));
    fillStore(existing, true);
    // 与现有规则完全同名的重复项，去重后新增数为 0
    const dupOnly = [makeRule('i0', { name: 'rule-e0', matchPattern: existing[0].matchPattern })];

    const result = await importProxyConfig(dupOnly, { mode: 'merge' });
    expect(result).toEqual({ success: true, added: 0, skipped: 1 });
  });
});

describe('useImportExport.importConfig — 回传稳定错误码', () => {
  beforeEach(() => {
    sendMessageSpy.mockReset();
  });

  it('JSON 解析失败 → INVALID_CONFIG', async () => {
    const { importConfig } = useImportExport();
    const result = await importConfig('{ not json', 'replace');
    expect(result).toEqual({ success: false, error: 'INVALID_CONFIG' });
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('结构缺少 config.rules → INVALID_CONFIG', async () => {
    const { importConfig } = useImportExport();
    const result = await importConfig(JSON.stringify({ config: {} }), 'replace');
    expect(result).toEqual({ success: false, error: 'INVALID_CONFIG' });
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('sendMessage 抛错 → IMPORT_ERROR（不能报成格式错误）', async () => {
    sendMessageSpy.mockRejectedValue(new TypeError('Extension context invalidated.'));
    const { importConfig } = useImportExport();
    const result = await importConfig(JSON.stringify({ config: { rules: [] } }), 'merge');
    expect(result).toEqual({ success: false, error: 'IMPORT_ERROR' });
  });

  it('后台无响应（resolve undefined）→ IMPORT_NO_RESPONSE', async () => {
    sendMessageSpy.mockResolvedValue(undefined);
    const { importConfig } = useImportExport();
    const result = await importConfig(JSON.stringify({ config: { rules: [] } }), 'replace');
    expect(result).toEqual({ success: false, error: 'IMPORT_NO_RESPONSE' });
  });

  it('模式随消息下发，成功时透传后台结果', async () => {
    sendMessageSpy.mockResolvedValue({ success: true });
    const { importConfig } = useImportExport();
    const payload = { config: { enabled: true, rules: [] } };
    const result = await importConfig(JSON.stringify(payload), 'merge');

    expect(result).toEqual({ success: true });
    const [msg] = sendMessageSpy.mock.calls[0] as [{ type: string; data: { mode?: string } }];
    expect(msg.type).toBe('IMPORT_CONFIG');
    expect(msg.data.mode).toBe('merge');
  });
});

/**
 * 预览这一路自己的判据（弹窗侧的契约钉在本文件末尾那两组里）
 *
 * `fetchImportPlan` 是纯计算、不落库，但它有三条失败面必须与「预览显示无变化」分得开：
 * 本地格式判据（一条消息都不该发）、后台空回包、sendMessage 抛错。界面拿不到 `plan`
 * 才能说「这次没法预告」，拿到 `{plan: undefined}` 就会画成「这次没有变化」——
 * 后者是谎报，也是这个 composable 唯一能钉住的那一格。`importing` 那把锁同理：
 * 它锁的是写入，预览不该占用它。
 */
describe('useImportExport.fetchImportPlan — 预览这一路自己的判据', () => {
  const validJson = JSON.stringify({ config: { enabled: true, rules: [] } });

  beforeEach(() => {
    sendMessageSpy.mockReset();
  });

  const plan: ImportPlan = {
    mode: 'merge',
    added: 2,
    skipped: 1,
    conflicts: [
      {
        name: 'rule-r1',
        matchPattern: 'https://api-rule-r1.example.com/*',
        currentTargetUrl: 'https://old.example.com',
        incomingTargetUrl: 'https://new.example.com',
      },
    ],
    duplicatesWithinFile: 0,
    replaces: 0,
    exceedsLimit: false,
  };

  it('模式与载荷一起发给后台，plan 原样带回（预览只在后台算）', async () => {
    sendMessageSpy.mockResolvedValue({ success: true, plan });
    const { fetchImportPlan } = useImportExport();

    await expect(fetchImportPlan(validJson, 'merge')).resolves.toEqual({ success: true, plan });
    const [msg] = sendMessageSpy.mock.calls[0] as [{ type: string; data: { mode?: string; config?: unknown } }];
    expect(msg.type).toBe('GET_IMPORT_PLAN');
    expect(msg.data.mode).toBe('merge');
    expect(msg.data.config).toEqual({ enabled: true, rules: [] });
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['JSON 解析失败', '{ not json'],
    ['结构缺少 config.rules', JSON.stringify({ config: {} })],
  ])('%s：本地就报 INVALID_CONFIG，一条消息都不发（预览是增强，不该把垃圾打到后台）', async (_label, input) => {
    const { fetchImportPlan } = useImportExport();
    await expect(fetchImportPlan(input, 'replace')).resolves.toEqual({ success: false, error: 'INVALID_CONFIG' });
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('后台无响应：回的是「没法预告」而不是一块空预览', async () => {
    sendMessageSpy.mockResolvedValue(undefined);
    const { fetchImportPlan } = useImportExport();
    await expect(fetchImportPlan(validJson, 'replace')).resolves.toEqual({
      success: false,
      error: 'IMPORT_NO_RESPONSE',
    });
  });

  it('sendMessage 抛错：稳定码 + 说一句 error，异常原文只进日志', async () => {
    const seen: unknown[][] = [];
    const spy = vi.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
      seen.push(args);
    });
    sendMessageSpy.mockRejectedValue(new TypeError('Extension context invalidated.'));
    const { fetchImportPlan } = useImportExport();

    await expect(fetchImportPlan(validJson, 'replace')).resolves.toEqual({
      success: false,
      error: 'IMPORT_PLAN_ERROR',
    });
    expect(seen).toHaveLength(1);
    expect(String(seen[0][1])).toContain('Extension context invalidated.');
    spy.mockRestore();
  });

  it('预览不占用 importing：算个预览不该把「导入」按钮锁住', async () => {
    sendMessageSpy.mockResolvedValue({ success: true, plan });
    const { importing, fetchImportPlan } = useImportExport();
    await fetchImportPlan(validJson, 'merge');
    expect(importing.value).toBe(false);
  });

  it('importing 在途为 true，三条落定路径都回 false', async () => {
    let settle: (result: unknown) => void = () => {};
    sendMessageSpy.mockImplementation(() => new Promise(resolve => (settle = resolve)));
    const { importing, importConfig } = useImportExport();

    const first = importConfig(validJson, 'replace');
    expect(importing.value).toBe(true);
    settle({ success: true });
    await first;
    expect(importing.value).toBe(false);

    const second = importConfig(validJson, 'replace');
    expect(importing.value).toBe(true);
    settle(undefined);
    await second;
    expect(importing.value).toBe(false);

    let fail: (error: unknown) => void = () => {};
    sendMessageSpy.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
    const third = importConfig(validJson, 'replace');
    expect(importing.value).toBe(true);
    fail(new Error('boom'));
    await third;
    expect(importing.value).toBe(false);
  });
});

describe('[P2-6] 导入失败保留输入（弹窗与父组件的契约）', () => {
  const dialogSrc = fs.readFileSync('components/options/ImportExportDialog.vue', 'utf-8');
  const appSrc = fs.readFileSync('components/options/App.vue', 'utf-8');
  const start = dialogSrc.indexOf('async function handleImport');
  // 只截 handleImport 本体：后面的 cURL / HAR 导入各自关窗，不属于本次契约
  const end = dialogSrc.indexOf('function handleImportCurl', start);
  const handle = dialogSrc.slice(start, end);

  it('弹窗等待导入结果，而不是 emit 后立刻清空并关窗', () => {
    expect(handle).toContain('const result = await importConfig(');
    expect(handle).not.toContain("emit('import',");
    expect(handle).not.toContain("emit('update:visible', false)");
  });

  it('失败分支先返回，清空输入只发生在成功之后', () => {
    const firstClear = handle.indexOf("jsonInput.value = ''");
    const earlyReturn = handle.indexOf('if (!result.success)');
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(firstClear).toBeGreaterThan(earlyReturn);
    // emit 必须带上后台的实际条数：成功提示要说得出「跳过几条」
    expect(handle).toContain("emit('imported', {");
    expect(handle).toContain('result.skipped ?? 0');
    expect(handle).toContain('result.invalid ?? 0');
    // 超上限必须有专属提示，不能一律报「JSON 格式错误」
    expect(handle).toContain('MAX_RULES_EXCEEDED');
    expect(handle).toContain("t('maxRulesReached'");
  });

  it('版本过新的文件有专属提示（不能报成格式错误，用户改不出 JSON 版本）', () => {
    expect(handle).toContain('SCHEMA_TOO_NEW');
    expect(handle).toContain("t('importSchemaTooNew'");
  });

  it('HAR 选中的文件不跨次打开残留（弹窗分片不随关闭销毁，再点一次会导入两遍）', () => {
    expect(dialogSrc).toContain('@closed="resetHarPick"');
    const reset = dialogSrc.slice(
      dialogSrc.indexOf('function resetHarPick'),
      dialogSrc.indexOf('async function handleImportHar'),
    );
    expect(reset).toContain('harFileContent.value = null');
    expect(reset).toContain('harUploadRef.value?.clearFiles()');
  });

  it('父组件只监听 imported，不再自行调用 importConfig', () => {
    expect(appSrc).toContain('@imported="handleImported"');
    expect(appSrc).not.toContain('@import="handleImport"');
    expect(appSrc).not.toContain('importConfig(');
  });

  it('HAR 的成功提示由执行写入的父组件发出（弹窗里 emit 是同步的，拿不到成败）', () => {
    expect(dialogSrc).not.toContain('importHarSuccess');
    const harHandler = appSrc.slice(
      appSrc.indexOf('async function handleImportHarRules'),
      appSrc.indexOf('\n}\n', appSrc.indexOf('async function handleImportHarRules')),
    );
    expect(harHandler).toContain("ElMessage.success(t('importHarSuccess'");
    // 顺序要求：提示在写入之后；关窗只在 try 内（位于 catch 之前），失败时弹窗保持打开
    expect(harHandler.indexOf('await batchAddRules')).toBeLessThan(
      harHandler.indexOf("ElMessage.success(t('importHarSuccess'"),
    );
    expect(harHandler.indexOf('showImportExport.value = false')).toBeLessThan(harHandler.indexOf('catch'));
    expect(harHandler).toContain('showAddFailedMessage');
  });
});

describe('导入预览与恢复点界面契约（批次 B）', () => {
  const dialogSrc = fs.readFileSync('components/options/ImportExportDialog.vue', 'utf-8');
  const appSrc = fs.readFileSync('components/options/App.vue', 'utf-8');
  const settingsSrc = fs.readFileSync('components/options/SettingsDialog.vue', 'utf-8');
  const previewStart = dialogSrc.indexOf('async function handlePreview');
  const previewEnd = dialogSrc.indexOf('function handleExport', previewStart);
  const preview = dialogSrc.slice(previewStart, previewEnd);

  it('预览由后台算，弹窗不自己写一份差集（否则数字迟早和写入侧分叉）', () => {
    expect(preview).toContain('await fetchImportPlan(');
    expect(dialogSrc).not.toContain('deduplicateRules');
    expect(dialogSrc).not.toContain('planImport');
  });

  it('预览失败与「预览显示无变化」分开说：失败要显式点名，不能画成空预览', () => {
    expect(preview).toContain('planUnavailable.value = true');
    // 摊平文案的那个 computed 在 handlePreview 之前，整份文件里查
    expect(dialogSrc).toContain('importPreviewFailed');
    // 格式与版本问题各有专属文案，一律报「无法预览」会让人以为文件没问题
    expect(preview).toContain("t('importFailed')");
    expect(preview).toContain("t('importSchemaTooNew')");
  });

  it('输入或模式一变即作废旧预览', () => {
    expect(dialogSrc).toContain('watch([jsonInput, fileContent, importMode]');
    const reset = dialogSrc.slice(
      dialogSrc.indexOf('watch([jsonInput, fileContent, importMode]'),
      dialogSrc.indexOf('async function handlePreview'),
    );
    expect(reset).toContain('plan.value = null');
  });

  it('父组件按实际条数说实话：有跳过/丢弃时必须报出来', () => {
    const handler = appSrc.slice(
      appSrc.indexOf('async function handleImported'),
      appSrc.indexOf('\n}\n', appSrc.indexOf('async function handleImported')),
    );
    expect(handler).toContain('stats.skipped > 0 || stats.invalid > 0');
    expect(handler).toContain("t('importSuccessDetail'");
    expect(handler).toContain("t('importSuccess')");
  });

  it('恢复点列表在设置弹窗里随打开即取（异步分片不能只靠 @open）', () => {
    expect(settingsSrc).toContain('await loadHistory()');
    const watcher = settingsSrc.slice(
      settingsSrc.indexOf('watch(\n  () => props.visible'),
      settingsSrc.indexOf('/**\n * 把界面上的行整表写回'),
    );
    expect(watcher).toContain('historyLoadFailed.value = !(await loadHistory())');
    expect(watcher).toContain('{ immediate: true }');
  });

  it('回退走后台消息并通知父组件重取配置，绝不在界面侧直接写 storage', () => {
    expect(settingsSrc).toContain('await restore(entry.id)');
    expect(settingsSrc).toContain("emit('restored')");
    expect(settingsSrc).not.toContain('STORAGE_KEYS.CONFIG_HISTORY');
    expect(appSrc).toContain('@restored="handleConfigRestored"');
    const handler = appSrc.slice(
      appSrc.indexOf('async function handleConfigRestored'),
      appSrc.indexOf('\n}\n', appSrc.indexOf('async function handleConfigRestored')),
    );
    expect(handler).toContain('await fetchConfig()');
    expect(handler).toContain('clearRuleSelection()');
  });

  it('未知时间不渲染成 1970 年', () => {
    expect(settingsSrc).toContain("t('restoreUnknownTime')");
    expect(settingsSrc).toContain('savedAt ? formatLocaleDateTime(savedAt, locale.value)');
  });
});
