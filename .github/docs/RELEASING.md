# 发版与 Chrome 应用商店提审 — 跨域代理助手 / Cross-Origin Proxy

> 本文讲**怎么发一个版本**，以及哪些地方**只能人去点**（逐项见 §1）。GitHub 仓库侧的展示信息（About / website / topics / Pages 开关）在 [GITHUB.md](./GITHUB.md)，商店表单文案在 [CHROMEWEBSTORE.md](./CHROMEWEBSTORE.md)。
>
> 不可撤回的动作只有两个，都归人：**首次上架必须手动**（`publish-extension` 不提供"新建商店条目"的能力，官方 README 原文是 _You are responsible for uploading and submitting an extension for the first time by hand_）；**向 Google 提审那一下必须有人点头**。点头的**位置**可以选：合进 main 之后在 Run 页面点 **Approve**（§2 路径 A），或者在本机推 `v*` tag（§2 路径 B）——两条路最后走的是同一份发布实现 `.github/workflows/release.yml`，所以「发了什么」不会取决于「你从哪一头进去」。其余——版本号、CHANGELOG 小节、校验、打包、建 GitHub Release、打 tag、上传与提审——都在链路里。
>
> 读这份文档的顺序：第一次接触这个仓库 → §0 + §1（一次性，做完就再也不用回来）；要发一个版本 → §2；出问题 → §4，想不通为什么这样设计 → §7。

## 0. 链路全貌

五条链路，各自**不越界**：

```
⓪ 校验（任何 push / PR 都跑，与发版无关的那一份绿）
   .github/workflows/ci.yml → 复用 .github/actions/verify

① 起草（自动，机器人只写文件，不发版）
   代码合进 main
      │
      └─ .github/workflows/release-please.yml（Release Please，push main 触发）
           ├─ 按提交类型算出下一个版本号（feat→minor、fix/perf/refactor/revert→patch、BREAKING CHANGE→major）
           ├─ 开/更新一个待人工合并的 PR：把号写进 package.json 与 .release-please-manifest.json，
           │  并在 CHANGELOG.md 顶部开出 `## [x.y.z]` 小节、把提交标题列进去
           └─ 不建 tag、不建 GitHub Release（配置里 skip-github-release: true）

② 闸门（自动判断 + 人工点头；合并即起跑，但点头之前 refs 一个都不动）
   机器人的发布 PR 合进 main（或任何一次 main 上的 push）
      │
      └─ .github/workflows/store-publish.yml
           ├─ decide      只读三份远端事实：`vX.Y.Z` 在不在、审批闸门配没配、四个 Secrets 齐不齐
           ├─ prepare     与 CI 同一份清单（.github/actions/verify）+ 打包，产物留成 Artifact 给你核
           ├─ confirm     挂着 Environment `chrome-web-store` —— 必需审查员批准就发生在这里
           ├─ release-tag 批准之后才把 `vX.Y.Z` 落到远端（先重查一次，避免和人工补跑撞车）
           └─ publish     调用 ③，发布实现只有那一份
           （任何一格判「现在不该发」→ hold 那一格翻红并写明原因，而不是安静跳过）

③ 发布（三个入口，同一份实现）
   .github/workflows/release.yml
      ├─ 被 ② 的 publish 调用（workflow_call）
      ├─ 人从本机推 tag（on: push: tags）—— §2 路径 B
      └─ 人在 Actions 里手动起跑（workflow_dispatch）—— §3 补跑 / 灰度
      ├─ Verify            复用 ⓪ 那份 .github/actions/verify（lint/style/format/typecheck/build:zip/test）
      ├─ Guard             tag 必须等于 package.json 的 version，否则终止
      ├─ GitHub Release    附 .output/*-chrome.zip，说明取 CHANGELOG 对应小节
      ├─ 清标签            把 release-please 的 `autorelease: pending` 换成 `tagged`（§2 末）
      └─ Chrome Web Store  4 个 Secrets 齐 → `wxt submit` 上传并提审；缺 → 跳过并写 Job Summary 指引

④ 产品站（含隐私政策）走另一条独立链路 .github/workflows/deploy-pages.yml，
   改动 docs/** 即自动部署，不需要任何 Secrets。
```

**为什么发版那一下仍然要人点头**：向 Chrome 应用商店提交审核不可撤回，且 Google 侧的审核配额有限；它不该是「合并 PR」这个动作的副作用。同一条理由也解释了为什么机器人只起草版本 PR（`release-please-config.json` 的 `skip-github-release: true`）。

**为什么闸门把「校验」排在「点头」之前**：审批人该在点头前知道这份代码合不合格，而不是点完头才发现构建是红的。代价是一次版本 bump 的合并会把全套 `verify` 跑两遍（CI 一遍、`prepare` 一遍）——这是拿一分钟换「点头之前看见绿勾」，普通 PR 不付这个钱，因为它们的号早就对应一个已存在的 tag，`decide` 直接判「这一版已经发过」。

**为什么 `publish` 是 `workflow_call` 而不是「打完 tag 让 `release.yml` 自己起跑」**：GitHub 规定**由默认 `GITHUB_TOKEN` 产生的事件不会再起跑新工作流**。闸门链路用作业令牌推 tag，那个 tag 触发不了 `release.yml`——链路会停在「tag 有了、商店没吃到包」这个中间态，而它看起来像成功。所以必须显式接力。**人从本机推的 tag 没有这个问题**，那条规则也解释了 §1.5 里分支保护的那个坑。

## 1. 一次性准备（只做一次）

下面每一项都是**只能人点**的：没有 API、没有 CLI 能替你把它们做完（凭据类是 Google 侧的授权页，开关类是仓库设置）。全部做完约 30 分钟。

| #   | 项目                                                     | 谁做       | 不做会怎样                             |
| --- | -------------------------------------------------------- | ---------- | -------------------------------------- |
| 1.1 | 商店条目（首次上传拿 ID）                                | 人，Google | 没有 Extension ID，链路只能到 GitHub   |
| 1.2 | Google Cloud OAuth 凭据与 refresh token                  | 人，Google | 上传步骤拿不到令牌                     |
| 1.3 | 4 个 GitHub Secrets                                      | 人，GitHub | `release.yml` 跳过商店那一步并留指引   |
| 1.4 | 本机鉴权预检                                             | 人         | 撞 401 时才发现，而那一刻 tag 已经推了 |
| 1.5 | 允许 `googleapis/release-please-action` 与分支保护的影响 | 人，GitHub | 起草链路静默不跑，或被保护规则卡死     |
| 1.6 | 审批环境 `chrome-web-store` 与必需审查员                 | 人，GitHub | **合并即发版**——那正是这条闸门要防的事 |

### 1.1 手动建商店条目并上传首个包

1. `pnpm build:zip` → `.output/cross-origin-proxy-<version>-chrome.zip`。
2. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **New item** → 上传该 zip。
3. 从条目编辑页 URL 取 Extension ID。它是 32 位字母串，且**只含 `a`–`p`**（不含 `q`–`z`），形如 `abcdefghijklmnopqrstuvwxyzabcdef`；复制时别带进空格或换行，它们是不可见的，但会让 Secrets 里的值一直鉴权失败。
4. 按 `CHROMEWEBSTORE.md` §1–§5 填名称/摘要/详细描述/截图/权限理由/数据披露，**先不提审**——自动化从第二个版本开始接管，或者在本机配好凭据后用 §3 的手动补跑把首个版本也交出去。

### 1.2 Google Cloud OAuth 凭据

前置条件：发布/更新扩展要求该 Google 账号**已开启两步验证**（官方硬性要求，未开启时报错信息很隐晦）。

1. [Google Cloud Console](https://console.cloud.google.com/) 新建项目 → 搜索栏输入 **Chrome Web Store API** → 启用。
2. **OAuth 同意屏幕** → 选 **External** → 填应用名、用户支持邮箱、开发者联系邮箱；Scopes 跳过；先把**自己的邮箱加进 Test users**，这样无需审核流程就能用。
3. **凭据 → 创建凭据 → OAuth 客户端 ID**：走官方推荐的 [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) 路径时，应用类型选 **Web 应用**，已获授权的重定向 URI 填 `https://developers.google.com/oauthplayground`；记下 Client ID 与 Client secret。
4. 打开 Playground → 右上角设置选 **Use your own OAuth credentials** 填入上一步两个值 → **Input your own scopes** 填 `https://www.googleapis.com/auth/chromewebstore` → **Authorize APIs** 并以开发者账号授权 → **Exchange authorization code for tokens**，返回体里的 `refresh_token` 就是要存的值（令牌交换端点是 `https://oauth2.googleapis.com/token`）。

> 注意：`redirect_uri=urn:ietf:wg:oauth:2.0:oob` 那条老路径 Google 早已下线，任何还在写 OOB 的教程都换不到 refresh token；客户端类型选「桌面应用」也走不通 Playground（它要求 Web 应用的重定向 URI）。
>
> 更省事的路径：`pnpm exec wxt submit init` 会交互式带你走完 1.1/1.2 的取值过程，并把结果写进 `.env.submit`（已进 `.gitignore`，**绝不能提交**）。
>
> 同意屏幕长期停在 **Testing** 模式时 refresh token 有效期受限（社区普遍报告约 7 天），久未发版后再跑链路会先撞 401 / `invalid_grant`——重新走一遍 §1.2 第 4 步生成即可，Secrets 名字不用改。

### 1.3 落到 GitHub Secrets

仓库 **Settings → Secrets and variables → Actions → New repository secret**，四条：

| Secret                 | 内容                        |
| ---------------------- | --------------------------- |
| `CHROME_EXTENSION_ID`  | §1.1 拿到的条目 ID          |
| `CHROME_CLIENT_ID`     | §1.2 的 OAuth Client ID     |
| `CHROME_CLIENT_SECRET` | §1.2 的 OAuth Client secret |
| `CHROME_REFRESH_TOKEN` | §1.2 换到的 refresh token   |

命名刻意与 `publish-extension` 的环境变量同名（CLI 参数转大写蛇形即环境变量），工作流因此可以直接 `env:` 注入，无需映射。这四个名字**不是本仓库自己定的**：2026-10-09 从依赖产物里 grep 出那份 CLI 实际读的键名，`CHROME_EXTENSION_ID` · `CHROME_CLIENT_ID` · `CHROME_CLIENT_SECRET` · `CHROME_REFRESH_TOKEN`（另带 `CHROME_ZIP` / `CHROME_PUBLISH_TARGET` / `CHROME_SKIP_SUBMIT_REVIEW` / `CHROME_DEPLOY_PERCENTAGE` / `CHROME_REVIEW_EXEMPTION`），§1.4 的 `--dry-run` 读的也是同一份。所以要改就改 GitHub 那一侧，不要把工作流里的名字迁就历史凭据——那会让本机与 CI 两套口径。

**仓库里已经有一套不同名的凭据时，用 UI 的 Rename，不要删了重建。** Secrets 是只写不读的，删掉就得重新去 Google 换一遍值；而 **Rename 保留值、只改名字**。本仓库 2026-10-09 实测正是这个形状：远端四条都在（`CWS_EXTENSION_ID` / `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET`，以及 2026-10-01 建的 `CWS_REFRESH_TOKEN`），**没有一个 `CHROME_*`**，于是 `Detect Chrome Web Store credentials` 判「没配」、`Submit to Chrome Web Store` 被跳过——GitHub Release 照发、整条 run 全绿，商店连续两版没吃到包。这条路径没有 API 可走：GitHub 的 Secrets 只有 `GET` / `PUT` / `DELETE`，**没有 rename 端点**，所以只能在 **Settings → Secrets and variables → Actions → 那一行右侧 `…` → Rename** 逐条点。

改完这样自证（这份名单要写权限才读得到，本机没有 `gh`，直接用 git 存着的凭据）：

```bash
TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | awk -F= '/^password=/{print $2}')"
curl -sS --http1.1 -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/liaolongdong/cross-origin-proxy/actions/secrets \
  | node -e 'let d = "";
process.stdin.on("data", c => d += c).on("end", () => {
  const names = ((JSON.parse(d) || {}).secrets || []).map(s => s.name);
  const need = ["CHROME_EXTENSION_ID", "CHROME_CLIENT_ID", "CHROME_CLIENT_SECRET", "CHROME_REFRESH_TOKEN"];
  console.log("远端有:", names.join(", ") || "（空）");
  console.log("缺:", need.filter(n => !names.includes(n)).join(", ") || "无 ✅");
});'
```

期望 `缺: 无 ✅`。**别把这条命令的结果与 §1.6 那条环境复核混成一件事**：这条查的是名字齐不齐，那条查的是有人点头没有；两条都对，商店那一步才真的会动。也**别看 `decide` 的摘要来判这件事**——它用的是作业令牌（`contents: read`），读这个端点回 403，于是它只会说「这一轮读不到仓库 Secrets 名单」，那是令牌的权限边界，不是凭据缺失（§7 Q17）。

### 1.4 本机验证（不上传、不提审）

```bash
pnpm exec wxt submit --dry-run          # 读 .env.submit，只验鉴权
```

期望输出为鉴权成功、无上传动作。**这一步没通过就不要去打 tag。**

### 1.5 仓库设置与机器人首次运行有关的三处

1. **Settings → Actions → General → 策略类开关**。公开仓库默认允许使用第三方 action，通常**不需要动**。只有当这里被改成「只允许指定 action 与可复用工作流」时，才要把 `googleapis/release-please-action`（以及它内部用到的 `actions/checkout`、`actions/github-script`）加进允许列表——否则起草链路会在起跑时立刻卡在 `Workflow is pending awaiting approval`，而它看起来只是「没生成 PR」。判断依据：Actions 页面那条 run 的状态是 pending / awaiting approval 而不是 success / failed。
2. **main 的分支保护规则（Settings → branches 或 Settings → rules）**。如果 `main` 要求「状态检查必须通过」，要注意一件事：**机器人用 `GITHUB_TOKEN` 开的 PR 不会触发 CI**（就是 §0 末尾那条 GitHub 规则），于是那个 PR 上一个检查都不会报，保护规则永远不放行。三种处置，按你想要的严格程度选：
   - 什么都不改，靠 §0 ② 那条链兜底——`release.yml` 在推 tag 之后会跑完整的 `Verify`（与 CI 同一份清单），不合格就终止，商店包不会出门。**本项目当前的默认**，代价是坏提交会先进 main。
   - 给 release-please 配一个 PAT（`googleapis/release-please-action` 的 `token:` 输入），它开的 PR 就能正常触发 CI。代价是多一份长期有效的凭据要管，而且那份令牌的权限比 `GITHUB_TOKEN` 大。
   - 把保护规则改成不要求检查，或给 `chore: release *` 这一类 PR 让路。

   本轮**没有**给工作流加 PAT：`permissions:` 已在文件里按最小值声明（`contents: write` + `pull-requests: write`，不碰 `secrets.*`），起草链路能拿到的写权限就这么大。

3. **推的顺序：先 tag，后 main**。机器人判断「上一次发布在哪」有两步：先翻 GitHub Releases（本仓库没有），再按 `.release-please-manifest.json` 里的号去找那个 **tag**（`backfillReleasesFromTags`）。远程两个都没有时它认定仓库需要 bootstrap，于是往回一路收提交，上限 `DEFAULT_COMMIT_SEARCH_DEPTH = 500`——本仓库全部历史都不到这个数，结果是第一份发布 PR 把**已经发布过的那一段提交从头再列一遍**，而且因为找不到 `previousTag`，小节标题写成裸的 `## X.Y.Z (日期)`（没有对比链接那一种）。兜底已经写进配置：`release-please-config.json` 的 `"bootstrap-sha"` 钉在接入机器人之前仓库里的最后一个提交上（一个 40 位 sha，值以配置文件为准；`tests/docs-consistency.test.ts` 只校验它是 40 位十六进制——CI 的 checkout 默认 `fetch-depth: 1`，浅克隆里那个 sha 本来就查不到，「解析得到哪个提交」只能在本机核），即使 tag 一个都没落地，它也只收那个提交之后的段落。但**别把兜底当顺序用**：`git push origin vX.Y.Z` 与 `git push origin main` 若写在同一条命令里，GitHub 不保证 tag 先落地，所以先发 tag、再发 main。

### 1.6 建审批环境 `chrome-web-store`（这一项做错会静默）

`store-publish.yml` 的 `confirm` 那一格挂着 `environment: chrome-web-store`，人工批准就发生在那一格。**但 YAML 里写了 `environment:` 与「有人必须先点头」是两件事**——GitHub 的行为是：作业引用一个**不存在**的环境时，会**隐式创建一个同名、且不带任何保护规则的环境**（官方文档原文：_Running a workflow that references an environment that does not exist will create an environment with the referenced name_）。那种裸环境里 `confirm` 直接成功通过，于是「合并即向 Google 提审」当场变成真的，而整条流水线**全绿**——这一格看起来在等审批，实际谁也没等。这是本链路唯一一处**失败不留痕迹**的配置项，所以它自己也被判据守着：`decide` 会去读那个环境的 `protection_rules`，没配上必需审查员就让 `hold` 那一格翻红（读不出形状同样算没配，宁可红一次让人去看）。它同时是 [GITHUB.md](./GITHUB.md) §6.1 那条一次性仓库设置项——步骤与复核命令只写在这里，那份清单只负责把它列进「填完之后用 §7 自检」。

**创建步骤**（只能人在网页上点；做完约 2 分钟）：

1. 仓库 → **Settings** → 左侧 **Environments** → **New environment**。
2. 名称逐字填 `chrome-web-store`（大小写与连字符都要一致——工作流按这个名字等审批，`decide` 也按这个名字查；差一个字符的结果是「永远等不到批准」，而闸门那一格会把它读成 `not-found`，恰好是隐式创建那一种形状）。
3. 在保护规则里勾选 **Required reviewers**（界面措辞随 GitHub 版本会变，认 `Required reviewers` 这个关键词即可）。
4. 点 **Add reviewer**，从下拉里选至少一个 GitHub 账号或 org team（个人仓库就选自己那个账号）。上限 6 个，这里刻意**只放有发布责任的人**。
5. **取消勾选「Allow administrators to bypass configured protection rules」**（界面措辞可能是 _Optionally, disallow bypassing configured protection rules_，官方文档在环境配置那节就是这么写的：「Optionally, disallow bypassing configured protection rules. … Deselect _Allow administrators to bypass configured protection rules_」）。**这一项比勾审查员更容易漏，而且漏掉之后界面完全正常。** 它在 API 里对应 `can_admins_bypass`，本仓库 2026-10-09 建好环境时实测到的默认值是 `true`——意思是**具备管理员权限的人触发的作业不等审查员直接跑**。这个仓库合并进 `main` 的 actor 就是所有者本人，于是「合并即提审」换一种更隐蔽的形态重新成立：环境在、审查员在、`decide` 读到的也是 `configured`，唯独 `confirm` 不挂起。这一条与第 3 步那两件事是同一个问题的两面——`decide` 能查出「环境有没有必需审查员」，查不出「你这一趟到底会不会被等」。
6. 其余开关与三个实测读数（2026-10-09，本仓库那个环境建完之后从 `GET /repos/{owner}/{repo}/environments/chrome-web-store` 读到）：
   - `prevent_self_review` 读到的是 `false`，也就是**触发者可以自己批准自己**。单人维护者需要它保持 `false`——名单里只有所有者一个人，把它改成 `true` 之后没有任何人能批准那条 run，它会一路挂到 30 天自动失败。所以上面第 5 步关掉 bypass 不会把你锁死：你还是要在 Run 页面点那一次 Approve，只是这一次真的在等。
   - 「批准之前会等其它作业跑完」这一条本链路不依赖它，但行为是一致的：`confirm` 只 `needs: [decide, prepare]`，所以那句话在实践里等于「全套校验绿了才轮到点头」。
   - 30 天没人批准则该 run 自动失败——这就是 `release-tag` 里那句「等待期间 tag 可能已被人自己推出去」重查存在的全部理由（审批等待不计入作业超时，上限 30 天）。
   - 「防止同一人**反复**批准」这类语义仍以你界面上看到的为准：**它的字段级行为我没有在本仓库实测过**，不要当成事实引用。
7. **Save environment**。

**配完立刻复核这一条**，把「我点了保存」换成「远端确实有必需审查员、而且没人能绕过它」。仓库是公开的，这条 GET 匿名就读得到（2026-10-09 在本仓库实测：`github-pages` 回 200 但 `protection_rules` 里只有 `branch_policy`；`chrome-web-store` 在这一天先回 404、按本节配完之后回 200），所以不需要 `gh`——本机也没有装：

```bash
curl -sS --http1.1 -o /tmp/env.json -w '%{http_code}' \
  https://api.github.com/repos/liaolongdong/cross-origin-proxy/environments/chrome-web-store \
  | node -e 'let c = "";
process.stdin.on("data", d => c += d).on("end", () => {
  const code = Number(c.trim());
  const j = JSON.parse(require("fs").readFileSync("/tmp/env.json", "utf8"));
  if (code === 404) return console.log("环境不存在（404）：名字打错，或 §1.6 还没做");
  if (code !== 200) return console.log("读不到（HTTP " + code + "）：别按「大概配好了」往下走");
  const p = (j.protection_rules || []).find(r => r.type === "required_reviewers");
  if (!p) return console.log("环境在，但没开必需审查员：闸门等于直接通过");
  const n = (p.reviewers || []).length;
  if (n === 0) return console.log("必需审查员开着、名单是空的：没人能批准，那条 run 会挂到 30 天自动失败");
  console.log("必需审查员：已配，名单 " + n + " 人 → " + p.reviewers.map(r => (r.reviewer || {}).login).join(", "));
  console.log("prevent_self_review: " + p.prevent_self_review + "（false = 触发者可以自己批自己，单人维护者要的就是这个）");
  console.log("can_admins_bypass: " + j.can_admins_bypass + (j.can_admins_bypass ? "  ← 第 5 步还没做：管理员触发的作业不等审批直接跑" : "（已关，闸门对所有人一律生效）"));
});'
```

期望三行依次是 `必需审查员：已配…`、`prevent_self_review: false…`、`can_admins_bypass: false（已关…）`。**第三行才是这一节真正的终点**——前两行对了而第三行是 `true`，界面上看一切都对，`confirm` 却谁也不等。

**名单长度这个数现在可以当事实用了**：2026-10-09 匿名（不带任何凭据）实测这条 GET 原样返回 `reviewers` 数组连同每个人的 `login`，公开仓库上 GitHub 没有把它隐掉。所以 `decide` 用作业令牌读到的名单长度与设置页上看到的应当是同一个数，两处不一致就说明中间有人在改设置。附带一条要接受的代价：**审查员是谁在公开仓库上是公开的**。链路上 `decide` 用的是作业令牌（`contents: read`），它按四种读数分头处置（`not-found` / `no-rule` / `empty-reviewers` / `unknown`），措辞与对应的处置见 §4 与 §7；404 在它眼里就是 `not-found`，也就是这一节开头那幕「隐式创建一个裸环境」的前一刻。**`decide` 查不到、也只能靠这一行命令查的那一面是 `can_admins_bypass`**——它不在 `protection_rules` 数组里，而在环境对象的顶层，所以「环境带着必需审查员且名单非空」这个 `configured` 读数**并不蕴含**你的这一趟会被等：这一条链路里目前没有任何自动化能替你发现它，只能靠本节那一步。

**四个 `CHROME_*` Secrets 必须留在仓库级，不要挪到这个环境上。** 两个理由叠在一起：① `secrets: inherit` 不会把**环境级** Secrets 传进被调用的工作流（`inherit` 带过去的是调用方那一份），而提审那一步正是在被调用的 `release.yml` 里跑的；② 带环境的是 `confirm` 那一格，`publish` 那一格**不带**环境，所以它在运行时根本看不到环境级的东西。挪上去的表现是「审批点了、校验绿了、tag 也打了，商店那一步静默跳过」，而 GitHub Release 照样建好——看起来只差最后一步，实际什么都没提审。

## 2. 日常发版

版本号只写在 `package.json`（`wxt.config.ts` 刻意不再声明 `manifest.version`，WXT 会回落并把它规整成 `X.Y.Z`），`tests/build-verification.test.ts` 守卫两者一致。**写它的是机器人**，而机器人的对账基准是 `.release-please-manifest.json`——这两个文件的号必须相等，`tests/docs-consistency.test.ts` 已经把它变成一条断言。

发版这一步有**两个入口**，结尾都是同一份 `release.yml`，所以「发出去的是什么」不取决于「你从哪一头进去」：

| 入口   | 谁点头           | 点在哪里                                | 什么时候用它                                                     |
| ------ | ---------------- | --------------------------------------- | ---------------------------------------------------------------- |
| 路径 A | 环境的必需审查员 | Run 页面 `confirm` 那一格的 **Approve** | 默认。合进 main 就进闸门，人不需要碰 `git tag`                   |
| 路径 B | 推 tag 的那个人  | 本机 `git push origin vX.Y.Z`           | §1.6 还没配、审批要挂很久而你想现在发、或闸门那条 run 坏了要绕开 |

#### 前置：两条路径都要做的两件事

```bash
# 1) 正常开发、正常合并。提交类型决定要不要发版、发哪一级：
#      feat → minor      fix / perf / refactor / revert → patch      BREAKING CHANGE → major
#    docs / test / chore / ci / build / style 既不进 CHANGELOG 也不参与 bump：
#    只有这类提交的合并不会挤出一个空版本，也就不需要发布 PR。
git push origin feature-dev          # 照常开 PR、跑 CI、合进 main

# 2) 机器人开的发布 PR（标题 `chore: release X.Y.Z`）里，人做三件事：
#    a. 看版本级别对不对（它只看提交类型，不懂你的业务风险）；不对就在 PR 里改 package.json
#       与 .release-please-manifest.json 两个号，改一处必改另一处。
#    b. 把 CHANGELOG.md 顶部「待发布（Unreleased，人工草稿区）」那段中英长文并进它新开的
#       `## [X.Y.Z]` 小节，然后清空草稿区——GitHub Release 与商店的更新说明就是这个小节，
#       只有一行行提交标题是不够的。
#    c. 合并。合并**不会**发布任何东西：机器人不建 tag、不建 Release。
```

第 2 步 b 那一句在两条路径上都成立，而且它是这条链路里**唯一一处机器写不出来的东西**：`decide` 摘要与 GitHub Release 都从 `CHANGELOG.md` 那一节现切（判据收在 `.github/actions/release-notes`，两处共用同一份），所以那一节里只有一行行提交标题时，审批人看到的就是那一行行提交标题。

#### 路径 A：合进 main，然后在 Run 页面点批准

1. 合并机器人的发布 PR。这一刻 `store-publish.yml` 自动起跑，**什么 refs 都还没动**。
2. **Actions** → 顶部工作流列表选 **Store Publish** → 点开最新那条 run。
3. 先看 `decide` 那一格的 **Summary**（run 页面底部，或点进 `Decide` 作业再看 Job Summary）。那一屏写的是四件事：
   - 版本号取自 `package.json`，对应标签 `vX.Y.Z`，以及**它在远端有没有**（已有 → 这一版已经发过，后面全部跳过，这是正常结局）；
   - 审批闸门（环境 `chrome-web-store`）配没配、几名必需审查员；
   - 四个商店凭据在不在仓库级（**只是线索**：缺了不影响判定，发布那一格自己会说，见 §5）；
   - `CHANGELOG.md` 那一节切出几行——写着 ⚠️ 就是没切到，Release 说明会回落成流水账、商店的「更新说明」那一栏是空的。
4. `prepare` 那一格跑完整套校验并打包（与 CI 同一份清单）。**它红了就没有 Approval 按钮可点**——`confirm` 是 `needs: [decide, prepare]`，前置失败时它根本不起跑，这正是「校验排在点头之前」的另一面：审批人不会面对一个「批准了才看到构建是红的」的处境。绿了再去看它末尾 `Report the Package` 那一步输出的 zip 名与 sha256，以及 Artifact `store-publish-zip`。
   > 那句 sha256 说的是「这一棵提交树的一次成功构建」，**不是**商店最终收到的那份字节——批准之后 `publish` 会重新构建一遍，而 zip 不逐字节可复现（构建时间戳与文件顺序都会变）。它对审批人的用处是「产物确实存在、名字与版本对得上」。
5. `confirm` 那一格此时是 **Waiting**，run 页面顶部会出现一个黄色的 **Review jobs**。点开它，勾选 `chrome-web-store`，可以留一句注释（这一句会进 run 的历史，是「为什么发这一版」最省事的落款处），然后按 **Approve and comment**。
   - 批准**不会**立刻发布：批准只是放行后面三格。三格依次是 `release-tag`（把 `vX.Y.Z` 落到远端）→ `publish`（调用 `release.yml`：建 Release、换标签、传商店、提审）。
   - 想**拒绝**这一版就别点 Approve——挂着的审批不是发布，最长 30 天后那条 run 自动失败，而它拦不住下一次合并。真的要把这一版**永久**撤回：把 `package.json` 与 `.release-please-manifest.json` 一起改回上一个已发布的号（改一处必改另一处，见 §2.3 那条纪律），并把 `## [x.y.z]` 那一节的内容搬回 CHANGELOG 顶部的「待发布」草稿区——不然那一段既发不出去、也没人记得它写过什么。这一笔改号本身是一次 main 上的 push，所以它会再起跑一次 `store-publish.yml`，而 `decide` 对新号（也就是刚发过的那个）判「已经发过」，安静跳过。
6. `hold` 那一格如果是红的，说明闸门判「现在不该发」（原因写在那一屏）：绝大多数是 §1.6 没配或读不到，处置见 §4。
7. 跑完之后仍然只有人能做的两件事照旧：**§2.1**（商店「更新说明」要人粘）与 **§2.2**（tag 落地后要翻的那批句子）。

**这条路上谁动了 refs**：只有 `release-tag` 那一格，而且它排在批准之后。它打的是**轻量 tag**，指向触发这次 run 的那个提交（也就是合并后的 main 顶端），用的 API 是 `POST /repos/…/git/refs` 而不是 `git tag` + `git push`——checkout 默认是浅克隆，从浅仓库推 tag 会被 git 拒绝。它也**不会**再触发一次 `release.yml`（作业令牌产生的事件不起跑新工作流，见 §0），发布是 `publish` 那一格显式调用 `release.yml` 完成的。

**审批期间又合了一笔 main 会怎样**：`concurrency` 刻意不 `cancel-in-progress`，所以挂着的那条不会被取消；新的那一条排队等这一条走完。等你批准后，`release-tag` 打的仍然是**发起批准时那一次 run 的那个提交**——后来合进 main 的内容不会跟着这一版出去，它们进下一个版本号。这一点值得在批准前看一眼 run 的提交号。

#### 路径 B：本机打 tag、推 tag

绕开闸门直接走 `release.yml`（`on: push: tags`）。它是 §1.6 还没配时的可用路径，也是紧急修复时最快的一条。

```bash
# 3) 合并之后，本机把那份 main 拉下来，走发布前的门禁（等价于 CI 的 Verify）
git pull --ff-only origin main
pnpm lint && pnpm typecheck && pnpm typecheck:vue && pnpm lint:style && pnpm test && pnpm build
pnpm exec prettier --check CHANGELOG.md package.json   # 只查改动文件

# 4) 打 tag，然后**分两条命令**推：先 tag、后 main。把两个 ref 写进同一条 push（先 main 后 tag
#    那种顺序）时 GitHub 不保证谁先落地，而顺序错了机器人会以为仓库需要 bootstrap（见 §1.5 第 3 条）。
git tag vX.Y.Z          # X.Y.Z 必须等于 package.json 里的号，release.yml 会拒不一致
git push origin vX.Y.Z
git push origin main    # 本地分支不叫 main 时写 `git push origin <你的分支>:main`

# 5) Run 页面绿了之后，还有两件事只有人能做的（§2.1、§2.2）
```

**推完 tag，闸门那条链路会自己认账**：下一次 main 上有 push 时 `decide` 读到 `vX.Y.Z` 已存在，直接判「这一版已经发过，本次合并不重复提审」，后面四格全部跳过。所以路径 B 不会与路径 A 撞车，`release-tag` 那一格也专门在打之前重查过一次（防止两个动作同时进行中）。

**跑的那份 workflow 来自哪个 ref**：路径 B 用的是 tag 所指那个提交里的 `.github/workflows/release.yml`——所以如果你刚刚在 main 上改了发布链路、而 tag 打在一个更早的提交上，这一次跑的还是旧文件（改动画像常在这里丢）。要么把 tag 打到包含那些改动的那个提交（未推送过的 tag 用 `git tag -f vX.Y.Z <sha>` 挪位即可，远程不需要重写），要么接受这一次跑旧逻辑、下一次才生效。路径 A 不存在这个岔子：它跑的一直是触发它的那个 ref（main）上的文件，包括被调用的 `release.yml` 与两个复合动作。

**第三条路是 §3.2 的手动补跑**：它跑的是你选的那个 ref（默认 main）上的 `release.yml`，而 `tag` 输入只决定 checkout 哪个提交的内容。2026-09-30 那次就是这么救回来的——它为什么成立、以及复合动作取自哪个 ref，见 §3.2 末。

**小节标题的两种写法都发得出去**：`release.yml` 从 `CHANGELOG.md` 切 Release 说明时，认机器人带对比链接的 `## [X.Y.Z](…/compare/vA...vB) (日期)`，也认它拿不到上一个 tag 时写的裸 `## X.Y.Z (日期)`——所以 §2 第 4 步推 tag 前不必先确认标题长什么样。切不到小节时会退回 GitHub 自动生成的流水账并在日志里留一条 warning，不会发一个空说明的 Release。

**推完 tag 之后机器人那本账由 `release.yml` 替它换**。release-please 给发布 PR 打的标签是 `autorelease: pending`，通常由它自己「建 Release + 打 tag」那一步换成 `autorelease: tagged`；这一仓库刻意让它 `skip-github-release`，那一换就永远不发生，而它下次起草时只要看到任何**已合并、仍带 pending** 的 PR 就直接放弃开新 PR（日志里那句是 `There are untagged, merged release PRs outstanding - aborting`，而那条 run 全绿）。所以 `release.yml` 在 GitHub Release 建成之后紧跟着一步 `Clear release-please pending label`，把标题写着这个版本号的那一个 PR 的标签换掉。**它失败不会翻发布**，只会在 Job Summary 里留一段指引——看到那段就去 GitHub 上手工把标签改成 `autorelease: tagged`，否则下一次发版的 PR 不会来。

**走过 §2.3 手工 bump，上面那一步会扫不到东西，得人工换**。清扫按**标题里写着本版本号**来筛已合并的发布 PR，而手工 bump 意味着发出去的号不是机器人 PR 标题上那一个（2026-09-30 那一次：PR #1 的标题写的是 `chore(main): release 1.3.1`，推出去的 tag 比它高一级）。日志会老实说一句「没有待清理的 release-please PR（可能这一版是 §2.3 的手工 bump）」然后正常退出——**这不是失败**，但那个 PR 仍带 `pending`，机器人下次起草时看到它就当场放弃。所以手工发版后要自己去看一眼有没有已合并却仍带 `pending` 的发布 PR，人工换成 `tagged`（症状与处置见 §4「机器人不再开新的发布 PR」那一行）。

**手工换那一格有两个静默假成功的坑**（2026-10-07 踩在第一个上）。① `POST /issues/{n}/labels` 是**追加**而不是覆盖：用它提交 `["autorelease: tagged"]`，HTTP 回 200，GET 回来却是 `pending | tagged` 两个并存，而 release-please 的判据是「有没有**已合并仍带 `pending`** 的发布 PR」——卡点原样还在，界面却看着像已经改好了。覆盖整个标签集要用 `PUT`，且换完必须 GET 一次确认那个数组里只剩 `tagged`。② 换完不会立刻有下文：`release-please.yml` 只有 `push: branches: [main]` 一个触发器，没配 `workflow_dispatch`，所以解开卡点之后还得再推一笔 main 它才会重新起草——这一笔提交本身就是为了这件事存在的。

**`pnpm test` 不再要求你去翻「复述当前版本号」的文档**：那三处（`docs/llms-full.txt` 两句与 `.github/ISSUE_TEMPLATE/bug_report.yml` 的示例版本）已经改成不带号的指针，指向 CHANGELOG 的最新小节。改带号的守卫反而会把机器人自己的发布 PR 判红——它在同一个 PR 里抬 `package.json`，却写不了散文。取而代之的是一条按文件清单放的断言：**除「写号是它的职责」的那几处**（`package.json`、`.release-please-manifest.json`、`CHANGELOG.md`、`CHROMEWEBSTORE.md`、`docs/**` 说的商店在装版本、HAR 规范字段、锁文件）**以外，任何被跟踪的文本文件都不许复述开发中的版本号**；新地方想写号，要么改措辞成指针，要么把那个文件连理由一起加进清单。

落地页页脚、schema 的 `softwareVersion` 与 `CHROMEWEBSTORE.md` §8 表里的历史行说的是**商店在装的已发布版本**，不在 bump 范围内——它们要到 tag 真的推出去那一刻才按 §2.2 翻。

可见文案或能力有变化时，按 `AGENTS.md` 的文档矩阵同步 `README.md`（中文主文档）/ `README.en.md` / `locales/` / `CHROMEWEBSTORE.md` / `docs/`（中英必须同事实）。商店 `name` ≤ 75、`description` ≤ 132 字符由 `pnpm test` 守卫。

### 2.1 商店的「更新说明」要人粘

`wxt submit` 没有对应参数，包上传时那一栏是空的（GitHub Release 的说明反倒是自动的，从 `CHANGELOG.md` 切）。所以 Run 页面显示提审成功后，去 Dashboard 该条目 → 更新信息 → 把 [`CHROMEWEBSTORE.md` §8.1](./CHROMEWEBSTORE.md) 的中英文两块分别粘进对应语言列表，一分钟内可完成，漏了不报错、只是这一版对用户没有说明。**路径 A 与路径 B 在这里完全一样**——点头的位置不同，粘文字的位置不变。

### 2.2 tag 推出去之后那批「此刻为真、推完就为假」的句子

落地页页脚版本与日期、`llms*.txt` 里关于 tag 的句子、README「方式 B」那条**安装途径**的 Releases 提示（与本文 §2 的发版路径 B 无关）、`CHROMEWEBSTORE.md` §8 的提审状态——清单只有一个出口：[`CHROMEWEBSTORE.md` §12](./CHROMEWEBSTORE.md)。它现在是一张**翻牌记录**：八行已经全部翻过（2026-10-01 那一次），最后一列写着每处当前的措辞；其中第 4、5、7、8 行说的是**商店在装的版本**，所以商店每真正吃到一个新包就要回来再翻一次，而行 1、2、3、6 讲的是 tag 的存在性，翻了就不再回来。翻完跑 `pnpm test` 与本次改动文件的 `pnpm exec prettier --check`。

### 2.3 不用机器人的那条路（紧急修复、或机器人没跑）

**这一节说的是「谁写版本号」，不是「谁点头」**——它和 §2 路径 B（谁点头）正交：手工把号写进 `package.json` 之后，你照样可以走路径 A 让人审批，也可以直接推 tag。手工 bump 依然完全有效，`release.yml` 不在乎号是谁写的：

```bash
npm version patch --no-git-tag-version          # 或 minor / major
# 手工在 CHANGELOG.md 顶部补 `## [X.Y.Z] - YYYY-MM-DD`（写法必须是行首 `## [数字`，
# 它是机器人下一次找插入点的锚；写成 `## [Unreleased]` 那种占位标题会把整份历史挪位）
```

**走完这条路必须顺手把 `.release-please-manifest.json` 改成同一个号**，否则机器人的基准落后一级，下一次它算出来的就是刚刚发过的那个版本（`tests/docs-consistency.test.ts` 会当场红，这是那条评论存在的原因）。

## 3. 手动补跑 / 灰度 / 只传草稿

补跑有两个入口，选哪个取决于**你想不想让这一次也走审批**：

### 3.1 走闸门：Actions → **Store Publish** → **Run workflow**

把「读事实 → 校验 → 点头 → 打 tag → 发布」整条再走一遍，不需要人再推一次 main。它比下面 §3.2 多三件事：审批留痕（谁点的、那句话）、与 CI 同一份 `verify` 在点头**之前**跑完、以及 `decide` 那次重查（远端已有同名 tag 时直接判「已经发过」）。适合「链路坏了重跑一次」「§1.6 刚配好想验一遍」「这一次仍然该有人点头」。

它没有输入参数：版本号和 tag 都取自你选的那个 ref（默认 main）的 `package.json`，也就是说**它发的是当前 main 上写着的号**。要发一个旧号，用 §3.2。

### 3.2 直连发布：Actions → **Release** → **Run workflow**

| 输入             | 用途                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `tag`            | 已存在的标签，如 `v1.0.0`——用于 Secrets 补齐后把首个版本交出去          |
| `publish-target` | `default` 为正式分组；`trustedTesters` 只发给测试者，先验证再走正式     |
| `skip-review`    | 勾上 = 只上传 zip 成草稿，不提交审核，去 Dashboard 人工核对后再手动提审 |

Release 创建步骤是幂等的：同一个 tag 重跑会更新说明并 `--clobber` 覆盖资产，不会报"已存在"。

**它跑的是哪个文件**：`workflow_dispatch` 用的是你选的那个分支（默认 main）上的那份 `release.yml`，而 `tag` 输入只决定 checkout 哪个提交的内容。2026-09-30 那次就是这么救回来的——tag 指的 `6798385` 里 `release.yml` 还缺 `GH_TOKEN`（推 tag 那一次停在 Publish），从 main 补跑用的已经是修好的文件，Release 与 zip 照样按 tag 那个提交的内容产出，refs 一个都没动。这也是 §3「用 main 上修好的链路补跑旧 tag」能成立的原因：复合动作（`.github/actions/*`）取自**工作流所在的那个 ref**，不是 checkout 出来的那棵树。

**一次性验收这条链路（建议 §1.6 配完就做一次）**：这一版还没真正要发，所以先让它只走到草稿。两种做法，从轻到重：

```bash
# A. 本机只验鉴权（不上传、不提审）——§1.4 那条命令，最便宜
pnpm exec wxt submit --dry-run

# B. 用 §3.2 起跑 Release，publish-target 选 trustedTesters、勾上 skip-review
#    → 商店 Dashboard 里该条目会多出一份只发给测试者的草稿包，且不动 refs
```

`trustedTesters` 需要在商店 Dashboard 的 **Item dashboard → 该条目 → 测试者**里先把那些 Google 账号列进测试计划（个人测试者填邮箱即可），否则分组里是空的、包传上去也没有人能装到。这一条**只在本机/后台界面核过格式，商店后台对「自动化上传到 trustedTesters」是否要求该分组先存在，我没有实测**——第一次跑这一步时请盯着 Run 日志里的 `Submit to Chrome Web Store` 那一步输出，别只看它绿不绿。

**Secrets 还没配、而这一次就想把包送进去**：本机直传与链路做的是同一件事（都是 `wxt submit`），凭据读 `.env.submit`（§1.2 末尾那句 `wxt submit init` 生成的那份），不需要动仓库设置。

```bash
pnpm build:zip
pnpm exec wxt submit --dry-run    # 先验鉴权——别把审核配额浪费在撞 401 的那一刻
pnpm exec wxt submit --chrome-zip .output/<包名>-<版本>-chrome.zip --chrome-publish-target default
```

它与上面那条链路唯一的差别是**它不动 refs**：GitHub Release 那一侧要么已经存在（正是「tag 早就推了、商店没吃到包」这种状态），要么得另外补一次 `git tag` + 推 tag。两条路都走得通，代价是商店的号与 GitHub 的号从此可以不一致，§5 那套措辞纪律（落地页页脚、`softwareVersion`、§8 状态列说的都是**商店在装**那个号）必须跟着走。另外两个档位：`--chrome-skip-submit-review` 只上传不提审，去 Dashboard 人工核对后再手动提交；`--chrome-review-exemption` 走加急审核，配额在 Google 侧、数量有限，留给真正的紧急修复。

**商店落后好几个版本时，只交最新那一份**。商店吃的是「当前这个包 + 更新说明」，不是将中间每个版本号补齐；依次上传只会重复消耗审核配额，还把已经修好的东西退回商店一次。

**灰度**：`wxt submit` 支持 `--chrome-deploy-percentage`（1–100），本工作流默认全量。需要灰度时把该 flag 加进 `Submit to Chrome Web Store` 步骤，或本机直接跑：

```bash
pnpm exec wxt submit --chrome-zip .output/cross-origin-proxy-1.0.1-chrome.zip --chrome-deploy-percentage 25
```

**回滚**：Chrome 商店不提供"撤回已发布版本"的按钮式操作，只能在 Dashboard 上传上一个版本的 zip 作为新版本提交（需重新走审核）。所以发布前 `Verify` 与 §1.4 的鉴权预检不要跳过。

## 4. 失败排查

| 现象                                                                 | 原因与处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 合了代码但机器人没开发布 PR                                          | 大概率正常：这一批只有 `docs` / `chore` / `test` / `ci` / `build` / `style` 类型，它们不进 CHANGELOG 也不 bump。否则看那条 run 是不是 pending（§1.5 第 1 条）或报错                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 机器人的发布 PR 上一个检查都没有                                     | `GITHUB_TOKEN` 开的 PR 不触发 CI（§1.5 第 2 条），不是链路坏了                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 机器人把版本号抬错级别                                               | 它只读提交类型，不懂业务风险：在 PR 里同时改 `package.json` 与 `.release-please-manifest.json`，或用 `Release-As: X.Y.Z` 脚注强制                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 机器人的 PR 里 CHANGELOG 小节只有一行行提交标题                      | 正常，那是它写得出来的全部；中英长文由人在合并前并进那一节（§2 第 2 步 b）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 下一次机器人开出的号等于刚发过的那个号                               | 手工 bump（§2.3）后没同步 `.release-please-manifest.json`，两个号脱钩了                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CHANGELOG 里已有 `## [X.Y.Z]`，远端却没有那个 tag                    | bump 的 PR 合了、tag 没推（或走过 §3 的本机直传——那条链路压根不碰 git tag）。**先做的那一步是换标签**：那一个已合并的发布 PR 仍带 `autorelease: pending`，而机器人下次起草时只要看见这种 PR 就当场放弃开新 PR（判据见 §2 末，症状是下一行那一条），所以「等它算号」今天等不来任何东西——去 PR 页面手工把它换成 `autorelease: tagged`。换完才轮到第二件事：机器人仍以 `.release-please-manifest.json` 为准算号，**不会重发那个号，内容并进下一个号**，所以不丢东西，代价只是那一节的 compare 链接指向不存在的 tag。2026-10-03 实测正是这个形状：商店在装 1.3.0、GitHub Release 最新是 `v1.4.0`，`package.json` 与 `.release-please-manifest.json` 已比远端最新的 tag 高一级（那个号本地远端都没有 tag），而那个已合并的发布 PR 当时仍带 pending。别把另一件事混进这一行：`v1.4.0` 那次 run 里 `Submit to Chrome Web Store` 是 skipped（四个 `CHROME_*` secrets 未配），那是 tag **已经**推出去、只差商店那一步，按 §3 补跑即可。处置：**不要补推一个追认性质的旧 tag**（§6 第一条同理），把落后那几个小节的要点并进这一次要发的那个号，商店只交最新那一份包（§3） |
| 机器人不再开新的发布 PR，可那条 run 全绿                             | 有一个**已合并却仍带 `autorelease: pending`** 的发布 PR 卡着它（`There are untagged, merged release PRs outstanding`）。走过 §2.3 手工 bump 时 `release.yml` 的按标题清扫会扫不到它（见 §2），去 PR 页面把标签手工换成 `autorelease: tagged`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `标签 v1.0.1 与 package.json 的 1.0.0 不一致`                        | 先 `npm version` 再打 tag，别改 tag 迁就文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Release 说明变成自动生成的流水账                                     | `CHANGELOG.md` 里那一节的小节号与版本对不上；补上后手动补跑即可覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Run 秒红、**一个作业都没有**、日志 404                               | 工作流文件没过 GitHub 的 **schema**（不是 YAML 语法，本机 `pnpm test` 查不出）。2026-10-09 实测的那一次是 `on.workflow_call.inputs.publish-target` 写成 `type: choice`——`choice` 只有 `workflow_dispatch` 支持，被调用的工作流只认 `boolean`/`number`/`string`，于是 `release.yml` 与调用它的 `store-publish.yml` 一起零作业红。判据与改法见 §7 Q16                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `gh: ... set the GH_TOKEN environment variable`                      | 用 `gh` 的那一步没声明 `GH_TOKEN`。GitHub **不把 `GITHUB_TOKEN` 注入 `run` 步骤**，而 `gh` 在 Actions 里只认前者；`release.yml` 里 Publish 与清标签两个步骤各写一份，缺哪个红哪个（首次于 2026-09-30 真发生过，症状是 Release 没建成、下游全 skip）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `confirm` 一格秒过、谁也没被等，后面 `release-tag` 与 `publish` 照跑 | 三种形状分开查。那一格是 **skipped** 就是正常（`decide` 判这个号的 tag 已在远端，Q18 第 1 条）；是 **success** 而 `hold` 同时翻红，说明环境是隐式建出来的裸环境，按 §1.6 重来；绿的、`hold` 也没红，就是 **`can_admins_bypass` 还开着**——管理员触发的作业不进等待队列，`decide` 读的是 `protection_rules` 数组而这个字段在环境对象顶层，全链路只有 §1.6 末那条命令打印得出来（Q18）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Job Summary 显示"Chrome Web Store 发布已跳过"                        | Secrets 缺失，按 §1.3 补齐后用 §3 补跑。**先看摘要里点名的那四个名字，再去查「配没配」**——本仓库 2026-10-09 撞的是第二种形状：四条凭据一条都不缺地躺在仓库级，但名字是历史遗留的 `CWS_*`，而链路读 `CHROME_*`，于是 `Detect` 判「没配」、`Submit` 被跳过，连错都不报（同一条 run 全绿，商店连续两版没吃到包）。处置是逐条 **Rename**（§1.3 末：改名保留值，GitHub 没有 rename Secrets 的 API，只能网页上点），**不是**再建一份同值的 `CHROME_*`。自证：`curl` 带凭据读 `GET /repos/{owner}/{repo}/actions/secrets`，看那份名单里四个名字齐不齐——注意这件事只有带权限的令牌做得到，`decide` 自己那颗 `contents: read` 读它回 403（Q17）                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `invalid_grant` / 401                                                | refresh token 过期或 OAuth consent screen 还在 Testing 模式（改成 Published 或加测试用户）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `The requested profile could not be found`                           | `CHROME_EXTENSION_ID` 拼错，或该条目不属于这个开发者账号                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 上传成功但商店里版本没变                                             | 只上传未提审：确认 `skip-review` 是否为 true，去 Dashboard 手动提交                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Pages not enabled`（另一条 deploy-pages 链路）                      | `GITHUB.md` §5 的 Source 开关没切到 GitHub Actions，与商店发布无关                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `hold` 那一格红，摘要写「审批闸门没配好」                            | 闸门按设计拦人——**这一条红是好事**，它替代的是「合并即发版」那种静默。四种读数分开处置：① 环境**不存在**（`not-found`）通常是隐式创建了裸环境后你把它删了、或 §1.6 的名字打错了；② 环境在但**没勾必需审查员**（`no-rule`）；③ 勾了但**审查员为空**（`empty-reviewers`）；④ 读不出可信答复（`unknown`，多为令牌作用域或 GitHub API 抖动）。①②③ 回到 §1.6 补齐并用那条复核命令确认；④ 直接重跑一次，仍然 `unknown` 就按 §1.6 那条 curl 看**匿名**读不读得到这个环境（本仓库是公开仓库，匿名 200 已在 2026-10-09 实测过；匿名读不到而 CI 里读得到，就是令牌作用域问题），403 在匿名读下多半是限流。**不要**为了让这条变绿而删掉 `confirm` 的 `if` 或去掉环境——那正是它要拦的那件事                                                                                                                                                                                                                                                                                                                                                                                 |
| `decide` 摘要写「读不到 …/git/ref/tags/… 的可信答复」                | 事实不明时链路**不会**自动打 tag 或提审（重复提审不可撤回、且耗 Google 的审核配额）。先重跑一次 `Store Publish`（§3.1）；仍读不到就按上一条的 ④ 处置。别用「本机推 tag」把它绕过去——那等于在不知道发没发过的情况下赌一把，然后 §2 路径 B 会真把这一版再送进商店一次                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `confirm` 一直 Waiting，而你想批也批不了                             | 审查员名单里没有你（或名单是一个你不在里面的 team）。个人仓库就按 §1.6 第 4 步把自己的账号加进去；改名单**不影响已经挂着的这次等待**，它会用新名单重新判定，不用重跑 run。30 天没人批准则该 run 自动失败，这期间 refs 一个都没动——这条 run 红掉不等于这一版发不出去，重跑 §3.1 即可                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 批准后 `release-tag` 红，日志写「在等待期间已被打出」                | 不是故障：审批挂着的期间有人走了 §2 路径 B 或 §3.2 补跑，同一个号已经落地。这一格**就该**红——它防的是「把已经发布的东西再向 Google 提审一遍」。去做的事是核对：GitHub Release 在不在、商店有没有真的吃到包（`curl -s https://img.shields.io/chrome-web-store/v/<id>.json` 现量，见 §5 末那段「两个号」的纪律）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 批准之后 GitHub Release 建好了、商店却静默跳过                       | 两个原因之一：四个 `CHROME_*` 没配全（§1.3 / §5），或者**它们被挪到了环境级**（§1.6 末——`publish` 那一格不带环境，`secrets: inherit` 也不带环境级的东西）。前者补 Secrets 后按 §3.2 用那个 tag 补跑；后者把四个值挪回仓库级再补跑，环境级那份删掉                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 同一棵 main 上 Store Publish 跑了两次，第二次四格全 skip             | 正常结局：第一次已经把 `vX.Y.Z` 打出去了，第二次 `decide` 读到同名 tag 存在，判「这一版已经发过，本次合并不重复提审」。这条链路的幂等就建在「tag 在不在远端」这一件事上                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 一次版本 bump 的合并把全套校验跑了两遍                               | 刻意：CI 一遍、`prepare` 一遍，为的是让审批人在点头前看见绿勾（§0）。普通 PR 不付这个钱——它们的号对应的 tag 早已存在，`decide` 直接判已发过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 审批页上的 `prepare` Artifact 的 sha256 与商店拿到的对不上           | 对不上是预期的：批准后 `publish` 会重新构建，而 zip 不逐字节可复现。Artifact 证明的是「这棵提交树有一次成功构建、产物存在且命名对得上」，不是「商店收到的就是这几个字节」（§2 路径 A 第 4 步那段引言）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 5. 没有配 Secrets 时仓库会怎样

发版链路照常走完校验、构建与 GitHub Release，只是商店那一步被跳过并在 Run 页面留一段指引。**「预构建 zip」从第一支远端 tag 起就永久可下载**，`README.md`、`docs/` 落地页与 `llms.txt` 指向 Releases 的入口也都因此成立。**在这种状态下，商店里装的还是上一个成功提审的版本**——落地页页脚、schema 的 `softwareVersion` 与 `CHROMEWEBSTORE.md` §8 说的是那个号，不是 `package.json` 里这个。

于是 §2.2 那份清单要**拆成两次翻**，不要合并：讲 tag 存在性的那几句（`llms*.txt` 的「尚未发布 tag」、README 方式 B 的提示）随推 tag 就翻；讲**商店在装版本**的那几处（落地页页脚与 `softwareVersion`、`llms*.txt` 的核对行、§8 的状态列、`GITHUB.md` 的 `CWS` 徽章）只随商店真的吃到新包才翻，而且翻成的是商店那个号——按 `curl -s https://img.shields.io/chrome-web-store/v/dednngakllblfilbndkaggphohmpgcbg.json` 现量，不是 `package.json` 里那个（2026-10-01 写这一句时两边差一级：GitHub 已经发出去的号比商店在装的高一级）。把它们一次翻成 `package.json` 里那个号，就是把「下载 GitHub 的 zip」与「从商店安装」这两条不同的路径写成同一条。

## 6. 不要做的事

- 不把 `.env.submit` 或任何 token 提交进仓库（`.gitignore` 已宽泛排除 `.env*`，别用 `git add -f` 绕过）。
- 不补推本机遗留的旧 tag。仓库里现在躺着一个**从未推送**的 `v1.3.0`（轻量 tag，指向 `72ba96a`，那一包是人工上传进商店的、从没走过后端链路）：推上去它会凭空长出一个 GitHub Release，而商店里那个号早已存在，两边对不上。发版前用 `git tag -n99 -l` 与 `curl -s https://api.github.com/repos/<owner>/<repo>/tags` 各列一遍，只对远端那份动手。
- 不在 `wxt.config.ts` 里重新加回 `manifest.version`：双写必然漂移，而漂移的代价是一个版本号错乱的包进商店。
- 不让机器人自己发版：`release-please-config.json` 的 `skip-github-release` 不是冗余配置，删掉它就得到一个「合 PR 即向 Google 提审」的链路，而且它用 `GITHUB_TOKEN` 打的 tag 根本触发不了 `release.yml`（§0 末尾）——两件事叠加的结果是版本号涨了、GitHub Release 与商店包却没有，看起来像成功。
- 不在机器人的发布 PR 里顺手翻 §2.2 那批文档：那一句句要在 tag 真的推出去之后才为真，而机器人的 PR 可能因审查改期合并。
- 不把 CHANGELOG 的草稿区标题改回 `## [Unreleased]`：方括号 + 数字形状是 release-please 找插入点的锚，占位标题写着 `Unreleased` 却长着锚的脸，会把整份历史挪到它下面。
- 不为了让发布变绿而跳过 `Verify`、降低断言或删测试。
- 不手改 GitHub Release 的资产名去凑商店期望（包名由 `wxt zip` 按 `<package-name>-<version>-<browser>.zip` 生成，zip 里的版本号是 WXT 削去预发布后缀后的 `manifest.version`）。
- 不用 `npm version prerelease`：WXT 会把 `X.Y.Z-beta.0` 削成 `X.Y.Z` 写进 manifest，与商店里同号的正式版撞车，商店会直接拒收更新。发版只用 `major` / `minor` / `patch`。
- 不擅自给 Firefox/Edge 配凭据：本项目声明不支持 Firefox（`declarativeNetRequest` 差异），要扩大目标平台先与产品决策对齐。
- 不删 `confirm` 那一格的 `environment:` 或它的 `approval-state == 'configured'` 条件，也不把这三个条件从 `release-tag` 与 `publish` 上挪走。删掉的不是「一次点击」，而是**这道闸门本身**：`decide` 与 `hold` 还在，却再没有哪一格会停下来等人。`tests/docs-consistency.test.ts` 按作业名逐格查这三处，就是为了让「顺手简化条件」当场红，而不是在下一次发版时才被发现。
- 不把四个 `CHROME_*` Secrets 挪到环境级（理由与表现见 §1.6 末）。
- 不让那四条凭据顶着别的名字留在仓库里（比如历史遗留的 `CWS_*`）。`Detect` 只按名字查，名字不对与压根没配在链路上是同一个形状：作业跳过、全绿、商店少收一包，而这份仓库已经连着少了两包（§1.3 与 Q7）。改名要在网页上用 **Rename**——改名保留值，而 Secrets 是只写不读的，删了重建就得重新去 Google Cloud 抄一遍。
- 不留着那条「Allow administrators to bypass configured protection rules」的默认勾选。它和环境不存在、必需审查员没勾是**第三种**静默失效：前两种 `decide` 至少还能靠 `protection_rules` 抓到，这一条住在地对象顶层（`can_admins_bypass`），`decide` 看不见它。单人维护的仓库里它等于把闸门对唯一那位审查员摘掉——你点的 Approve 不再是「被拦下来之后放行」，而是一次都没被拦（Q18）。

## 7. 常见问题

**Q1 · 我合了 main，为什么什么都没发出去？**
三种情况，看 `Store Publish` 那条 run 的 `decide` 摘要就能分清：① 摘要说「`vX.Y.Z` 已在远端——这一版已经发过」→ **正常结局**，这一批合并没有新号（或号已被路径 B / 补跑接管），后面四格全部跳过；② `hold` 那一格红 → 闸门没配好或事实读不到，按 §4 那两行处置；③ `confirm` 停在 Waiting → 在等人批准，去 run 顶部的 **Review jobs**。

**Q2 · 审批和「本机推 tag」到底选哪个？**
默认选审批（路径 A）：它多了三样东西——批准留痕、点头之前跑完整套 `verify`、以及打 tag 前那次重查。路径 B 快，但它绕过的恰恰是这三样，所以留给紧急情况与「§1.6 还没配」那一段。两条路最后跑的都是同一份 `release.yml`，发出去的东西没有区别。

**Q3 · 能不能让它别等人，合并就自动发？**
技术上能：删掉 `confirm` 的 `environment:` 与三处 `approval-state == 'configured'` 就通了。不该做的理由写在 §0 与 §6 最后三条——向 Google 提审不可撤回、配额有限，而且商店审核时长不受本仓库控制，一次坏合并的退路是「再上传一个更高版本」（§3 末），不是一键回滚。真要无人值守，那是一次产品决策，不是 YAML 精简。

**Q4 · 谁可以点那个 Approve？我是不是必须有 write 权限？**
必须在该环境的必需审查员名单里（§1.6 第 4 步加进去的账号或 team）。名单外的人在 run 上看不到批准按钮。**这一条我没有实测过「仓库 admin 但不在名单里」是否有例外**，别把它当安全边界：需要的是「有发布责任的人」，把 admin 一起放进名单更省事。GitHub 也提供批准待审批部署的 REST 端点（`POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments`），用脚本去调它等于把这道闸门改回自动——本链路刻意不这么做。

**Q5 · 审批会卡住后面的合并吗？**
不会卡住 `main`，也不会取消挂着的审批：`concurrency` 里 `cancel-in-progress: false` 就是为了后者。新合进 main 的那条 run 会排队，等这一条走完才起跑。**注意排队的那条用的是它自己那次 push 的提交**——所以你批准后打的 tag 指向的是**发起这次 run 的那个提交**，不是排到后面那笔的内容（§2 路径 A 末）。

**Q6 · 我批准了，但 `release-tag` 红在「在等待期间已被打出」，现在怎么办？**
什么都不用做——那一格拦的就是「同一个号发两遍」，它红说明有人（或另一条链路）先把 tag 落地了。要核对的是商店有没有真的吃到包：`curl -s https://img.shields.io/chrome-web-store/v/<id>.json` 现量。号一致、商店没动，走 §3.2 用那个 tag 补跑。

**Q7 · 批准之后 GitHub Release 建好了、商店那一步静默跳过，包去哪了？**
两个原因，都在 §1.6 末与 §5：四个 `CHROME_*` 没配全，或者被挪到了环境级（`publish` 那一格不带环境，`secrets: inherit` 也不带环境级的东西）。补 Secret 或把它挪回仓库级，再按 §3.2 用同一个 tag 补跑一次——Release 那一步是幂等的，不会长出第二份。

「没配全」这一种还有**第二个形状**，本仓库 2026-10-09 撞的是它：四条凭据一条不缺地躺在仓库级，只是名字叫 `CWS_*`，而链路按 `publish-extension` 的环境变量契约读 `CHROME_*`（§1.3）。这种形状**不会有任何报错**——`Detect` 只看名字、`Submit` 被跳过、作业成功、整条 run 绿，而商店连续两版没吃到包。现在那一格会补发一条 `::warning::` 注解，Run 列表页就能看见，不必点进作业读摘要。处置是逐条 **Rename**（改名保留值；GitHub 没有 rename Secrets 的 API，只能网页上点），**不是**再建一份同值的 `CHROME_*`——那样仓库里就是八条凭据、四个值各存两份，以后轮换一次 token 要记得改两处，而漏掉的那一处永远是旧的那一份。

**Q8 · 这一版我不想发了，怎么撤回？**
**还没批准**：不点 Approve 就行，30 天后那条 run 自动失败，refs 一个都没动；要把号也降回去见 §2 路径 A 第 5 步那一条（两个文件一起改，CHANGELOG 那一节搬回草稿区）。
**已经批准但 `publish` 还没跑完**：批准撤不回正在跑的作业，只能等它落定。
**已经提审**：Chrome 商店没有「撤回已发布版本」的按钮，只能在 Dashboard 把上一个版本的 zip 当作新版本再提审一次（§3 末）。这就是为什么点头之前要有 `prepare`。

**Q9 · 商店审核要多久？**
不受本仓库控制，也没有可靠的上限可写。经验性说法（社区普遍报告）是小时到天级，大改动与首次上架更久。别把「商店在装版本」和「`package.json` 里的号」在同一天写成一致——§5 末那段纪律就是为这件事存在的。

**Q10 · 我想先验一次这条链路，但不想真的发版。**
按 §3.2 末那份一次性验收清单：先 `pnpm exec wxt submit --dry-run`（不上传、不提审），再用 `trustedTesters` + `skip-review` 跑一次 §3.2。两个档位都碰不到正式分组。注意 §1.6 的复核命令先跑一次——环境没配时 `Store Publish` 会停在 `hold` 红，那正是你想看到的第一个证据。

**Q11 · `prepare` 上传的那个 Artifact，就是商店收到的那份 zip 吗？**
不是，措辞在 §2 路径 A 第 4 步那段引言里已经写明：批准后 `publish` 会重新构建，而 zip 不逐字节可复现。Artifact 的作用是「让审批人在点头前看到产物存在、名字与版本对得上，并且全套校验过一次」。

**Q12 · PR 上那条 `Store Publish` 会不会误发布？**
不会。`confirm` / `release-tag` / `publish` 三格的 `if` 都带 `github.event_name != 'pull_request'`，PR 上它们不可达；`decide` 的摘要也明说「本次是 PR：只演练判定」。fork 的 PR 更是拿不到任何仓库 Secrets。PR 上你能看到的是 `decide` 的结论与 `prepare` 的校验结果——这是把「这一版会不会被发」提前演一遍的地方。

**Q13 · 一次版本 bump 的合并为什么要跑两遍全套校验？**
CI 一遍、`prepare` 一遍，为的是点头之前看见绿勾（§0）。代价是一分钟量级的机器时间，普通 PR 不付——它们的号对应的 tag 早已存在，`decide` 直接判已发过，`prepare` 连起跑都不会起跑。

**Q14 · `CHANGELOG.md` 那一节我写错了，Release 已经发出去了。**
改 main 上的那一节，然后按 §3.2 用同一个 tag 补跑：`gh release edit` 会覆盖说明，商店侧的「更新说明」本来就要人粘（§2.1），把新的那块再粘一次。不用重写 tag，也不用发一个补丁号来「带上」这段文字——那会把一次排版错误变成一次提审。

**Q15 · 闸门那条 run 自己坏了（YAML 报错 / 作业红在无关的地方），这一版还是要发，怎么办？**
走 §2 路径 B：本机推 `vX.Y.Z`，`release.yml` 照跑（它的三个入口之一）。修链路和发版本是两件事，不必互为前提——这也是当初把发布实现留在 `release.yml`、只让闸门去调用它的原因：闸门坏了，出口还在。

**Q16 · 那条 run 红得一个作业都没有，Run 页面只有工作流文件名，日志点进去 404。**
这不是链路上的某一格失败，是 **GitHub 没能把这份工作流文件读进去**，所以它连过滤器都评估不了：`on:` 里只要有一个值不符合 workflow-syntax 的模式（schema），整份文件就作废，表现为「秒红、零作业、无日志」。本机 `pnpm test` 里的 YAML 解析查不出它——js-yaml 只保证语法合法，模式是 GitHub 自己那一套。

2026-10-09 第一次开 PR 实测撞到的就是这一种，值只有一个：`release.yml` 的 `on.workflow_call.inputs.publish-target` 写成了 `type: choice`。**`choice` 与 `environment` 是 `workflow_dispatch` 专属**，被调用的工作流只认 `boolean` / `number` / `string`。代价不只是 `release.yml` 自己红：`store-publish.yml` 的 `publish` 那格要 `uses:` 它，于是两条链路一起零作业红，而红字里没有任何一行提到那个字段。

改法两面：`workflow_call` 那份降成 `type: string`，`workflow_dispatch` 的下拉框**原样留着**（人手补跑时靠它挡错别字）；被调用那侧失去的约束补在作业里——`release.yml` 的 `Validate publish inputs` 那一步按白名单 `default | trustedTesters` 判，位置排在 `Verify` **之前**，因为分组名传错是一笔不可撤回的提审，而这一格红只花几秒。这条口径由 `tests/docs-consistency.test.ts` 的「被调用的工作流只声明 boolean / number / string 三种输入类型」守着，并且自带阳性对照：同一份提取函数遇到 `type: choice` 必须数得出 `['choice']`，否则「全绿」只说明判据没在看。

**Q17 · `decide` 摘要里那句「这一轮读不到仓库 Secrets 名单」，是不是 Secrets 没配？**
不一定，而且这句话本来就不该这样读。那个名单来自 `GET /repos/{owner}/{repo}/actions/secrets`，链路用的是 `contents: read` 的作业令牌，读不到就写 `known=false`——**判定与措辞都不因此改变**（`should-publish` 与 `hold` 两根轴都不看它）。真正决定商店那一步发不发的是 `release.yml` 的 `Detect Chrome Web Store credentials`。想知道四个到底在不在，看那一格的输出，或按 §1.3 自己数。

**Q18 · 环境建好了、必需审查员也勾了，为什么那次 run 里 `confirm` 没有停下来等我，直接绿过去了？**
先分清三种「没停下来」，它们的修法完全不同：

1. **`confirm` 是 skipped，不是绿**。`decide` 判这个号的 tag 已在远端（重跑旧 tag、或普通 PR），后面几格按设计不起跑。这不是闸门坏了，是这次本来就没有要发的东西。
2. **环境是 GitHub 隐式建的那一个**——作业引用了不存在的环境，GitHub 建一个不带任何保护规则的同名环境（§1.6 开头）。这一种 `decide` 抓得到：它读 `protection_rules`，读不出 `required_reviewers` 就判 `hold` 翻红。
3. **环境在、规则在、审查员也在，但那次是仓库管理员触发的**。环境的对象上还有一条**默认开启**的开关，设置页写作 **Allow administrators to bypass configured protection rules**，API 字段是 `can_admins_bypass`；开着时管理员的作业**不进等待队列**，`confirm` 秒过，`release-tag` 与 `publish` 的条件（`approval-state == 'configured'`）也照样满足——那个读数说的是「环境上配了规则」，不是「这一次真的有人点过」。

第三种是本仓库当前的形状，也是三种里唯一没有任何自动化能看见的一种：`can_admins_bypass` 住在地对象**顶层**，不在 `protection_rules` 数组里，而 `decide` 只遍历那个数组。2026-10-09 实测 `GET /repos/…/environments/chrome-web-store` 回 `required_reviewers` + 1 名审查员 + `can_admins_bypass: true`（`created_at` 与 `updated_at` 都是 `06:19:41Z`，说明建完没再改过设置）。而单人维护的仓库里这一条最要命：**唯一那位审查员恰好就是管理员**，于是每次发版都走第三条，闸门在统计意义上从没生效过，而全链路每次都是绿的。

修法一步：**Settings → Environments → `chrome-web-store` → 取消勾选那条 → Save environment**（只在网页上，`GITHUB_TOKEN` 改不到它，因为它不是保护规则而是环境属性）。改完按 §1.6 末那条命令复量，`can_admins_bypass` 应当变 `False`——那一行现在会自己打印出来，不用另外拼 URL。

改完怎么确认闸门真的会拦人：发一个**新版本号**合进 main（不是重跑旧 tag——旧 tag 走的是第一条，`confirm` 直接 skipped，看不出差别）。run 列表里那条 `Store Publish` 应当显示为**等待批准**的挂起态，作业图停在 `confirm` 那一格、`release-tag` 与 `publish` 灰着；点进去有 `Review jobs` → **Approve**。如果你看到它一秒跑完且三格全绿，回来先查 `can_admins_bypass`，再查审查员名单里到底有没有别人。

顺带一句代价：这个仓库是公开的，而公开仓库的环境**匿名可读**，`reviewers` 里的 login 会原样出现在 `api.github.com` 的公开 JSON 里（§1.6 末实测）。所以审查员名单要么接受它公开，要么换一个不带规则的环境名把发版审批挪去别处——本项目选接受。
