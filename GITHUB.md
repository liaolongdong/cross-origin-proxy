# GitHub 仓库设置清单 — 跨域代理助手 / Cross-Origin Proxy

> 本文是**仓库在 GitHub 侧的展示信息**（About / website / topics / 社交预览 / Pages）的唯一操作清单，与商店侧的 `CHROMEWEBSTORE.md` 互补。
>
> 这些字段全部位于 GitHub 仓库设置里，只能由仓库所有者在 UI 手动填写——本仓库刻意不写需要 Personal Access Token 的脚本，也不建会改仓库设置的工作流。填完之后用 §7 的命令自检。
>
> 本文位于仓库根目录，不在 `docs/`（Pages 站点根）内，也不会被打进扩展包。

## 0. 为什么要填：每个字段的受众

| 字段                | 谁看                                                        | 空的代价                                                |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| About → Description | GitHub 搜索摘要、Google 收录的仓库卡、分享链接的机器摘要    | 仓库名之外没有任何可被检索的语义，星标转化低            |
| About → Website     | 仓库首页右侧链接、README 之外的最短入口                     | 落地页与隐私政策少一个权威入口，商店审核看不到产品站    |
| Topics              | GitHub 话题页（`/topics/<slug>`）与相关推荐                 | 话题页是长期被动流量来源，空 = 完全放弃                 |
| Social preview      | 所有聊天工具、Twitter/X、Slack、掘金/知乎链接卡（1280×640） | 分享时只显示灰底仓库名，点击率显著下降                  |
| Pages Source        | 产品站与隐私政策的托管开关                                  | `privacy.html` 打不开是 Chrome 商店首审最常见的拒审理由 |

## 1. About → Description

仓库首页右侧 **About → ⚙️** → 粘贴（GitHub 上限 350 字符，当前 214 码点）：

```
Chrome extension: point a FAT frontend at a UAT backend with one rule. Proxies API requests cross-origin - rewrite URL/headers/responses, mock, delay, block, retry, WebSocket. No backend CORS changes. 跨域代理助手 · 环境切换
```

写作约束（改动前先看，别顺手"优化"）：

- 结尾的中文是主市场检索词（`跨域` / `环境切换`），不是装饰，删掉会让中文检索彻底失去落点。
- 用 `-` 而不是 em dash，避免部分渠道把 UTF-8 标点转义成 `&#8212;`。
- 不出现 `best` / `#1` / `free`，也不写"翻墙/代理上网"语义——`proxy` 一词在这里只指 API 请求转发。

## 2. About → Website

```
https://liaolongdong.github.io/cross-origin-proxy/
```

与 `package.json` 的 `homepage`、`docs/sitemap.xml`、`docs/llms.txt`、`CHROMEWEBSTORE.md` 的 Homepage/隐私政策 URL 必须逐字符一致。**Pages 的路径基等于仓库名**，所以这个 URL 一旦提交给商店就不能再改仓库名——改仓库名会让隐私政策 404，需要重新提审。

## 3. Topics（19 个，上限 20）

在同一处 **About → ⚙️ → Topics** 逐个输入并回车（或粘贴后按空格分隔，GitHub 会自动切分）：

```
chrome-extension
browser-extension
manifest-v3
declarative-net-request
cross-origin
cors
api-proxy
proxy
request-interceptor
request-modification
mock-api
environment-switch
developer-tools
devtools
frontend
typescript
vue3
element-plus
wxt
```

分层理由：前 4 个决定"出现在哪些扩展类话题页"，`cross-origin` / `cors` / `api-proxy` 是有真实搜索量的意图词，`request-modification` / `mock-api` / `environment-switch` 覆盖用例词，后面 5 个（`typescript` / `vue3` / `element-plus` / `wxt` / `devtools`）走技术栈被检索的路径。`proxy` 与 `api-proxy` 都保留：前者流量大但语义泛（会跟 VPN 类仓库同框），后者意图精准。

## 4. Social preview（1280×640）

`Settings → General`，滚到 **Social preview → Edit** 上传：

```
store-assets/tiles/github-social-preview.png
```

`store-assets/` 已进 `.gitignore`（可再生产物，不入库），本地没有就先跑：

```bash
pnpm assets:en
```

图片把 URL 烧进了像素，所以**改仓库名或 Pages 地址必须重跑 `pnpm assets && pnpm assets:en` 并重新上传**，只改文本不会更新图片。

## 5. GitHub Pages → Source: GitHub Actions

`.github/workflows/deploy-pages.yml` 用 `actions/deploy-pages` 部署，它要求 Pages 的构建源已经是 **GitHub Actions**；未切换前工作流会以 "Pages not enabled" 失败。

仓库 `Settings → Pages → Build and deployment → Source`，选 **GitHub Actions**（不要选 Deploy from a branch）。之后每次 `main` 上改动 `docs/**` 都会自动部署，无需手动触发。

> 若你更想用零 YAML 的经典分支部署（`main` + `/docs`），把 §5 换成分支部署并删掉 `deploy-pages.yml` 也能达成同一结果；两种只能选一种，同时留着会让 Actions 部署一直报错。
>
> 在 Pages 设置页里切源时，GitHub 会顺手提供一份模板 workflow（常叫 `static.yml`，`path: '.'`）。**不要提交它**：它把整个仓库当站点根发布，`/privacy.html` 会变成 `/docs/privacy.html`（商店与 `llms.txt` 里的链接全断），还会与 `deploy-pages.yml` 抢同一个 `github-pages` 环境。只保留 `deploy-pages.yml` 一份。

## 6. 开启私密漏洞报告（`SECURITY.md` 的前提）

仓库 **Settings → General**，滚到 **Advanced** 区，勾选 **Privately report a security vulnerability**。不勾就没有 `Security → Report a vulnerability` 入口，而 [`SECURITY.md`](./SECURITY.md) 把隐私报漏洞作为首选项——这个扩展拿的是 `<all_urls>`，公开 Issue 里贴复现等于公开利用方式。

勾选后仓库首页 Security 标签页会出现 **Report a vulnerability** 按钮，可在里面验证一下入口真能用。

## 7. 自检命令

```bash
# 产品站与隐私政策必须都是 200（商店提审前置条件）
curl -s -o /dev/null -w 'home:    %{http_code}\n' https://liaolongdong.github.io/cross-origin-proxy/
curl -s -o /dev/null -w 'zh:      %{http_code}\n' https://liaolongdong.github.io/cross-origin-proxy/zh.html
curl -s -o /dev/null -w 'privacy: %{http_code}\n' https://liaolongdong.github.io/cross-origin-proxy/privacy.html

# 仓库元数据是否已落库
curl -s https://api.github.com/repos/liaolongdong/cross-origin-proxy \
  | grep -E '"(description|homepage|has_pages|default_branch)"'

# topics（GitHub 把它放在独立端点）
curl -s -H "Accept: application/vnd.github.mercy-preview+json" \
  https://api.github.com/repos/liaolongdong/cross-origin-proxy/topics | head -c 400
```

期望：三个 200、`has_pages: true`、`description`/`homepage` 非 null、`topics` 含 19 项。

还要确认 README 顶部两枚徽章已变绿：`Release` 在仓库首个 tag 推上去之前会显示 unknown（因为还没有任何 Release），`Product site` 在 §5 的 Source 开关没切之前会跟着首次失败的 run 显红。两者都是配置未就绪的中间态，不是徽章写错。

## 8. 本文刻意没有做的事（需要时另行确认）

| 项                        | 为什么先不做                                                          |
| ------------------------- | --------------------------------------------------------------------- |
| Discussions               | 反馈渠道已经是 `has_issues` + 商店 Support URL，开 Discussions 会分流 |
| 分支保护 / required check | 单人仓库开了反而挡住自己的实验性推送，等有多人贡献再开                |
| Dependabot                | 会自动开升级 PR；本仓库依赖升级需要连带跑 `pnpm build` 与商店文案守卫 |
| Wiki（当前 `has_wiki`）   | 文档走 `README.md` / `AGENTS.md`，双份知识源必然漂移                  |
| 用 PAT 脚本改这些设置     | 需要你把令牌交出来；清单化+自检命令的收益/风险比更划算                |
