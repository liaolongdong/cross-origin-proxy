import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import type { ProxyRule } from '@/utils/types';
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
    expect(handle).toContain("emit('imported')");
    // 超上限必须有专属提示，不能一律报「JSON 格式错误」
    expect(handle).toContain('MAX_RULES_EXCEEDED');
    expect(handle).toContain("t('maxRulesReached'");
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
