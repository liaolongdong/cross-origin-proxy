/**
 * `diffRewrite` 的单测
 *
 * 这个函数只服务界面高亮，但它有一个硬性不变量：**三段拼回去必须等于目标地址**
 * （画出来的强调不能是地址里不存在的字符）。所以每条用例都同时断言切分结果与不变量，
 * 而不是只挑几个好看的例子。
 */
import { describe, it, expect } from 'vitest';
import { diffRewrite } from '@/utils/rewriteDiff';

describe('diffRewrite —— 硬性不变量', () => {
  const pairs: [string, string][] = [
    ['https://fat-api.example.com/api/users', 'https://uat-api.example.com/api/users'],
    ['https://a.com/x', 'https://a.com/api/x'],
    ['https://a.com/api/x', 'https://a.com/x'],
    ['https://fat.example.com/a/b/c?x=1', 'https://uat.example.com/a/b/c?x=1'],
    ['', ''],
    ['abc', 'x'],
    ['https://x.com', 'http://x.com'],
    ['同一段中文地址/接口', '同一段中文地址/API'],
  ];

  it('三段拼回去永远等于目标地址', () => {
    for (const [source, target] of pairs) {
      const { before, changed, after } = diffRewrite(source, target);
      expect(`${before}${changed}${after}`).toBe(target);
    }
  });

  it('前后缀不重叠：共用的部分只算一次', () => {
    for (const [source, target] of pairs) {
      const { before, changed, after } = diffRewrite(source, target);
      // `before` 必须是目标的前缀、`after` 必须是目标的后缀，且三段长度不越界
      expect(target.startsWith(before)).toBe(true);
      expect(target.endsWith(after)).toBe(true);
      // 「共用」得真的共用：这两段同时也出现在源地址里，不然高亮就是凭空圈的
      expect(source.startsWith(before)).toBe(true);
      expect(source.endsWith(after)).toBe(true);
      expect(before.length + changed.length + after.length).toBe(target.length);
    }
  });
});

describe('diffRewrite —— 界面要能说的话', () => {
  it('换主机名：高亮对齐到被换掉的那一整个词段，而不是一个字母', () => {
    const diff = diffRewrite('https://fat-api.example.com/api/users', 'https://uat-api.example.com/api/users');
    expect(diff.before).toBe('https://');
    // 裸的最小字符编辑会把 'at' 算成共用后缀，于是高亮只剩一个 'u'——
    // 而读者要看的「这一段被换成了什么」恰恰是 'uat'。对齐到词边界，但不跨过分隔符。
    expect(diff.changed).toBe('uat');
    expect(diff.after).toBe('-api.example.com/api/users');
  });

  it('版本位换掉一个字符：整段路径参数一起点名', () => {
    expect(diffRewrite('https://a.com/v1/x', 'https://a.com/v2/x').changed).toBe('v2');
  });

  it('整段主机名不同：高亮正好是那一截', () => {
    expect(diffRewrite('https://fat.example.com/a', 'https://uat.internal/a').changed).toBe('uat.internal');
  });

  it('未改写（目标与源相同）时不产生空的高亮块', () => {
    const same = 'https://api.example.com/x';
    expect(diffRewrite(same, same)).toEqual({ before: same, changed: '', after: '' });
  });

  it('纯插入：只有插进来的那段被点名', () => {
    const diff = diffRewrite('https://a.com/x', 'https://a.com/api/x');
    expect(diff.before).toBe('https://a.com/');
    expect(diff.changed).toBe('api/');
    expect(diff.after).toBe('x');
  });

  it('纯删除：目标里没有可高亮的字符，changed 为空而不是报错', () => {
    // 边界对齐**不**适用于空段——把隔壁那个没动过的词段染上色，是凭空圈人，
    // 比不圈更糟（这条功能的立身之本是「不说谎」）。
    expect(diffRewrite('https://a.com/api/x', 'https://a.com/x').changed).toBe('');
  });

  it('协议降级（https → http）：目标里没有新字符，于是只有前后缀', () => {
    const diff = diffRewrite('https://x.com', 'http://x.com');
    expect(diff.before).toBe('http');
    expect(diff.changed).toBe('');
    expect(diff.after).toBe('://x.com');
  });

  it('对齐永远不从词的中间开始、也不在词的中间收尾', () => {
    const pairs: [string, string][] = [
      ['https://fat-api.example.com/api/users', 'https://uat-api.example.com/api/users'],
      ['https://a.com/v1/x', 'https://a.com/v2/x'],
      ['https://abc.com/x', 'https://abd.com/x'],
      ['https://fat.example.com/a/b/c?x=1', 'https://uat.example.com/a/b/c?x=1'],
      ['同一段中文地址/接口', '同一段中文地址/API'],
      ['https://a.com/x', 'https://a.com/api/x'],
      ['abc', 'x'],
    ];
    // 这份判据刻意抄自 `isWordChar` 而不是 import 它：oracle 复用被测物，写坏了就一起绿。
    const isWord = (char: string) => /[A-Za-z0-9一-鿿]/.test(char);
    for (const [source, target] of pairs) {
      const { changed } = diffRewrite(source, target);
      if (changed === '') continue;
      const start = target.indexOf(changed);
      expect(start >= 0).toBe(true);
      const end = start + changed.length;
      // 段首是词字符时，它左边必须是分隔符（或就是开头）——否则是「从词中间染起」
      if (isWord(changed[0])) expect(start === 0 || !isWord(target[start - 1])).toBe(true);
      // 段尾同理
      if (isWord(changed[changed.length - 1])) expect(end === target.length || !isWord(target[end])).toBe(true);
    }
  });
});
