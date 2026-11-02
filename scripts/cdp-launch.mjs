/**
 * headless Chrome 的 CDP 启动配方（本仓两份实拍脚本共用）
 *
 * 为什么这里值得有一份：`scripts/capture-screenshots.mjs` 与 `scripts/record-promo-video.mjs`
 * 各自抄过同一段「起浏览器 + 等调试端口 + 收进程」，而其中那条 origin 旗标是**安全相关的**——
 * 抄第二遍的时候最容易变成「照旧加上 `*`，反正能跑」。判据只留一处。
 *
 * ## 这里刻意不带 `--remote-allow-origins`（也别把 `*` 补回去）
 *
 * 2026-11-02 在本机 Chrome 156 + Node 24 上，按**真脚本的连接形状**实测
 * （`--remote-debugging-port=0` → 抓 stderr 那行 `DevTools listening on` → `GET /json/version`
 * 取 `webSocketDebuggerUrl` → 用 Node 全局 `WebSocket` 连上 → 发一次真 `Browser.getVersion`）：
 *
 * - 不带任何 origin 旗标：**连得上**，`Browser.getVersion` 正常回话。
 * - Node 的全局 `WebSocket` **不发 `Origin` 头**；手工带上 `Origin: http://127.0.0.1:<同一个端口>`
 *   （host 与端口都对上）同样是 101。
 * - 手工带上 `Origin: https://evil.example`：browser 端点与 page 端点**都是 403**。
 *
 * 于是 `--remote-allow-origins=*` 买到的东西等于零，卖掉的却是「本机任意网页只要命中那枚端口，
 * 就能驱动这个装着扩展的浏览器」——跑批那几分钟里，那个浏览器带着扩展、带着演示凭据、
 * 带着一个真实存在的 profile 目录。删掉它才是收紧，且不破坏任何功能。
 *
 * 反面提醒：这一条只成立于「客户端不发 Origin，或发的就是同一个源」。若将来改成从**页面里**
 * 连 CDP（或任何会带异源 `Origin` 的客户端），那才会撞上 403——此时要登记的是**那一个具体源**
 * （`--remote-allow-origins=http://127.0.0.1:<端口>`），而不是退回 `*`。
 */
import { spawn } from 'node:child_process';

/** 等 `DevTools listening on …` 那行的预算 */
const LAUNCH_TIMEOUT_MS = 60000;

/**
 * 起一个 headless Chrome 并交出它的 CDP 端点
 *
 * @param {{chromeBin: string, baseArgs: string[]}} options `baseArgs` 里**不要**放
 *   `--remote-debugging-port` 与末尾的起始 URL，这两项由这里加。
 * @returns {Promise<{proc: import('node:child_process').ChildProcess, wsUrl: string, port: number}>}
 */
export async function launchCdpChrome({ chromeBin, baseArgs }) {
  const proc = spawn(
    chromeBin,
    // 端口交给系统分配（0）：只此一个本地监听，且只听 127.0.0.1。
    // 刻意不加 `--remote-allow-origins`——依据见文件头那三条实测读数。
    [...baseArgs, '--remote-debugging-port=0', 'about:blank'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    const wsUrl = await waitForDevToolsUrl(proc);
    // 端口从抓回来的那行里取，而不是「再问一次系统」：两处必须是同一个数，调用方拿它去
    // `GET /json/version` 才不会对着一个没人听的端口重试
    const port = wsUrl.replace(/^ws:\/\/127\.0\.0\.1:/, '').replace(/\/.*$/, '');
    return { proc, wsUrl, port: Number(port) };
  } catch (error) {
    // 起不来就不留一份孤儿 Chrome 在后台占着 profile
    try {
      proc.kill('SIGKILL');
    } catch {
      /* 已经不在了 */
    }
    throw error;
  }
}

/** 从 stderr 里等那行 `DevTools listening on ws://…` */
function waitForDevToolsUrl(proc) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => settle(reject, new Error('Chrome 没有报出调试端口')), LAUNCH_TIMEOUT_MS);
    proc.stderr.on('data', chunk => {
      buf += chunk.toString();
      const match = buf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]{36})/);
      if (match) settle(resolve, match[1]);
    });
    proc.once('exit', code => settle(reject, new Error(`Chrome 提前退出（code=${code}）`)));
  });
}
