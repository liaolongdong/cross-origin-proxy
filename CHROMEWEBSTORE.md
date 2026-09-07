# Chrome Web Store Listing — 跨域代理助手 / Cross-Origin Proxy

> Last Updated: 2026-09-07
> 本文件是商店上架的唯一素材源：把这里的内容逐项复制进 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)。
> 商店表单（名称/描述/截图/权限理由/数据披露）无法由 API 代写，只能手动粘；**包上传与提审已经自动化**，见第 11 节。
> 本文件位于仓库根目录，不在 `.output/chrome-mv3` 内，因此不会被打进上传包。

## 0. Keyword strategy（为什么这么写）

Chrome 应用商店搜索的权重顺序是 **名称 > 摘要（manifest description）> 详细描述 > 分类/语言**。优化前英文名称只用了 18/75 字符，是最大的浪费点；现已分别为中文 36/75、英文 52/75，均用于承载核心检索词。

| 目标查询                                       | 用户怎么搜                     | 落点                             |
| ---------------------------------------------- | ------------------------------ | -------------------------------- |
| `cors` / `cross origin` / `跨域`               | 报错来搜的人，量最大、意图最强 | 名称（中英）、摘要、详细描述首句 |
| `api proxy` / `request proxy` / `请求转发`     | 明确要代理工具                 | 名称、摘要                       |
| `environment switch` / `环境切换` / `联调`     | 中文前端场景词，竞争小、转化高 | 中文名称、详细描述               |
| `mock api` / `mock 数据`                       | 后端未就绪的前端               | 名称（Mock）、详细描述           |
| `modify request headers` / `response override` | 抓包改包需求                   | 详细描述能力清单                 |
| `websocket proxy`                              | 长连接联调，几乎无同类扩展     | 摘要 + 详细描述（差异化点）      |

刻意**不做**的事：不在名称里堆同义词（Chrome 会因 "misleading keyword stuffing" 拒审，且 AI 检索研究里关键词堆砌反而降低可见度）；不写 "best"、"#1"、"free" 这类词；不出现 "Chrome" 字样冒充官方；不引用其他产品商标。

## 1. Store listing

### 1.1 中文（中国）列表 — 默认语言

**Extension Name**（≤75 字符，当前 36）

```
跨域代理助手 - CORS 跨域调试 · API 环境切换 · Mock
```

**Short description / manifest description**（≤132 字符，当前 82）

```
把前端 API 请求代理到 FAT/UAT/PROD 后端，无需改代码或 CORS：URL 重写、请求头与响应改写、Mock、延迟、阻断与 WebSocket 代理
```

**Detailed description**（≤16000 字符；商店会剥掉 Markdown，故用换行与短横线排版）

```
前端连着 FAT，要验的改动只在 UAT——这个扩展让你在浏览器里加一条规则就完成跨环境联调，不用改应用代码，也不用请后端改 CORS 配置再发一次版。

它能做什么：
- 按通配符、前缀或正则匹配请求地址，转发到你指定的另一个环境
- 注入或替换请求头（例如目标环境的鉴权 token），替换请求体
- 改写响应状态码、响应头，或按路径替换 JSON 里的某个字段
- Mock 响应：接口还没写好时，直接返回你准备的 JSON / 文本 / HTML / XML
- 注入 0–60 秒延迟，用来验证骨架屏、加载态与超时处理
- 阻断请求，用来验证异常提示与离线兜底
- 按 HTTP 方法限定规则，或在代理后的地址上追加查询参数（灰度标识、__env=uat）
- 转发 WebSocket 长连接，让实时功能跟着同一套环境走
- 简单转发在浏览器网络层完成，不给页面增加脚本开销

调试与协作：
- 请求日志记录方法、状态、耗时与规则命中情况，点开可看完整请求与响应
- 一键把任意请求复制为 cURL；支持 HAR 与 cURL 的导入导出
- 规则可拖拽排序、批量启停、按名称与状态搜索
- 环境轮换时批量迁移目标域名，并给出逐条变更预览
- 把整套规则保存成命名环境快照，在 FAT / UAT / PROD 间一键切换
- 配置以 JSON 导出，交给同事直接导入即可复现

界面：
- 中文 / English 双语界面，6 套主题与浅色 / 深色 / 跟随系统
- 弹窗提供总开关、今日统计、自动关闭倒计时，以及「当前页面命中哪条规则」的预演
- 快捷键：⌘⇧P（Windows/Linux 为 Ctrl+Shift+P）切换代理

关于数据：
- 规则、日志与偏好全部保存在你本机的浏览器存储中，没有账号、没有统计埋点、不连接任何自有服务器
- 唯一的网络流量就是你自己要求代理的接口流量；导出文件也只写到本地
- 隐私政策：https://liaolongdong.github.io/cross-origin-proxy/privacy.html

限制：最多 200 条规则、最近 500 条日志、请求体上限 10MB。
需要较新版本的桌面 Google Chrome（Manifest V3）。

问题反馈与源码：https://github.com/liaolongdong/cross-origin-proxy
```

### 1.2 English listing（本地化列表）

**Extension Name**（≤75 字符，当前 52）

```
Cross-Origin Proxy - CORS & API Environment Switcher
```

**Short description**（≤132 字符，当前 129）

```
Proxy API calls to FAT/UAT/PROD backends, no code or CORS changes. Rewrite URLs/headers/responses, mock, delay, block, WebSocket.
```

**Detailed description**

```
Your frontend talks to FAT, but the change you need to verify only exists on UAT. This extension lets you add one rule in Chrome instead of editing a dev-server proxy in every project, hardcoding a token, or asking the backend to open CORS and redeploy.

What it does:
- Match requests by wildcard, prefix or regular expression and forward them to another environment
- Inject or replace request headers (such as the target environment's auth token) and replace request bodies
- Override the response status, response headers, or individual JSON fields by path
- Mock responses with your own JSON / text / HTML / XML when the API is not built yet
- Add 0–60 seconds of latency to exercise loading, skeleton and timeout states
- Block requests to verify error handling and offline fallbacks
- Limit a rule to specific HTTP methods, or append query parameters such as __env=uat and gray-release tags
- Forward WebSocket connections, so real-time features follow the same environment switch
- Simple rewrites are resolved inside the browser's network layer, adding no script work to your page

Debugging and teamwork:
- A request log with method, status, duration and rule hit statistics; open any entry for full headers and body
- Copy any request as cURL; import and export HAR
- Drag to reorder rule priority, batch enable or disable, search and filter
- Batch-migrate target domains across rules with a per-rule change preview
- Save the whole rule set as a named environment profile and switch between FAT, UAT and PROD in one click
- Export configuration as JSON so a teammate can import the exact same setup

Interface:
- English and Chinese UI, six themes, light / dark / system modes
- Popup with a global switch, today's stats, an auto-off countdown, and a preview of which rule matches the page you have open
- Keyboard shortcut Ctrl+Shift+P (⌘⇧P on macOS) to toggle proxying

About your data:
- Rules, logs and preferences are stored in your browser's local storage on your own device. No accounts, no analytics, no telemetry, no servers of ours
- The only network traffic is the API traffic you ask it to proxy; exports are written locally
- Privacy policy: https://liaolongdong.github.io/cross-origin-proxy/privacy.html

Limits: 200 rules, the last 500 log entries, 10 MB request body. Requires a recent desktop Google Chrome (Manifest V3).

Source code and issue tracker: https://github.com/liaolongdong/cross-origin-proxy
```

**Category**: Developer Tools
**Languages**: 中文（中国）+ English（两个本地化列表都建，中文为默认）

### 1.3 Single purpose（表单里的一句话，必须窄）

```
Redirects a page's API requests to another backend environment and lets developers modify those requests and responses for cross-environment debugging.
```

## 2. Graphics & Assets

运行 `pnpm assets`（中文版）与 `pnpm assets:en`（英文版）生成，产物在 `store-assets/`（已 gitignore，可再生）。

| Asset                  | Dimensions  | Status   | Filename                                                                              |
| ---------------------- | ----------- | -------- | ------------------------------------------------------------------------------------- |
| Store icon             | 128×128 PNG | ✅ Ready | `public/icon/128.png`                                                                 |
| Screenshot 1（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/01-rules-overview.png`                                   |
| Screenshot 2（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/02-rule-editor.png`                                      |
| Screenshot 3（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/03-url-tester.png`                                       |
| Screenshot 4（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/04-request-log.png`                                      |
| Screenshot 5（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/05-popup.png`                                            |
| Screenshot 1–5（英文） | 1280×800    | ✅ Ready | `store-assets/screenshots-en/0X-*.png`                                                |
| Small promo tile       | 440×280     | ✅ Ready | `store-assets/tiles/small-tile-zh.png` / `small-tile-en.png`                          |
| Marquee promo tile     | 1400×560    | ✅ Ready | `store-assets/tiles/marquee-zh.png` / `marquee-en.png`                                |
| GitHub social preview  | 1280×640    | ✅ Ready | `store-assets/tiles/github-social-preview.png`（仓库 Settings → Social preview 上传） |

**Screenshot notes**：每张图顶部带一句能力标题 + 一行说明，主体是真实界面截图（非 mockup、不含任何真实内网域名或 token）。商店只接受 **1280×800 或 640×400**，像素级校验，最多 5 张——顺序按「先讲清主用途 → 再讲能力 → 最后讲开关可见性」排列。

## 3. Permissions Justification

审核要求逐条给具体理由，"needed for the extension to work" 会被拒。以下文案可直接粘贴。

| Permission                      | Type             | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                       | permissions      | Saves the user's proxy rules, environment profiles, request logs and UI preferences in `chrome.storage.local`. Nothing leaves the device and no other storage area is used.                                                                                                                                                                                                                                                                                                  |
| `declarativeNetRequest`         | permissions      | The core feature. Rules that only rewrite a request URL are installed as dynamic redirect rules so the browser's network stack performs the redirect without per-request JavaScript. Rules are created only by the user, in the options UI, and are removed when disabled or deleted.                                                                                                                                                                                        |
| `declarativeNetRequestFeedback` | permissions      | Reads which dynamic rules actually matched, to display hit counts and forwarding-channel statistics in the request-log drawer. Used for display only; results are kept locally.                                                                                                                                                                                                                                                                                              |
| `alarms`                        | permissions      | Two timers: a keepalive ping so the background worker survives while proxying is active, and the user-configured auto-off countdown that turns proxying off after a set number of minutes. Minimum period is one minute; no second-precision scheduling is used.                                                                                                                                                                                                             |
| `<all_urls>`                    | host_permissions | The extension must work on whatever origin the developer's frontend runs on — internal domains, `localhost` dev servers and staging hosts cannot be enumerated in advance, and they differ per developer. It is used to (a) inject the request interceptor on pages the user browses and (b) issue proxied requests on the user's behalf for rules the user authored. The extension sends no data to any third-party or developer-controlled server; see the privacy policy. |

**为什么不用更窄的方案**（审核常追问，先答清楚）：`activeTab` 不满足需求——被代理的请求发生在用户浏览任意页面时的 `fetch`/XHR/WebSocket 调用中，不是用户点击扩展图标那一刻；按域名白名单也不可行，目标环境是每个开发者自己的内网域名。若审核要求收窄，可提议改为「用户手动授权当前站点」的降级方案。

## 4. Privacy & Data Use

### 4.1 Data collection

**Does the extension collect user data?** **No.**

| Data Type                    | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
| ---------------------------- | ---------- | ----------------------- | ------- | -------------------------- |
| Personally identifiable info | No         | No                      | —       | No                         |
| Health info                  | No         | No                      | —       | No                         |
| Financial info               | No         | No                      | —       | No                         |
| Authentication info          | No         | No                      | —       | No                         |
| Personal communications      | No         | No                      | —       | No                         |
| Location                     | No         | No                      | —       | No                         |
| Web history                  | No         | No                      | —       | No                         |
| User activity                | No         | No                      | —       | No                         |
| Website content              | No         | No                      | —       | No                         |

Rationale to paste if the form asks for clarification: request and response data of proxied calls is read **inside the user's browser** to perform the transformation the user configured, and is written only to `chrome.storage.local`. The extension contains no analytics, no telemetry and no remote endpoint of its own; there is no code path that uploads user data. Blocked/mock responses never reach a third party.

> ⚠️ 2026-08-01 起 Chrome 应用商店执行了更严格的数据收集与「最小必要」基准。提交前请以 Dashboard 当时的表单文案为准复核一遍上表，尤其确认 `declarativeNetRequestFeedback` 的命中统计是否被归入需要声明的类别。

### 4.2 Data use certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes
- [x] Data is NOT used to inform personalized advertising

## 5. Privacy Policy

**URL**: `https://liaolongdong.github.io/cross-origin-proxy/privacy.html`（仓库 `docs/privacy.html`，中英双语同页）

该页由 `.github/workflows/deploy-pages.yml` 在 `main` 上改动 `docs/**` 时自动部署，但**部署源必须先在 Settings → Pages 里切成「GitHub Actions」**（一次性开关，见 [GITHUB.md](./GITHUB.md) §5）。提审前用下面命令确认三个页面都是 200——隐私政策 URL 打不开是最常见的首审被拒原因：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://liaolongdong.github.io/cross-origin-proxy/privacy.html
```

## 6. Distribution

- **Visibility**: Public
- **Regions**: All regions
- **Pricing**: Free
- **Package**: `pnpm build:zip` → `.output/cross-origin-proxy-<version>-chrome.zip`（即 `<package-name>-<version>-<browser>.zip`；`manifest.json` 位于 zip 根目录，包内不含源码、测试与本文档）。版本号只在 `package.json` 维护，发版链路见 [RELEASING.md](./RELEASING.md)。

## 7. Developer Info

| 字段           | 值                                                          | 说明                                                            |
| -------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Publisher Name | Better                                                      | 与 `package.json` 的 `author.name` 一致                         |
| Contact Email  | 924902324@qq.com                                            | 商店页面公开显示；Google 的整改通知发到这里，必须是能收信的邮箱 |
| Support URL    | `https://github.com/liaolongdong/cross-origin-proxy/issues` |                                                                 |
| Homepage URL   | `https://liaolongdong.github.io/cross-origin-proxy/`        |                                                                 |

> 仓库已建立并公开（`liaolongdong/cross-origin-proxy`，2026-09-07）。剩下的一次性动作全部列在 [GITHUB.md](./GITHUB.md)：About 描述与 website、topics、社交预览图、**Pages 源切到 GitHub Actions**、私密漏洞报告入口。**确认 `privacy.html` 能打开后再提审。**
>
> 联系邮箱会在商店页与隐私政策页公开，可能被爬虫采集用于发送 Spam。若希望隔离，可改用 GitHub 专用可收信地址（`用户名+编号@users.noreply.github.com`），并同步更新本节与 `docs/privacy.html`。

## 8. Version History

完整版本历史以 [CHANGELOG.md](./CHANGELOG.md) 为唯一事实源（发版链路会把它对应小节切成 GitHub Release 的说明）；本表只记**已向商店提审**的版本与状态。

| Version | Date   | Changes                                                                                                                                               | Status |
| ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1.0.0   | 待提交 | 首次提交：双通道代理（DNR + 后台）、请求/响应改写、Mock/延迟/阻断、方法与查询参数控制、WebSocket 转发、HAR/cURL 导入导出、环境快照、中英双语与 6 主题 | Draft  |

## 9. Pre-Publish Checklist

包与清单：

- [ ] `pnpm build:zip` 通过，zip 根目录就是 `manifest.json`
- [ ] `manifest.json` 的 `name` / `description` 与本文档第 1 节完全一致（Chrome 硬校验 ≤75 / ≤132，`pnpm test` 已守卫）
- [ ] 版本号 > 商店已发布版本（首次忽略）
- [ ] 包内无 `.git`、`node_modules`、源码 map、测试、`README.md`、本文件

商店信息：

- [ ] 5 张 1280×800 截图已上传（英文列表用 `screenshots-en/`）
- [ ] 分类 = Developer Tools；默认语言 = 中文（中国），并新增 English 本地化列表
- [ ] Single purpose 一句话填写（第 1.3 节）
- [ ] 每一项权限与 host 权限的理由都粘贴（第 3 节），`<all_urls>` 单独说明
- [ ] 数据披露按第 4 节勾选，与隐私政策文本一致
- [ ] 隐私政策 URL 已可公开访问（第 5 节）
- [ ] 开发者联系邮箱已验证（Developer Dashboard → Account）

功能自检（提交前在本地最新版 Chrome 手动过一遍）：

- [ ] 通配 / 前缀 / 正则三类规则均能命中并重写
- [ ] 简单规则确实走 DNR（日志通道显示 DNR），复杂规则走后台
- [ ] Mock、延迟、阻断、响应改写、方法过滤、查询参数注入逐项生效
- [ ] WebSocket 规则能转发 `wss://` 连接
- [ ] 拦截异常时页面回退原生请求，且阻断请求不会被回退发出
- [ ] 弹窗、配置页、日志抽屉、导入导出无报错（`chrome://extensions` 查看 service worker 控制台）
- [ ] 关闭总开关后不再代理任何请求；自动关闭倒计时到期真的关掉
- [ ] 中英文切换、6 主题与深浅模式无残留样式
- [ ] 卸载扩展后无残留副作用（storage 随扩展清除）

## 10. Review Risk Notes

| 风险                                | 为什么会被盯           | 应对                                                                                                             |
| ----------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `<all_urls>` 权限过大               | 商店明确偏好窄权限     | 第 3 节已给出「无法枚举内网域名 + activeTab 不满足时机」的具体论证，并主动提出可降级为按站点授权                 |
| 名称含 `CORS`/`Mock` 被判关键词堆砌 | 名称是搜索权重最高字段 | 名称结构为「品牌名 - 能力 A · 能力 B · 能力 C」，每个词对应真实功能，无重复词、无最高级、无 "free/best"          |
| 数据披露与代码不一致                | 拒审主因               | 全仓库无 `fetch` 到自有域名、无埋点 SDK；命中统计仅本地展示；已在第 4 节写明可粘贴的依据                         |
| 截图与实际不符                      | 会要求重传             | 截图由 `screenshots/` 真实界面派生，且不含真实内网域名（示例统一 `fat-api.example.com` / `uat-api.example.com`） |
| 远程代码                            | MV3 红线               | 无 CDN 脚本、无 `eval`；构建产物 `esbuild.drop: ['console','debugger']`，全部脚本随包发布                        |

### Rejection History

| Date | Reason | Fix Applied | Resubmitted |
| ---- | ------ | ----------- | ----------- |
| —    | 暂无   | —           | —           |

## 11. 自动化发布（包上传与提审）

第 1–10 节是人工填写的商店表单；一旦条目存在，包体本身就不该再手工传。

- **一次性准备（无法绕开的手动部分）**：`publish-extension` 不提供「新建商店条目」能力，必须在 Dashboard 手动上传一次 zip 才能拿到 Extension ID；同时在 Google Cloud 建 OAuth 客户端换 refresh token。四个值落到仓库 Secrets：`CHROME_EXTENSION_ID` · `CHROME_CLIENT_ID` · `CHROME_CLIENT_SECRET` · `CHROME_REFRESH_TOKEN`。逐步命令见 [RELEASING.md](./RELEASING.md) §1。
- **日常**：推 `v*` 标签即触发 `.github/workflows/release.yml`——全量校验 → 打 zip → 建 GitHub Release → `pnpm exec wxt submit` 上传并提审。版本号必须与 `package.json` 一致，不一致时工作流直接终止（商店收到错版本号的包是静默失败）。
- **Secrets 未配时的行为**：Release 照建，商店那一步跳过并在 Run 页面留指引，不报红。
- **先验后提审**：首次接管已有条目时，用 `Run workflow` 勾选 `skip-review`（只上传成草稿）或选 `publish-target=trustedTesters`，人工核对完再走 `default`。
- **与商店表单的耦合点**：详细描述里刻意不写版本号，避开每次发版都要改商店文案；但限制条数（200 规则 / 500 日志 / 10MB）与能力清单必须与 `README.md`、`docs/` 落地页、`CHANGELOG.md` 保持同一事实。
