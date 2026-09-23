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
  it('换主机名：高亮落在真正换掉的那一段，共用的头尾不进高亮', () => {
    const diff = diffRewrite('https://fat-api.example.com/api/users', 'https://uat-api.example.com/api/users');
    expect(diff.before).toBe('https://');
    expect(diff.changed).toBe('u');
    expect(diff.after).toBe('at-api.example.com/api/users');
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
    expect(diffRewrite('https://a.com/api/x', 'https://a.com/x').changed).toBe('');
  });

  it('协议降级（https → http）：目标里没有新字符，于是只有前后缀', () => {
    const diff = diffRewrite('https://x.com', 'http://x.com');
    expect(diff.before).toBe('http');
    expect(diff.changed).toBe('');
    expect(diff.after).toBe('://x.com');
  });
});
