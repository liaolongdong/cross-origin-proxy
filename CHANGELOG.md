# Changelog

所有值得用户感知的变更都记录在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-cn/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

版本号的唯一事实源是 `package.json`：`wxt.config.ts` 不再声明 `manifest.version`，由 WXT 回落生成。发版时在本文件顶部补一个 `## [<新版本>] - YYYY-MM-DD` 小节，`.github/workflows/release.yml` 会把该小节原样切成 GitHub Release 的说明。流程见 [RELEASING.md](./RELEASING.md)。

All user-visible changes are recorded here. Version numbers live in `package.json` only; add a `## [<new version>] - YYYY-MM-DD` section here when releasing, and the release workflow turns it into the GitHub Release notes.

## [Unreleased]

待发布的变更先记在这里，发版时整段提升为 `## [x.y.z] - YYYY-MM-DD`（未提升的小节不会进入 Release 说明）。
Collect unreleased changes here; promote the section to `## [x.y.z] - YYYY-MM-DD` when releasing.

## [1.0.0] - 2026-09-07

首个版本，解决一个具体问题：页面连的是 FAT 环境，要验的东西只在 UAT——在浏览器里加一条规则就完成跨环境联调，不改应用代码，也不请后端放开 CORS。
First release. One problem: your frontend talks to FAT but the change you need only exists on UAT — one browser rule closes the gap, with no application code and no backend CORS change.

### Added

- **规则驱动的请求转发**：按通配符、前缀或正则匹配 URL 并重写到目标环境；仅重写 URL 的规则编译为 `declarativeNetRequest` 网络层重定向（单请求零 JS 开销），其余走后台通道。
  **Rule-based URL rewriting** by wildcard, prefix or regex. Rules that only rewrite the URL compile to `declarativeNetRequest` network-layer redirects (zero per-request JavaScript); everything else runs through the background channel.
- **请求改写**：注入或替换请求头（目标环境 token 等）、替换请求体。
  **Request modification**: inject or replace request headers (e.g. the target environment's token) and replace request bodies.
- **响应改写**：覆盖状态码、状态文本、响应头、整个响应体，或按点分路径（`data.token`）改写单个 JSON 字段。
  **Response modification**: override status code, status text, headers, the whole body, or individual JSON fields by dot-notation path.
- **Mock / 延迟 / 阻断 / 重试**：直接返回 JSON / 文本 / HTML / XML；注入 0–60000 ms 延迟验证加载与超时；把请求阻断成网络错误验证兜底；失败或 5xx 时重试 0–5 次且间隔可配。
  **Mock / delay / block / retry**: return your own JSON / text / HTML / XML; inject 0–60000 ms latency to exercise loading and timeout states; fail requests like a network error to exercise fallbacks; retry 0–5 times on failure or 5xx with a configurable interval.
- **条件化 Mock**：按 URL 正则、HTTP 方法、查询参数命中，首个命中的条件决定响应体、状态码与 Content-Type。
  **Conditional mock**: conditions on URL pattern, HTTP method and query parameters; the first match decides body, status and content type.
- **HTTP 方法过滤与查询参数注入**：把规则限定到指定方法，或在代理后的地址上追加 `__env=uat` 之类的灰度标识。
  **Method filter and query-parameter injection**: scope a rule to specific methods, or append gray-release tags to the proxied URL.
- **WebSocket 转发**：`ws://` / `wss://` 按 URL 重写转发，实时功能跟同一套环境切换。
  **WebSocket proxying**: `ws://` / `wss://` handshakes are rewritten by URL, so real-time features follow the same environment switch.
- **规则工作台**：快速模板、复制、撤销删除、拖拽排序、批量启停与删除、带逐条预览的目标域名批量迁移、按名称/状态/匹配类型搜索筛选，以及同模式更高优先级规则的遮蔽冲突提示。
  **Rule workspace**: quick templates, duplicate, undo delete, drag-to-reorder priority, batch enable/disable/delete, batch target-domain migration with per-rule preview, search and filters, plus a shadowing-conflict warning.
- **诊断能力**：URL 匹配测试器（命中规则、重写结果、转发通道、被遮蔽规则）、最近 500 条请求日志（筛选、可调自动刷新、详情视图、复制为 cURL、由日志建规则），以及两条通道各自的命中统计。
  **Diagnostics**: a URL match tester (matched rule, rewritten URL, forwarding channel, shadowed rules), the last 500 log entries with filters, adjustable auto-refresh, a detail view, copy-as-cURL and "create a rule from this entry", plus per-rule hit counts for both channels.
- **导入导出**：JSON 配置（覆盖或合并）、HAR 1.2 导出与导入（由录制流量自动建规则）、cURL 导入（DevTools 复制的命令直接预填规则表单）。
  **Import and export**: JSON configuration (replace or merge), HAR 1.2 export and import that creates rules from recorded traffic, and cURL import that prefills the rule form.
- **环境配置快照**：把整套规则存成命名快照，在 FAT / UAT / PROD 间一键切换。
  **Environment profiles**: save the rule set as a named snapshot and switch between FAT, UAT and PROD in one click.
- **界面与自动化**：弹窗总开关、今日统计、最近请求、自动关闭倒计时（`chrome.alarms`，跨服务工作线程重启持久化）、工具栏角标、当前页命中预览、"为此页面创建规则"；中英双语、6 套主题与浅色/深色/跟随系统、快捷键 `⌘⇧P` / `Ctrl+Shift+P`。
  **Interface**: popup with a global switch, today's stats, recent requests, an auto-off countdown persisted across service-worker restarts, a toolbar badge, a current-page match preview and "create a rule for this page"; English / Chinese UI, six themes, light / dark / system, and a keyboard shortcut to toggle proxying.
- **本地优先**：规则、日志、快照与偏好全部只写入 `chrome.storage.local`；无账号、无统计埋点、无遥测、无自有服务端。
  **Local-first**: rules, logs, profiles and preferences live only in `chrome.storage.local`; no accounts, no analytics, no telemetry, no servers of ours.

[1.0.0]: https://github.com/liaolongdong/cross-origin-proxy/releases/tag/v1.0.0
