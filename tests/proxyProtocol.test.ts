import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { PROXYABLE_PROTOCOLS, isProxyableUrl, protocolOf } from '@/utils/proxyProtocol';

/**
 * `utils/proxyProtocol.ts` —— 代发前的那道协议闸
 *
 * 守的不是「规则写得对不对」，而是「扩展该不该替这一页出门」。`PROXY_REQUEST` 的 `url` 由页面给，
 * 同页任意脚本都能往桥接层那个频道发消息；一条合法形状的 `{wildcard, '*', targetUrl:''}` 规则
 * 会把匹配、分流、重写三件事各自都做对，叠起来却等于「页面点名、扩展代发、正文送回页面」。
 * 这里按**输入 → 答案**逐个核，不靠源码 grep：这道闸一旦静默改判，症状是扩展替陌生地址出门，
 * 界面上什么都不会发生。
 */
describe('isProxyableUrl — 只有 http(s) 能由扩展代发', () => {
  it('白名单就是那两项，别顺手往里加', () => {
    expect(PROXYABLE_PROTOCOLS).toEqual(['http:', 'https:']);
  });

  it('http(s) 放行（含带查询、带片段、大写协议、端口与内网地址——协议闸不管这些）', () => {
    for (const url of [
      'http://a.com/',
      'https://a.com/x?y=1#z',
      'HTTP://a.com/x',
      'https://a.com:8443/x',
      'https://127.0.0.1:8080/api',
      'https://169.254.169.254/latest/meta-data/',
    ]) {
      expect(isProxyableUrl(url), url).toBe(true);
    }
  });

  it('其余协议一律拒：这五档正是「扩展出门一趟回来带东西」的那几种形状', () => {
    for (const url of [
      'file:///Users/me/.aws/credentials',
      'file:///C:/Windows/win.ini',
      'ftp://internal.example.com/secret',
      'data:text/plain;base64,SGVsbG8=',
      'blob:https://a.com/0f7c6c1e-1111-2222-3333-444455556666',
      'javascript:alert(1)',
      'about:config',
      'ws://internal.example.com/socket',
      'chrome-extension://otherext/payload.json',
    ]) {
      expect(isProxyableUrl(url), url).toBe(false);
    }
  });

  it('非字符串、空串与解析不出的串都算不可代发（默认方向朝保守）', () => {
    for (const value of ['', '   ', '/relative/path', 'not a url', '%ZZ', undefined, null, 123, {}, []]) {
      expect(isProxyableUrl(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('大小写协议名归一：`HTTPS://` 是真 URL，不是新协议', () => {
    expect(isProxyableUrl('HTTPS://a.com/x')).toBe(true);
  });
});

describe('protocolOf — 只说得出协议，说不出整串', () => {
  it('读得出时给带冒号的小写协议', () => {
    expect(protocolOf('file:///etc/hosts')).toBe('file:');
    expect(protocolOf('HTTP://a.com/')).toBe('http:');
  });

  it('读不出时给空串，而不是抛出（日志那一头只想要一个词）', () => {
    for (const value of ['', 'garbage', '/x', undefined, null, 42, {}]) {
      expect(protocolOf(value), JSON.stringify(value)).toBe('');
    }
  });
});

describe('白名单只有一份（源码契约）', () => {
  const handler = fs.readFileSync('entrypoints/background/proxyHandler.ts', 'utf-8');
  const replay = fs.readFileSync('utils/requestReplay.ts', 'utf-8');

  it('两个消费方都从这一个模块取，不各写一把尺', () => {
    expect(handler).toContain("import { isProxyableUrl, protocolOf } from '@/utils/proxyProtocol';");
    expect(replay).toContain("import { PROXYABLE_PROTOCOLS, protocolOf } from '@/utils/proxyProtocol';");
    // 重放那一头此前自带一份 `['http:', 'https:']`：两扇门后面是同一次 `fetch`，
    // 各留一把尺的下场是其中一扇门将来悄悄多放行一个协议
    expect(replay).not.toMatch(/\[\s*'http:'\s*,\s*'https:'\s*\]/);
  });

  it('后台那两扇门都还在：入站那一串与重写之后的那一串', () => {
    // 「只守入站」是容易写错的那一半——`targetUrl` 同样是自由文本（手改存储、导入文件），
    // 页面给的是 https 而过闸、重写出一个本地路径照样出门。少任何一处都是半个答案。
    expect(handler.match(/if \(!isProxyableUrl\(/g) ?? []).toHaveLength(2);
    expect(handler.match(/body: 'Unsupported protocol'/g) ?? []).toHaveLength(2);
  });
});
