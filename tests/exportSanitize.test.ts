/**
 * 配置导出脱敏（分享模式）
 *
 * 规则里的请求头覆盖 / 响应头覆盖 / 查询参数覆盖是凭据最常见的落脚点，而配置文件常被
 * 直接贴进群里让同事复现环境。`sanitizeExportData` 在导出前整条摘掉这些项：
 * 导入方退化为「不覆盖该头」，比留下 `***REMOVED***` 这种会被服务端 401 的占位值更安全。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ExportData, ProxyRule } from '@/utils/types';
import { sanitizeExportData, isSensitiveHeaderName, isSensitiveQueryName } from '@/utils/exportSanitize';

function makeRule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r1',
    name: 'rule',
    enabled: true,
    matchPattern: 'https://fat.example.com/*',
    targetUrl: 'https://uat.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeExport(rules: ProxyRule[]): ExportData {
  return { version: '1.0.0', exportTime: 0, config: { enabled: true, rules } };
}

describe('sanitizeExportData — 请求头覆盖', () => {
  it('摘掉凭据头，保留普通头', () => {
    const { data, removedCount } = sanitizeExportData(
      makeExport([
        makeRule({ headerOverrides: { Authorization: 'Bearer sk-live', 'Content-Type': 'application/json' } }),
      ]),
    );
    expect(removedCount).toBe(1);
    expect(data.config.rules[0].headerOverrides).toEqual({ 'Content-Type': 'application/json' });
  });

  it('头名大小写与首尾空白不影响判定', () => {
    expect(isSensitiveHeaderName(' AUTHORIZATION ')).toBe(true);
    expect(isSensitiveHeaderName('Cookie')).toBe(true);
    expect(isSensitiveHeaderName('X-Token-Refresh-Interval')).toBe(false);
  });

  it('全是凭据头时删掉整个字段，回到「未配置」而不是留个空对象', () => {
    const { data } = sanitizeExportData(makeExport([makeRule({ headerOverrides: { Cookie: 'session=abc' } })]));
    expect('headerOverrides' in data.config.rules[0]).toBe(false);
  });

  it('不修改入参，也不需要脱敏时原样复用同一对象', () => {
    const safe = makeRule({ headerOverrides: { 'X-Env': 'fat' } });
    const source = makeExport([safe, makeRule({ name: 'no-headers' })]);
    const { data, removedCount } = sanitizeExportData(source);
    expect(removedCount).toBe(0);
    expect(data.config.rules[0]).toBe(safe);
    expect(source.config.rules[0].headerOverrides).toEqual({ 'X-Env': 'fat' });
  });
});

describe('sanitizeExportData — 查询参数与响应头', () => {
  it('摘掉 token 类查询参数，保留普通参数', () => {
    expect(isSensitiveQueryName('access_token')).toBe(true);
    expect(isSensitiveQueryName('page')).toBe(false);
    const { data, removedCount } = sanitizeExportData(
      makeExport([makeRule({ queryOverrides: { access_token: 'A', tenant: 'uat' } })]),
    );
    expect(removedCount).toBe(1);
    expect(data.config.rules[0].queryOverrides).toEqual({ tenant: 'uat' });
  });

  it('摘掉响应头里的 Set-Cookie，其余响应头与其它覆盖字段原样保留', () => {
    const { data, removedCount } = sanitizeExportData(
      makeExport([
        makeRule({
          responseOverrides: { status: 200, headers: { 'Set-Cookie': 'a=b', 'X-Trace': 'on' }, bodyRaw: '{"ok":1}' },
        }),
      ]),
    );
    expect(removedCount).toBe(1);
    expect(data.config.rules[0].responseOverrides).toEqual({
      status: 200,
      headers: { 'X-Trace': 'on' },
      bodyRaw: '{"ok":1}',
    });
  });

  it('响应头被摘空时删掉 headers 字段，status/bodyRaw 仍在', () => {
    const { data } = sanitizeExportData(
      makeExport([makeRule({ responseOverrides: { status: 503, headers: { 'Set-Cookie': 'a=b' } } })]),
    );
    const overrides = data.config.rules[0].responseOverrides!;
    expect('headers' in overrides).toBe(false);
    expect(overrides.status).toBe(503);
  });

  it('有意不动请求体与 Mock 响应体（那正是规则要交付的内容）', () => {
    const { data, removedCount } = sanitizeExportData(
      makeExport([
        makeRule({
          requestBodyOverride: '{"token":"inside-body"}',
          mockResponse: { body: '{"access_token":"inside-mock"}' },
        }),
      ]),
    );
    expect(removedCount).toBe(0);
    expect(data.config.rules[0].requestBodyOverride).toContain('inside-body');
    expect(data.config.rules[0].mockResponse?.body).toContain('inside-mock');
  });
});

describe('exportConfig — 勾选值贯通到下载', () => {
  function stubDownload() {
    const clicked: { json?: string } = {};
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async () =>
          makeExport([makeRule({ headerOverrides: { Authorization: 'Bearer sk-live' } })]),
        ),
      },
    });
    // 只补两个方法：整体替换 URL 会让 Node 自带的 `new URL` 失效
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal(
      'Blob',
      class {
        constructor(parts: string[]) {
          clicked.json = parts.join('');
        }
      },
    );
    vi.stubGlobal('document', { createElement: () => ({ click: () => {} }) });
    return clicked;
  }

  it('分享模式开启时下载的文件里不含凭据，并回报移除数', async () => {
    const downloaded = stubDownload();
    const { useImportExport } = await import('@/composables/useImportExport');
    const result = await useImportExport().exportConfig(true);

    expect(result.removedCount).toBe(1);
    expect(downloaded.json).not.toContain('sk-live');
  });

  it('取消勾选即原样导出（本机全量备份）', async () => {
    const downloaded = stubDownload();
    const { useImportExport } = await import('@/composables/useImportExport');
    const result = await useImportExport().exportConfig(false);

    expect(result.removedCount).toBe(0);
    expect(downloaded.json).toContain('sk-live');
  });
});

describe('[功能] 弹窗默认走分享模式', () => {
  const dialogSrc = readFileSync('components/options/ImportExportDialog.vue', 'utf-8');
  const appSrc = readFileSync('components/options/App.vue', 'utf-8');

  it('勾选状态默认 true，且随 export 事件上报', () => {
    expect(dialogSrc).toContain('const sanitizeExport = ref(true)');
    expect(dialogSrc).toContain("emit('export', sanitizeExport.value)");
    expect(dialogSrc).toContain('export: [sanitize: boolean]');
    expect(dialogSrc).toContain('v-model="sanitizeExport"');
  });

  it('父组件把勾选值交给 exportConfig，并按移除数换提示', () => {
    expect(appSrc).toContain('async function handleExport(sanitize: boolean)');
    expect(appSrc).toContain('await exportConfig(sanitize)');
    expect(appSrc).toContain("t('exportSuccessSanitized', [removedCount])");
  });
});
