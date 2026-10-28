/**
 * 商店 / 落地页源图实拍脚本
 *
 * 用 Chrome for Testing + CDP 启动已构建的扩展，写入演示规则、日志与变量，再按
 * `screenshots/` 的八个状态逐张截图。产物是 `generate-store-assets.mjs` 的输入：
 *   pnpm shots && pnpm assets && pnpm assets:en
 *
 * 为什么不是手工截图：这八张要覆盖同一份演示数据（七条规则、四条成功 + 两条失败日志、
 * 两个凭据变量），手点一遍就会漏、改名还会对不上；脚本让「截图里的数据」与
 * `generate-store-assets.mjs` 的 caption/alt 一起可复算。
 *
 * 环境：
 * - 先 `pnpm build`，脚本装的是 `.output/chrome-mv3`；
 * - 本机 Chrome for Testing（`CHROME_BIN` 指过去，或放在 `.test-tmp/chrome-mac-<arch>/`、
 *   `~/.cache/chrome-for-testing/<version>/chrome-mac-<arch>/`）；
 * - `CFT_PORT=<端口>` 时不再自起浏览器，直接连一个已经带
 *   `--enable-unsafe-extension-debugging --remote-allow-origins=*` 起好的 CFT；
 * - 本脚本不跑 CI：它要一个已构建的扩展与本机浏览器。
 *
 * 用法：
 *   pnpm shots                 # 中文，写入 screenshots/
 *   pnpm shots:en              # 英文，写入 screenshots/en/
 *   node scripts/capture-screenshots.mjs --en --out=.test-tmp/captured
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXT = path.join(ROOT, '.output/chrome-mv3');
const EN = process.argv.includes('--en');
const OUT_ARG = process.argv.find(arg => arg.startsWith('--out='));
const OUT_BASE = path.resolve(ROOT, OUT_ARG ? OUT_ARG.slice('--out='.length) : 'screenshots');
const OUT_DIR = EN ? path.join(OUT_BASE, 'en') : OUT_BASE;
const PROFILE = path.join(ROOT, `.test-tmp/screenshots-profile${EN ? '-en' : ''}`);
const PORT = process.env.CFT_PORT;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const localeFile = path.join(ROOT, 'locales', EN ? 'en' : 'zh_CN', 'options.json');
const LOCALE = JSON.parse(fs.readFileSync(localeFile, 'utf8'));
/** 界面文案从 locale 现读；脚本里不存第二份界面语言。 */
const t = key => {
  const value = LOCALE[key];
  if (typeof value !== 'string') throw new Error(`${path.relative(ROOT, localeFile)} 里读不到 ${key}`);
  return value;
};

const NAMES = EN
  ? {
      all: 'FAT → UAT all requests',
      token: 'Inject target-env token',
      mock: 'Mock user profile',
      slow: 'Timeout test: orders +8s',
      block: 'Block analytics',
      ws: 'WebSocket → UAT',
      legacy: 'Legacy API (disabled)',
    }
  : {
      all: 'FAT → UAT 全站转发',
      token: '注入目标环境 token',
      mock: 'Mock 用户资料',
      slow: '验证超时: 订单列表 +8s',
      block: '阻断埋点上报',
      ws: 'WebSocket 长连接转到 UAT',
      legacy: '旧版接口兜底（已停用）',
    };

const now = Date.now();
const RULES = [
  {
    id: 'shot-rule-all',
    name: NAMES.all,
    enabled: true,
    matchPattern: 'https://fat-api.example.com/*',
    targetUrl: 'https://uat-api.example.com',
    matchType: 'wildcard',
    priority: 1,
    createdAt: now - 86400000,
    updatedAt: now - 3600000,
  },
  {
    id: 'shot-rule-token',
    name: NAMES.token,
    enabled: true,
    matchPattern: 'https://fat-api.example.com/api/*',
    targetUrl: 'https://uat-api.example.com/api/*',
    matchType: 'wildcard',
    headerOverrides: { Authorization: 'Bearer {{UAT_TOKEN}}', 'x-gray-env': 'uat' },
    sendCredentials: true,
    priority: 2,
    createdAt: now - 80000000,
    updatedAt: now - 3400000,
  },
  {
    id: 'shot-rule-mock',
    name: NAMES.mock,
    enabled: true,
    matchPattern: 'https://fat-api.example.com/api/user/profile',
    targetUrl: 'https://uat-api.example.com',
    matchType: 'prefix',
    mockResponse: {
      status: 200,
      contentType: 'application/json',
      body: '{"code":0,"data":{"name":"Mock User","roles":["admin"]}}',
    },
    priority: 3,
    createdAt: now - 72000000,
    updatedAt: now - 3200000,
  },
  {
    id: 'shot-rule-slow',
    name: NAMES.slow,
    enabled: true,
    matchPattern: 'https://fat-api.example.com/api/orders*',
    targetUrl: 'https://uat-api.example.com',
    matchType: 'wildcard',
    delayMs: 8000,
    priority: 4,
    createdAt: now - 60000000,
    updatedAt: now - 3000000,
  },
  {
    id: 'shot-rule-block',
    name: NAMES.block,
    enabled: true,
    matchPattern: 'https://track.example.com/*',
    targetUrl: 'https://track.example.com',
    matchType: 'wildcard',
    blocked: true,
    priority: 5,
    createdAt: now - 50000000,
    updatedAt: now - 2800000,
  },
  {
    id: 'shot-rule-ws',
    name: NAMES.ws,
    enabled: true,
    matchPattern: 'wss://fat-ws.example.com/*',
    targetUrl: 'wss://uat-ws.example.com',
    matchType: 'wildcard',
    priority: 6,
    createdAt: now - 40000000,
    updatedAt: now - 2600000,
  },
  {
    id: 'shot-rule-legacy',
    name: NAMES.legacy,
    enabled: false,
    matchPattern: 'https://fat-api.example.com/v1/*',
    targetUrl: 'https://legacy.example.com',
    matchType: 'wildcard',
    retryCount: 2,
    priority: 7,
    createdAt: now - 30000000,
    updatedAt: now - 2400000,
  },
];

const RULE_BY_ID = Object.fromEntries(RULES.map(rule => [rule.id, rule]));
const LOGS = [
  {
    id: 'shot-log-6',
    timestamp: now - 10 * 60000,
    ruleId: 'shot-rule-all',
    ruleName: NAMES.all,
    originalUrl: 'https://fat-api.example.com/api/report/monthly',
    proxiedUrl: 'https://uat-api.example.com/api/report/monthly',
    method: 'GET',
    status: 502,
    duration: 812,
    proxyType: 'sw',
  },
  {
    id: 'shot-log-5',
    timestamp: now - 30 * 60000,
    ruleId: 'shot-rule-block',
    ruleName: NAMES.block,
    originalUrl: 'https://track.example.com/collect',
    proxiedUrl: 'https://track.example.com/collect',
    method: 'GET',
    error: 'Blocked by rule',
    proxyType: 'sw',
  },
  {
    id: 'shot-log-4',
    timestamp: now - 60 * 60000,
    ruleId: 'shot-rule-all',
    ruleName: NAMES.all,
    originalUrl: 'https://fat-api.example.com/api/user/list?page=1',
    proxiedUrl: 'https://uat-api.example.com/api/user/list?page=1',
    method: 'GET',
    status: 200,
    duration: 128,
    proxyType: 'sw',
  },
  {
    id: 'shot-log-3',
    timestamp: now - 120 * 60000,
    ruleId: 'shot-rule-slow',
    ruleName: NAMES.slow,
    originalUrl: 'https://fat-api.example.com/api/orders',
    proxiedUrl: 'https://uat-api.example.com/api/orders',
    method: 'POST',
    status: 200,
    duration: 3214,
    proxyType: 'sw',
  },
  {
    id: 'shot-log-2',
    timestamp: now - 180 * 60000,
    ruleId: 'shot-rule-mock',
    ruleName: NAMES.mock,
    originalUrl: 'https://fat-api.example.com/api/user/profile',
    proxiedUrl: 'https://fat-api.example.com/api/user/profile',
    method: 'GET',
    status: 200,
    duration: 6,
    proxyType: 'sw',
    responseBody: '{"code":0,"data":{"name":"Mock User","roles":["admin"]}}',
  },
  {
    id: 'shot-log-1',
    timestamp: now - 240 * 60000,
    ruleId: 'shot-rule-token',
    ruleName: NAMES.token,
    originalUrl: 'https://fat-api.example.com/api/user/list?page=1',
    proxiedUrl: 'https://uat-api.example.com/api/user/list?page=1',
    method: 'GET',
    status: 200,
    duration: 96,
    proxyType: 'sw',
  },
];

const VARIABLES = {
  FAT_COOKIE_PAIR: 'fat_cookie=shot-demo',
  UAT_TOKEN: 'uat-token-shot-demo',
};

const IMPORT_PAYLOAD = {
  // 演示文件由当前这份构建导出，版本号跟着 package.json 走（脚本里不复述）
  version: PKG.version,
  schemaVersion: 2,
  exportTime: now,
  config: {
    enabled: true,
    rules: [
      {
        ...RULE_BY_ID['shot-rule-token'],
        id: 'import-token',
        targetUrl: 'https://pre-api.example.com/api/*',
      },
      {
        ...RULE_BY_ID['shot-rule-all'],
        id: 'import-all',
        targetUrl: 'https://pre-api.example.com',
      },
      {
        ...RULE_BY_ID['shot-rule-mock'],
        id: 'import-staging',
        name: EN ? 'Imported staging rule' : '导入的预发规则',
        matchPattern: 'https://fat-api.example.com/api/staging/*',
        targetUrl: 'https://pre-api.example.com/api/staging/',
        priority: 8,
        createdAt: now,
        updatedAt: now,
      },
    ],
  },
};

const missing = [];
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  missing.push('没有 .output/chrome-mv3 —— 先跑一次 `pnpm build`');
}
if (!PORT) {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const app = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const expand = pattern => {
    const star = pattern.indexOf('*');
    if (star === -1) return fs.existsSync(pattern) ? [pattern] : [];
    const dir = path.dirname(pattern.slice(0, star));
    const suffix = pattern.slice(star + 1);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map(name => path.join(dir, name) + suffix)
      .filter(hit => fs.existsSync(hit));
  };
  const candidates = [
    process.env.CHROME_BIN,
    path.join(ROOT, '.test-tmp', 'chrome-mac-*', app),
    path.join(os.homedir(), '.cache', 'chrome-for-testing', '*', `chrome-mac-${arch}`, app),
  ].filter(Boolean);
  const chrome = candidates.flatMap(expand)[0];
  if (!chrome) {
    missing.push(
      '找不到 Chrome for Testing：设置 CHROME_BIN、放到 .test-tmp/chrome-mac-<arch>/，' +
        '或用 CFT_PORT 连一个已起好的实例',
    );
  } else {
    process.env.CHROME_BIN = chrome;
  }
}
if (missing.length) {
  console.error(missing.map(line => `✗ ${line}`).join('\n'));
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

/* ───────── CDP 客户端：优先连外部 CFT，否则自己起一个 ───────── */

let chromeProc = null;
let wsUrl;
if (PORT) {
  const version = await (await globalThis.fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  wsUrl = version.webSocketDebuggerUrl;
} else {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  chromeProc = spawn(
    process.env.CHROME_BIN,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--user-data-dir=${PROFILE}`,
      '--enable-unsafe-extension-debugging',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const kill = () => {
    try {
      chromeProc.kill('SIGKILL');
    } catch {
      /* noop */
    }
  };
  process.on('exit', kill);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      kill();
      process.exit(1);
    });
  }
  wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 没有报出调试端口')), 60000);
    chromeProc.stderr.on('data', chunk => {
      buf += chunk.toString();
      const match = buf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]{36})/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
}

const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
});
let seq = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const msg = JSON.parse(event.data.toString());
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
    }, 30000);
    pending.set(id, {
      resolve: value => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: error => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });

const { id: extensionId } = await send('Extensions.loadUnpacked', { path: EXT });
if (!extensionId) throw new Error('Extensions.loadUnpacked 没有返回扩展 ID');

const { targetId: optionsTarget } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: s } = await send('Target.attachToTarget', { targetId: optionsTarget, flatten: true });
await send('Target.activateTarget', { targetId: optionsTarget });
await send('Page.bringToFront', {}, s);
await send('Page.enable', {}, s);
await send('Runtime.enable', {}, s);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, s);

const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s);
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const waitFor = async (fn, timeout = 12000, interval = 150) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return true;
    } catch {
      /* 页面导航/重载中 */
    }
    await sleep(interval);
  }
  return false;
};
const setViewport = async (width, height, deviceScaleFactor = 1) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false }, s);
  await sleep(250);
};
const pressEscape = async () => {
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
    s,
  );
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
    s,
  );
  await sleep(450);
};
const capture = async file => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, s);
  const out = path.join(OUT_DIR, file);
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(`shot  ${path.relative(ROOT, out)}`);
};

/**
 * 最上层那个「真的看得见」的弹窗。
 *
 * EP 关闭后遮罩可能仍是 `display:block`、只是把 dialog 的 opacity 落到 0；
 * 只按 display 找会选中一个正在退场的旧弹窗，后面的输入框自然找不到。
 */
const TOP_DIALOG = `(() => {
  const overlays = [...document.querySelectorAll('.el-overlay')].filter(el => {
    if (getComputedStyle(el).display === 'none') return false;
    const dialog = el.querySelector('.el-dialog');
    if (!dialog) return false;
    const style = getComputedStyle(dialog);
    return style.visibility !== 'hidden' && Number(style.opacity) > 0.5;
  });
  return overlays[overlays.length - 1]?.querySelector('.el-dialog') || null;
})()`;

const visibleDialog = async () =>
  evaluate(`(() => {
    const dialog = ${TOP_DIALOG};
    return dialog ? { title: dialog.querySelector('.el-dialog__title')?.textContent?.trim() || '', text: dialog.innerText.slice(0, 100) } : null;
  })()`);
const waitDialog = title =>
  waitFor(async () => {
    const dialog = await visibleDialog();
    return !!dialog && (!title || dialog.title === title);
  });

/** 用弹窗头部那枚 × 关闭：比 Escape 稳，不会被输入框的焦点或 EP 的焦点陷阱吃掉。 */
const closeDialog = async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clicked = await evaluate(`(() => {
      const dialog = ${TOP_DIALOG};
      const button = dialog?.querySelector('.el-dialog__headerbtn');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked || attempt > 0) await pressEscape();
    await sleep(450);
    if (!(await visibleDialog())) return;
  }
  throw new Error(`弹窗关不掉：${JSON.stringify(await visibleDialog())}`);
};

/** 关日志抽屉：它的关闭按钮在 EP 的 header 里，类名与弹窗不同。 */
const closeDrawer = async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await evaluate(`(() => {
      const button = document.querySelector('.el-drawer__close-btn');
      if (button) { button.click(); return true; }
      return false;
    })()`);
    await sleep(450);
    const open = await evaluate(`(() => {
      const drawer = document.querySelector('.el-drawer');
      const overlay = drawer?.closest('.el-overlay');
      return !!drawer && !!overlay && getComputedStyle(overlay).display !== 'none';
    })()`);
    if (!open) return;
    await pressEscape();
    await sleep(450);
    const stillOpen = await evaluate(`(() => {
      const drawer = document.querySelector('.el-drawer');
      const overlay = drawer?.closest('.el-overlay');
      return !!drawer && !!overlay && getComputedStyle(overlay).display !== 'none';
    })()`);
    if (!stillOpen) return;
  }
  throw new Error('日志抽屉关不掉');
};

/** 截图前把 options 页拉到前台：onInstalled 会另开一个 options 标签，后台标签的表格层可能不重绘。 */
const focusOptions = async () => {
  await send('Target.activateTarget', { targetId: optionsTarget });
  await send('Page.bringToFront', {}, s);
  await sleep(150);
};

const seed = () =>
  evaluate(`(async () => {
    await chrome.storage.local.set({
      proxy_config: ${JSON.stringify({ enabled: true, rules: RULES })},
      request_logs: ${JSON.stringify(LOGS)},
      variables: ${JSON.stringify(VARIABLES)},
      locale: ${JSON.stringify(EN ? 'en' : 'zh_CN')},
      theme: 'sky',
      theme_mode: 'light',
      welcome_dismissed: true
    });
    return 'seeded';
  })()`);

async function reloadOptions(width, height, dpr = 1) {
  await focusOptions();
  await setViewport(width, height, dpr);
  await send('Page.reload', {}, s);
  // `Page.reload` 的求值可能还落在旧文档上：先等它真的换掉，再谈表格行数
  await sleep(1000);
  await waitFor(() => evaluate("document.readyState === 'complete' && !!document.querySelector('.rules-count-info')"));
  await waitFor(
    () =>
      evaluate(`(() => {
        const rows = document.querySelectorAll('.el-table__row');
        const table = document.querySelector('.el-table');
        const header = document.querySelector('.el-table__header');
        const swapping = document.querySelector('.panel-swap-enter-active, .panel-swap-leave-active');
        const masks = [...document.querySelectorAll('.el-loading-mask')].filter(mask => getComputedStyle(mask).display !== 'none');
        return (
          rows.length === 7 &&
          !!table &&
          !!header &&
          !swapping &&
          masks.length === 0 &&
          table.getBoundingClientRect().height > 0
        );
      })()`),
    15000,
  );
  await sleep(900);
}

await focusOptions();
await send('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` }, s);
await waitFor(() => evaluate("document.readyState === 'complete' && !!document.querySelector('.rules-count-info')"));
// 安装钩子会自己开一个 options 标签，它会抢前台；截图只认我们这一张
await sleep(800);
const extraTabs = (await send('Target.getTargets')).targetInfos.filter(
  target => target.type === 'page' && target.url.includes('/options.html') && target.targetId !== optionsTarget,
);
for (const extra of extraTabs) await send('Target.closeTarget', { targetId: extra.targetId }).catch(() => {});
await focusOptions();
// onInstalled 可能与第一次写入抢；补种一次再重载，避免把空配置拍进图里
await seed();
await sleep(400);
await seed();
await reloadOptions(1440, 900);
await capture('opt-options-main.png');

/* ───────── 规则编辑弹窗 ───────── */
await setViewport(1600, 1120);
await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.el-table__row')];
  rows[1].querySelector('.row-actions .el-button').click();
  return true;
})()`);
await waitDialog(t('editRule'));
await sleep(900);
await capture('opt-rule-dialog.png');
await closeDialog();
await setViewport(1440, 900);

/* ───────── URL 匹配测试 ───────── */
await evaluate("location.hash = '#url-test'; true");
await waitDialog(t('urlTest'));
await waitFor(() =>
  evaluate(`(() => {
      const dialog = ${TOP_DIALOG};
      return [...(dialog?.querySelectorAll('input') || [])].some(
        el => el.placeholder === ${JSON.stringify(t('urlTestPlaceholder'))},
      );
    })()`),
);
const urlFilled = await evaluate(`(() => {
  const dialog = ${TOP_DIALOG};
  const input = [...(dialog?.querySelectorAll('input') || [])]
    .find(el => el.placeholder === ${JSON.stringify(t('urlTestPlaceholder'))});
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'https://fat-api.example.com/api/user/list?page=1');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);
if (urlFilled !== 'https://fat-api.example.com/api/user/list?page=1') {
  throw new Error(`URL 测试输入没填进去：${urlFilled}`);
}
await waitFor(() => evaluate("!!document.querySelector('.url-test-dialog .result-block')"));
await sleep(600);
await capture('opt-rule-test.png');
await closeDialog();

/* ───────── 请求日志抽屉 ───────── */
await evaluate("location.hash = '#logs'; true");
await waitFor(() => evaluate("document.querySelectorAll('.log-table .el-table__row').length === 6"));
await sleep(700);
await capture('opt-log-drawer.png');
await closeDrawer();

/* ───────── 导入/导出：合并模式 + 一份会触发「跳过 + 冲突」的 JSON ───────── */
await setViewport(1600, 1000);
await evaluate("location.hash = '#import-export'; true");
await waitDialog(t('importExportConfig'));
await sleep(500);
await evaluate(`(() => {
  const dialog = ${TOP_DIALOG};
  const textarea = dialog?.querySelector('.paste-section textarea');
  if (!textarea) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, ${JSON.stringify(JSON.stringify(IMPORT_PAYLOAD, null, 2))});
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(400);
// 合并模式（第二枚 radio）：替换模式会把现有 7 条整包换掉，拍出来就不是「跳过 + 冲突」那一格
await evaluate(`(() => {
  const dialog = ${TOP_DIALOG};
  const radios = [...(dialog?.querySelectorAll('.import-mode-row .el-radio') || [])];
  if (radios.length < 2) return false;
  radios[1].click();
  return true;
})()`);
await sleep(350);
await evaluate(`(() => {
  const dialog = ${TOP_DIALOG};
  dialog?.querySelector('.preview-actions .el-button')?.click();
  return true;
})()`);
await waitFor(() => evaluate("!!document.querySelector('.import-preview li')"), 12000);
await sleep(500);
// 预览在导入小节下方：把导入标题滚到正文顶部，让预览一起进画面
await evaluate(`(() => {
  const dialog = ${TOP_DIALOG};
  const body = dialog?.querySelector('.dialog-body-scroll') || dialog?.querySelector('.el-dialog__body');
  const title = [...dialog.querySelectorAll('h3')].find(el => el.textContent.trim() === ${JSON.stringify(t('importSectionTitle'))});
  if (!body || !title) return false;
  const top = title.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 24;
  body.scrollTop = Math.max(0, top);
  return true;
})()`);
await sleep(400);
await capture('opt-import-export.png');
await closeDialog();
await setViewport(1440, 900);

/* ───────── 偏好设置：主题 / 语言 / 自动关闭 / 凭据变量 ───────── */
await evaluate("location.hash = '#settings'; true");
await waitDialog(t('settingsTitle'));
await sleep(700);
await capture('opt-variables-dialog.png');
await closeDialog();

/* ───────── 弹窗：假一个当前页标签，让「本页命中」有真实内容 ───────── */
const { targetId: popupTarget } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: ps } = await send('Target.attachToTarget', { targetId: popupTarget, flatten: true });
await send('Target.activateTarget', { targetId: popupTarget });
await send('Page.bringToFront', {}, ps);
await send('Page.enable', {}, ps);
await send('Runtime.enable', {}, ps);
// 400×560：止于「本页地址命中」卡下沿，不把下方动作区的前两张卡切一半（旧图同样只截首屏）
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 560, deviceScaleFactor: 2, mobile: false }, ps);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, ps);
await send(
  'Page.addScriptToEvaluateOnNewDocument',
  {
    source: `(() => {
      const fake = {
        id: 4242,
        url: 'https://fat-api.example.com/',
        active: true,
        windowId: 1,
        index: 0,
        highlighted: true,
        pinned: false,
        incognito: false,
        selected: true,
        discarded: false,
        autoDiscardable: true,
        groupId: -1
      };
      const original = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info, ...rest) => {
        if (!(info && info.active && info.currentWindow)) return original(info, ...rest);
        // 用真实 tab id（弹窗自己那一页）配一个假的 URL：页面命中按 URL 算，
        // 而 DNR 采样只认有效 tab id —— 编一个 id 会让「本页·近 5 分钟」变成读不到。
        const [tab] = await original({ active: true, currentWindow: true });
        return [{ ...fake, id: tab?.id ?? fake.id, url: fake.url }];
      };
    })();`,
  },
  ps,
);
await send('Page.navigate', { url: `chrome-extension://${extensionId}/popup.html` }, ps);
const pevaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ps);
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
await waitFor(() => pevaluate("document.readyState === 'complete' && !!document.querySelector('.popup-container')"));
await waitFor(
  () =>
    pevaluate(
      "(document.querySelector('.page-hit-rule-tag')?.textContent || '').includes(" + JSON.stringify(NAMES.all) + ')',
    ),
  12000,
);
await sleep(700);
const { data: popupData } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, ps);
fs.writeFileSync(path.join(OUT_DIR, 'opt-popup.png'), Buffer.from(popupData, 'base64'));
console.log(`shot  ${path.relative(ROOT, path.join(OUT_DIR, 'opt-popup.png'))}`);
await send('Target.closeTarget', { targetId: popupTarget }).catch(() => {});

/* ───────── 深色主题 ───────── */
await focusOptions();
await evaluate("chrome.storage.local.set({ theme_mode: 'dark' }); true");
await reloadOptions(1440, 900);
await sleep(600);
await capture('opt-dark-mode.png');

console.log(`\n完成：${path.relative(ROOT, OUT_DIR)}（${EN ? 'en' : 'zh'}）`);
if (chromeProc) {
  await send('Browser.close').catch(() => {});
  socket.close();
} else {
  socket.close();
}
