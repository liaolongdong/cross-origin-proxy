# Security Policy · 安全策略

## Supported versions · 受支持版本

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

扩展由 `.github/workflows/release.yml` 从打标签的版本发布，只维护最新一条版本线。
The extension is published from tagged releases; only the latest version line is maintained.

## 为什么这个扩展的安全问题值得私下报

它拿的是 `<all_urls>` 主机权限，能为任意页面代发请求并注入请求头，也能把页面 `fetch` / `XMLHttpRequest` / `WebSocket` 改道到另一个环境。也就是说，一个规则注入校验漏洞、一条让被阻断请求真的发出去的回归、或一处把跨源消息当成可信来源的判断失误，都可能变成**目标环境 token 泄露**或**请求被悄悄改写**。这类问题请不要开公开 Issue。

It holds the `<all_urls>` host permission, can issue requests on behalf of any page and inject headers, and can redirect page `fetch` / `XHR` / `WebSocket` traffic elsewhere. A flaw in header validation, in block-rule enforcement, or in message-origin checks could leak a target-environment token or silently rewrite requests. Please don't open a public issue for that.

## 如何报告 · How to report

1. **首选**：仓库首页 **Security → Report a vulnerability**（私密漏洞报告），填写复现步骤即可，只有你与维护者能看到。该入口需要仓库所有者先在 `Settings → General → Advanced` 勾选 **Privately report a security vulnerability**（见 [GITHUB.md](./GITHUB.md) §6）。
   **Preferred**: use **Security → Report a vulnerability** on the repository home page. It is private to you and the maintainers. The owner must first enable _Privately report a security vulnerability_ under `Settings → General → Advanced`.
2. 入口未开启时，开一个标题只写 `security` 的最小 Issue 并@维护者，**不要在正文里贴漏洞细节**，约到私密渠道再展开。
   If that entry point is off, open a minimal issue titled only `security` without any details and ask for a private channel.
3. 复现材料里请用 `fat-api.example.com` / `uat-api.example.com` 这类示例域名，不要贴真实内网域名、token 或抓包数据——Issue 正文是公开的，仓库与商店审核都会看到。
   Use `*.example.com` domains in reports. Never paste real internal hostnames, tokens or captured traffic: issue text is public.

## 处理承诺 · What to expect

- 收到后先确认并给出是否复现的结论与临时规避手段（单人维护，不承诺固定 SLA）。
  We acknowledge first and come back with reproduction status plus a workaround; it is a solo-maintained project, so no fixed SLA is promised.
- 确认的问题优先出补丁版本并按 [RELEASING.md](./RELEASING.md) 走商店提审；商店审核时长不受本仓库控制，会在补丁发布时一并说明。
  Confirmed issues ship as a patch release through the store; store review latency is outside our control and gets called out in the release notes.
- 修复会写进 [CHANGELOG.md](./CHANGELOG.md)；是否署名致谢完全尊重报告者意愿，不公开未修复的细节。
  Fixes are listed in `CHANGELOG.md`; attribution follows the reporter's preference, and unpatched details stay undisclosed.

## 已有的基线 · Existing baseline

请求头名校验且拒绝 CRLF、状态码钳制在 200–599、请求体 10 MB 上限（按 UTF-8 字节量最终出站 body，规则覆盖的 body 同样计入）、被规则拒绝的请求在本地日志留下原因、用户正则的嵌套量词（ReDoS）筛查、送给网络层的正则必须过 Chrome 的 RE2 校验且替换引用越界检查、跨 world 消息一律以 `window.location.origin` 为目标源、跨 world 的代理响应在桥接层整形（失败信封补齐 `requestId` 与数值 `status`，后台内部错误文案不外泄给页面）、响应体改写的路径写入拒绝 `__proto__` / `constructor` / `prototype` 键名、修改状态的消息需过 `isTrustedSender`、导入的 HAR/cURL/JSON 在边界处过滤非法项、无 `v-html` / `eval` / 远程代码、无遥测与埋点。
Header name validation with CRLF rejected, status codes clamped to 200–599, a 10 MB body cap (measured in UTF-8 bytes on the final outbound body, including one injected by a rule), rejected requests leaving a reason in the local log, ReDoS screening on user regexes, RE2 validation plus substitution bounds-checking for rules bound to the network layer, `window.location.origin` as the target origin for every cross-world message, cross-world proxy responses normalized at the bridge (failure envelopes get a `requestId` and a numeric `status`, and internal error text is never forwarded to the page), response-body path writes rejecting `__proto__` / `constructor` / `prototype` keys, `isTrustedSender` on state-changing messages, boundary filtering for imported HAR/cURL/JSON, no `v-html` / `eval` / remote code, no telemetry.

### 已知缺口 · Known gaps

上面这些基线里，**ReDoS 筛查**、**导入规则过滤**、**响应体路径写入的原型链拒绝**、**跨 world 响应信封整形**、**查询参数编码保持**、**请求头与 CRLF 校验**（`isValidHeaderEntry` / `filterIncomingHeaders` / `validateRuleHeaders`）、**请求体上限**（`exceedsBodyCap`）与**状态码钳制**（`clampResponseStatus`）已有直接的 Vitest 用例（`tests/security-and-optimization.test.ts`、`tests/round2-regression.test.ts`、`tests/channel-consistency.test.ts`、`tests/proxyResponseGuard.test.ts`、`tests/requestGuard.test.ts`）。后三项此前是 [`entrypoints/background/proxyHandler.ts`](./entrypoints/background/proxyHandler.ts) 里的私有函数或内联表达式，现已导出（行为不变的可见性调整）并被覆盖。仍未补的是 [`messageRouter.ts`](./entrypoints/background/messageRouter.ts) 的私有函数 `isTrustedSender`：它需要 mock Chrome 运行时消息通道才能单测，属于独立的加固任务。
Of these, ReDoS screening, imported-rule filtering, prototype-chain rejection in response-body path writes, cross-world response envelope normalization, query-parameter encoding fidelity, header/CRLF validation (`isValidHeaderEntry` / `filterIncomingHeaders` / `validateRuleHeaders`), the body cap (`exceedsBodyCap`) and status clamping (`clampResponseStatus`) all have direct Vitest cases (`security-and-optimization`, `round2-regression`, `channel-consistency`, `proxyResponseGuard`, `requestGuard`). The last three were private helpers or inline expressions in `proxyHandler.ts` and are now exported (a visibility-only change) and covered. Still open: `isTrustedSender`, private in `messageRouter.ts` — unit-testing it needs the Chrome runtime message channel mocked out, which is a separate hardening task.
