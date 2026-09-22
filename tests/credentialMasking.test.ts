import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { maskHeaderValue, resolveHeaderDisplayValue } from '@/utils/headerMask';
import { isSensitiveHeaderName } from '@/utils/exportSanitize';

// ═══════════════════════════════════════════════════════════════════════════════
// 日志详情的凭据打码（屏幕上画什么，与存储和导出无关）
//
// 详情面板里躺着的是**真实站点**的 Cookie / Authorization：投屏、录屏、贴截图都会把它带出去。
// 判据与导出脱敏同源（`isSensitiveHeaderName`），差别是这里只画成掩码——行还在、头名还在、
// 值仍留在本地，排障要看的就是「这个头有没有发、发的是哪一把」。
// ═══════════════════════════════════════════════════════════════════════════════

describe('maskHeaderValue', () => {
  it('长值留尾 4 位（真实 token 的辨识度全在结尾）', () => {
    expect(maskHeaderValue('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh')).toBe('•••••••••••• efgh');
  });

  it('短值整串覆盖：长度只有几位时尾巴就是全部', () => {
    const masked = maskHeaderValue('abc1234');
    expect(masked).toBe('••••••••••••');
    expect(masked).not.toContain('abc');
  });

  it('掩码段定长：不回报原长度', () => {
    const short = maskHeaderValue('12345678901234567890');
    const long = maskHeaderValue('1234567890'.repeat(6));
    expect(short.split(' ')[0]).toBe(long.split(' ')[0]);
  });

  it('空值不炸', () => {
    expect(maskHeaderValue('')).toBe('••••••••••••');
    expect(maskHeaderValue(undefined as unknown as string)).toBe('••••••••••••');
  });

  it('按码点切，非 ASCII 值不会切出代理对半成品', () => {
    expect(maskHeaderValue('🔑'.repeat(20))).toBe(`•••••••••••• ${'🔑'.repeat(4)}`);
    expect(maskHeaderValue('令牌值很长很长很长')).toBe('••••••••••••');
  });
});

describe('resolveHeaderDisplayValue — 只有会带出凭据的头被打码', () => {
  it('敏感头默认打码', () => {
    expect(resolveHeaderDisplayValue('Authorization', 'Bearer abcdefghijklmnop', false)).toBe('•••••••••••• mnop');
    expect(resolveHeaderDisplayValue('cookie', 'sid=1234567890abcdef', false)).toBe('•••••••••••• cdef');
  });

  it('非敏感头原样显示（Content-Type 打码只会挡住排障）', () => {
    expect(resolveHeaderDisplayValue('Content-Type', 'application/json', false)).toBe('application/json');
  });

  it('开关打开时原样显示', () => {
    expect(resolveHeaderDisplayValue('Authorization', 'Bearer abcdefghijklmnop', true)).toBe('Bearer abcdefghijklmnop');
  });

  it('判据与导出脱敏同源，两条路径不会一边抹一边漏', () => {
    for (const name of ['authorization', 'Cookie', 'X-CSRF-Token', 'Set-Cookie', 'api-key']) {
      expect(isSensitiveHeaderName(name)).toBe(true);
      expect(resolveHeaderDisplayValue(name, 'abcdefghijklmnop', false)).not.toContain('abcdefghijklmn');
    }
    // 计数头不是凭据：精确匹配而非子串，别把它一起打了码
    expect(isSensitiveHeaderName('x-token-refresh-interval')).toBe(false);
    expect(resolveHeaderDisplayValue('x-token-refresh-interval', '3600', false)).toBe('3600');
  });
});

describe('LogDrawer 接线（源码契约）', () => {
  const src = fs.readFileSync('components/options/LogDrawer.vue', 'utf-8');

  it('请求头与响应头两处的值都经过打码出口', () => {
    expect(src).toContain('displayHeaderValue(key, value)');
    // 表格只画 URL，值只出现在详情面板的两张头表里
    expect(src.match(/displayHeaderValue\(key, value\)/g)).toHaveLength(2);
  });

  it('「显示原值」默认关，且不落 storage（关掉抽屉就收回）', () => {
    expect(src).toContain('const revealSensitive = ref(false)');
    expect(src).not.toMatch(/STORAGE_KEYS\.\w*(REVEAL|SENSITIVE)/);
  });

  it('方法筛选与规则表单共用 HTTP_METHODS，不再写死四项', () => {
    expect(src).toContain('v-for="method in HTTP_METHODS"');
    expect(src).not.toContain('label="PATCH"');
  });
});
