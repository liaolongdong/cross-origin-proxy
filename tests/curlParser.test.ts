import { describe, it, expect } from 'vitest';
import { parseCurlCommand, tokenizeCurl } from '@/utils/curlParser';

describe('tokenizeCurl', () => {
  it('单引号内容原样保留（含空格与双引号）', () => {
    expect(tokenizeCurl(`curl 'https://a.com/x y'`)).toEqual(['curl', 'https://a.com/x y']);
    expect(tokenizeCurl(`-d '{"a":"b c"}'`)).toEqual(['-d', '{"a":"b c"}']);
  });

  it('双引号内支持反斜杠转义', () => {
    expect(tokenizeCurl(`-d "{\\"a\\":1}"`)).toEqual(['-d', '{"a":1}']);
  });

  it('引号外反斜杠转义与空白分词', () => {
    expect(tokenizeCurl('a\\ b  c')).toEqual(['a b', 'c']);
  });

  it('空串/空引号边界', () => {
    expect(tokenizeCurl('')).toEqual([]);
    expect(tokenizeCurl(`curl ''`)).toEqual(['curl', '']);
  });
});

describe('parseCurlCommand', () => {
  it('最简形式：裸 URL → GET 无头无体', () => {
    const r = parseCurlCommand('curl https://api.example.com/users');
    expect(r).toEqual({ url: 'https://api.example.com/users', method: 'GET', headers: {}, body: undefined });
  });

  it('DevTools 风格：单引号 + 行续 + 请求头 + data-raw → POST', () => {
    const cmd = `curl 'https://api.example.com/login' \\
      -H 'content-type: application/json' \\
      -H 'authorization: Bearer abc' \\
      --data-raw '{"user":"a"}'`;
    const r = parseCurlCommand(cmd);
    expect(r).not.toBeNull();
    expect(r!.url).toBe('https://api.example.com/login');
    expect(r!.method).toBe('POST');
    expect(r!.headers['content-type']).toBe('application/json');
    expect(r!.headers['authorization']).toBe('Bearer abc');
    expect(r!.body).toBe('{"user":"a"}');
  });

  it('显式 -X 优先于推断', () => {
    const r = parseCurlCommand(`curl -X PUT https://a.com/x --data 'v'`);
    expect(r!.method).toBe('PUT');
  });

  it('多个 -d 以 & 连接', () => {
    const r = parseCurlCommand(`curl https://a.com -d 'a=1' --data 'b=2'`);
    expect(r!.body).toBe('a=1&b=2');
    expect(r!.method).toBe('POST');
  });

  it('--json 自动补 Content-Type，已存在时不覆盖', () => {
    const r = parseCurlCommand(`curl --json '{"a":1}' https://a.com`);
    expect(r!.headers['Content-Type']).toBe('application/json');
    const r2 = parseCurlCommand(`curl --json '{}' -H 'Content-Type: text/plain' https://a.com`);
    expect(r2!.headers['Content-Type']).toBe('text/plain');
  });

  it('-u 凭据转 Basic 认证头', () => {
    const r = parseCurlCommand(`curl -u user:pass https://a.com`);
    expect(r!.headers['Authorization']).toBe(`Basic ${btoa('user:pass')}`);
  });

  it('快捷选项映射为请求头', () => {
    const r = parseCurlCommand(`curl -A 'UA/1.0' -e 'https://r.com' -b 'sid=1' https://a.com`);
    expect(r!.headers['User-Agent']).toBe('UA/1.0');
    expect(r!.headers['Referer']).toBe('https://r.com');
    expect(r!.headers['Cookie']).toBe('sid=1');
  });

  it('--url 与 --header=value 形式', () => {
    const r = parseCurlCommand(`curl --url=https://a.com/p --header='X-T: 1'`);
    expect(r!.url).toBe('https://a.com/p');
    expect(r!.headers['X-T']).toBe('1');
  });

  it('Windows 风格双引号', () => {
    const r = parseCurlCommand(`curl "https://a.com" -H "X-Foo: bar"`);
    expect(r!.url).toBe('https://a.com/');
    expect(r!.headers['X-Foo']).toBe('bar');
  });

  it('头值末尾分号表示空值头', () => {
    const r = parseCurlCommand(`curl -H 'X-Empty;' https://a.com`);
    expect(r!.headers['X-Empty']).toBe('');
  });

  it('未知布尔开关与带参选项安全跳过', () => {
    const r = parseCurlCommand(`curl -s -k --compressed -o out.bin --connect-timeout 5 https://a.com`);
    expect(r!.url).toBe('https://a.com/');
    expect(r!.method).toBe('GET');
  });

  it('开头 $ 提示符被清理', () => {
    const r = parseCurlCommand(`$ curl https://a.com`);
    expect(r!.url).toBe('https://a.com/');
  });

  it('非法输入返回 null', () => {
    expect(parseCurlCommand('')).toBeNull();
    expect(parseCurlCommand('hello world')).toBeNull();
    expect(parseCurlCommand('curl not-a-url')).toBeNull();
    expect(parseCurlCommand('curl -H "NoColonHere" https://a.com')).not.toBeNull();
    expect(parseCurlCommand(null as unknown as string)).toBeNull();
  });
});
