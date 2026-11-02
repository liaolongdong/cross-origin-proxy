import { describe, expect, it } from 'vitest';
import { decodeHashValue } from '@/utils/hashParam';

/**
 * `decodeHashValue` 住在这个文件里测：它是地址栏里那一串的唯一解码出口，
 * 判据只有一件事——**畸形输入回空串，绝不向上抛**。
 *
 * 抛错的代价不是「这一格没读到」而是「整条 hash 分派中途退出」：
 * `handleHashNavigation` 把 `history.replaceState`（抹掉 hash）排在所有分支之后，
 * 于是畸形串会留在地址栏里，每次刷新再走一遍同一个抛出。
 */
describe('decodeHashValue — 地址栏取值按不可信输入处理', () => {
  it('正常编码串解回原值', () => {
    const url = 'https://fat.example.com/api/users?a=1&b=%E4%B8%AD#frag';
    expect(decodeHashValue(encodeURIComponent(url))).toBe(url);
  });

  it('畸形百分号序列回空串而不是抛 URIError', () => {
    expect(() => decodeURIComponent('%ZZ')).toThrow();
    expect(decodeHashValue('%ZZ')).toBe('');
    expect(decodeHashValue('%E0%A4%A')).toBe('');
    expect(decodeHashValue('https://a.com/?x=%')).toBe('');
  });

  it('没带值与空串同档：回空串', () => {
    expect(decodeHashValue('')).toBe('');
    expect(decodeHashValue(null)).toBe('');
    expect(decodeHashValue(undefined)).toBe('');
  });

  it('未编码的裸 % 也按畸形处理（调用方必须显式 encodeURIComponent）', () => {
    // 「100%」这种值走不到配置页：popup 侧永远编码后再拼 hash，这里解不出就当没带。
    expect(decodeHashValue('100%')).toBe('');
  });
});
