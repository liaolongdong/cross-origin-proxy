#!/usr/bin/env node
/**
 * Chrome Web Store 凭据的**离线**预检（`.github/workflows/release.yml` 的 `Store preflight` 那一步调用，
 * 本机也可以直接 `node scripts/store-preflight.mjs` 跑）。
 *
 * 只做形状与组合判定，不碰网络、不碰 git、不读构建产物——一个字节都不出网，所以它敢排在
 * 六七分钟的构建**之前**。判据全部只看 `process.env`（外加本机 `.env.submit`，与
 * `publish-browser-extension` 自己那份读取口径一致：命令行/环境变量优先于文件）。
 *
 * 为什么值得单独一格：这条链路上最贵的两种失败都来自「环境变量里那几个值」，而它们在
 * GitHub 的日志里长得和成功一模一样——
 * 1. **名字不对**：本仓库已经连着两次「Release 建好、zip 挂上、整条 run 全绿，Google 那边
 *    什么都没收到」，原因都是凭据存在但读的键名不是 CLI 要的那四个。
 * 2. **形状不对**：服务账号私钥必须是真换行的 PEM。从 `service-account.json` 里复制 `private_key`
 *    字段时粘的是 JSON 那一行的字面 `\n`（两个字符），`createPrivateKey` 当场读不出密钥。
 *
 * 三条固定取舍，改判据前先读：
 * - **只说名字、长度与期望形状，绝不复读值**。这一格的输出进 CI 日志，而日志会被检索、被缓存、
 *   被截图；一份形状错的私钥恰恰是最不该落到日志里的那串字符。
 * - **v1.1 的键只要带着值就红**，不是「忽略」。v2 的 schema 里根本没有 `chrome.publishTarget` 这些键，
 *   传进去会被 mask 掉——「选了等于没选」的旋钮比没有旋钮更糟，因为操作者以为自己在发测试通道。
 * - **读不出就当不合法**，不做「大概是好的」推断。这一格翻红的代价是一次人工看一眼，
 *   放过去一次不可撤回的提审代价大得多。
 */

import { readFileSync } from 'fs';
import { createPrivateKey } from 'crypto';
import { parseEnv } from 'util';
import { pathToFileURL } from 'url';
import { STORE_SECRET_NAMES } from './release-gate.mjs';

/** 唯一受支持的 API 版本；与 `release.yml` 的 `CHROME_API_VERSION` 同一个值。 */
export const REQUIRED_API_VERSION = 'v2';
const API_VERSION_KEY = 'CHROME_API_VERSION';

/**
 * v1.1 时代的键。它们在 v2 下没有任何读者：`apiVersion` 不是 `v2` 时整条链路已经先红了，
 * 是 `v2` 时这份 schema 里连这些键都没有（被 mask）。留着只会让人以为自己在配另一件事。
 */
export const RETIRED_V1_1_KEYS = Object.freeze([
  'CHROME_CLIENT_ID',
  'CHROME_CLIENT_SECRET',
  'CHROME_REFRESH_TOKEN',
  'CHROME_PUBLISH_TARGET',
  'CHROME_REVIEW_EXEMPTION',
]);

/** 短时令牌那条认证路径：本链路不支持，见 `ACCESS_TOKEN_REASON`。 */
const ACCESS_TOKEN_KEY = 'CHROME_SERVICE_ACCOUNT_ACCESS_TOKEN';

/**
 * 会**改变发布形态**、但流水线不建模的开关。真值（truthy）出现即红：它们每一个都意味着
 * 「商店那头的结果和这条链路声称要做的不是同一件事」。
 */
export const SEMANTIC_SWITCHES = Object.freeze([
  {
    name: 'CHROME_CANCEL_PENDING',
    reason:
      '提审前会先撤掉商店那边正在排队的上一版。那是别人可能正在等的动作，只能由人当场决定，不接受一个环境变量兜住它。',
  },
  {
    name: 'CHROME_SKIP_REVIEW',
    reason:
      '申请跳过人工审核。这条通道只对少数变更类型开放（见 developer.chrome.com/docs/webstore/skip-review），本扩展不在其中。',
  },
]);

/** 出现就说一句、但不判红的键（它们让本机那次手动提审和 CI 那次不完全一样）。 */
export const UNMODELED_KEYS = Object.freeze([
  'CHROME_PUBLISH_TYPE',
  'CHROME_DEPLOY_PERCENTAGE',
  'CHROME_SKIP_SUBMIT_REVIEW',
]);

const ENV_FILE = '.env.submit';

const EXTENSION_ID_RE = /^[a-p]{32}$/;
const PUBLISHER_ID_RE = /^[A-Za-z0-9._-]{1,63}$/;
const CLIENT_EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.iam\.gserviceaccount\.com$/;

const isTruthy = value => /^(true|1)$/i.test(String(value ?? '').trim());

/**
 * 私钥能不能被当成一份真密钥读出来。
 * @param {string} value 环境变量里的原文
 * @returns {string} 空串表示通过；否则是那句「错在哪、该怎么办」
 */
export function privateKeyProblem(value) {
  // 两个字符的 `\n`（不是换行本身）只有一种来历：把 JSON 里那一行原样复制了过来。
  if (value.includes('\\n')) {
    return (
      '值里含有字面的反斜杠 + n 两字符序列，也就是 JSON 源文件里的转义写法没被还原。' +
      'GitHub Secrets 与本机的 .env.submit 都要存成**真换行**的 PEM（第一行是 -----BEGIN PRIVATE KEY-----）。' +
      '`wxt submit init` 会在写盘前自己还原一次，手动粘贴则不会。'
    );
  }
  if (!value.includes('-----BEGIN')) return '不是 PEM 文本：没有 -----BEGIN ... ----- 那一行。';
  try {
    createPrivateKey({ key: value, format: 'pem' });
  } catch (err) {
    // 只用 code/reason/name 组这句话：`err.message` 在某些 OpenSSL 分支里会带上被解析的片段，
    // 而这一格的输出要进 CI 日志。
    const code = err.code || err.reason || err.name || 'unknown';
    return `PEM 读不出密钥（${code}）。通常是首尾行被截断、行首多了空格，或者复制到的不是 private_key 那一字段。`;
  }
  return '';
}

/**
 * 单个键的形状判据。
 * @param {string} name 键名
 * @param {string} value 值
 * @returns {string} 空串表示通过
 */
export function shapeProblem(name, value) {
  switch (name) {
    case 'CHROME_EXTENSION_ID':
      // Chrome 的扩展 ID 是 32 个 **a–p** 字母（不是十六进制，也不是任意 base32）。
      // 它进的是 URL 路径 `publishers/{P}/items/{E}`，所以形状钉死同时也是路径穿越面收口。
      if (!EXTENSION_ID_RE.test(value)) {
        return (
          `长度 ${value.length} 的值形状不对（不复读原文）：扩展 ID 是 32 个 a–p 之间的小写字母，` +
          '在开发者控制台的商品页 URL 与商店详情页 URL 里都能看到它。'
        );
      }
      return '';
    case 'CHROME_PUBLISHER_ID':
      // 同样进 URL 路径。`/` `?` `#` `%` 与空白一律不接受，长度上限取 URL 单段的保守值。
      if (!PUBLISHER_ID_RE.test(value)) {
        return (
          `长度 ${value.length} 的值形状不对（不复读原文）：publisher ID 只能由字母、数字与 . _ - 组成，` +
          '在开发者控制台选中发布者后的地址 devconsole/<publisher-id> 里能看到。'
        );
      }
      return '';
    case 'CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL':
      if (!CLIENT_EMAIL_RE.test(value)) {
        return (
          `长度 ${value.length} 的值形状不对（不复读原文）：服务账号邮箱必须以 .iam.gserviceaccount.com 结尾，` +
          '也就是 JSON 文件里的 client_email 那一条，不是普通 Gmail 地址、也不是 serviceAccountName。'
        );
      }
      return '';
    case 'CHROME_SERVICE_ACCOUNT_PRIVATE_KEY':
      return privateKeyProblem(value);
    default:
      return '';
  }
}

/**
 * 全部判据。纯函数：收一份 env 对象，吐结构化结论，不打印、不退出。
 *
 * @param {Record<string, string|undefined>} env 已合并过的环境变量
 * @param {{fileName?: string}} [extra] fileName 是本机 .env.submit 的路径，只为「值从哪来」那句话
 * @returns {{ok: boolean, items: Array<{name: string, ok: boolean, detail: string}>, notes: string[]}}
 */
export function evaluate(env, extra = {}) {
  const items = [];
  const notes = [];
  const get = name => String(env[name] ?? '');

  const apiVersion = get(API_VERSION_KEY);
  if (apiVersion !== REQUIRED_API_VERSION) {
    items.push({
      name: API_VERSION_KEY,
      ok: false,
      detail:
        `当前是「${apiVersion || '未设置'}」，本链路只支持 ${REQUIRED_API_VERSION}。` +
        '这个字段缺省时 `publish-browser-extension` 按 **v1.1 的 schema** 判据走老客户端，' +
        `而 v1.1 于 2026-10-15 停止支持——「没显式写 v2」不是走老路，是拿已经退役的那条 API 去发版。`,
    });
  } else {
    items.push({ name: API_VERSION_KEY, ok: true, detail: `${REQUIRED_API_VERSION}` });
  }

  // 四项凭据：先分「没配」与「配了但形状不对」两种说法。把它们合成一条会让「名字打错了」
  // 读起来像「值写错了」，而这两种处置完全不同（前者去改名或新增，后者去重新拿值）。
  for (const name of STORE_SECRET_NAMES) {
    const value = get(name);
    if (!value.trim()) {
      items.push({
        name,
        ok: false,
        detail: '仓库级没配这个 Secrets（或值为空）。配了但名字拼错，在这里的表现与没配一模一样。',
      });
      continue;
    }
    const problem = shapeProblem(name, value);
    items.push({ name, ok: !problem, detail: problem || `已配，长度 ${value.length}，形状通过` });
  }

  // v1.1 的键：有值就红，不是「忽略」。判据只能到「非空」这一层——`process.env` 与
  // `${{ secrets.X }}` 都不区分「设成空串」与「压根没设」（未定义的 Secrets 渲染出来就是空串），
  // 所以 `CHROME_PUBLISH_TARGET=` 这种空壳在这里与不存在同形，只能放过；tests 里那条
  // 「空壳的退役键不红」记录的就是这个边界，不是判据漏了一档。
  for (const name of RETIRED_V1_1_KEYS) {
    if (get(name)) {
      items.push({
        name,
        ok: false,
        detail:
          '这是 Chrome Web Store API v1.1 的键，v2 的 schema 里没有它（传进去会被 mask 掉，静默失效）。' +
          '确认不需要回滚到 v1.1 之后把它删掉；如果本意是「先发测试通道」，v2 没有这个概念，见 RELEASING.md §3.4。',
      });
    }
  }

  if (get(ACCESS_TOKEN_KEY)) {
    items.push({
      name: ACCESS_TOKEN_KEY,
      ok: false,
      detail:
        '本链路不支持短时访问令牌那条认证路径：它几十分钟就过期，而流水线拿不到新的。' +
        '请用服务账号邮箱 + 私钥那一对。',
    });
  }

  for (const { name, reason } of SEMANTIC_SWITCHES) {
    if (isTruthy(get(name))) {
      items.push({ name, ok: false, detail: `这份配置会改变发布形态，而流水线不建模它。${reason}` });
    }
  }

  for (const name of UNMODELED_KEYS) {
    if (get(name))
      notes.push(`${name} 已被设置——它会影响这一次提交的行为，但不是这条链路会用的值（本机手动提审时尤其注意）。`);
  }

  if (extra.fileName)
    notes.push(`判定用的值来自 ${extra.fileName} 与本进程环境合并后的结果（同名时以本进程环境为准）。`);

  return { ok: items.every(item => item.ok), items, notes };
}

/** 把结论渲染成给人看的报告。只含键名、长度与判据文本，不含任何值。 */
export function render(result) {
  const lines = ['### Chrome Web Store 离线预检（v2）', ''];
  for (const item of result.items) {
    lines.push(`${item.ok ? '✓' : '✗'} \`${item.name}\` —— ${item.detail}`);
  }
  for (const note of result.notes) lines.push(`· ${note}`);
  lines.push('');
  lines.push(
    result.ok
      ? '**预检通过**：四项齐备且形状合法，且没有 v1.1 的残留键。下一步可以是 `mode=publish-dry`（联网验一次身份，不上传）。'
      : '**预检没过**：上面每一条 ✗ 都要处理。处置步骤见 `.github/docs/RELEASING.md` §1.3（服务账号）与 §1.6（仓库级 Secrets 清单）。',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * 读 `.env.submit`（与 `publish-browser-extension` 的读法一致：本进程环境优先）。
 * 文件不存在或读不动时按「没有」处理——CI 里本来就没有，那是正常形状，不是错误。
 * @param {string} file
 * @returns {{env: Record<string, string|undefined>, fileName?: string}}
 */
export function mergeEnvFile(file = ENV_FILE, base = process.env) {
  try {
    // 读不动与解析不出走同一条路：当这份文件不存在，判定只剩本进程环境，
    // 预检照样按「没配」红在那几条上，而不是抛一句和凭据无关的话。
    const parsed = parseEnv(readFileSync(file, 'utf-8'));
    const env = { ...parsed };
    for (const [key, value] of Object.entries(base)) env[key] = value;
    return { env, fileName: file };
  } catch {
    return { env: base };
  }
}

/** CLI 主体：打印报告，预检不过以 1 退出。 */
export function main() {
  const merged = mergeEnvFile();
  const result = evaluate(merged.env, { fileName: merged.fileName });
  process.stdout.write(render(result));
  if (!result.ok) process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
