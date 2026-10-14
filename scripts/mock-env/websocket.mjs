/**
 * 最小 WebSocket 服务端（RFC 6455 子集，零依赖）
 *
 * 只服务一件事：让 `ws://localhost:<port>/ws` 这条长连接通道在本机可验证。
 * 代理侧对 WebSocket 的能力面只有地址重写、查询参数注入与阻断三件事（见
 * `tests/wsCapabilitySurface.test.ts`），所以这里只需要把「握手成了没有」与
 * 「连到了哪个环境」说得出来，不必实现完整的 WS 协议栈。
 *
 * 不引 `ws` 包：本目录是纯本地工装，`node` 直接跑，不装依赖。
 */

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

/** RFC 6455 §1.3 里固定的握手盐值，规范只有这一份 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_continuation = 0x0;
const OP_text = 0x1;
const OP_binary = 0x2;
const OP_close = 0x8;
const OP_ping = 0x9;
const OP_pong = 0xa;

/**
 * 编码一个服务端 → 客户端帧（服务端不得掩码，见 RFC 6455 §5.1）
 *
 * @param {import('node:net').Socket} socket
 * @param {string | Buffer} payload 文本帧传字符串；pong 必须原样回显 ping 的字节，所以也收 Buffer
 * @param {number} [opcode] 默认 text；只有回 ping 时传 `OP_pong`——把 pong 写成 text 帧，
 *   页面会收到一条凭空多出来的 `onmessage`，而那个 ping 永远没被应答（RFC 6455 §5.5.3）
 */
function encodeFrame(socket, payload, opcode = OP_text) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = buf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  socket.write(Buffer.concat([header, buf]));
}

/**
 * 从累积缓冲里取出完整帧，返回 `{ frames, rest }`
 *
 * 掩码键只有 4 字节，负载按 `i % 4` 解掩码；长度分 7 位 / 16 位 / 64 位三档。
 * 半包（TCP 分片把一帧切开）由调用方保留 `rest` 等下一次 data 事件。
 *
 * @param {Buffer} buf
 */
function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const first = buf[offset];
    const second = buf[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (cursor + 2 > buf.length) break;
      len = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (cursor + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let maskKey = null;
    if (masked) {
      if (cursor + 4 > buf.length) break;
      maskKey = buf.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + len > buf.length) break;
    const payload = Buffer.from(buf.subarray(cursor, cursor + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    frames.push({ opcode, payload });
    offset = cursor + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

/**
 * 把 WebSocket 挂到一个已存在的 http.Server 的 `upgrade` 事件上
 *
 * @param {import('node:http').Server} server
 * @param {{ env: string, port: number, getContext: () => object }} meta
 */
export function attachWebSocket(server, meta) {
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${meta.port}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      // 不是握手路径：按普通请求回 404 再断开，免得客户端把「连不上」当成服务端挂了
      socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.end();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }

    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    const ctx = meta.getContext();
    ctx.counts.websocketHandshakes += 1;
    const seq = ctx.counts.websocketHandshakes;

    // 握手一成就主动推一条：客户端据此确认「这一笔连到了哪个环境」，
    // 不必等它自己发一句话才有回音（地址重写是否生效，看的就是这个 env）。
    encodeFrame(
      socket,
      JSON.stringify({
        type: 'hello',
        seq,
        env: meta.env,
        port: meta.port,
        query: Object.fromEntries(url.searchParams),
        hadCookie: Boolean(req.headers.cookie),
        ts: Date.now(),
      }),
    );

    let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === OP_close) {
          socket.end();
          return;
        }
        if (frame.opcode === OP_ping) {
          encodeFrame(socket, frame.payload, OP_pong);
          continue;
        }
        if (frame.opcode !== OP_text && frame.opcode !== OP_binary && frame.opcode !== OP_continuation) continue;
        const text = frame.payload.toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* 非 JSON 的原始文本走下面的 echo 分支 */
        }
        if (parsed && parsed.action === 'push') {
          const n = Math.min(Math.max(Number(parsed.n) || 3, 1), 50);
          const gap = Math.min(Math.max(Number(parsed.gapMs) || 300, 0), 5000);
          for (let i = 1; i <= n; i++) {
            setTimeout(() => {
              if (!socket.destroyed) {
                encodeFrame(socket, JSON.stringify({ type: 'push', env: meta.env, i, n, ts: Date.now() }));
              }
            }, gap * i);
          }
          setTimeout(
            () => {
              if (!socket.destroyed) encodeFrame(socket, JSON.stringify({ type: 'push-done', env: meta.env, n }));
            },
            gap * (n + 1),
          );
          return;
        }
        if (parsed && parsed.action === 'close') {
          socket.end();
          return;
        }
        encodeFrame(
          socket,
          JSON.stringify({
            type: 'echo',
            seq,
            env: meta.env,
            port: meta.port,
            query: Object.fromEntries(url.searchParams),
            fromClient: text.length > 512 ? `${text.slice(0, 512)}…` : text,
            ts: Date.now(),
          }),
        );
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => socket.destroy());
  });
}
