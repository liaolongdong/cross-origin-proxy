#!/usr/bin/env node
/**
 * 商店发布流水线的判据（`.github/workflows/store-publish.yml` 的 `decide` 作业调用）。
 *
 * 这里只做**判定与措辞**，不碰网络、不碰 git：远端那三份读数由 YAML 用 `curl` 取回来，
 * 落成文件后交给本脚本。拆成两半的原因是可测——「这一版该不该发」「审批闸门到底配没配」
 * 这两件事一旦写进 shell 就全仓没有任何运行时对应物，而它们错了的代价分别是
 * 「向 Google 重复提交审核」（配额有限、不可撤回）与「合并即发版、没有任何人点头」。
 *
 * 两条 fail-closed 原则，改判据前先读：
 * 1. **读不到就当不能发**：API 探测失败（限流、网络、令牌权限）不判成「可以自动发」，
 *    而是 `hold=true`——宁可红一次让人看一眼，也不在事实不明的情况下动 refs 或提审。
 * 2. **环境存在 ≠ 有审批闸门**：作业引用一个不存在的 `environment:` 时，GitHub 会**隐式创建**
 *    它且不带任何保护规则（官方文档原文：Running a workflow that references an environment
 *    that does not exist will create an environment with the referenced name）。于是
 *    「流水线里写了 `environment:`」与「有人必须先点头」是两件事，这里查的是后者。
 */

import { readFileSync, appendFileSync } from 'fs';
import { pathToFileURL } from 'url';

/** 与 `.github/workflows/store-publish.yml` 里 `environment:` 那个名字一致（这里只用于措辞）。 */
const DEFAULT_ENVIRONMENT = 'chrome-web-store';

/** 商店提审要用的四个仓库级 Secrets（与 `release.yml` 的 `Detect Chrome Web Store credentials` 同一份清单）。 */
export const STORE_SECRET_NAMES = Object.freeze([
  'CHROME_EXTENSION_ID',
  'CHROME_CLIENT_ID',
  'CHROME_CLIENT_SECRET',
  'CHROME_REFRESH_TOKEN',
]);

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

/**
 * 版本号是否合法（不带 `v`）。YAML 也用它决定能不能把号拼进 API 路径。
 * @param {unknown} version 待判定的字符串
 * @returns {boolean}
 */
export function isValidVersion(version) {
  return typeof version === 'string' && VERSION_RE.test(version);
}

/** 每个审批读数对应的两句话：摘要里那句短的，和拦截作业里那句带操作指引的长的。 */
export const APPROVAL_READINGS = Object.freeze({
  configured: { short: '已配必需审查员', action: '' },
  'not-found': {
    short: '环境不存在',
    action:
      'Settings → Environments → New environment，名字必须逐字是 `chrome-web-store`，' +
      '并勾选 **Required reviewers**、至少填一个人。**这一步必须在合并这条链路之前做**：' +
      '作业引用的环境若不存在，GitHub 会隐式创建一个不带任何保护规则的同名环境，' +
      '于是「合并即发版」当场变成真的——没有任何人点头。',
  },
  'no-rule': {
    short: '环境在、但没开必需审查员',
    action: '在该环境的 **Protection rules** 里勾选 **Required reviewers** 并至少填一个人。',
  },
  'empty-reviewers': {
    short: '必需审查员开着、但名单是空的',
    action: '名单为空时没人能批准，那条 run 会一直挂着直到过期；请至少添加一个审查员。',
  },
  unknown: {
    short: '读不到（限流 / 令牌权限 / 网络）',
    action:
      '核对工作流令牌能不能读 `GET /repos/{owner}/{repo}/environments/{env}`' +
      '（公开仓库、`contents: read` 应当可读）。读不到时宁可拦下来，也不要按「大概配好了」放行。',
  },
});

/** 远端 tag 那三种读数在摘要里的说法。 */
const TAG_READINGS = Object.freeze({
  exists: '已存在',
  missing: '不存在',
  unknown: '读不到',
});

/** 把 `curl -w '%{http_code}'` 的输出收成数字；非数字（含空串、`000`）一律 0，代表「没读到」。 */
function toStatus(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 把响应体收成普通对象；不是 JSON、是数组、或是空白时返回 null（调用方据此判 unknown）。 */
function toBody(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 远端 tag 的状态。
 * @param {string|number} status HTTP 状态码
 * @param {string} body 响应体原文
 * @param {string} tag 完整标签名（含 `v`）
 * @returns {'exists'|'missing'|'unknown'}
 */
export function tagStateOf(status, body, tag) {
  const code = toStatus(status);
  if (code === 404) return 'missing';
  if (code !== 200) return 'unknown';
  const parsed = toBody(body);
  // 必须是「这个标签的那条 ref 记录」，不是任意一份 200：拿代理页、登录页或限流文案
  // 当成「tag 已存在」，会把该发的那一版判成已发，而那句「已经发过」在界面上跟真话长得一样。
  if (!parsed || typeof parsed.ref !== 'string') return 'unknown';
  if (parsed.ref !== `refs/tags/${tag}`) return 'unknown';
  if (!parsed.object || typeof parsed.object.sha !== 'string') return 'unknown';
  return 'exists';
}

/**
 * 审批闸门（环境的必需审查员）配到什么程度。
 * @param {string|number} status HTTP 状态码
 * @param {string} body 响应体原文
 * @returns {{ state: 'configured'|'not-found'|'no-rule'|'empty-reviewers'|'unknown', reviewers: number }}
 */
export function approvalStateOf(status, body) {
  const code = toStatus(status);
  if (code === 404) return { state: 'not-found', reviewers: 0 };
  if (code !== 200) return { state: 'unknown', reviewers: 0 };
  const parsed = toBody(body);
  // 「不是对象」与「没有 protection_rules」都归 unknown：读不出形状就说不知道，
  // 不许把它读成「没配审查员」——那会让一次 API 形状变更把发布链路判成配置问题。
  if (!parsed || !Array.isArray(parsed.protection_rules)) return { state: 'unknown', reviewers: 0 };
  const rule = parsed.protection_rules.find(entry => entry && entry.type === 'required_reviewers');
  if (!rule) return { state: 'no-rule', reviewers: 0 };
  const reviewers = Array.isArray(rule.reviewers) ? rule.reviewers.length : 0;
  return reviewers > 0 ? { state: 'configured', reviewers } : { state: 'empty-reviewers', reviewers: 0 };
}

/**
 * 仓库级 Secrets 名单里那四个在不在。**只是给审批人看的一条线索**：这个端点在部分令牌
 * 权限下读不到，读不到时 `known=false`，判定与措辞都不许因此改变（真正决定发不发商店包的
 * 是 `release.yml` 的 `Detect Chrome Web Store credentials` 那一步）。
 * @param {string|number} status HTTP 状态码
 * @param {string} body 响应体原文
 * @param {readonly string[]} required 需要的名字
 * @returns {{ known: boolean, present: string[], missing: string[] }}
 */
export function secretPresenceOf(status, body, required = STORE_SECRET_NAMES) {
  const code = toStatus(status);
  const parsed = code === 200 ? toBody(body) : null;
  const list = parsed && Array.isArray(parsed.secrets) ? parsed.secrets : null;
  if (!list) return { known: false, present: [], missing: [] };
  const names = new Set(list.map(entry => entry && entry.name).filter(n => typeof n === 'string'));
  return {
    known: true,
    present: required.filter(n => names.has(n)),
    missing: required.filter(n => !names.has(n)),
  };
}

/**
 * 这一次合并要不要走发布，以及要不要把人拦下来。
 *
 * 两个轴彼此独立，别合并成一个布尔：「有东西要发」与「没人能点头」是两件事——
 * 前者决定是否起跑后续作业，后者决定这条流水线必须红一次，而不是安静地什么都不做。
 *
 * @param {{version: unknown, tag: string, tagState: string, approval: string}} input
 * @returns {{version: string, shouldPublish: boolean, hold: boolean, reason: string}}
 */
export function decide({ version, tag, tagState, approval }) {
  if (!isValidVersion(version)) {
    return {
      version: String(version ?? ''),
      shouldPublish: false,
      hold: true,
      reason: `package.json 的 version（${String(version)}）不是 MAJOR.MINOR.PATCH，流水线不猜号`,
    };
  }
  if (tagState === 'exists') {
    return {
      version,
      shouldPublish: false,
      hold: false,
      reason: `\`${tag}\` 已在远端——这一版已经发过（或由 §2 路径 B、§3 补跑接管），本次合并不重复提审`,
    };
  }
  if (tagState === 'unknown') {
    return {
      version,
      shouldPublish: false,
      hold: true,
      reason:
        `读不到 \`GET /repos/…/git/ref/tags/${tag}\` 的可信答复，无法确定这一版发过没有。` +
        '事实不明时自动打 tag 或提审都可能造成重复，请把这条 run 当作「要人看一眼」的信号',
    };
  }
  if (approval !== 'configured') {
    return {
      version,
      shouldPublish: true,
      hold: true,
      reason: `这一版待发（\`${tag}\` 不在远端），但审批闸门没配好（当前读数：${APPROVAL_READINGS[approval].short}）`,
    };
  }
  return {
    version,
    shouldPublish: true,
    hold: false,
    reason: `\`${tag}\` 不在远端，审批闸门已配 —— 走「校验 → 人工确认 → 打 tag → 发布」`,
  };
}

/**
 * 渲染 Job Summary（审批人打开那条 run 时看到的那一屏）。
 * @param {{
 *   version: string, tag: string, tagState: string, approval: string, reviewers: number,
 *   environment: string, event: string, sha: string, repository: string,
 *   shouldPublish: boolean, hold: boolean, reason: string,
 *   secrets: { known: boolean, present: string[], missing: string[] },
 *   notesSource?: string, notesLines?: string
 * }} facts 判定好的事实
 * @returns {string} Markdown
 */
export function renderSummary(facts) {
  const {
    version,
    tag,
    tagState,
    approval,
    reviewers,
    environment,
    event,
    sha,
    repository,
    shouldPublish,
    hold,
    reason,
    secrets,
    notesSource,
    notesLines,
  } = facts;
  const lines = [];
  lines.push(`### 商店发布闸门 · \`${tag}\``);
  lines.push('');
  lines.push(`- 提交：\`${String(sha ?? '').slice(0, 7)}\`（\`${event}\` @ ${repository}）`);
  lines.push(
    `- 版本号取自 \`package.json\`：\`${version}\`，对应标签 \`${tag}\`：${TAG_READINGS[tagState] ?? tagState}`,
  );
  const approvalText =
    approval === 'configured' ? `已配 —— ${reviewers} 名必需审查员` : (APPROVAL_READINGS[approval]?.short ?? approval);
  lines.push(`- 审批闸门（环境 \`${environment}\`）：${approvalText}`);
  if (!secrets.known) {
    lines.push('- 商店凭据：这一轮读不到仓库 Secrets 名单（不影响判定，发布作业那一步会自己说）');
  } else if (secrets.missing.length === 0) {
    lines.push(`- 商店凭据：${secrets.present.length} 个都在仓库级 ✅（**别挪到环境级**，见 RELEASING.md §1.6 末）`);
  } else {
    lines.push(
      `- 商店凭据：仓库级缺 \`${secrets.missing.join('`、`')}\` —— GitHub Release 照发，` +
        '商店那一步会被跳过并在 Run 页面留指引（RELEASING.md §5）',
    );
  }
  if (notesSource) {
    lines.push(
      notesSource === 'changelog'
        ? `- \`CHANGELOG.md\` 那一小节切出 ${notesLines} 行，它就是 GitHub Release 的说明（正文由同一条 run 的校验作业贴在摘要里）`
        : `- ⚠️ \`CHANGELOG.md\` 里没有 \`${tag}\` 对应的小节：Release 说明会回落到自动生成的流水账，而商店的「更新说明」那一栏是空的`,
    );
  }
  if (event === 'pull_request') {
    lines.push('');
    lines.push(
      '**本次是 PR：只演练判定。** 打 tag、审批、发布三个作业对 `pull_request` 事件不可达，' +
        'fork 的 PR 更是拿不到任何 Secrets。',
    );
  } else {
    lines.push('');
    lines.push(hold ? `**结论：拦下来，等人处理。** ${reason}` : `**结论：${reason}**`);
    // 配置指引只在「这一版确实待发、卡点就是没人能点头」时出现。拦下来的原因还有
    // 两种（读不到 tag、号不合法），那时把那三行设置步骤糊在后面，等于把人的注意力
    // 从真正的卡点上带走——摘要里那一屏只有一次机会说话。
    if (hold && shouldPublish && approval !== 'configured' && APPROVAL_READINGS[approval]?.action) {
      lines.push('');
      lines.push(APPROVAL_READINGS[approval].action);
    }
    if (!hold && shouldPublish) {
      lines.push('');
      lines.push(
        '下一格是完整校验（与 CI 同一份清单）。**审批人点头之前，refs 一个都不会动、商店一个字都不会收到**；' +
          '点头之后才打 tag、建 Release、提审。',
      );
    }
  }
  lines.push('');
  lines.push('教程与排查：`.github/docs/RELEASING.md`（§1.6 环境配置、§2 日常发版、§7 常见问题）');
  return `${lines.join('\n')}\n`;
}

/** 极简 flag 解析：`--k v` 成对；下一个 token 缺失或以 `--` 开头时记为 `'true'`。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

/** 读一个文件；不存在或读不动时给空串（交给各判据自己收成 unknown）。 */
function readMaybe(file) {
  if (!file || file === 'true') return '';
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/** 取 `package.json` 的号；读不出就给空串，让判据把它归进「号不合法、拦下来」那一档。 */
function readVersion(file) {
  try {
    return JSON.parse(readMaybe(file)).version ?? '';
  } catch {
    return '';
  }
}

/** 往 `$GITHUB_OUTPUT` 追加一行 `key=value`（值里的换行压成空格，避免破坏后续读取）。 */
function emit(file, key, value) {
  if (!file || file === 'true') return;
  appendFileSync(file, `${key}=${String(value).replace(/\s*\n\s*/g, ' ')}\n`);
}

/** CLI 主体：读三份响应体 + package.json，写出 outputs 与摘要。 */
export function main() {
  const a = parseArgs(process.argv.slice(2));
  const environment = a.environment || DEFAULT_ENVIRONMENT;
  const version = readVersion(a.package);
  const tag = `v${version}`;
  const tagState = tagStateOf(a['tag-status'], readMaybe(a['tag-file']), tag);
  const approvalResult = approvalStateOf(a['approval-status'], readMaybe(a['approval-file']));
  const secrets = secretPresenceOf(a['secrets-status'], readMaybe(a['secrets-file']));
  const event = a.event ?? process.env.GITHUB_EVENT_NAME ?? '';
  const verdict = decide({ version, tag, tagState, approval: approvalResult.state });
  // PR 上没有「等人点头」这件事（三个作业本就不可达），把 hold 撤掉，摘要只说这是演练。
  const hold = event === 'pull_request' ? false : verdict.hold;

  const summary = renderSummary({
    version,
    tag,
    tagState,
    approval: approvalResult.state,
    reviewers: approvalResult.reviewers,
    environment,
    event,
    sha: a.sha ?? process.env.GITHUB_SHA ?? '',
    repository: a.repository ?? process.env.GITHUB_REPOSITORY ?? '',
    shouldPublish: verdict.shouldPublish,
    hold,
    reason: verdict.reason,
    secrets,
    notesSource: a['notes-source'],
    notesLines: a['notes-lines'],
  });

  emit(a.output, 'version', version);
  emit(a.output, 'tag', tag);
  emit(a.output, 'tag-state', tagState);
  emit(a.output, 'approval-state', approvalResult.state);
  emit(a.output, 'should-publish', String(verdict.shouldPublish));
  emit(a.output, 'hold', String(hold));
  emit(a.output, 'reason', verdict.reason);

  if (a.summary && a.summary !== 'true') appendFileSync(a.summary, summary);
  process.stdout.write(`${summary}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
