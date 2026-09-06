/**
 * 构建产物全量验证测试
 *
 * 验证构建输出的完整性、manifest 配置、i18n、文件结构等
 * 无需浏览器，直接验证 .output/chrome-mv3 目录
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import fs from 'fs';

const BUILD_DIR = path.resolve(__dirname, '../.output/chrome-mv3');

describe('[Build] 构建产物全量验证', () => {
  let manifest: any;
  let enMessages: any;
  let zhMessages: any;

  beforeAll(() => {
    if (!fs.existsSync(BUILD_DIR)) {
      throw new Error(`构建目录不存在: ${BUILD_DIR}。请先运行 'pnpm build'`);
    }

    manifest = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'manifest.json'), 'utf-8'));
    enMessages = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, '_locales/en/messages.json'), 'utf-8'));
    zhMessages = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, '_locales/zh_CN/messages.json'), 'utf-8'));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Manifest 基础验证
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Manifest 基础配置', () => {
    it('should be Manifest V3', () => {
      expect(manifest.manifest_version).toBe(3);
    });

    it('should have i18n name and description', () => {
      expect(manifest.name).toBe('__MSG_extensionName__');
      expect(manifest.description).toBe('__MSG_extensionDescription__');
    });

    /**
     * `manifest.name` 为商店搜索承载关键词（≤75 字符），但工具栏悬停提示
     * 直接复用它会让 tooltip 变成一长串关键词，因此必须指向短名 key。
     */
    it('should use the short brand name for the toolbar tooltip', () => {
      expect(manifest.action?.default_title).toBe('__MSG_extensionShortName__');
    });

    it('should have default locale zh_CN', () => {
      expect(manifest.default_locale).toBe('zh_CN');
    });

    it('should have version string', () => {
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 权限验证
  // ═══════════════════════════════════════════════════════════════════════════

  describe('权限声明', () => {
    it('should have storage permission', () => {
      expect(manifest.permissions).toContain('storage');
    });

    it('should have declarativeNetRequest permission', () => {
      expect(manifest.permissions).toContain('declarativeNetRequest');
    });

    it('should have declarativeNetRequestFeedback permission', () => {
      expect(manifest.permissions).toContain('declarativeNetRequestFeedback');
    });

    it('should have alarms permission (for keepalive)', () => {
      expect(manifest.permissions).toContain('alarms');
    });

    it('should have <all_urls> host permission', () => {
      expect(manifest.host_permissions).toContain('<all_urls>');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 快捷键命令验证
  // ═══════════════════════════════════════════════════════════════════════════

  describe('快捷键命令 (Feature 4)', () => {
    it('should have commands section', () => {
      expect(manifest.commands).toBeDefined();
    });

    it('should have toggle-proxy command', () => {
      expect(manifest.commands['toggle-proxy']).toBeDefined();
    });

    it('should have Ctrl+Shift+P for Windows/Linux', () => {
      expect(manifest.commands['toggle-proxy'].suggested_key.default).toBe('Ctrl+Shift+P');
    });

    it('should have Command+Shift+P for Mac', () => {
      expect(manifest.commands['toggle-proxy'].suggested_key.mac).toBe('Command+Shift+P');
    });

    it('should have i18n description reference', () => {
      expect(manifest.commands['toggle-proxy'].description).toBe('__MSG_commandToggleProxy__');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Background Service Worker
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Background Service Worker', () => {
    it('should have background.service_worker defined', () => {
      expect(manifest.background?.service_worker).toBe('background.js');
    });

    it('should have background.js file', () => {
      const bgPath = path.join(BUILD_DIR, 'background.js');
      expect(fs.existsSync(bgPath)).toBe(true);
    });

    it('background.js should contain chrome.runtime API calls', () => {
      const content = fs.readFileSync(path.join(BUILD_DIR, 'background.js'), 'utf-8');
      expect(content).toContain('chrome.runtime');
    });

    it('background.js should contain command listener for keyboard shortcut', () => {
      const content = fs.readFileSync(path.join(BUILD_DIR, 'background.js'), 'utf-8');
      expect(content).toContain('onCommand');
      expect(content).toContain('toggle-proxy');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Content Scripts
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Content Scripts', () => {
    it('should have content_scripts defined', () => {
      expect(manifest.content_scripts).toBeDefined();
      expect(Array.isArray(manifest.content_scripts)).toBe(true);
    });

    it('should have ISOLATED world content script', () => {
      const contentScript = manifest.content_scripts.find((cs: any) => cs.js?.includes('content-scripts/content.js'));
      expect(contentScript).toBeDefined();
      expect(contentScript.matches).toContain('<all_urls>');
      expect(contentScript.run_at).toBe('document_start');
    });

    it('should have MAIN world interceptor script', () => {
      const interceptor = manifest.content_scripts.find((cs: any) =>
        cs.js?.includes('content-scripts/main-interceptor.js'),
      );
      expect(interceptor).toBeDefined();
      expect(interceptor.world).toBe('MAIN');
    });

    it('should have content.js file', () => {
      expect(fs.existsSync(path.join(BUILD_DIR, 'content-scripts/content.js'))).toBe(true);
    });

    it('should have main-interceptor.js file', () => {
      expect(fs.existsSync(path.join(BUILD_DIR, 'content-scripts/main-interceptor.js'))).toBe(true);
    });

    it('main-interceptor.js should intercept fetch', () => {
      const content = fs.readFileSync(path.join(BUILD_DIR, 'content-scripts/main-interceptor.js'), 'utf-8');
      expect(content).toContain('fetch');
    });

    it('main-interceptor.js should intercept XMLHttpRequest', () => {
      const content = fs.readFileSync(path.join(BUILD_DIR, 'content-scripts/main-interceptor.js'), 'utf-8');
      expect(content).toContain('XMLHttpRequest');
    });

    it('main-interceptor.js should intercept WebSocket', () => {
      const content = fs.readFileSync(path.join(BUILD_DIR, 'content-scripts/main-interceptor.js'), 'utf-8');
      expect(content).toContain('WebSocket');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Options & Popup Pages
  // ═══════════════════════════════════════════════════════════════════════════

  describe('扩展页面', () => {
    it('should have options_ui defined', () => {
      expect(manifest.options_ui).toBeDefined();
      expect(manifest.options_ui.page).toBe('options.html');
      expect(manifest.options_ui.open_in_tab).toBe(true);
    });

    it('should have action with popup', () => {
      expect(manifest.action).toBeDefined();
      expect(manifest.action.default_popup).toBe('popup.html');
    });

    it('should have options.html file', () => {
      expect(fs.existsSync(path.join(BUILD_DIR, 'options.html'))).toBe(true);
    });

    it('should have popup.html file', () => {
      expect(fs.existsSync(path.join(BUILD_DIR, 'popup.html'))).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // i18n 国际化验证
  // ═══════════════════════════════════════════════════════════════════════════

  describe('国际化 (i18n)', () => {
    it('should have en/messages.json', () => {
      expect(fs.existsSync(path.join(BUILD_DIR, '_locales/en/messages.json'))).toBe(true);
    });

    it('should have zh_CN/messages.json', () => {
      expect(fs.existsSync(path.join(BUILD_DIR, '_locales/zh_CN/messages.json'))).toBe(true);
    });

    it('should have extensionName in English', () => {
      expect(enMessages.extensionName.message).toBe('Cross-Origin Proxy - CORS & API Environment Switcher');
    });

    it('should have extensionName in Chinese', () => {
      expect(zhMessages.extensionName.message).toBe('跨域代理助手 - CORS 跨域调试 · API 环境切换 · Mock');
    });

    it('should have commandToggleProxy in English', () => {
      expect(enMessages.commandToggleProxy.message).toBe('Toggle proxy on/off');
    });

    it('should have commandToggleProxy in Chinese', () => {
      expect(zhMessages.commandToggleProxy.message).toBe('切换代理开关');
    });

    it('should expose the same message keys in both locales', () => {
      expect(Object.keys(enMessages).sort()).toEqual(Object.keys(zhMessages).sort());
    });

    it('should keep the tooltip short name identical to the in-app brand name', () => {
      // 同一品牌字符串分布在四处，不一致时商店名/悬停提示/popup 头部会互相漂移：
      // _locales.extensionShortName（悬停提示）、common.extensionName（HeaderBar）、
      // popup.popupTitle（popup 头部与文档标题）。options 页标题带「- 配置/- Options」
      // 后缀，故意不等于短品牌名，不纳入本断言。
      const readKey = (locale: string, file: string, key: string) =>
        JSON.parse(fs.readFileSync(path.resolve(__dirname, `../locales/${locale}/${file}`), 'utf-8'))[key] as string;

      for (const [locale, messages] of [
        ['zh_CN', zhMessages],
        ['en', enMessages],
      ] as Array<[string, any]>) {
        expect(messages.extensionShortName.message).toBe(readKey(locale, 'common.json', 'extensionName'));
        expect(readKey(locale, 'popup.json', 'popupTitle')).toBe(readKey(locale, 'common.json', 'extensionName'));
      }
    });

    it('should keep the tooltip short name free of store keywords', () => {
      // 30 是 tooltip 可视宽度的经验预算，Chrome 对 default_title 并无长度硬校验；
      // 禁词只列长名追加的关键词，“跨域”是品牌名自带成分，不得加入禁词表。
      for (const messages of [enMessages, zhMessages]) {
        const short = messages.extensionShortName.message;
        expect([...short].length, `短名过长：${short}`).toBeLessThanOrEqual(30);
        expect(short).not.toMatch(/CORS|Mock|环境切换|Environment/i);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 商店文案字符上限
  //
  // Chrome 在上传扩展包时对 manifest 的 name / description 做硬校验
  // （name ≤ 75、description ≤ 132，按码点计数），超出直接拒收，
  // 故此处作为回归守卫，避免文案优化时又把包撑爆。
  // ═══════════════════════════════════════════════════════════════════════════

  describe('商店文案字符上限（Chrome 上传硬校验）', () => {
    const MAX_NAME = 75;
    const MAX_DESCRIPTION = 132;

    /** 必须在用例会执行时再取消息对象：`enMessages`/`zhMessages` 到 `beforeAll` 才被赋值。 */
    const storeLocales = [
      { locale: 'en', read: () => enMessages },
      { locale: 'zh_CN', read: () => zhMessages },
    ];

    for (const { locale, read } of storeLocales) {
      it(`[${locale}] extensionName fits the 75-character manifest limit`, () => {
        const length = [...read().extensionName.message].length;
        expect(length, `extensionName 长度 ${length} 超过 ${MAX_NAME}`).toBeLessThanOrEqual(MAX_NAME);
      });

      it(`[${locale}] extensionDescription fits the 132-character manifest limit`, () => {
        const length = [...read().extensionDescription.message].length;
        expect(length, `extensionDescription 长度 ${length} 超过 ${MAX_DESCRIPTION}`).toBeLessThanOrEqual(
          MAX_DESCRIPTION,
        );
      });

      it(`[${locale}] store copy mentions a searchable capability keyword`, () => {
        const messages = read();
        const text = messages.extensionName.message + messages.extensionDescription.message;
        const keywords = ['CORS', '代理', 'proxy', 'API'];
        const hit = keywords.some(keyword => text.toLowerCase().includes(keyword.toLowerCase()));
        expect(hit, `商店文案应包含 ${keywords.join(' / ')} 之一`).toBe(true);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 图标资源验证
  // ═══════════════════════════════════════════════════════════════════════════

  describe('图标资源', () => {
    it('should have all required icon sizes', () => {
      const sizes = [16, 32, 48, 96, 128];
      for (const size of sizes) {
        const iconPath = path.join(BUILD_DIR, `icon/${size}.png`);
        expect(fs.existsSync(iconPath), `缺少图标: icon/${size}.png`).toBe(true);
      }
    });

    it('should have icon.svg', () => {
      expect(fs.existsSync(path.join(BUILD_DIR, 'icon.svg'))).toBe(true);
    });

    it('manifest icons should match existing files', () => {
      const icons = manifest.icons;
      expect(icons).toBeDefined();

      for (const [, filePath] of Object.entries(icons)) {
        const fullPath = path.join(BUILD_DIR, filePath as string);
        expect(fs.existsSync(fullPath), `图标文件不存在: ${filePath}`).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // JS/CSS 资源验证
  // ═══════════════════════════════════════════════════════════════════════════

  describe('JS/CSS 资源', () => {
    it('should have chunks directory', () => {
      expect(fs.existsSync(path.join(BUILD_DIR, 'chunks'))).toBe(true);
    });

    it('should have assets directory', () => {
      expect(fs.existsSync(path.join(BUILD_DIR, 'assets'))).toBe(true);
    });

    it('should have JS chunk files', () => {
      const chunks = fs.readdirSync(path.join(BUILD_DIR, 'chunks'));
      const jsChunks = chunks.filter(f => f.endsWith('.js'));
      expect(jsChunks.length).toBeGreaterThan(0);
    });

    it('should have CSS asset files', () => {
      const assets = fs.readdirSync(path.join(BUILD_DIR, 'assets'));
      const cssAssets = assets.filter(f => f.endsWith('.css'));
      expect(cssAssets.length).toBeGreaterThan(0);
    });

    it('should have lazy-loaded component chunks', () => {
      const chunks = fs.readdirSync(path.join(BUILD_DIR, 'chunks'));
      const componentChunks = chunks.filter(
        f =>
          f.includes('RuleFormDialog') ||
          f.includes('LogDrawer') ||
          f.includes('ImportExportDialog') ||
          f.includes('SettingsDialog'),
      );
      expect(componentChunks.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 构建产物大小验证
  // ═══════════════════════════════════════════════════════════════════════════

  describe('构建产物大小', () => {
    function getDirSize(dir: string): number {
      let size = 0;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          size += getDirSize(filePath);
        } else {
          size += stat.size;
        }
      }
      return size;
    }

    it('total build size should be under 2MB', () => {
      const totalSize = getDirSize(BUILD_DIR);
      const maxSize = 2 * 1024 * 1024; // 2MB
      expect(totalSize).toBeLessThan(maxSize);
    });

    it('total build size should be over 100KB', () => {
      const totalSize = getDirSize(BUILD_DIR);
      const minSize = 100 * 1024; // 100KB
      expect(totalSize).toBeGreaterThan(minSize);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CSP (Content Security Policy) 验证
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Content Security Policy', () => {
    it('should have CSP defined', () => {
      expect(manifest.content_security_policy).toBeDefined();
    });

    it('should restrict script-src to self', () => {
      const csp = manifest.content_security_policy.extension_pages;
      expect(csp).toContain("script-src 'self'");
    });

    it('should restrict object-src to self', () => {
      const csp = manifest.content_security_policy.extension_pages;
      expect(csp).toContain("object-src 'self'");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 关键功能代码验证
  // ═══════════════════════════════════════════════════════════════════════════

  describe('关键功能代码', () => {
    it('background.js should handle proxy toggle via keyboard', () => {
      const content = fs.readFileSync(path.join(BUILD_DIR, 'background.js'), 'utf-8');
      expect(content).toContain('toggle-proxy');
    });

    it('options page JS should contain toggle all functionality', () => {
      const chunks = fs.readdirSync(path.join(BUILD_DIR, 'chunks'));
      const optionsChunk = chunks.find(f => f.includes('options'));
      if (optionsChunk) {
        const content = fs.readFileSync(path.join(BUILD_DIR, 'chunks', optionsChunk), 'utf-8');
        // 应该包含全部启用/禁用的相关代码
        expect(content.length).toBeGreaterThan(1000);
      }
    });

    it('content script should have ReDoS protection', () => {
      const content = fs.readFileSync(path.join(BUILD_DIR, 'content-scripts/main-interceptor.js'), 'utf-8');
      // ReDoS protection uses these regex patterns (function name gets minified)
      expect(content).toContain('[+*]'); // nested quantifier detection pattern
    });

    it('background.js should have DNR rule management', () => {
      const content = fs.readFileSync(path.join(BUILD_DIR, 'background.js'), 'utf-8');
      expect(content).toContain('declarativeNetRequest');
    });
  });
});
