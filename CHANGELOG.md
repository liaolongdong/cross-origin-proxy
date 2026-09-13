# Changelog

所有值得用户感知的变更都记录在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-cn/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

版本号的唯一事实源是 `package.json`：`wxt.config.ts` 不再声明 `manifest.version`，由 WXT 回落生成。发版时在本文件顶部补一个 `## [<新版本>] - YYYY-MM-DD` 小节，`.github/workflows/release.yml` 会把该小节原样切成 GitHub Release 的说明。流程见 [RELEASING.md](./RELEASING.md)。

All user-visible changes are recorded here. Version numbers live in `package.json` only; add a `## [<new version>] - YYYY-MM-DD` section here when releasing, and the release workflow turns it into the GitHub Release notes.

## [Unreleased]

待发布的变更先记在这里，发版时整段提升为 `## [x.y.z] - YYYY-MM-DD`（未提升的小节不会进入 Release 说明）。
Collect unreleased changes here; promote the section to `## [x.y.z] - YYYY-MM-DD` when releasing.

### Added

- **产品站新增中英对比专页与 `llms-full.txt`**：`docs/alternatives.html` 与 `docs/zh-alternatives.html` 逐项对比 devServer 代理、mitmproxy、API 客户端、后端放开 CORS 等做法各自擅长什么，并明确列出六个不该用这个扩展的场景；`llms-full.txt` 是给检索与 AI 系统消费的完整机器可读规格。落地页、README、sitemap、`llms.txt` 与页脚均已互链，hreflang 中英与 `x-default` 三向补齐。
  **Two bilingual comparison pages and a full machine-readable spec.** `alternatives.html` / `zh-alternatives.html` walk through what the dev-server proxy, mitmproxy, API clients and a backend CORS change are each genuinely good at, plus six situations where this extension is the wrong tool. `llms-full.txt` is the long-form spec for search and answer engines. The landing pages, READMEs, sitemap and `llms.txt` all cross-link, with `en` / `zh` / `x-default` hreflang annotations reconciled in both the page heads and the sitemap.
- **README 新增「核心优势 / What makes it different」**：中英各一张七行对照表（网络层零 JS 通道、无需本地 CA 证书、响应改写、WebSocket、环境与快照、数据不出本机、MIT 与双语文档），每行都指向对应实现或文档。
  **A "What makes it different" table in both READMEs** — seven rows (the zero-JavaScript network-layer path, no local CA certificate, response rewriting, WebSocket, environments and snapshots, nothing leaving the machine, MIT plus bilingual docs), each pointing at the implementation or document that backs it.
- **`GITHUB.md` 补当前实测状态与一次性命令**：新增 §0.1 记录 2026-09-12 用 GitHub API 实测到的 `description` / `homepage` / topics / tag 真值，并给出 §3.1 一条从本文自身读取描述、`homepage` 与 topic 列表的 `gh api` 命令，值不再有第二份事实源。
  **`GITHUB.md` now records measured state** (§0.1, values read from the GitHub API on 2026-09-12) and offers §3.1, a one-shot `gh api` command that reads the description, homepage and topic list from the document itself, so no second source of truth is introduced.
- **产品站补齐结构化数据与文档标题缺口**：两个对比页原先声明 `og:type=article` 却没有对应节点，现补 `Article`（作者与日期同页面「由本扩展作者撰写」的署名），并给其 `WebPage` 补 `datePublished`；隐私政策页此前整页没有 `<h1>`，现补一个双语文档级标题（配套一个 `.page-head` 样式块）、给英文半区加 `lang="en"`（读屏不再用中文语音朗读整段英文），并补 `WebPage` 节点与 sitemap 的 `lastmod`。
  **Structured-data and heading gaps closed on the product site.** Both comparison pages declared `og:type=article` without an `Article` node, so one was added (author and dates matching the on-page byline) together with the `WebPage` `datePublished`; the privacy page had no `<h1>` at all, and now carries one bilingual document title, `lang="en"` on its English half, a `WebPage` node and a matching sitemap `lastmod`.

### Changed

- **商店摘要与详细描述重写**：中文摘要改为以用户查询语序开头（"前端跨域联调不用改代码，也不用请后端改 CORS"），英文摘要补齐 `retry`；详细描述按「先讲一条规则解决什么 → 能力清单 → 双通道的诚实边界 → 权限理由」重排，中英条目数一致。扩展名称与悬停短名未改，商店名预算不变。
  **Store summary and detailed description rewritten.** The Chinese summary now opens in the user's own query wording, the English summary gains `retry`, and the detailed description is reordered as one-rule payoff → capability list → honest two-channel boundaries → permission justifications, with matching item counts across languages. The extension name and short name are unchanged.
- **落地页元数据修正**：中文页 `<title>` 从 78 码点压到不截断的长度，两页补 `og:image:alt` / `twitter:image:alt`，`datePublished` 取首次提交日期、`dateModified` 更新为 2026-09-12，sitemap 补 `x-default`。
  **Landing page metadata fixed**: the Chinese `<title>` no longer exceeds what search engines render, both pages get image alt text, `datePublished`/`dateModified` are set from real history, and the sitemap declares `x-default`.
- **三处过强表述按实现校正**（中英落地页、README、FAQ 与 `FAQPage` 结构化数据同步）：重试不是"0–5 次自动重试"，而是按规则开启的开关，追加 1–5 次尝试、间隔 100–30000 毫秒（默认 1000）、单次尝试 30 秒超时；快速模板只在规则为空时的引导区提供；响应改写中状态文本与整块 body 没有界面入口。
  **Three over-strong claims corrected against the implementation**, in page copy, FAQ answers, `FAQPage` structured data and both READMEs: retry is a per-rule switch adding 1–5 extra attempts at a 100–30000 ms interval (default 1000) with a 30-second per-attempt timeout; quick templates exist only in the zero-rule empty state; status text and whole-body overrides have no editor.
- **商店详细描述按差异化缺口扩写**：中文 2,983 → 3,687 码点、英文 7,314 → 9,509（上限 16,000）。新增按角色分组的「谁会用上它」、规则生效但控制台仍报 CORS 的双通道解释与解法、与 VPN／抓包代理共存时看到哪一条请求、扩展自身零远端依赖四段；名称与悬停短名复核后维持不动，`CHROMEWEBSTORE.md` §0 已记录这一决定，不要因为「预算还没用满」去扩名称。
  **Store detailed description expanded where it was actually thin** — Chinese 2,983 → 3,687 codepoints, English 7,314 → 9,509 (budget 16,000). Four new passages: who reaches for it, grouped by role; why the console can still say CORS after a rule took effect and what switches the rule to the other channel; which request a VPN or capture proxy sees; and the extension's own zero remote dependencies. The name and short-name fields were reviewed and deliberately left alone, and `CHROMEWEBSTORE.md` §0 now records that decision.
- **五个页面的 `title` 与 description 压进搜索结果可见宽度**：Google 按字形宽度截断（约 60 / 160 单位，中日韩全角算 2 单位），此前中文页 `title` 宽 102、description 宽 195，尾部在结果页根本不显示。现最长为 `title` 59、description 157。
  **Titles and descriptions now fit what search results actually render** (≈60 and ≈160 glyph units, with CJK counting double). The Chinese page was running at 102 and 195, so its tail never appeared; the widest values are now 59 and 157.
- **四处对外数字与措辞按实现与页面对齐**：中文 README 优势表删掉「整个响应体」（数据结构与后台执行都支持，但界面无入口，与 1.0.0 的记录一致）；落地页统计条的能力数从 11 改为 12，与两份 README 的能力清单和页面自己的 `featureList` 相同；`llms-full.txt` 的对比矩阵行数 11 → 10；两个对比页的「0 条具名产品宣称」改为「0 个具名产品进入矩阵」（页面确实点名了 mitmproxy、Vite 等类别样例）；中英两份 `offers` 的币种统一为 USD。
  **Four outward-facing numbers and phrasings reconciled with the implementation**: the Chinese README's whole-response-body claim is gone (the data structure and the background handler support it, but no editor exposes it — matching the 1.0.0 note); the landing pages' capability stat moves 11 → 12 to match both README capability lists and the page's own `featureList`; the comparison matrix in `llms-full.txt` is corrected to 10 rows; "0 named-product claims" becomes "0 named products in the matrix" because the page does name category examples; and both localized listings now declare the same offer currency.
- **`robots.txt` 显式放行检索类 AI 爬虫，并新增文档守卫**：在原有 `GPTBot` / `ChatGPT-User` / `ClaudeBot` 之外补 `OAI-SearchBot`、`Perplexity-User`、`Claude-Web`、`Claude-User`（不屏蔽训练类爬虫是既有决定，未改）。`tests/docs-consistency.test.ts` 新增 13 条：搜索结果可见宽度预算、每段 JSON-LD 可解析且 `og:type=article` 必须有 `Article` 节点、中英统计条数字逐项相同、落地页能力数与中英 README 一致。
  **`robots.txt` names the retrieval crawlers and the docs gain guards.** `OAI-SearchBot`, `Perplexity-User`, `Claude-Web` and `Claude-User` join the existing allowances (training crawlers remain unblocked, unchanged from before). `tests/docs-consistency.test.ts` adds 13 cases: search-result visible-width budgets, every JSON-LD block must parse and `og:type=article` requires an `Article` node, stat-strip numbers must match across languages, and the landing pages' capability count must equal the README lists.

### Fixed

1.0.0 尚未打 tag，因此下面三条在首次发版时会随本段一起提升进 Release 说明。

- **关闭总开关后网络层规则不再代理请求**：总开关只挡住了后台通道，仅重写 URL 的简单规则仍以 `declarativeNetRequest` 动态规则留在浏览器网络层里继续转发。现在关闭总开关会清空这批动态规则，重新打开时按当前规则集重建。
  Turning the global switch off now actually stops proxying. Rules that only rewrite the URL were still installed as network-layer redirect rules and kept forwarding requests; switching off now clears that rule set, and switching back on rebuilds it from the current rules.
- **「复制规则」不再丢字段**：复制出的新规则会丢掉 HTTP 方法过滤与查询参数注入配置，得到一个和原规则行为不同的副本。现在这两个字段与其余配置一起深拷贝。
  **Duplicating a rule kept its HTTP method filter and query-parameter overrides.** The copy behaved differently from the rule it was made from; both fields are now carried over with the rest of the configuration.
- **首栏里的行内图标不再被拉成整栏宽度**：`docs/assets/landing.css` 里既有的 `.hero-visual svg` 选择器本意是给首栏插图用，却会命中首栏内任意一个行内图标。两个对比页的「一句话版本」框因此把 18×18 的对勾撑到 470 像素宽，正文被挤成一列竖排的单字。现在这条规则收窄到首栏插图所在的 `<figure>`（两个落地页首栏内没有任何 `<svg>`，实测宽度不变），框本身也改用站点约定的「图标 + 单段落」写法。
  **Inline icons in the hero column are no longer stretched.** The pre-existing `.hero-visual svg` rule was written for a hero illustration but matched any inline icon in that column, so the comparison pages' 18×18 check-mark expanded to 470px and squeezed their one-sentence summary into one Chinese character per line. The rule now reads `.hero-visual figure svg` (neither landing page has an `<svg>` in its hero, so its layout is measurably unchanged), and the box uses the site's icon-plus-single-paragraph callout pattern.

## [1.0.0] - 2026-09-07

首个版本，解决一个具体问题：页面连的是 FAT 环境，要验的东西只在 UAT——在浏览器里加一条规则就完成跨环境联调，不改应用代码，也不请后端放开 CORS。
First release. One problem: your frontend talks to FAT but the change you need only exists on UAT — one browser rule closes the gap, with no application code and no backend CORS change.

### Added

- **规则驱动的请求转发**：按通配符、前缀或正则匹配 URL 并重写到目标环境；仅重写 URL 的规则编译为 `declarativeNetRequest` 网络层重定向（单请求零 JS 开销），其余走后台通道。
  **Rule-based URL rewriting** by wildcard, prefix or regex. Rules that only rewrite the URL compile to `declarativeNetRequest` network-layer redirects (zero per-request JavaScript); everything else runs through the background channel.
- **请求改写**：注入或替换请求头（目标环境 token 等）、替换请求体。
  **Request modification**: inject or replace request headers (e.g. the target environment's token) and replace request bodies.
- **响应改写**：界面可覆盖状态码、响应头，或按点分路径（`data.token`）改写单个 JSON 字段；状态文本与整块响应体的覆盖存在于数据结构并被后台执行，但没有界面入口，只能通过导入的 JSON 配置写入。
  **Response modification**: the rule form overrides the status code, response headers, and individual JSON fields by dot-notation path (`data.token`). Overriding the status text or the whole body is part of the stored schema and is honoured by the proxy, but has no editor, so it only arrives through an imported JSON config.
- **Mock / 延迟 / 阻断 / 重试**：直接返回 JSON / 文本 / HTML / XML；注入 0–60000 ms 延迟验证加载与超时；把请求阻断成网络错误验证兜底；重试按规则开启，默认关闭，开启后在网络错误或 5xx 时追加 1–5 次尝试、间隔 100–30000 毫秒。
  **Mock / delay / block / retry**: return your own JSON / text / HTML / XML; inject 0–60000 ms latency to exercise loading and timeout states; fail requests like a network error to exercise fallbacks; retry is a per-rule switch, off by default, adding 1–5 extra attempts at a 100–30000 ms interval on a network error or a 5xx.
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
