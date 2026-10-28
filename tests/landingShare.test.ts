import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MARKETING_PAGES = ['docs/index.html', 'docs/en.html', 'docs/alternatives.html', 'docs/en-alternatives.html'];
const ZW_PAGES = ['docs/index.html', 'docs/alternatives.html'];
const EN_PAGES = ['docs/en.html', 'docs/en-alternatives.html'];
const STORE_URL = 'https://chromewebstore.google.com/detail/dednngakllblfilbndkaggphohmpgcbg';

const read = (file: string) => readFileSync(file, 'utf-8');
const count = (src: string, pattern: RegExp) => (src.match(pattern) ?? []).length;

describe('产品站分享入口与移动安装条（源码契约）', () => {
  it('四个营销页各有两枚分享入口、一个播报区、一条安装条', () => {
    for (const page of MARKETING_PAGES) {
      const src = read(page);
      expect(count(src, /data-share(?![\w-])/g), `${page} 的分享入口数`).toBe(2);
      expect(count(src, /data-share-status/g), `${page} 的播报区数`).toBe(1);
      expect(count(src, /data-install-bar/g), `${page} 的安装条数`).toBe(1);
      expect(count(src, /data-install-dismiss/g), `${page} 的关闭按钮数`).toBe(1);
      expect(src, `${page} 没指向商店`).toContain(STORE_URL);
    }
  });

  it('隐私页不出现分享与安装条：政策页不放转化组件', () => {
    const privacy = read('docs/privacy.html');
    expect(privacy).not.toContain('data-share');
    expect(privacy).not.toContain('data-install-bar');
  });

  it('分享文案住在 HTML，中英各自成对；脚本里不写界面语言', () => {
    for (const page of ZW_PAGES) {
      const src = read(page);
      expect(src).toContain('data-copied="链接已复制"');
      expect(src).toContain('data-failed="复制失败，请手动复制地址"');
    }
    for (const page of EN_PAGES) {
      const src = read(page);
      expect(src).toContain('data-copied="Link copied"');
      expect(src).toContain('data-failed="Copy failed — copy the address manually"');
    }
    const js = read('docs/assets/landing.js');
    expect(js).not.toContain('链接已复制');
    expect(js).not.toContain('Link copied');
    expect(js).not.toContain('复制失败，请手动复制地址');
    expect(js).not.toContain('Copy failed — copy the address manually');
  });

  it('无 JS 时三个入口都不画：默认 display:none，只有 html.js 才显形', () => {
    const css = read('docs/assets/landing.css');
    expect(css).toMatch(/\.share-btn\s*\{\s*display:\s*none;/);
    expect(css).toMatch(/\.footer-share\s*\{\s*display:\s*none;/);
    expect(css).toMatch(/\.install-bar\s*\{\s*display:\s*none;/);
    expect(css).toContain('html.js .share-btn');
    expect(css).toContain('html.js .footer-share');
    expect(css).toContain('html.js .install-bar');
  });

  it('跨页转场只在 prefers-reduced-motion: no-preference 下启用，且全仓只有一条', () => {
    const css = read('docs/assets/landing.css');
    expect(count(css, /@view-transition/g), '重复的 @view-transition').toBe(1);
    const ruleAt = css.indexOf('@view-transition');
    const mediaAt = css.lastIndexOf('@media (prefers-reduced-motion: no-preference)', ruleAt);
    expect(mediaAt, '转场没有被 no-preference 包住').toBeGreaterThan(-1);
    expect(mediaAt, '媒体查询排在转场之后').toBeLessThan(ruleAt);
  });

  it('减弱动效档把安装条的下滑收掉', () => {
    const css = read('docs/assets/landing.css');
    const reduceAt = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(reduceAt).toBeGreaterThan(-1);
    const reduce = css.slice(reduceAt);
    expect(reduce).toContain('html.js .install-bar');
    expect(reduce).toContain('transition: none;');
  });

  it('脚本只做行为：系统分享 + AbortError 静默 + 剪贴板降级，不写本地状态也不埋点', () => {
    const js = read('docs/assets/landing.js');
    expect(js).toContain('navigator.share');
    expect(js).toContain("error.name === 'AbortError'");
    expect(js).toContain('copyText(location.href)');
    expect(js).toContain('data-install-bar');
    expect(js).toContain('data-install-dismiss');
    expect(js).toContain('navMenu.open');
    expect(js).not.toContain('localStorage');
    expect(js).not.toContain('sessionStorage');
    expect(js).not.toContain('sendBeacon');
    expect(js).not.toContain('gtag');
  });
});
