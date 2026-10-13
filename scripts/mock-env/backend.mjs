/**
 * 单个环境的模拟后端（dev / fat / uat / prod / web 共用同一份路由表）
 *
 * 为什么路由表要在环境之间完全一致：代理规则是按**路径**写的
 * （`http://localhost:5302/api/*` → `http://localhost:5303`），只要目标环境少一条路由，
 * 「重写生效了」与「重写把我带进 404」在界面上就长成一个样子。同一份表 + 每个响应都带
 * `env` 字段，才让「这一笔到底落到了哪个环境」成为一个可分辨的断言。
 *
 * CORS 按环境分级，不是随手配的：
 * - `wildcard`（dev）：`Access-Control-Allow-Origin: *`。这是**网络层重写唯一接得住的一档**——
 *   一条把请求改写到另一个原点的规则，会让目标收到 `Origin: null`（同原点内的改写不受影响），
 *   2026-10-13 在 Chrome for Testing 155 实测；回显式的后端在这种请求下一律判失败，
 *   真实后端按回显写 CORS 时是同一个下场，所以这一档必须存在，演示规则集的纯重写那几条才落得住。
 * - `local`（web/fat）：回显任意本机来源。页面**直接**跨端口请求它时 200，
 *   一旦走跨原点的网络层重写就接不住——这正是上面那一档存在的理由。
 * - `harness`（uat）：只放行触发页那一个来源，模拟「UAT 只给已登记的前端域名放行」；
 * - `none`（prod）：任何来源都不放行——这就是「必须走后台通道」的那一面，
 *   与 README 里「关于 CORS，说准确一点」那段是同一件事，可以用一条纯重写规则当场证伪。
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

/** 请求体读取上限：比扩展侧 10MB 的代发上限高一档，才量得出「超限是被扩展拦下的」 */
const MAX_READ_BODY = 24 * 1024 * 1024;

/** 按 RFC 9110 不能带响应正文的状态码——扩展的回包形状约束与此同源 */
const NO_BODY_STATUS = new Set([101, 204, 205, 304]);

/** `?corp=` 只认这三个值：写错就当作没配，免得把一个拼错的头值当成「响应把你拦下了」的证据 */
const CORP_VALUES = new Set(['same-origin', 'same-site', 'cross-origin']);

/**
 * 五个环境的静态描述。
 *
 * `cors` 是 `resolveAllowOrigin` 那四档里的一档；`port` 是默认端口，`--base` 会整体平移。
 * dev 单独占 `wildcard` 这一档，是因为演示规则集里「纯重写 · 网络层」那几条都落脚在它身上，
 * 而那条通道改写完的 `Origin` 是 `null`（见 `resolveAllowOrigin` 的说明）。
 */
export const ENVS = {
  web: { port: 5300, cors: 'local', note: '触发页 + 自己的同源 API' },
  dev: { port: 5301, cors: 'wildcard', note: '本机开发后端（CORS 放行任意来源，网络层重写接得住）' },
  fat: { port: 5302, cors: 'local', note: '功能测试环境（页面默认请求它）' },
  uat: { port: 5303, cors: 'harness', note: '验收环境（只放行触发页来源）' },
  prod: { port: 5304, cors: 'none', note: '生产镜像（不放行任何来源，必须走后台通道）' },
};

/** 8x8 24 位无压缩 BMP：不抄任何现成 base64，全部字节按定义算出来 */
function buildBmp() {
  const width = 8;
  const height = 8;
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowBytes * height, 0);
  // 24 位 BMP 的通道顺序是 BGR（不是 RGB），行首字节是蓝；每行补齐到 4 的倍数
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * rowBytes + x * 3;
      pixels[at] = 40 + x * 26;
      pixels[at + 1] = 90 + y * 20;
      pixels[at + 2] = 200;
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}

const BMP = buildBmp();

/** 本机来源判定：localhost / 127.0.0.1 加任意端口 */
function isLocalOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * 这一笔来源能不能被放行
 *
 * `local` / `harness` / `none` 三档只在能放行时**回显**具体 origin：`sendCredentials` 那档要的是
 * `Access-Control-Allow-Credentials: true`，而它与 `*` 同时出现时浏览器直接判失败，
 * 一份「看起来更宽松」的实现反而会把带 Cookie 的用例变成一个查不出来的假故障。
 *
 * `wildcard` 是第四档，专门给「网络层重写」的那几条规则落脚：2026-10-13 在 Chrome for Testing 155
 * 实测过，一条把请求改写到**另一个原点**的 declarativeNetRequest 规则，会让目标收到 `Origin: null`
 * （同一原点内的改写不受影响，Origin 原样带过去）。回显式的三档因此一律接不住这种请求，
 * 页面只剩 `net::ERR_FAILED`——这不是模拟后端的毛病，是真后端按回显写 CORS 时同样的下场。
 * 所以「纯重写 · 网络层」那几条的目标环境必须放行 `*`，这一档就是它。
 */
function resolveAllowOrigin(origin, mode, harnessOrigin) {
  if (mode === 'wildcard') return '*';
  if (!origin) return null;
  if (mode === 'none') return null;
  if (mode === 'harness') return origin === harnessOrigin ? origin : null;
  return isLocalOrigin(origin) ? origin : null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        // 越界后继续把请求体排空、但不留内存：直接 destroy 会让这一笔连 413 都回不去，
        // 而页面看到的只是「网络错误」，量不出「谁把这笔拦下了」。
        overflow = true;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on('end', () => (overflow ? reject(new Error('PAYLOAD_TOO_LARGE')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

/** 取头里的整数，带钳制（所有 `?ms=` / `?kb=` / `?fail=` 一类参数只认这一套读法） */
function intParam(searchParams, name, fallback, min, max) {
  const raw = searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/**
 * 创建一个环境的 HTTP 服务
 *
 * @param {{env: string, port: number, host?: string, harnessOrigin?: string, pageHtml?: string|null, quiet?: boolean}} options
 * @returns {{server: import('node:http').Server, ctx: object, origin: string}}
 */
export function createEnvServer(options) {
  const { env, port, host = '127.0.0.1', harnessOrigin = 'http://localhost:5300', pageHtml = null } = options;
  const cfg = ENVS[env] ?? { cors: 'local', note: '' };
  const ctx = {
    env,
    port,
    corsMode: cfg.cors,
    startedAt: Date.now(),
    counts: { requests: 0, telemetry: 0, websocketHandshakes: 0, proxiedFromPage: 0 },
    flaky: new Map(),
  };

  const send = (req, res, status, body, extraHeaders = {}, contentType = 'application/json; charset=utf-8') => {
    const origin = req.headers.origin;
    const allowed = resolveAllowOrigin(origin, cfg.cors, harnessOrigin);
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      Vary: 'Origin',
      'X-Cop-Env': env,
      'X-Cop-Port': String(port),
      'X-Cop-Request-Seq': String(ctx.counts.requests),
      'Access-Control-Expose-Headers': 'X-Cop-Env,X-Cop-Port,X-Cop-Request-Seq',
      ...extraHeaders,
    };
    if (allowed) {
      headers['Access-Control-Allow-Origin'] = allowed;
      // `*` 与 Allow-Credentials 同时出现，浏览器一律判失败——所以带凭据那一档只能回显具体来源
      if (allowed !== '*') headers['Access-Control-Allow-Credentials'] = 'true';
    }
    // CORP / COEP 由查询参数决定：这一类失败是**响应自己**把请求拦下的，与 CORS 是两件事——
    // 纯网络层重写改的是请求落点、改不了响应头，所以它只能由后台代发那一侧救。
    // 用它才能把「DevTools 里那行 `ERR_BLOCKED_BY_RESPONSE`」造出来，而不是只剩一句猜测。
    const policies = new URL(req.url, `http://127.0.0.1:${port}`).searchParams;
    const corp = policies.get('corp');
    if (CORP_VALUES.has(corp)) headers['Cross-Origin-Resource-Policy'] = corp;
    if (policies.get('coep') === '1') headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    if (cfg.cors === 'none') {
      // 让「这一档不放行任何来源」这件事在界面上可读，而不是只剩一条 CORS 报错
      headers['X-Cop-Cors'] = 'denied-for-all-origins';
    } else {
      headers['X-Cop-Cors'] = allowed ? `allowed:${allowed}` : `mode:${cfg.cors}`;
    }
    if (body === null || body === undefined || NO_BODY_STATUS.has(status)) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const payload = Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    headers['Content-Length'] = String(payload.length);
    // HEAD 由 Node 自己吞掉正文、保留 Content-Length，不必在这里另写一份判据
    res.writeHead(status, headers);
    res.end(payload);
  };

  /**
   * 手写原始响应
   *
   * Node 会拒绝非 latin1 的状态行与头值（实测 `writeHead` / `setHeader` 抛
   * `ERR_INVALID_CHAR`），所以「上游把中文直接写进状态行」这一面只能绕开 `res`
   * 写字节。浏览器按 latin1 解码状态行与头，于是这一条的观感是**乱码**而不是报错——
   * 码点仍 ≤255，永远不构成 ByteString 违规。真正会踩到那条约束的是**规则配置**
   * （`responseOverrides.statusText` 写中文），服务端造不出它，所以那一份用例在
   * `presets/demo-rules.json` 里。
   *
   * `detachSocket` 会把 `res.socket` 置空，所以必须先把 socket 抓在手里。
   */
  const sendRaw = (req, res, statusLine, headerLines, bodyText) => {
    const socket = res.socket ?? req.socket;
    const allowed = resolveAllowOrigin(req.headers.origin, cfg.cors, harnessOrigin);
    const lines = [
      `HTTP/1.1 ${statusLine}`,
      ...headerLines,
      ...(allowed
        ? [
            `Access-Control-Allow-Origin: ${allowed}`,
            ...(allowed === '*' ? [] : ['Access-Control-Allow-Credentials: true']),
          ]
        : []),
      `Content-Length: ${Buffer.byteLength(bodyText, 'utf8')}`,
      'Connection: close',
    ];
    const bytes = Buffer.from(`${lines.join('\r\n')}\r\n\r\n${bodyText}`, 'utf8');
    res.detachSocket(socket);
    socket.end(bytes);
  };

  const base = { env, port };

  const server = http.createServer(async (req, res) => {
    ctx.counts.requests += 1;
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const q = url.searchParams;
    const method = req.method || 'GET';
    const seq = ctx.counts.requests;

    // 预检：放行时给一份完整的 Allow-*，不放行时故意让浏览器在校验阶段失败
    if (method === 'OPTIONS') {
      const origin = req.headers.origin;
      const allowed = resolveAllowOrigin(origin, cfg.cors, harnessOrigin);
      if (allowed) {
        return send(req, res, 204, null, {
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
          'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
          'Access-Control-Max-Age': '0',
        });
      }
      return send(req, res, 403, {
        ...base,
        error: 'preflight_rejected',
        hint: '这一档不放行任何来源，需要走后台通道',
      });
    }

    if (path === '/' || path === '/index.html') {
      if (pageHtml) return send(req, res, 200, pageHtml, {}, 'text/html; charset=utf-8');
      return send(req, res, 200, { ...base, hint: '触发页只跑在 web 环境，接口清单见 /env', routes: ROUTES });
    }

    if (path === '/favicon.ico') {
      return send(req, res, 200, BMP, {}, 'image/bmp');
    }

    if (path === '/env') {
      return send(req, res, 200, {
        ...base,
        corsMode: cfg.cors,
        harnessOrigin,
        uptimeMs: Date.now() - ctx.startedAt,
        counts: ctx.counts,
        flakyKeys: [...ctx.flaky.entries()].map(([k, v]) => ({ key: k, attempts: v.attempts })),
        routes: ROUTES,
      });
    }

    if (path === '/api/health') {
      return send(req, res, 200, {
        ...base,
        ok: true,
        seq,
        serverTime: new Date().toISOString(),
        ua: req.headers['user-agent'] ?? null,
      });
    }

    if (path === '/api/query') {
      return send(req, res, 200, { ...base, seq, query: Object.fromEntries(q), raw: url.search });
    }

    if (path === '/api/echo') {
      const body = await readBody(req, MAX_READ_BODY).catch(() => null);
      return send(req, res, 200, {
        ...base,
        seq,
        method,
        path,
        query: Object.fromEntries(q),
        headers: pickHeaders(req),
        bodyText: body ? body.toString('utf8').slice(0, 8192) : null,
        bodyBytes: body ? body.length : 0,
      });
    }

    if (path === '/api/user/profile') {
      const auth = req.headers.authorization || req.headers['x-api-key'] || '';
      if (!auth) {
        return send(req, res, 401, {
          ...base,
          seq,
          error: 'unauthorized',
          hint: '带上 Authorization 或 X-Api-Key 才回 200——用来验证 headerOverrides 与 {{变量}} 注入',
        });
      }
      return send(req, res, 200, {
        ...base,
        seq,
        user: { id: 1025, name: '跨域代理助手演示账号', env },
        auth: {
          via: req.headers.authorization ? 'Authorization' : 'X-Api-Key',
          scheme: String(req.headers.authorization || '').split(' ')[0] ?? null,
          prefix: auth.slice(0, 6),
          length: auth.length,
        },
      });
    }

    if (path === '/api/list') {
      const page = intParam(q, 'page', 1, 1, 1000);
      const size = intParam(q, 'size', 5, 1, 50);
      const total = 23;
      const items = [];
      for (let i = 0; i < size; i++) {
        const n = (page - 1) * size + i + 1;
        if (n > total) break;
        items.push({ id: n, name: `${env}-record-${n}`, env });
      }
      return send(req, res, 200, { ...base, seq, page, size, total, items });
    }

    /**
     * `/api/v1/*` 与 `/api/v2/*` 同形，专门给正则重写那条规则用：
     * 源侧（fat）必须有内容可回，否则「规则没生效」和「目标环境少这条路由」在界面上长成一个样子。
     */
    const versioned = /^\/api\/v([12])(\/.*)?$/.exec(path);
    if (versioned) {
      return send(req, res, 200, {
        ...base,
        seq,
        api: `v${versioned[1]}`,
        rest: versioned[2] ?? '',
        query: Object.fromEntries(q),
      });
    }

    /**
     * 边界用例的落点：这两条路径本身**完全正常**，异常形状全部由规则造
     *
     * 服务端造不出「中文 statusText」那一面——Node 拒绝把非 latin1 写进状态行（见 `sendRaw` 的说明），
     * 而越界状态码也不该由上游来演（浏览器自己会拒）。所以这里给的是干净的 200，
     * 让 `presets/demo-rules.json` 里那两条 `responseOverrides` 去制造越界值，
     * 观察点因此落在扩展侧的钳制与清洗，而不是服务端。
     */
    if (path === '/api/edge/text') {
      return send(
        req,
        res,
        200,
        `${env} 的边界用例正文（规则打算把 statusText 改成中文、并加一个中文响应头）`,
        {},
        'text/plain; charset=utf-8',
      );
    }

    if (path === '/api/edge/code' || path.startsWith('/api/edge/')) {
      return send(req, res, 200, {
        ...base,
        seq,
        rest: path.slice('/api/edge'.length),
        note: '这一条本身是正常 200，越界的状态码/状态描述/响应头由规则的 responseOverrides 制造',
      });
    }

    if (path.startsWith('/api/orders')) {
      const idMatch = /^\/api\/orders\/([^/]+)$/.exec(path);
      const body = await readBody(req, MAX_READ_BODY).catch(() => null);
      if (method === 'DELETE') {
        if (q.get('empty') === '1') return send(req, res, 204, null);
        return send(req, res, 200, { ...base, seq, deleted: idMatch ? idMatch[1] : null });
      }
      return send(req, res, method === 'POST' ? 201 : 200, {
        ...base,
        seq,
        method,
        id: idMatch ? idMatch[1] : null,
        contentType: req.headers['content-type'] ?? null,
        bodyText: body ? body.toString('utf8').slice(0, 4096) : null,
        bodyBytes: body ? body.length : 0,
        receivedAt: new Date().toISOString(),
      });
    }

    if (path.startsWith('/api/status/')) {
      const raw = path.slice('/api/status/'.length);
      const code = Number(raw);
      if (!Number.isInteger(code) || code < 100 || code > 599) {
        return send(req, res, 400, {
          ...base,
          error: 'bad_status_code',
          hint: '/api/status/201 这样的三位数，范围 100-599',
        });
      }
      return send(req, res, code, { ...base, seq, status: code, withBody: !NO_BODY_STATUS.has(code) });
    }

    if (path === '/api/slow') {
      const ms = intParam(q, 'ms', 1000, 0, 130_000);
      setTimeout(() => {
        send(req, res, 200, { ...base, seq, delayedMs: ms, note: '扩展侧代发等待 = 35s + 规则 delay/重试预算' });
      }, ms);
      return undefined;
    }

    if (path === '/api/flaky') {
      const key = q.get('key') || 'default';
      const fail = intParam(q, 'fail', 2, 0, 20);
      const entry = ctx.flaky.get(key) || { attempts: 0 };
      entry.attempts += 1;
      ctx.flaky.set(key, entry);
      const shouldFail = entry.attempts <= fail;
      return send(req, res, shouldFail ? 500 : 200, {
        ...base,
        seq,
        key,
        attempt: entry.attempts,
        remainingFailures: Math.max(fail - entry.attempts, 0),
        error: shouldFail ? 'upstream_500' : null,
      });
    }

    if (path === '/api/flaky/reset' && method === 'POST') {
      const key = q.get('key') || 'default';
      ctx.flaky.delete(key);
      return send(req, res, 200, { ...base, seq, reset: key });
    }

    if (path === '/api/big') {
      const kb = intParam(q, 'kb', 64, 1, 8192);
      return send(req, res, 200, {
        ...base,
        seq,
        kb,
        note: '日志正文按 32K 字符截断，整份日志按 4M 字符收口',
        payload: 'A'.repeat(kb * 1024),
      });
    }

    if (path === '/api/text') {
      return send(
        req,
        res,
        200,
        `${env} 的纯文本响应（不是 JSON，日志抽屉不该尝试格式化它）`,
        {},
        'text/plain; charset=utf-8',
      );
    }

    if (path === '/api/binary') {
      return send(req, res, 200, BMP, { 'Content-Disposition': 'inline; filename="cop-8x8.bmp"' }, 'image/bmp');
    }

    if (path === '/api/upload' && method === 'POST') {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_READ_BODY) {
        return send(req, res, 413, { ...base, error: 'payload_too_large', declaredBytes: declared });
      }
      const body = await readBody(req, MAX_READ_BODY).catch(() => null);
      if (body === null) return send(req, res, 413, { ...base, error: 'payload_too_large' });
      return send(req, res, 200, {
        ...base,
        seq,
        receivedBytes: body.length,
        sha1: createHash('sha1').update(body).digest('hex').slice(0, 12),
        contentType: req.headers['content-type'] ?? null,
        isMultipart: String(req.headers['content-type'] || '').startsWith('multipart/form-data'),
      });
    }

    if (path === '/api/redirect') {
      const to = q.get('to') || '/api/health';
      // `//host` 也算 startsWith('/')，浏览器却把它当协议相对地址解析到站外去；这一档要的是
      // 「同机跳一跳」，把测试的人引到外网主机上是纯粹的帮倒忙
      const isSafe =
        (to.startsWith('/') && !to.startsWith('//')) ||
        to.startsWith(`http://localhost:${port}`) ||
        to.startsWith(`http://127.0.0.1:${port}`);
      if (!isSafe)
        return send(req, res, 400, {
          ...base,
          error: 'bad_redirect',
          hint: '只接受本站路径（// 打头的协议相对地址不算）或同端口绝对地址',
        });
      return send(req, res, intParam(q, 'code', 302, 300, 399), { ...base, redirectingTo: to }, { Location: to });
    }

    if (path === '/api/redirect-loop') {
      return send(req, res, 301, null, { Location: '/api/redirect-loop' });
    }

    if (path === '/api/sse') {
      const n = intParam(q, 'n', 3, 1, 20);
      const gap = intParam(q, 'gap', 200, 0, 3000);
      const origin = req.headers.origin;
      const allowed = resolveAllowOrigin(origin, cfg.cors, harnessOrigin);
      const headers = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        Vary: 'Origin',
      };
      if (allowed) headers['Access-Control-Allow-Origin'] = allowed;
      res.writeHead(200, headers);
      for (let i = 1; i <= n; i++) {
        setTimeout(() => res.write(`event: tick\ndata: ${JSON.stringify({ env, i, n, ts: Date.now() })}\n\n`), gap * i);
      }
      setTimeout(() => res.end(), gap * (n + 1));
      return undefined;
    }

    if (path === '/api/telemetry') {
      const body = await readBody(req, MAX_READ_BODY).catch(() => null);
      ctx.counts.telemetry += 1;
      return send(req, res, 202, { ...base, seq, accepted: ctx.counts.telemetry, bodyBytes: body ? body.length : 0 });
    }

    if (path === '/api/cookies') {
      return send(req, res, 200, {
        ...base,
        seq,
        cookieHeader: req.headers.cookie ?? null,
        hasCookie: Boolean(req.headers.cookie),
      });
    }

    if (path === '/api/set-cookie' && method === 'POST') {
      const value = q.get('value') || String(Date.now());
      const sameSite = ['Lax', 'Strict', 'None'].includes(q.get('sameSite')) ? q.get('sameSite') : 'Lax';
      // SameSite=None 必须配 Secure，否则 Chrome 直接丢条；localhost 被当作可信 origin，
      // 所以 http://localhost 上带 Secure 是收得到的——扩展后台代发属于第三方上下文，
      // 只有这一档才谈得上「把该环境的 Cookie 带过去」
      const secure = q.get('secure') === '1' || sameSite === 'None';
      const attrs = ['Path=/', `SameSite=${sameSite}`];
      if (secure) attrs.push('Secure');
      return send(
        req,
        res,
        200,
        { ...base, seq, set: 'cop_probe', value, attrs },
        {
          'Set-Cookie': `cop_probe=${value}; ${attrs.join('; ')}`,
        },
      );
    }

    if (path === '/api/raw/latin1') {
      // 状态行与头值直接写中文：线路上是 UTF-8 字节，浏览器按 latin1 解，于是界面看到乱码
      return sendRaw(
        req,
        res,
        '200 服务正常',
        ['Content-Type: text/plain; charset=latin1', `X-Cop-Env: ${env}`, 'X-Cop-Note: 中文头值', 'X-Cop-Raw: 1'],
        '这条响应由服务端直接写字节，状态行与响应头都带中文。浏览器按 latin1 解码，所以看到的是乱码而不是异常。',
      );
    }

    return send(req, res, 404, { ...base, seq, error: 'not_found', path, hint: '路由清单见 /env' });
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[${env}] 端口 ${port} 被占用：换端口（--base=…）或先占掉它的那个进程（lsof -nP -iTCP:${port} -sTCP:LISTEN）`,
      );
      process.exit(1);
    }
    console.error(`[${env}] 服务错误：${err.message}`);
  });

  return { server, ctx, origin: `http://${host}:${port}` };
}

/** 只回显与代理规则相关的那几个头，避免把整包 ua/accept 刷进日志抽屉 */
function pickHeaders(req) {
  const wanted = ['authorization', 'x-api-key', 'content-type', 'x-env', 'cookie', 'referer', 'x-requested-with'];
  const out = {};
  for (const name of wanted) {
    const value = req.headers[name];
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    out[name] = /authorization|x-api-key|cookie/.test(name) ? `${text.slice(0, 6)}…(${text.length})` : text;
  }
  return out;
}

/** 路由清单：给 /env 与触发页当索引用，写代码的人与读界面的人看同一份 */
export const ROUTES = [
  { method: 'GET', path: '/api/health', purpose: '基线：证明这一笔落到了哪个环境' },
  { method: 'GET', path: '/api/query', purpose: '验证 queryOverrides 与 {{变量}} 查询注入' },
  { method: 'GET', path: '/api/user/profile', purpose: '无凭据 401，带 Authorization/X-Api-Key 才 200' },
  { method: 'GET', path: '/api/list?page=&size=', purpose: '真实分页对照（条件化 Mock 走 /api/v1/data）' },
  { method: 'GET', path: '/api/v1/*', purpose: '正则重写（捕获组）与 Mock 落点的通用前缀' },
  { method: 'GET', path: '/api/v2/*', purpose: '与 v1 同形，供 ^/api/v2/(.*)$ → /api/$1 这类正则规则用' },
  { method: 'GET', path: '/api/edge/text', purpose: '规则改中文 statusText / 中文响应头时的落点' },
  { method: 'GET', path: '/api/edge/code', purpose: '规则改越界状态码（如 999）时的落点' },
  { method: 'POST/PUT/PATCH/DELETE', path: '/api/orders[/:id]', purpose: '请求体覆盖与方法面' },
  { method: 'GET', path: '/api/status/:code', purpose: '状态码钳制 200-599、204/304 空正文' },
  { method: 'GET', path: '/api/slow?ms=', purpose: '延迟与代发等待预算（>35s 会超时）' },
  { method: 'GET', path: '/api/flaky?key=&fail=', purpose: '重试次数与间隔' },
  { method: 'POST', path: '/api/flaky/reset?key=', purpose: '重置上面的计数器' },
  { method: 'GET', path: '/api/big?kb=', purpose: '日志正文 32K 截断与整份 4M 收口' },
  { method: 'POST', path: '/api/upload', purpose: '请求体 10MB 上限（超限扩展侧拦下）' },
  { method: 'GET', path: '/api/text', purpose: '非 JSON 正文' },
  { method: 'GET', path: '/api/binary', purpose: '二进制响应体（base64 通道）' },
  { method: 'GET', path: '/api/redirect?to=&code=', purpose: '重定向跟随' },
  { method: 'GET', path: '/api/redirect-loop', purpose: '重定向成环的失败表现' },
  { method: 'GET', path: '/api/sse?n=&gap=', purpose: '流式文本正文' },
  { method: 'POST', path: '/api/telemetry', purpose: '阻断规则的对象（看计数有没有涨）' },
  { method: 'GET', path: '/api/cookies', purpose: 'sendCredentials 是否带上 Cookie' },
  { method: 'POST', path: '/api/set-cookie?value=', purpose: '给目标环境埋一个 Cookie' },
  { method: 'GET', path: '/api/raw/latin1', purpose: '服务端直写的 latin1 状态行与头' },
  { method: 'WS', path: '/ws?token=', purpose: '长连接：地址重写 / 查询注入 / 阻断' },
];
