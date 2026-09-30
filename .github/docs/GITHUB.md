# GitHub 仓库设置清单 — 跨域代理助手 / Cross-Origin Proxy

> 本文是**仓库在 GitHub 侧的展示信息**（About / website / topics / 社交预览 / Pages）的唯一操作清单，与商店侧的 `CHROMEWEBSTORE.md` 互补。
>
> 这些字段全部位于 GitHub 仓库设置里，只有仓库所有者能改。本仓库刻意**不**收录自动改设置的脚本、也**不**建会动仓库设置的工作流；§3.1 给的是一条你自愿手动跑的 `gh` 命令，值仍然从本文读，不另建事实源。填完之后用 §7 的命令自检。
>
> 本文位于 `.github/docs/`（仓库侧运维文档），既不在 `docs/`（Pages 站点根，公开产品站）内，也不会被打进扩展包。

## 0. 为什么要填：每个字段的受众

| 字段                | 谁看                                                        | 空的代价                                                |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| About → Description | GitHub 搜索摘要、Google 收录的仓库卡、分享链接的机器摘要    | 仓库名之外没有任何可被检索的语义，星标转化低            |
| About → Website     | 仓库首页右侧链接、README 之外的最短入口                     | 落地页与隐私政策少一个权威入口，商店审核看不到产品站    |
| Topics              | GitHub 话题页（`/topics/<slug>`）与相关推荐                 | 话题页是长期被动流量来源，空 = 完全放弃                 |
| Social preview      | 所有聊天工具、Twitter/X、Slack、掘金/知乎链接卡（1280×640） | 分享时只显示灰底仓库名，点击率显著下降                  |
| Pages Source        | 产品站与隐私政策的托管开关                                  | `privacy.html` 打不开是 Chrome 商店首审最常见的拒审理由 |

## 0.1 当前实测状态（配置类字段量于 2026-09-22，tag/徽章类量于 2026-10-01，用 §7 的命令可复核）

| 字段               | 实测值                                                                                                                                                                                                     | 结论                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `description`      | **已填**，214 码点，与 §1 的代码块逐字节相同（含结尾那句中文检索词）                                                                                                                                       | §1 已完成                                                                                                                                  |
| `homepage`         | **已填**，就是 §2 那条产品站 URL                                                                                                                                                                           | §2 已完成                                                                                                                                  |
| topics             | **20 个，已用满上限**                                                                                                                                                                                      | §3 已完成；只有 `request-interceptors` 是复数，与 §3 清单的单数差一个 `s`                                                                  |
| `has_pages`        | `true`；§7 列的 URL 全部 200（另实测 `sitemap.xml` 与 `robots.txt` 也 200）                                                                                                                                | §5 的源已切到 GitHub Actions，Pages 链路是通的                                                                                             |
| `has_wiki`         | `true`                                                                                                                                                                                                     | 建议关闭（理由见 §8），需你确认                                                                                                            |
| `v*` tag / Release | 远端**有 tag 也有 Release**（2026-09-30 起不再空；具体号别抄这里，`curl -s https://api.github.com/repos/liaolongdong/cross-origin-proxy/tags` 现量）。本机另有一个从未推送的 `v1.3.0` 轻量 tag，别顺手补推 | README 的 `Release` 徽章与「方式 B」已经有实物；商店还停在 1.3.0，因为 `release.yml` 读的 `CHROME_*` Secrets 一个都没配（RELEASING.md §5） |
| `pushed_at`        | 每次 push 都变，别信这里抄的数——用 `git rev-list --count origin/main..main` 自己量（2026-10-01 写这一行时是 0，本地与远端同点）                                                                            | 本地领先多少个，远端与产品站就看到多少个——商店那一头另有自己的节奏（见上一行）                                                             |
| `stargazers_count` | 1                                                                                                                                                                                                          | —                                                                                                                                          |
| Social preview     | 匿名 API 读不出来（`security_and_analysis` 同样为 `null`）                                                                                                                                                 | 只能在设置页目测；私密漏洞报告同理，§6 要人工确认                                                                                          |

**§1–§3、§5 都已落库，GitHub 侧的一次性清单只剩 §4 社交预览（图片已有，只能手动传）与 §6 私密漏洞报告勾选，外加 §8 那条「关 wiki」的建议。**

**这一段的处方已经抓完药，2026-10-01 起换成另一件事。** 曾经卡住曝光的是「没有任何东西被推出去」：0 个 tag → Releases 空、`Release` 徽章画不出数、README 的「方式 B」是空口承诺、落地页 HowTo 第一步指向一个空页面。第一支 tag 已经在 2026-09-30 推出去，GitHub Release 连同预构建 zip 都在，`CHROMEWEBSTORE.md` §12 那八句也已翻完（记录见那张表）。**现在唯一还缺的出口是商店**：`release.yml` 要读的 `CHROME_*` 四个 Secrets 一个都没配（仓库里只有 `CWS_*` 三个，且 `CHROME_REFRESH_TOKEN` 从来没有过），所以最新那一包只到了 GitHub、没进商店，商店在装的还是 1.3.0。补法两条，都在 [RELEASING.md](./RELEASING.md)：§1.2–§1.3 把凭据配好后按 §3 用 `workflow_dispatch` 补跑，或直接把 Release 上那只 zip 拖进 Dashboard 人工上传。

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

仓库 **Settings → General**，滚到 **Advanced** 区，勾选 **Privately report a security vulnerability**。不勾就没有 `Security → Report a vulnerability` 入口，而 [`SECURITY.md`](../../SECURITY.md) 把隐私报漏洞作为首选项——这个扩展拿的是 `<all_urls>`，公开 Issue 里贴复现等于公开利用方式。

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

# topics（GitHub 把它放在独立端点；本机没有 jq，用 python3 数）
curl -s -H "Accept: application/vnd.github.mercy-preview+json" \
  https://api.github.com/repos/liaolongdong/cross-origin-proxy/topics \
  | python3 -c 'import json,sys; n=json.load(sys.stdin)["names"]; print(len(n), n)'
```

期望：`description`/`homepage` 非 null、`has_pages: true`、topics 长度 `20`。七个 URL 都应返回 200——2026-09-22 实测七个全绿，另外 `sitemap.xml` 与 `robots.txt` 也是 200。中文页在站点根、英文页带 `en` 前缀这次搬迁**已经在远端生效**，`/en.html` 与 `/en-alternatives.html` 不再是 404。旧的 `/zh.html` 与 `/zh-alternatives.html` 已下线且**没有 301**（Pages 是纯静态目录，没有重写规则），所以仓库内任何文档都不许再引用它们——`tests/docs-consistency.test.ts` 已把这条钉死。

还要确认 README 顶部两枚徽章已变绿：`Release` 在仓库首个 tag 推上去之前会显示 unknown（它读 `img.shields.io/github/v/release/…`，没有 Release 就没有数），`Product site` 在 §5 的 Source 开关没切之前会跟着首次失败的 run 显红。两者都是配置未就绪的中间态，不是徽章写错。**2026-10-01 实测两枚都已变色有数**：`Release` 跟着远端最新的 tag，`CWS` = v1.3.0——这两个数**故意不一样**（最新那一包只到了 GitHub Release、没进商店，原因见 §0 那张表的 `v*` tag / Release 行），别把它们「对齐」成同一个号。`CWS` 那枚已改成 shields 的商店版本端点，**不需要每次发版手改**：它显示的是商店在线版本，2026-10-01 实测是 `v1.3.0`（更早写这一句时是 `v1.0.0`）。**它偶尔报 `not found`**——2026-10-01 连着量七次遇到一次，那是 shields 自己抓商店页失败，不是下架信号；判下架要看 Developer Dashboard，或带 `?cacheSeconds=30` 绕开它的缓存重试几次。文档里写「商店在装的版本号」之前，先按这个方法重试确认它稳定。

### 7.1 搜索收录与 AI 检索的提交动作（一次性的站外清单）

§7 那三条命令证明的是**站内**东西是干净的：`robots.txt` 放行、`sitemap.xml` 200、hreflang 成对、canonical 自指。这些只回答「爬虫来了能不能读懂」，不回答「它来没来过」。`docs/robots.txt` 逐个放行 GPTBot / OAI-SearchBot / Perplexity / Claude 系同理是**允许**而非**已收录**——放行之后没有任何一次提交动作，索引里就是没有。所以这一步只能在网页界面做，没有 API 可代跑（`GITHUB_TOKEN` 也管不到站外服务）。

按这个顺序做，做完各留一条实测记录在下面：

1. **Google Search Console**：`google-site-verification` 的值已经写在五页的 `<head>` 里（`unD6BHVEHRxOhyZ353oO_77V8GXyLInc8gvbrh_ARbI`），如果属性还没建过，用「网址前缀」建 `https://liaolongdong.github.io/cross-origin-proxy/` 即可直接命中这条 meta。建好后左侧 **Sitemaps** 提交 `sitemap.xml`，再用 **网址检查** 逐个走 `index.html`（站点根）、`en.html`、`alternatives.html`、`en-alternatives.html`、`privacy.html` 请求索引进索引。
2. **Bing Webmaster Tools**：用 **导入 Google Search Console 属性** 起步（比重新验证站点省事），然后提交同一份 `sitemap.xml`。这一条是本轮新增的**唯一实质动作**，理由是 ChatGPT 的 search 结果与 Copilot 的网页来源走的是 Bing 索引——`robots.txt` 里放行 GPTBot 只覆盖「用户主动让 ChatGPT 读某条链接」那一半，答案引擎要**主动**引本站，前提是本站在 Bing 的索引里。
3. **提交后各量一次收录面**，不要凭感觉：Google 用 `site:liaolongdong.github.io/cross-origin-proxy` 数结果页，Bing 用同样的语法。期望值 5（五个 HTML 页）；`llms.txt` 与 `llms-full.txt` 不算 HTML 页，被不计入是正常的。
4. 之后**每次改动落地页正文**都要回来看一眼 GSC 的「网页索引」报告里有没有新增排除项——Pages 是纯静态目录、没有 301 能力，历史已经吃过一次「旧 `/zh.html` 永久 404」的代价（见 §7 末段）。

```bash
# sitemap 与 robots 必须是 200，且 sitemap 的条数与页面数对得上
for p in robots.txt sitemap.xml; do
  printf '%-14s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://liaolongdong.github.io/cross-origin-proxy/$p")"
done
curl -s https://liaolongdong.github.io/cross-origin-proxy/sitemap.xml | grep -c '<url>'
```

期望 `5`（五个 URL）。改页数或中英配对时这条会跟着动，`tests/docs-consistency.test.ts` 里守 sitemap 的那两条按「每个中英页面对补齐 `en` / `zh` / `x-default`」断言，漏一条直接红。

一句实话作为投入判断的依据：**中文开发者找这类工具的主路径不是百度搜 github.io**，而是 Chrome 应用商店搜索与掘金/CSDN/V2EX/公众号的帖子。落地页在这里的职责是「规范来源与被引用锚点」（隐私政策 URL 是商店审核项、`llms.txt` 是 AI 引用面），把它当 CWS 详情页的后盾来分工，不值得为百度搜索单独做一轮投入。

## 8. 本文刻意没有做的事（需要时另行确认）

| 项                            | 为什么先不做                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discussions                   | 反馈渠道已经是 `has_issues` + 商店 Support URL，开 Discussions 会分流                                                                                                                    |
| 分支保护 / required check     | 单人仓库开了反而挡住自己的实验性推送，等有多人贡献再开                                                                                                                                   |
| Dependabot                    | 会自动开升级 PR；本仓库依赖升级需要连带跑 `pnpm build` 与商店文案守卫                                                                                                                    |
| Wiki（当前 `has_wiki: true`） | 文档走 `README.md` / `AGENTS.md`，双份知识源必然漂移。**建议关闭**，但它是仓库功能开关、且会连带改动 Security/Insights 等标签页布局，需你确认后再动（设置页 General → Features → Wikis） |
| 把 §3.1 收录成脚本或工作流    | 展示信息会随 CI 被覆盖式重写；清单化 + 自检命令的收益/风险比更划算，命令只作为你本机的一次性手动操作存在                                                                                 |
