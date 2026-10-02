/**
 * Chrome Web Store 宣传视频录制器：`pnpm promo`（中文列表）/ `pnpm promo:en`（英文列表）。
 *
 * 做法：起一个 headless Chrome for Testing，用 CDP 的 `Extensions.loadUnpacked` 装上
 * `.output/chrome-mv3`，打开 options 页，先种一份**纯示例域名**的演示配置与日志，
 * 再按镜头脚本点几个真实入口（日志抽屉 / URL 匹配预演 / 规则表单 / 换肤 / 总开关），
 * 全程按固定节拍抓 `Page.captureScreenshot`，最后写 concat 清单交给 ffmpeg 出 1280×720 的 mp4。
 *
 * 为什么不用 `Page.startScreencast`：headless=new 下它给的是缩小过的表面对象
 * （实测 1280×720 视口只回 756×413 的帧），放大到商店尺寸就是糊的，而且 413/756 与
 * 720/1280 不同比例，补边还会上下各出一条黑带。
 *
 * 前置（脚本会在开工前逐个检查并给出可执行的修法，不会默默录出一段空白）：
 * 1. `pnpm build` 已跑过，`.output/chrome-mv3` 存在；
 * 2. 一个 Chrome for Testing（或任意 Chrome）可执行文件——`CHROME_BIN` 指过来，
 *    否则按 `.test-tmp/chrome-mac-<arch>` 与 `~/.cache/chrome-for-testing/` 的顺序找；
 * 3. ffmpeg，且**这台机器的 ffmpeg 没有 libx264 / vp9**，只有 `h264_videotoolbox`
 *    （macOS 硬件编码）。换平台要改下面 `FF_ARGS` 里的编码器。
 * 4. Node 22+：CDP 那一层直接用 node 自带的全局 `WebSocket`，不为它引 `ws` 依赖。
 *
 * 交付物落在 `store-assets/promo/`（已 gitignore，与 `pnpm assets` 那批商店图同一口径：
 * 可再生，所以不入库）；中间件（帧序列与那份 profile）落在 `.test-tmp/promo/`，同样已
 * gitignore，出片成功后一并删掉，失败时留着当现场。演示数据里没有任何真实内网域名、token 或账号。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 商店有中文与英文两份本地化列表，宣传视频跟着列表走，所以同一套脚本出两条片子。
 *  `--en` 换的是种子里的界面语言与演示数据里那三个规则名，镜头脚本完全一致。 */
const EN = process.argv.includes('--en');
const SUFFIX = EN ? '-en' : '';

/** 展一层通配（只支持一个 `*`，不为此引 glob 依赖）：把模式变成磁盘上真存在的候选。 */
const expand = pattern => {
  const segs = pattern.split(path.sep);
  const star = segs.findIndex(s => s.includes('*'));
  if (star === -1) return fs.existsSync(pattern) ? [pattern] : [];
  const base = segs.slice(0, star).join(path.sep) || path.sep;
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const re = new RegExp('^' + segs[star].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return names
    .filter(n => re.test(n))
    .map(n => path.join(base, n, ...segs.slice(star + 1)))
    .filter(p => fs.existsSync(p));
};

/** Chrome for Testing 的解压目录按架构命名（`chrome-mac-arm64` / `chrome-mac-x64`），
 *  而 `os.arch()` 在 macOS 上给出的正是这两个后缀本身，不需要第二张映射表。 */
const CHROME_ARCH = os.arch() === 'arm64' ? 'arm64' : 'x64';

/** 找 Chrome for Testing：环境变量优先，其次本机已知的两处落点，最后退到系统 Chrome。
 *  找不到就把三条修法一起说出来——这一步失败得越早，越不会白跑一场录制。
 *
 *  缓存那一路必须跟着本机架构走：`chrome-mac-x64` 写死在候选里，在 Apple Silicon 上
 *  永远匹配不到（那边解压出来是 `chrome-mac-arm64`），于是这条候选形同不存在——
 *  而文件头承诺的是「按 `.test-tmp/chrome-mac-<arch>` 与 `~/.cache/chrome-for-testing/` 找」。
 *  这里用 `os.arch()` 现取而不是再套一层通配：`expand` 只展一个 `*`（见上），
 *  版本目录那个通配位已经用掉了，一条模式里两个 `*` 会把后一个当字面量拼出来。 */
const findChrome = () => {
  const APP = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const candidates = [
    process.env.CHROME_BIN,
    path.join(ROOT, '.test-tmp', 'chrome-mac-*', APP),
    path.join(os.homedir(), '.cache', 'chrome-for-testing', '*', `chrome-mac-${CHROME_ARCH}`, APP),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const pattern of candidates) {
    const hit = expand(pattern);
    if (hit.length) return hit[0];
  }
  return null;
};

/** ffmpeg：环境变量优先，其次 PATH。这台机器上的 ffmpeg 没有 libx264 / libvpx / vp9，
 *  只有 `h264_videotoolbox`（macOS 硬件编码），所以下面编码器写死了它——换平台要一起换。 */
const findFfmpeg = () => {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  for (const d of (process.env.PATH || '').split(':')) {
    if (!d) continue;
    const p = path.join(d, 'ffmpeg');
    if (fs.existsSync(p)) return p;
  }
  return null;
};

const CHROME = findChrome();
const FFMPEG = findFfmpeg();
const EXT = path.join(ROOT, '.output/chrome-mv3');
const PROFILE = path.join(ROOT, `.test-tmp/promo/profile${SUFFIX}`);
const FRAMES = path.join(ROOT, `.test-tmp/promo/frames${SUFFIX}`);
const OUT_DIR = path.join(ROOT, 'store-assets/promo');
const OUT = path.join(OUT_DIR, `promo-1280${SUFFIX}.mp4`);
const THUMB = path.join(OUT_DIR, `promo-thumb-440x280${SUFFIX}.jpg`);

const missing = [];
if (!CHROME) {
  missing.push(
    '找不到 Chrome for Testing。三种修法任选：' +
      '① `CHROME_BIN=/path/to/chrome pnpm promo`；' +
      `② 把 Chrome for Testing 解压到 \`.test-tmp/chrome-mac-${CHROME_ARCH}/\`（该目录已 gitignore，架构后缀按本机现取）；` +
      '③ 装一份系统 Chrome 到 /Applications（未在本仓验过它吃不吃 Extensions.loadUnpacked）。',
  );
}
/* CDP 那一层用的是 Node 自带的全局 WebSocket，没有再引 `ws` 依赖。这个全局在 Node 22 才稳定可用，
 * 而本机 PATH 上同时躺着旧版 node（`/usr/local/bin/node` 是残留的 v16）——按能力现测比写死版本号诚实：
 * 缺什么就说缺什么，而不是让人去猜哪一个大版本开始算「够新」。 */
if (typeof globalThis.WebSocket !== 'function') {
  missing.push(
    `当前 node（${process.version}）没有全局 WebSocket，连不上 CDP。切到 Node 22+ 再跑，例如 \`nvm use 22 && pnpm promo\`。`,
  );
}
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  missing.push(`没有 ${path.relative(ROOT, EXT)}——先跑一次 \`pnpm build\`，录制器装的是构建产物而不是源码。`);
}
if (!FFMPEG) {
  missing.push('找不到 ffmpeg。`FFMPEG=/usr/local/bin/ffmpeg pnpm promo` 指过来，或 `brew install ffmpeg`。');
}
if (missing.length) {
  console.error(missing.map(m => `✗ ${m}`).join('\n'));
  process.exit(1);
}

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 演示数据里的规则名——列表语言不同，界面上出现的这三个词也得跟着换。 */
const NAMES = EN
  ? { wildcard: 'FAT → UAT API', mock: 'Mock user API', slow: 'Slow network (loading)' }
  : { wildcard: 'FAT → UAT 接口', mock: 'Mock 用户接口', slow: '慢网络（加载态）' };

/** `components/options/HeaderBar.vue` 里 `.header-actions` 那六个按钮的 i18n 键，
 *  顺序 = 模板里的 DOM 顺序。镜头脚本按索引点按钮，索引能不能对上号只由这个顺序保证，
 *  所以首屏那道闸门拿它和界面上的文字逐格比（见下面 `HEADER_LABELS` 的用处）。 */
const HEADER_KEYS = ['addRule', 'tabLogs', 'urlTest', 'importExportConfig', 'openProfiles', 'tabSettings'];
const HEADER_LABELS = (() => {
  const file = path.join(ROOT, 'locales', EN ? 'en' : 'zh_CN', 'options.json');
  const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
  return HEADER_KEYS.map(key => {
    // 键被改名或删掉，这里必须先炸——否则期望清单变成一串 undefined，界面上一个字都对不上
    if (typeof dict[key] !== 'string') throw new Error(`${path.relative(ROOT, file)} 里读不到按钮文案键 ${key}`);
    return dict[key];
  });
})();

/* ───────── 演示数据：三条规则 + 四条日志，全部是示例域名，不含任何真实凭据 ───────── */

const now = Date.now();
const rules = [
  {
    id: 'promo-rule-wildcard',
    name: NAMES.wildcard,
    enabled: true,
    matchPattern: 'https://fat-api.example.com/*',
    targetUrl: 'https://uat-api.example.com',
    matchType: 'wildcard',
    priority: 1,
    createdAt: now - 86400000,
    updatedAt: now - 3600000,
  },
  {
    id: 'promo-rule-mock',
    name: NAMES.mock,
    enabled: true,
    matchPattern: 'https://api-fat.example.com/api/user/*',
    targetUrl: '',
    matchType: 'wildcard',
    mockResponse: {
      body: '{"code":0,"data":{"name":"Mock User","roles":["admin"]}}',
      contentType: 'application/json',
      status: 200,
    },
    priority: 2,
    createdAt: now - 72000000,
    updatedAt: now - 7200000,
  },
  {
    id: 'promo-rule-slow',
    name: NAMES.slow,
    enabled: true,
    matchPattern: 'https://fat-api.example.com/api/report/*',
    targetUrl: 'https://uat-api.example.com/api/report/',
    matchType: 'prefix',
    delayMs: 3000,
    priority: 3,
    createdAt: now - 3600000,
    updatedAt: now - 1800000,
  },
];

const logs = [
  {
    id: 'promo-log-1',
    timestamp: now - 42000,
    ruleId: 'promo-rule-wildcard',
    ruleName: NAMES.wildcard,
    originalUrl: 'https://fat-api.example.com/api/user/list?page=1',
    proxiedUrl: 'https://uat-api.example.com/api/user/list?page=1',
    method: 'GET',
    status: 200,
    duration: 128,
    proxyType: 'dnr',
  },
  {
    id: 'promo-log-2',
    timestamp: now - 31000,
    ruleId: 'promo-rule-mock',
    ruleName: NAMES.mock,
    originalUrl: 'https://api-fat.example.com/api/user/profile',
    proxiedUrl: 'https://api-fat.example.com/api/user/profile',
    method: 'GET',
    status: 200,
    duration: 6,
    proxyType: 'sw',
    responseBody: '{"code":0,"data":{"name":"Mock User","roles":["admin"]}}',
  },
  {
    id: 'promo-log-3',
    timestamp: now - 19000,
    ruleId: 'promo-rule-slow',
    ruleName: NAMES.slow,
    originalUrl: 'https://fat-api.example.com/api/report/monthly',
    proxiedUrl: 'https://uat-api.example.com/api/report/monthly',
    method: 'POST',
    status: 200,
    duration: 3214,
    proxyType: 'sw',
  },
  {
    id: 'promo-log-4',
    timestamp: now - 7000,
    ruleId: 'promo-rule-wildcard',
    ruleName: NAMES.wildcard,
    originalUrl: 'https://fat-api.example.com/api/order/summary',
    proxiedUrl: 'https://uat-api.example.com/api/order/summary',
    method: 'GET',
    status: 502,
    duration: 812,
    proxyType: 'dnr',
  },
];

const SEED = `(async () => {
  await chrome.storage.local.set({
    proxy_config: ${JSON.stringify({ enabled: true, rules })},
    request_logs: ${JSON.stringify(logs)},
    /* 这一整串是在页面里 eval 的，脚本作用域里的 EN 到这里根本不存在——
       直接写 "EN ? …" 会让整次求值抛 ReferenceError，种数据静默失败，
       表 0 行却被下面那道闸门报成「种数据没生效」。所以在这里就把值算出来。 */
    locale: ${JSON.stringify(EN ? 'en' : 'zh_CN')},
    theme: 'sky',
    theme_mode: 'light',
  });
  return 'seeded';
})()`;

/* ───────── CDP 客户端 ───────── */

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--user-data-dir=${PROFILE}`,
    // 扩展只由 CDP 的 Extensions.loadUnpacked 装一次：再叠一个 --load-extension
    // 会同时存在两份实例，界面里看到的是哪一份就不确定了。
    '--enable-unsafe-extension-debugging',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
/** 收掉那个 headless Chrome：它带着 `--remote-allow-origins=*` 的调试端口和本机的
 *  `--user-data-dir`，进程活着就意味着一个「任何来源都能连的 CDP 门面」开着。
 *
 *  只挂 `exit` 是不够的：`process.on('exit')` 在 SIGTERM/SIGHUP 默认终止下根本不跑，
 *  Ctrl-C（SIGINT）同理，于是「录到一半中止」= 一个孤儿 Chrome 常驻后台，
 *  下一次重跑还会因为 profile 被占而行为不可预期。三种信号各接管一次，走完清理再按
 *  原语义退出；`exit` 那道留着兜住任何绕过信号处理器的出口路径。 */
const killChrome = () => {
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* noop */
  }
};
process.on('exit', killChrome);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    console.error(`\n收到 ${signal}，中止录制（产物不会写出，避免留下一条说假话的片子）`);
    killChrome();
    process.exit(1);
  });
}

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('Chrome 没报调试端口')), 60000);
  chrome.stderr.on('data', c => {
    buf += c.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]{36})/);
    if (m) {
      clearTimeout(t);
      resolve(m[1]);
    }
  });
});

const socket = await new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
  const t = setTimeout(() => reject(new Error('CDP 连接超时')), 20000);
  ws.addEventListener('open', () => {
    clearTimeout(t);
    resolve(ws);
  });
  ws.addEventListener('error', e => {
    clearTimeout(t);
    reject(new Error(e.message));
  });
});

let seq = 0;
const pending = new Map();
/* 只按 id 配对，不订阅任何 CDP 事件：抓帧改走定拍 captureScreenshot 之后，
 * 这里没有事件消费者了（原先为 Page.screencastFrame 留的那张监听表已随之删掉）。 */
socket.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data.toString());
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(JSON.stringify(msg.error)));
  else resolve(msg.result);
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 60000);
    pending.set(id, {
      resolve: v => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: e => {
        clearTimeout(timer);
        reject(e);
      },
    });
    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });

/* ───────── 1. 拿扩展 ID：用 CDP 的 Extensions.loadUnpacked，再按 manifest 版本自证 ─────────
 *
 * 不能"从 chrome-extension:// 的 service worker target 里挑第一个"——Chrome 自带
 * 好几个内置扩展（例如 ...nkeimhogjdpnpccoofpliimaahmaaome），它们的 SW 排在前面，
 * 挑中之后打开的是别人家的 options.html：页面是空的，但一句错都不报。
 * 所以拿到 ID 之后还要回读 manifest 核版本，对不上就直接停。 */

const { id: loadedId } = await send('Extensions.loadUnpacked', { path: EXT });
if (!loadedId) throw new Error('Extensions.loadUnpacked 没返回 id');
const expectVersion = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;

const { targetId: probeTarget } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: probeSession } = await send('Target.attachToTarget', { targetId: probeTarget, flatten: true });
await send('Page.enable', {}, probeSession);
await send('Page.navigate', { url: `chrome-extension://${loadedId}/manifest.json` }, probeSession);
await sleep(1200);
const manifestText = await send(
  'Runtime.evaluate',
  {
    expression:
      "(() => { const p = document.querySelector('pre'); return p ? p.textContent : document.body.innerText; })()",
    returnByValue: true,
  },
  probeSession,
);
let manifest = {};
try {
  manifest = JSON.parse(manifestText.result.value ?? '');
} catch {
  /* 下面统一按版本对不上处理 */
}
if (manifest.version !== expectVersion) {
  throw new Error(`扩展 ID ${loadedId} 的 manifest 版本是 ${manifest.version}，不是本仓的 ${expectVersion}`);
}
await send('Target.closeTarget', { targetId: probeTarget });
const extId = loadedId;
console.log(`扩展 ID = ${extId}（manifest version ${manifest.version} 已核对）`);

/* ───────── 2. 开 options 页，先种数据再重载 ───────── */

const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
  sessionId,
);

const waitReady = async () => {
  const started = Date.now();
  while (Date.now() - started < 25000) {
    const r = await send('Runtime.evaluate', { expression: 'document.readyState' }, sessionId);
    if (r.result.value === 'complete') return;
    await sleep(200);
  }
  throw new Error('options 页没进入 complete');
};
await waitReady();
await sleep(1200);

const seeded = await send('Runtime.evaluate', { expression: SEED, awaitPromise: true, returnByValue: true }, sessionId);
if (seeded.exceptionDetails) {
  throw new Error(`种子求值就抛了：${seeded.exceptionDetails.exception?.description ?? seeded.exceptionDetails.text}`);
}
console.log(`种子 -> ${seeded.result.value}`);
await send('Page.reload', { ignoreCache: true }, sessionId);
await waitReady();
await sleep(2500);

const probe = await send(
  'Runtime.evaluate',
  {
    expression:
      'JSON.stringify({ vw: window.innerWidth, vh: window.innerHeight, title: document.title, ' +
      'rows: document.querySelectorAll(".el-table__row").length, ' +
      'btns: [...document.querySelectorAll(".header-actions .el-button")].map(b => b.textContent.trim()) })',
    returnByValue: true,
  },
  sessionId,
);
const first = JSON.parse(probe.result.value);
console.log('首屏 =', probe.result.value);
// 空白页也能一路"录"出几十秒，所以这里就断：视口要是 1280×720，界面要真的挂载了。
if (first.vw !== 1280 || first.vh !== 720) throw new Error(`视口不是 1280×720，而是 ${first.vw}×${first.vh}`);
if (!first.rows) throw new Error('规则表 0 行——种数据没生效，录出来的表是空的');
/* header 那六个按钮的文字按 `components/options/HeaderBar.vue` 的 DOM 顺序现读 locale JSON。
   这一比对是为了下面那几拍的**索引**成立：往 header 里插一个按钮或换个序，
   `clickNthHeaderButton(1)` 点开的就不是日志抽屉了，而片子照样一分钟填满、exit code 照样是 0，
   只是画面在讲另一件事——这种片子没人看得出来，直到它传上商店。
   文字从本仓的文案里读，不抄第二份清单：改措辞不用回来对，改结构当场红。 */
if (first.btns?.join('|') !== HEADER_LABELS.join('|')) {
  throw new Error(
    `header 按钮和镜头脚本假设的不是同一串：界面「${(first.btns ?? []).join(' / ')}」 vs ` +
      `期望「${HEADER_LABELS.join(' / ')}」（键序见 HEADER_KEYS）`,
  );
}
// 两条片子分别传中英两份列表；英文那条要是没真的切成英文界面，就是一张挂错语言的片子，
// 上传之后没人看得出来（界面是中文、列表是英文）。标签页标题由入口 main.ts 按应用内 i18n 设。
const wantTitle = EN ? /options|cross-origin/i : /配置|跨域/;
if (!wantTitle.test(first.title)) {
  throw new Error(`界面语言没切过去：--en=${EN} 却拿到标题「${first.title}」——这条片子会挂错语言列表`);
}

/* ───────── 3. 开录 ─────────
 *
 * 不用 Page.startScreencast：headless=new 下它给的是缩小过的表面对象
 * （实测 1280×720 的视口只回 756×413 的帧），放大到商店要求的 1280×720 就是糊的，
 * 而且 413/756 与 720/1280 不是同一个比例，补边还会上下各出一条黑带。
 * 改成按固定节拍抓 Page.captureScreenshot——它按布局视口出全尺寸图。 */

const frames = [];
let recording = true;
/** 抓帧通道一旦坏了就没法恢复（每一次 `send` 都是同一个 sessionId 上的往返），所以循环一失败就 break，
 *  这里存下的就是那一次、也是唯一一次失败的原因。它必须一路带到编码前——见下面「4. 落帧 + 编码」。 */
let captureFailure = null;

/** 抓一帧并记账。首帧的真实尺寸由调用方核（见下面那道闸门），尺寸不对就没必要录完整场。 */
const grabFrame = async () => {
  const shot = await send(
    'Page.captureScreenshot',
    { format: 'jpeg', quality: 88, clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 } },
    sessionId,
  );
  frames.push({ t: Date.now() / 1000, data: shot.data });
};

/* 130ms 实测只录到 7.6fps，滚动那两拍明显卡顿；降到 60ms 后，抓帧本身（约 40ms 一拍）
   成了节拍上限——连跑四轮量到 12.4–14.0 fps（632 / 686 / 706 / 708 帧，跨度都约 50.7s），
   负载高的那轮就是低的那头。这个数只决定「滚动那两拍有多顺」，不决定片长：时长由节拍表
   定死，出片一律由 fps=30 补帧到恒定帧率。 */
const CAPTURE_INTERVAL_MS = 60;
const captureLoop = (async () => {
  while (recording) {
    const started = Date.now();
    try {
      await grabFrame();
    } catch (e) {
      /* 不能只 `console.log` 然后继续走镜头脚本：那样剩下十几拍录的是同一帧静止画面，
         而主流程一无所知，最后照样出片、照样 exit 0，文档里那一栏就写成「✅ Ready」。 */
      captureFailure = e;
      recording = false;
      break;
    }
    const spent = Date.now() - started;
    await sleep(Math.max(0, CAPTURE_INTERVAL_MS - spent));
  }
})();

/** 从 JPEG 的 SOF0/SOF2 段读宽高。不为此多依赖一个 ffprobe：前置检查只验了 ffmpeg 在位，
 *  而尺寸闸门（下面那一道 1280×720）要的是「帧到底多大」这个事实本身，
 *  拿不到答案时它必须失败得清楚，不是「探测工具没跑起来」。 */
const jpegDims = buf => {
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) i += 2;
    else i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
};

await grabFrame();
{
  const dims = jpegDims(Buffer.from(frames[0].data, 'base64'));
  console.log(`首帧尺寸 = ${dims ? `${dims.w}×${dims.h}` : '读不出'}`);
  if (!dims || dims.w !== 1280 || dims.h !== 720)
    throw new Error(`抓帧不是 1280×720（拿到 ${JSON.stringify(dims)}），先别录完整场`);
}
const recT0 = frames[0].t;

const clickNthHeaderButton = n =>
  send(
    'Runtime.evaluate',
    {
      expression:
        `(() => { const b = document.querySelectorAll('.header-actions .el-button')[${n}]; ` +
        `if (!b) return 'no-button-${n}'; b.click(); return b.textContent.trim(); })()`,
      returnByValue: true,
    },
    sessionId,
  ).then(r => {
    const label = r.result.value;
    console.log(`  click -> ${label}`);
    /* 按钮没找到就当场停：这一拍从头到尾是「什么都没点开」，而一段静止画面照样能录满
       那几秒——首屏那道 `btns.length` 闸门只保证当时有按钮，保证不了索引还对得上号。 */
    if (String(label).startsWith('no-button')) {
      throw new Error(`第 ${n} 个 header 按钮不存在，这一拍录下去只是静止画面`);
    }
    return label;
  });

const pressEscape = () =>
  send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    sessionId,
  ).then(() =>
    send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      sessionId,
    ),
  );

/** 关浮层：先点各自那个关闭按钮（抽屉与对话框类名不同），点不着再退回 Escape。
 *  取「最后一个还可见的」而不是第一个匹配的——关掉的抽屉其 DOM 往往还在，
 *  按 DOM 顺序命中那个隐藏按钮就等于什么都没关。 */
const closeOverlay = () =>
  send(
    'Runtime.evaluate',
    {
      expression:
        "(() => { const all = [...document.querySelectorAll('.el-drawer__close-btn, .el-dialog__headerbtn')]; " +
        'const live = all.filter(b => b.offsetParent !== null); ' +
        "if (!live.length) return 'fallback-escape'; " +
        "live.at(-1).click(); return 'clicked-close:' + live.length; })()",
      returnByValue: true,
    },
    sessionId,
  ).then(async r => {
    console.log(`  close -> ${r.result.value}`);
    if (r.result.value === 'fallback-escape') await pressEscape();
  });

const scrollBy = (dx, dy) =>
  send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: dx, deltaY: dy }, sessionId);

/** 点配置弹窗里的第 n 个主题色板。找不到就抛——这一拍的全部信息量就是「整页换肤」，
 *  点空了片子照样有 6 秒画面，只是那 6 秒什么也没发生。 */
const pickSwatch = n =>
  send(
    'Runtime.evaluate',
    {
      expression:
        `(() => { const s = document.querySelectorAll('.theme-swatch'); ` +
        `if (s.length <= ${n}) return 'MISSING:' + s.length; s[${n}].click(); return 'swatch ' + (s.length) + ' clicked ' + ${n}; })()`,
      returnByValue: true,
    },
    sessionId,
  ).then(r => {
    console.log(`  theme -> ${r.result.value}`);
    if (String(r.result.value).startsWith('MISSING')) {
      throw new Error(`主题色板只有 ${r.result.value.slice(8)} 个，点不到第 ${n} 个——换肤那一拍是空的`);
    }
  });

/** 往「URL 匹配测试」那个输入框里打字，四字符一跳，看上去是人在敲。
 *
 * 两处坑，都是这一版当场踩出来的：
 * ① 那一行里有两个 <input>——el-select 自己也带一个，而且排在前面。
 *    按 `.url-test-input-row input` 取第一个，打的是那个下拉框的假输入框，
 *    真地址框一个字没动。必须按「不在 .el-select 里」挑。
 * ② 必须走原生 value setter：el-input 的 v-model 挂在原生 input 事件上，
 *    直接 el.value = …… 会被 Vue 读过的那个 getter 掩盖——框里有字，
 *    但 testUrl 仍是空串；Vue 那边绑定值没变，也就不会把 DOM 写回去，
 *    于是「读回来有值」和「界面出了结果」是两件事，两个都得断。
 * ③ `PICK_INPUT` 那句「没找到 input」的回落必须返回 JSON：打字那一拍不看返回值，
 *    最后那一拍要 `JSON.parse` 它，返回裸串 `'no-input'` 会让 parse 先抛 `SyntaxError`，
 *    于是下面那句专门写好的「URL 没有真的打进输入框」永远显示不出来。 */
const PICK_INPUT =
  "const el = [...document.querySelectorAll('.url-test-input-row input')].find(i => !i.closest('.el-select')); " +
  "if (!el) return JSON.stringify({ value: null, hit: null, missing: 'no-input' }); ";

const typeIntoUrlTest = async text => {
  for (let i = 4; i <= text.length + 4; i += 4) {
    const chunk = text.slice(0, i);
    await send(
      'Runtime.evaluate',
      {
        expression:
          `(() => { ${PICK_INPUT}` +
          `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(chunk)}); ` +
          "el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()",
        returnByValue: true,
      },
      sessionId,
    );
    await sleep(90);
  }
  const r = await send(
    'Runtime.evaluate',
    {
      expression:
        `(() => { ${PICK_INPUT}` +
        "const res = document.querySelector('.url-test-dialog .result-block'); " +
        'return JSON.stringify({ value: el.value, ' +
        "hit: res ? res.innerText.replace(/\\s+/g, ' ').trim().slice(0, 140) : null }); })()",
      returnByValue: true,
    },
    sessionId,
  );
  console.log(`  typed -> ${r.result.value}`);
  const out = JSON.parse(r.result.value);
  // 三种「这一拍其实没录上东西」分开说，因为修法完全不同：选择器失效 / 敲进去的字没留住 / 结果块没渲染。
  if (out.missing) {
    throw new Error('URL 没有真的打进输入框——.url-test-input-row 里没找到非 el-select 的 input，先看那个类名还在不在');
  }
  if (out.value !== text) {
    throw new Error(`输入框里是「${out.value}」，不是打进去的「${text}」——画面上的地址和这拍要说的不是同一条`);
  }
  if (!out.hit) throw new Error('输入框有值但没渲染出命中结果块——这一拍没有信息量');
};

/** 镜头脚本里每一拍的停留时长累加起来，就是「这一次录制本该有多长」。
 *  计在 `step` 这个唯一出口里，而不是另写一份常量——改镜头的人不需要记得回来对账。 */
let plannedMs = 0;

const step = async (label, holdMs, fn) => {
  console.log(`· ${label}`);
  plannedMs += holdMs;
  if (fn) await fn();
  await sleep(holdMs);
};

await step('首屏规则表停留', 4500);
await step('滚到表格下半部', 3000, () => scrollBy(0, 260));
await step('打开请求日志', 6000, () => clickNthHeaderButton(1));
await step('关掉日志', 1800, () => closeOverlay());
await step('打开 URL 匹配预演', 1200, () => clickNthHeaderButton(2));
await step('敲一个真 URL，看命中与重写', 4200, () => typeIntoUrlTest('https://fat-api.example.com/api/user/list'));
// 这一拍是整片信息量最大的一格：输入框有真地址、命中规则、重写后的 URL（改动段高亮）、
// 转发通道，还有那句「DNR 只在网络层改写 URL，响应不经扩展」的诚实说明。缩略图取它——
// 记的是「跑到这一刻的秒数」而不是写死的数字，上面任何一拍改时长，缩略图跟着走。
const thumbAt = Date.now() / 1000 - recT0;
await step('关掉预演', 1800, () => closeOverlay());
await step('打开添加规则表单', 5000, () => clickNthHeaderButton(0));
await step('关掉表单', 1800, () => closeOverlay());
await step('打开配置（主题 / 语言）', 5000, () => clickNthHeaderButton(5));
await step('换一次主题色板', 3500, () => pickSwatch(2));
await step('换回默认主题（收尾回到品牌色）', 2600, () => pickSwatch(0));
await step('关掉配置', 2000, () => closeOverlay());
await step('切回顶部并关总开关', 3500, async () => {
  await scrollBy(0, -600);
  const r = await send(
    'Runtime.evaluate',
    {
      expression:
        "(() => { const s = document.querySelector('.proxy-toggle-pill .el-switch'); if (s) s.click(); return s ? 'toggled' : 'no-switch'; })()",
      returnByValue: true,
    },
    sessionId,
  );
  console.log(`  toggle -> ${r.result.value}`);
  // 找不到那颗开关，这两拍（关、再打开）就全是静止画面，而片长一分钟都填得满。
  if (r.result.value !== 'toggled') throw new Error('总开关 .proxy-toggle-pill .el-switch 不存在，最后两拍没有内容');
});
await step('再打开，收尾', 3000, () =>
  send(
    'Runtime.evaluate',
    {
      expression: "(() => { const s = document.querySelector('.proxy-toggle-pill .el-switch'); if (s) s.click(); })()",
      returnByValue: true,
    },
    sessionId,
  ),
);

recording = false;
// 循环退出时最后一帧已经入账（`await` 等的就是那一次在途抓帧 + 节拍 sleep），不必再补一段等待。
await captureLoop;

/* ───────── 4. 落帧 + 编码 ───────── */

/* 两道闸门，各拦一种「出得来片子，但片子在说谎」：
 * ① 抓帧通道中途坏掉——循环自己 break 之后，镜头脚本照跑，画面停在中止那一刻的同一帧上，
 *    剩下的十几拍全是静止画面，而 exit code 照样是 0。
 * ② 跨度对不上镜头脚本的停留总和——①的兜底（万一失败没被 catch 到，比如循环外的路径），
 *    以及任何让录制提前收尾的情况（Chrome 自己退出、CDP 断连、机器休眠）。
 * 帧数那一道按实测节拍（60ms 一拍、连跑四轮 12.4–14.0 fps）取一个远低于下限的整数，
 * 它只负责「压根没在抓」这一种，不承担判断录了多久——那是②的活。 */
if (captureFailure) {
  throw new Error(
    `抓帧在中途失败，这条片子只有静止画面，不出片：${captureFailure.message}（已抓 ${frames.length} 帧）`,
  );
}
const spanMs = frames.length > 1 ? (frames.at(-1).t - frames[0].t) * 1000 : 0;
if (frames.length < 100) throw new Error(`只收到 ${frames.length} 帧，不够成片（60ms 一拍的节拍该有 700 帧上下）`);
if (spanMs < plannedMs * 0.95) {
  throw new Error(`录制跨度 ${spanMs.toFixed(0)}ms，短于镜头脚本计划停留 ${plannedMs}ms——中间有拍子没录上，不出片`);
}
frames.forEach((f, i) => {
  fs.writeFileSync(path.join(FRAMES, `f${String(i).padStart(4, '0')}.jpg`), Buffer.from(f.data, 'base64'));
});

/* concat 的 duration 单位是「秒」，不是帧数——写成帧数会让 30fps 的片子
   被拉成每帧几十秒。取真实帧间差，下限一帧，避免 0 时长被 demuxer 丢掉。 */
const FPS = 30;
const lines = ['ffconcat version 1.0'];
for (let i = 0; i < frames.length; i++) {
  const dur = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 1 / FPS;
  lines.push(`file 'f${String(i).padStart(4, '0')}.jpg'`, `duration ${Math.max(1 / FPS, dur).toFixed(4)}`);
}
lines.push(`file 'f${String(frames.length - 1).padStart(4, '0')}.jpg'`);
fs.writeFileSync(path.join(FRAMES, 'list.txt'), lines.join('\n') + '\n');

const span = spanMs / 1000;
console.log(`帧 ${frames.length}，时间跨度 ${span.toFixed(1)}s，约 ${(frames.length / span).toFixed(1)} fps`);

/* 编码那一段单独收在这里：换平台要改的就是这一份参数（尤其 `-c:v` 那一条），
   镜头脚本一个字都不用动。见文件头前置第 3 条。 */
const FF_ARGS = [
  '-hide_banner',
  '-y',
  '-f',
  'concat',
  '-safe',
  '0',
  '-i',
  path.join(FRAMES, 'list.txt'),
  '-vf',
  // 帧本身就是 1280×720（上面已经断过尺寸），这里只补帧到 30fps，不再缩放补边。
  'fps=30,format=nv12',
  '-c:v',
  'h264_videotoolbox',
  '-b:v',
  '6M',
  '-pix_fmt',
  'nv12',
  // 源是 mjpeg，ffmpeg 给它套了 smpte170m 的色域标记；截图其实是 sRGB，而 sRGB 的
  // 三原色就是 BT.709 那一套，所以按 smpte170m 解会偏色（这一步是推论，没有 A/B 过两
  // 张片子）。实测到的那半：`h264_videotoolbox` 只吃 `-colorspace`（产物 ffprobe 读作
  // color_space=bt709），`-color_primaries` / `-color_trc` 传了仍是 unknown，留着是为
  // 了换编码器时不用重写；随包还带着 sRGB 的 ICC 描述文件（456 字节）。标签写对，像素不动。
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-movflags',
  '+faststart',
  OUT,
];

execFileSync(FFMPEG, FF_ARGS, { stdio: 'inherit' });
console.log(`出片 -> ${OUT}（${frames.length} 帧实抓 / 跨度 ${span.toFixed(1)}s）`);

/* 视频缩略图：商店后台那一栏要一张 440×280，而 1280×720 是 16:9、440×280 是 11:7，
   直接 scale 会把界面拉扁。所以先等比放大到「盖住」再居中裁——裁掉的是左右各 29px
   的表头留白，标题栏、按钮行与表格主体都还在画面里。
   `-ss` 放在 `-i` 之后是刻意的：放在前面走关键帧快速定位，会落到上一帧 I 帧上，
   取到的可能不是标记的那一刻。 */
execFileSync(
  FFMPEG,
  [
    '-hide_banner',
    '-y',
    '-i',
    OUT,
    '-ss',
    thumbAt.toFixed(2),
    '-frames:v',
    '1',
    // 单张图也要显式声明：文件名里没有 %03d 这种序列占位符，image2 会先警告一句
    // 「不是一个图像序列模式」，然后照样写出那一张。警告不该是常态。
    '-update',
    '1',
    '-vf',
    'scale=440:280:force_original_aspect_ratio=increase,crop=440:280',
    '-q:v',
    '2',
    THUMB,
  ],
  { stdio: 'inherit' },
);
{
  const dims = jpegDims(fs.readFileSync(THUMB));
  console.log(`缩略图 -> ${THUMB}（${dims ? `${dims.w}×${dims.h}` : '读不出'}，取自 ${thumbAt.toFixed(1)}s）`);
  if (!dims || dims.w !== 440 || dims.h !== 280) throw new Error(`缩略图不是 440×280，而是 ${JSON.stringify(dims)}`);
}

socket.close();
chrome.kill('SIGKILL');
/* 收摊。中间件落在 `.test-tmp/promo/`（一次中英各跑一轮实测留下 46M + 53M 帧与 16.8M profile），
 * 起跑时本来就会先 `rmSync` 一遍，所以出片成功之后就可以删干净。
 * 只在成功这条路上删——中途失败时那叠帧是唯一的现场证据，留着才有得查。
 * 删不动不影响产物：Chrome 刚被 SIGKILL，profile 里可能还有几百毫秒的写在途。 */
try {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {
  /* noop */
}
process.exit(0);
