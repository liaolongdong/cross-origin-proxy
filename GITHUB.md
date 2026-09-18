# GitHub 仓库设置清单 — 跨域代理助手 / Cross-Origin Proxy

> 本文是**仓库在 GitHub 侧的展示信息**（About / website / topics / 社交预览 / Pages）的唯一操作清单，与商店侧的 `CHROMEWEBSTORE.md` 互补。
>
> 这些字段全部位于 GitHub 仓库设置里，只有仓库所有者能改。本仓库刻意**不**收录自动改设置的脚本、也**不**建会动仓库设置的工作流；§3.1 给的是一条你自愿手动跑的 `gh` 命令，值仍然从本文读，不另建事实源。填完之后用 §7 的命令自检。
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

## 0.1 当前实测状态（2026-09-18，用 §7 的命令可复核）

| 字段               | 实测值                                                              | 结论                                            |
| ------------------ | ------------------------------------------------------------------- | ----------------------------------------------- |
| `description`      | **已填**，与 §1 逐字一致                                            | §1 已完成                                       |
| `homepage`         | **已填**，就是 §2 那条产品站 URL                                    | §2 已完成                                       |
| topics             | `[]`（0 个）                                                        | §3 未填                                         |
| `has_pages`        | `true`；§7 列的 7 个 URL 全部 200（含两个对比页与 `llms-full.txt`） | §5 已经切到 GitHub Actions 源，Pages 链路是通的 |
| `has_wiki`         | `true`                                                              | 建议关闭（理由见 §8），需你确认                 |
| `v*` tag / Release | 0 个 tag、0 个 Release                                              | README 的 `Release` 徽章与「方式 A」都还是空态  |
| `stargazers_count` | 1                                                                   | —                                               |
| Social preview     | API 读不出来                                                        | 只能在设置页目测                                |

**§1 与 §2 已落库，GitHub 侧只剩 §3 的 topics 一项没填（20 个 slug 已备好，粘贴即可），而它正是话题页被动流量的唯一入口。**Pages 侧已经没有瓶颈——隐私政策、`llms.txt` 与两个对比页都可达，商店首审最常见的「隐私政策打不开」在这里不成立。剩下的曝光量差距按代价排序：topics（一次粘贴）、社交预览（§4，图片已有）、首个 `v*` tag（README 的 `Release` 徽章与 HowTo 第一步都指向它）。

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

## 3. Topics（20 个，已用满上限）

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
debugging
developer-tools
devtools
frontend
typescript
vue3
element-plus
wxt
```

分层理由：前 4 个决定"出现在哪些扩展类话题页"，`cross-origin` / `cors` / `api-proxy` 是有真实搜索量的意图词，`request-modification` / `mock-api` / `environment-switch` / `debugging` 覆盖用例词，后面 5 个（`typescript` / `vue3` / `element-plus` / `wxt` / `devtools`）走技术栈被检索的路径。`proxy` 与 `api-proxy` 都保留：前者流量大但语义泛（会跟 VPN 类仓库同框），后者意图精准。

20 个已经用满上限，日后再加词必须先删一个——删谁比加谁更值得想清楚。

### 3.1 可选：一条命令填完 §1–§3（不依赖 `gh`）

UI 逐字段粘贴当然也行。下面这段只用到系统自带的 `python3`（不需要 `gh`、也不需要 `jq`——本机两者都没装），它把 §1 的描述、`package.json` 的 `homepage` 与 §3 的 topic 列表**从本文自身读出**再写回仓库，因此不存在第二份事实源——改本文即改仓库要填的值。

先建一个有权限的令牌：**classic token 勾 `public_repo` 即可**（本仓库公开；若用 fine-grained token，需要仓库的 `Administration: Read and write`，Dashboard 在该端点文档的权限表里会写明）。令牌只放环境变量，不要写进任何文件——`.env.submit` 那套是商店凭据，和这里无关。

```bash
set -euo pipefail
export GH_TOKEN=<粘贴你的令牌>

python3 - <<'PY'
import json, os, re, urllib.request

REPO = "liaolongdong/cross-origin-proxy"
TOKEN = os.environ["GH_TOKEN"]

doc = open("GITHUB.md", encoding="utf-8").read()
desc = re.search(r"^Chrome extension:.*$", doc, re.M).group(0)
home = json.load(open("package.json", encoding="utf-8"))["homepage"]
slugs_section = doc.split("## 3. Topics", 1)[1].split("### 3.1", 1)[0]
topics = re.findall(r"^[a-z0-9][a-z0-9-]{0,49}$", slugs_section, re.M)


def call(method, path, payload):
    req = urllib.request.Request(
        "https://api.github.com" + path,
        data=json.dumps(payload).encode("utf-8"),
        method=method,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "cross-origin-proxy-docs",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return resp.status


print("description + homepage:", call("PATCH", "/repos/" + REPO, {"description": desc, "homepage": home}))
print("topics:", call("PUT", "/repos/" + REPO + "/topics", {"names": topics}), "(%d slugs)" % len(topics))
PY
```

跑完用 §7 自检。三点约束：

- 这是**你手动执行的一次性命令**，仓库不收录成脚本、也不建工作流去自动改设置——`description`/`homepage`/`topics` 会覆盖 GitHub 侧现值，自动化等于把展示信息交给 CI。
- 抽 topics 依赖「`## 3. Topics` 与 `### 3.1` 之间只有那 20 行是纯 slug」。往 §3 正文里加别的纯小写行之前，先确认脚本打印的仍是 `(20 slugs)`——`tests/docs-consistency.test.ts` 用另一套等价抽取守卫同一个上限，两边都不允许超 20。
- **§4 社交预览、§5 Pages 源、§6 私密漏洞报告没有可用 API**，只能在设置页点。这条命令只覆盖 §1–§3。

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
for p in "" en.html privacy.html llms.txt llms-full.txt alternatives.html en-alternatives.html; do
  printf '%-22s %s\n' "${p:-/}" "$(curl -s -o /dev/null -w '%{http_code}' "https://liaolongdong.github.io/cross-origin-proxy/$p")"
done

# 仓库元数据是否已落库
curl -s https://api.github.com/repos/liaolongdong/cross-origin-proxy \
  | grep -E '"(description|homepage|has_pages|default_branch)"'

# topics（GitHub 把它放在独立端点）
curl -s -H "Accept: application/vnd.github.mercy-preview+json" \
  https://api.github.com/repos/liaolongdong/cross-origin-proxy/topics \
  | jq '.names | length'
```

期望：`description`/`homepage` 非 null、`has_pages: true`、topics 长度 `20`。七个 URL 都应返回 200。两个例外窗口：本轮把中文页搬到站点根、英文页改名带 `en` 前缀，在 `docs/**` 推上 `main` 且 `deploy-pages` 跑完之前 `/en.html` 与 `/en-alternatives.html` 仍是 404，属预期而不是配置错。旧的 `/zh.html` 与 `/zh-alternatives.html` 已下线且**没有 301**（Pages 是纯静态目录，没有重写规则），所以仓库内任何文档都不许再引用它们——`tests/docs-consistency.test.ts` 已把这条钉死。

还要确认 README 顶部两枚徽章已变绿：`Release` 在仓库首个 tag 推上去之前会显示 unknown（因为还没有任何 Release），`Product site` 在 §5 的 Source 开关没切之前会跟着首次失败的 run 显红。两者都是配置未就绪的中间态，不是徽章写错。

## 8. 本文刻意没有做的事（需要时另行确认）

| 项                            | 为什么先不做                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discussions                   | 反馈渠道已经是 `has_issues` + 商店 Support URL，开 Discussions 会分流                                                                                                                    |
| 分支保护 / required check     | 单人仓库开了反而挡住自己的实验性推送，等有多人贡献再开                                                                                                                                   |
| Dependabot                    | 会自动开升级 PR；本仓库依赖升级需要连带跑 `pnpm build` 与商店文案守卫                                                                                                                    |
| Wiki（当前 `has_wiki: true`） | 文档走 `README.md` / `AGENTS.md`，双份知识源必然漂移。**建议关闭**，但它是仓库功能开关、且会连带改动 Security/Insights 等标签页布局，需你确认后再动（设置页 General → Features → Wikis） |
| 把 §3.1 收录成脚本或工作流    | 展示信息会随 CI 被覆盖式重写；清单化 + 自检命令的收益/风险比更划算，命令只作为你本机的一次性手动操作存在                                                                                 |
