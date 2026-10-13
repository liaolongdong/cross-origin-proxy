#!/usr/bin/env node
/**
 * 模拟后端启动器：一条命令起 web / dev / fat / uat / prod 五个环境 + 触发页
 *
 * 五个环境跑的是**同一份路由表**（`backend.mjs`），差别只有两处，而这两处正是代理规则
 * 要区分的维度：
 * 1. 端口（也就是 origin）——规则按端口选环境；
 * 2. CORS 档——`wildcard` 放行任意来源、`local` 回显本机来源、`harness` 只放行触发页、
 *    `none` 一律不放行。有了这四档，「纯 URL 重写」（网络层通道）与「后台代发」才第一次变成
 *    肉眼可分的事：同一条重写规则指向 `wildcard` 的 dev 就 200，指向 `none` 的 prod 就必定
 *    在浏览器层被拦；指向回显式的 `local` / `harness` 也拦——跨原点的重写会让目标收到
 *    `Origin: null`（实测见 `backend.mjs`），这一档接不住它。
 *    给那条失败规则加一项后台专属能力（最省事的是加个响应头改写）它才切到代发通道并回 200。
 *
 * 浏览器侧只认 `http://localhost:<port>`（`--canonical` 可换），而监听绑在 `--host`
 * （默认 127.0.0.1）。这两个值分开是有必要的：uat 那一档要按 `Origin` 逐字比对放行，
 * 而 `Origin` 是地址栏里那个 host，不是 socket 绑定地址。
 *
 * 用法：
 *   node scripts/mock-env/index.mjs                 # 五档全起
 *   node scripts/mock-env/index.mjs --only=web,fat,uat
 *   node scripts/mock-env/index.mjs --base=6300     # 整体平移端口，避开占用
 *   node scripts/mock-env/index.mjs --no-ws         # 不挂长连接
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVS, createEnvServer, ROUTES } from './backend.mjs';
import { renderHarness } from './harness.mjs';
import { attachWebSocket } from './websocket.mjs';
import { PRESET_FILE, buildDemoRules } from './demoRules.mjs';

const BASE_DEFAULT = 5300;

const HERE = dirname(fileURLToPath(import.meta.url));

const DEMO_VARIABLES = [
  {
    name: 'API_TOKEN',
    value: 'demo-token-not-a-secret',
    usedBy: '「FAT → DEV（注入凭据头 {{API_TOKEN}}）」的 Authorization',
  },
  { name: 'API_KEY', value: 'demo-key-not-a-secret', usedBy: '同一条规则的 X-Api-Key，用来看两个头各自到位没有' },
];

function parseArgs(argv) {
  const opts = { base: BASE_DEFAULT, host: '127.0.0.1', canonical: 'localhost', only: null, ws: true, help: false };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') opts.help = true;
    else if (raw === '--no-ws') opts.ws = false;
    else if (raw.startsWith('--base=')) opts.base = Number(raw.slice('--base='.length));
    else if (raw.startsWith('--host=')) opts.host = raw.slice('--host='.length);
    else if (raw.startsWith('--canonical=')) opts.canonical = raw.slice('--canonical='.length);
    else if (raw.startsWith('--only='))
      opts.only = raw
        .slice('--only='.length)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    else if (!raw.startsWith('--')) continue;
    else {
      console.error(`未知参数：${raw}（--help 看用法）`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.base) || opts.base < 1024 || opts.base > 65000) {
    console.error(`--base 需要一个 1024-65000 的整数端口，收到：${opts.base}`);
    process.exit(2);
  }
  const known = Object.keys(ENVS);
  if (opts.only) {
    const bad = opts.only.filter(e => !known.includes(e));
    if (bad.length) {
      console.error(`--only 里有不认识的环境：${bad.join(', ')}（可选：${known.join(', ')}）`);
      process.exit(2);
    }
    if (!opts.only.includes('web')) console.error('提示：没起 web 这一档，触发页就没有落脚点了。');
  }
  return opts;
}

function pad(text, width) {
  // 中文按两个显示宽度算，否则表格在终端里会歪
  let w = 0;
  for (const ch of String(text)) w += ch.codePointAt(0) > 0xff ? 2 : 1;
  return String(text) + ' '.repeat(Math.max(0, width - w));
}

/**
 * 演示规则集按本次的端口与 host 现生成一份：它和触发页读的是同一份事实。
 *
 * 仓库里那份 `presets/demo-rules.json` 是它的产物，不是手抄本——手抄的失效方式是静默的：
 * 换一次 `--base`，规则仍指向 5302，页面每一格都连到不存在的地址，而扩展界面一切正常。
 */
function writePreset({ base, canonical }) {
  let version = '0.0.0';
  try {
    version = JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8')).version ?? version;
  } catch {
    // version 只是文件里给人看的一行，导入侧不参与判读（判读看的是 schemaVersion），
    // 读不到它不该拦下整个启动
  }
  const preset = buildDemoRules({ base, canonical, version });
  const dir = join(HERE, 'presets');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, PRESET_FILE);
  writeFileSync(file, `${JSON.stringify(preset, null, 2)}\n`, 'utf8');
  return { file, count: preset.config.rules.length };
}

const HELP = `用法：node scripts/mock-env/index.mjs [--base=${BASE_DEFAULT}] [--host=127.0.0.1] [--canonical=localhost] [--only=web,fat,uat,prod,dev] [--no-ws]

  --base=N        整体平移端口（默认 ${BASE_DEFAULT}，五档依次 ${BASE_DEFAULT}-${BASE_DEFAULT + 4}）
  --host=H        监听地址（默认 127.0.0.1；要给局域网别的机器访问就写 0.0.0.0）
  --canonical=H   浏览器里用的主机名（默认 localhost，它同时是 uat 那一档的 CORS 白名单）
  --only=a,b      只起这几个环境
  --no-ws         不挂载长连接（/ws 会回 404）`;

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const selected = opts.only ?? Object.keys(ENVS);
  const ports = Object.fromEntries(selected.map(env => [env, opts.base + (ENVS[env].port - BASE_DEFAULT)]));
  const pagePort = ports.web ?? ports[selected[0]];
  const harnessOrigin = `http://${opts.canonical}:${pagePort}`;

  const instances = [];
  for (const env of selected) {
    const { server, ctx } = createEnvServer({
      env,
      port: ports[env],
      host: opts.host,
      harnessOrigin,
      pageHtml:
        env === 'web'
          ? renderHarness({ ports, host: opts.host, canonicalHost: `http://${opts.canonical}`, withWs: opts.ws })
          : null,
    });
    if (opts.ws) attachWebSocket(server, { env, port: ports[env], getContext: () => ctx });
    instances.push({ env, server, ctx, port: ports[env] });
  }

  // 先把长连接的 upgrade 监听挂上，再一起 bind：反过来会在两个 tick 之间留一段
  // 「端口已开、但 /ws 还没人接」的空档，那时页面上的第一条握手就会拿到 404。
  for (const { server, port } of instances) server.listen(port, opts.host);

  const preset = writePreset(opts);

  const url = env => `http://${opts.canonical}:${ports[env]}`;
  console.log(`\n跨域代理助手 · 模拟后端（同一份路由表，${ROUTES.length} 条接口，各环境只差端口与 CORS 档）\n`);
  console.log(`  ${pad('环境', 8)}${pad('端口', 8)}${pad('CORS', 14)}${pad('地址', 26)}说明`);
  for (const { env } of instances) {
    const corsLabel = { wildcard: '放行任意来源', local: '放行本机', harness: '只放行触发页', none: '一律不放行' }[
      ENVS[env].cors
    ];
    console.log(`  ${pad(env, 8)}${pad(ports[env], 8)}${pad(corsLabel, 14)}${pad(url(env), 26)}${ENVS[env].note}`);
  }
  console.log('');
  console.log(`  触发页 ${ports.web ? `${url('web')}/` : `（本次没起 web 这一档，无触发页）`}`);
  console.log(`  任一环境的自述 ${url(instances[0].env)}/env`);
  console.log(`  演示规则集 ${preset.file}`);
  console.log(
    `  ${pad('', 6)}本次按 --base=${opts.base} --canonical=${opts.canonical} 现生成，${preset.count} 条（仓库里那份就是它）`,
  );
  console.log('');
  console.log('  验证路径（四步）');
  console.log('   1. chrome://extensions 打开开发者模式 → 加载已解压的扩展：选 .output/chrome-mv3（先跑 pnpm build）');
  console.log(
    ports.web
      ? `   2. 打开 ${url('web')}/ 什么都不导入，先点「全部跑一遍」——这一列是基线：没有规则时每一格本来的样子`
      : '   2. 本次没起 web 这一档，触发页不可用（去掉 --only 里的排除即可）',
  );
  console.log(`   3. 扩展里导入 ${preset.file}（替换模式），再到 设置 → 凭据变量 里加上下面两个名字`);
  console.log('   4. 回触发页重跑，逐条比对「期望」；日志抽屉与 popup 的命中统计同页可查');
  console.log('');
  console.log('  凭据变量（演示值，不是任何真实密钥；规则里写的是 {{名称}}，真值只存在本机 storage）');
  for (const v of DEMO_VARIABLES) {
    console.log(`   ${pad(v.name, 12)}= ${pad(v.value, 34)}${v.usedBy}`);
  }
  console.log('');
  console.log('  Ctrl+C 关闭。\n');

  const shutdown = () => {
    console.log('\n正在关闭……');
    for (const { server } of instances) server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
