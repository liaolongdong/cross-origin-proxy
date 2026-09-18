import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { splitHighlight } from '@/utils/highlight';

function text(seg: { text: string }[]): string {
  return seg.map(s => s.text).join('');
}

describe('splitHighlight', () => {
  it('切片拼回原文（一个字符都不许多或少）', () => {
    const cases: [string, string][] = [
      ['https://a.com/x?b=1&c=2', '&'],
      ['fooBARbar', 'bar'],
      ['a', 'a'],
      ['nothing here', 'zzz'],
      ['多字节 表情 🙈 也照常切', '表情'],
    ];
    for (const [src, kw] of cases) {
      expect(text(splitHighlight(src, kw)), src).toBe(src);
    }
  });

  it('搜 `&` 能命中字面 &，而不是被 HTML 实体挡掉', () => {
    const segs = splitHighlight('a=1&b=2', '&');
    expect(segs).toEqual([
      { text: 'a=1', hit: false },
      { text: '&', hit: true },
      { text: 'b=2', hit: false },
    ]);
  });

  it('搜 amp / ; 只在真实文本上命中，不会打断任何实体', () => {
    expect(text(splitHighlight('Tom & Jerry', 'amp'))).toBe('Tom & Jerry');
    const segs = splitHighlight('Q&A; subset', ';');
    expect(segs.map(s => [s.text, s.hit])).toEqual([
      ['Q&A', false],
      [';', true],
      [' subset', false],
    ]);
  });

  it('大小写不敏感且命中所有出现位置', () => {
    const segs = splitHighlight('Foo bar foo', 'FOO');
    expect(segs.filter(s => s.hit).map(s => s.text)).toEqual(['Foo', 'foo']);
  });

  it('关键字里的正则元字符按字面量处理', () => {
    expect(text(splitHighlight('cost is 10.5', '.'))).toBe('cost is 10.5');
    expect(splitHighlight('abc', '.')).toEqual([{ text: 'abc', hit: false }]);
    const segs = splitHighlight('a.*b and axxb', '.*');
    expect(segs.filter(s => s.hit).map(s => s.text)).toEqual(['.*']);
  });

  it('空关键字 / 空文本返回可直渲的单段或空数组', () => {
    expect(splitHighlight('abc', '')).toEqual([{ text: 'abc', hit: false }]);
    expect(splitHighlight('', 'abc')).toEqual([]);
  });

  it('同一关键字连续切换文本时不残留上次状态', () => {
    expect(splitHighlight('xx', 'x').filter(s => s.hit)).toHaveLength(2);
    expect(splitHighlight('yy', 'x')).toEqual([{ text: 'yy', hit: false }]);
    expect(splitHighlight('xx', 'x').filter(s => s.hit)).toHaveLength(2);
  });
});

describe('[P3] 高亮不再走 v-html', () => {
  const tableSrc = fs.readFileSync('components/options/RuleTable.vue', 'utf-8');

  it('表格三列改用 HighlightText 组件渲染', () => {
    expect(tableSrc).not.toContain('v-html');
    expect(tableSrc).not.toContain('highlightText(');
    expect(tableSrc.match(/<HighlightText/g)?.length).toBe(3);
  });

  it('不再需要为 v-html 关闭规则', () => {
    expect(tableSrc).not.toContain('eslint-disable');
  });
});
