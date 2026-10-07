# 发版与 Chrome 应用商店提审 — 跨域代理助手 / Cross-Origin Proxy

> 本文讲**怎么发一个版本**，以及哪些地方**只能人去点**（逐项见 §1）。GitHub 仓库侧的展示信息（About / website / topics / Pages 开关）在 [GITHUB.md](./GITHUB.md)，商店表单文案在 [CHROMEWEBSTORE.md](./CHROMEWEBSTORE.md)。
>
> 自动化边界有两处，都是刻意的：**首次上架必须手动**（`publish-extension` 不提供"新建商店条目"的能力，官方 README 原文是 _You are responsible for uploading and submitting an extension for the first time by hand_）；**推 tag 必须手动**（推 tag 等于向 Google 提交审核，不可撤回、且审核配额有限，不该是「合并 PR」这个动作的副作用）。其余——版本号、CHANGELOG 小节、打包、建 GitHub Release、上传与提审——都在链路里。

## 0. 链路全貌

两条链路，一条起草、一条发布，彼此**不越界**：

```
① 起草（自动，机器人只写文件，不发版）
   代码合进 main
      │
      └─ .github/workflows/release-please.yml（Release Please，push main 触发）
           ├─ 按提交类型算出下一个版本号（feat→minor、fix/perf/refactor/revert→patch、BREAKING CHANGE→major）
           ├─ 开/更新一个待人工合并的 PR：把号写进 package.json 与 .release-please-manifest.json，
           │  并在 CHANGELOG.md 顶部开出 `## [x.y.z]` 小节、把提交标题列进去
           └─ 不建 tag、不建 GitHub Release（配置里 skip-github-release: true）

② 发布（人推 tag 才走）
   人在本机：git tag vX.Y.Z && git push origin vX.Y.Z
      │
      └─ .github/workflows/release.yml（tag 触发）
           ├─ Verify            复用 CI 的 .github/actions/verify（lint/style/format/typecheck/build:zip/test）
           ├─ Guard             tag 必须等于 package.json 的 version，否则终止
           ├─ GitHub Release    附 .output/*-chrome.zip，说明取 CHANGELOG 对应小节
           └─ Chrome Web Store  4 个 Secrets 齐 → `wxt submit` 上传并提审；缺 → 跳过并写 Job Summary 指引
```

产品站（含隐私政策）走另一条独立链路 `.github/workflows/deploy-pages.yml`，改动 `docs/**` 即自动部署，不需要任何 Secrets。

**为什么机器人不顺手把 tag 打了**：除了「提审要人点头」这条产品判断，还有一条更硬的技术原因——GitHub 规定**由默认 `GITHUB_TOKEN` 产生的事件不会再起跑新工作流**。机器人打的 tag 触发不了 `release.yml`，链路会停在「版本号涨了、商店包没动」这个中间态，而它看起来像成功。人从本机推的 tag 没有这个问题。同一条规则还解释了 §1.5 里分支保护的那个坑。

## 1. 一次性准备（只做一次）

下面每一项都是**只能人点**的：没有 API、没有 CLI 能替你把它们做完（凭据类是 Google 侧的授权页，开关类是仓库设置）。全部做完约 30 分钟。

| #   | 项目                                                     | 谁做       | 不做会怎样                             |
| --- | -------------------------------------------------------- | ---------- | -------------------------------------- |
| 1.1 | 商店条目（首次上传拿 ID）                                | 人，Google | 没有 Extension ID，链路只能到 GitHub   |
| 1.2 | Google Cloud OAuth 凭据与 refresh token                  | 人，Google | 上传步骤拿不到令牌                     |
| 1.3 | 4 个 GitHub Secrets                                      | 人，GitHub | `release.yml` 跳过商店那一步并留指引   |
| 1.4 | 本机鉴权预检                                             | 人         | 撞 401 时才发现，而那一刻 tag 已经推了 |
| 1.5 | 允许 `googleapis/release-please-action` 与分支保护的影响 | 人，GitHub | 起草链路静默不跑，或被保护规则卡死     |

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

命名刻意与 `publish-extension` 的环境变量同名（CLI 参数转大写蛇形即环境变量），工作流因此可以直接 `env:` 注入，无需映射。

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

## 2. 日常发版

版本号只写在 `package.json`（`wxt.config.ts` 刻意不再声明 `manifest.version`，WXT 会回落并把它规整成 `X.Y.Z`），`tests/build-verification.test.ts` 守卫两者一致。**写它的是机器人**，而机器人的对账基准是 `.release-please-manifest.json`——这两个文件的号必须相等，`tests/docs-consistency.test.ts` 已经把它变成一条断言。

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

**跑的那份 workflow 来自你推出去的那个 ref，不是来自 main**。`on: push: tags` 用的是 tag 所指那个提交里的 `.github/workflows/release.yml`——所以如果你刚刚在 main 上改了发布链路、而 tag 打在一个更早的提交上，这一次跑的还是旧文件（改动画像常在这里丢）。要么把 tag 打到包含那些改动的那个提交（未推送过的 tag 用 `git tag -f vX.Y.Z <sha>` 挪位即可，远程不需要重写），要么接受这一次跑旧逻辑、下一次才生效。

**§3 的 `workflow_dispatch` 是第三条路**：它跑的是你选的那个分支（默认 main）上的那份 `release.yml`，而 `tag` 输入只决定 checkout 哪个提交的内容。2026-09-30 那次就是这么救回来的——tag 指的 `6798385` 里 `release.yml` 还缺 `GH_TOKEN`（推 tag 那一次停在 Publish），从 main 补跑用的已经是修好的文件，Release 与 zip 照样按 tag 那个提交的内容产出，refs 一个都没动。

**小节标题的两种写法都发得出去**：`release.yml` 从 `CHANGELOG.md` 切 Release 说明时，认机器人带对比链接的 `## [X.Y.Z](…/compare/vA...vB) (日期)`，也认它拿不到上一个 tag 时写的裸 `## X.Y.Z (日期)`——所以 §2 第 4 步推 tag 前不必先确认标题长什么样。切不到小节时会退回 GitHub 自动生成的流水账并在日志里留一条 warning，不会发一个空说明的 Release。

**推完 tag 之后机器人那本账由 `release.yml` 替它换**。release-please 给发布 PR 打的标签是 `autorelease: pending`，通常由它自己「建 Release + 打 tag」那一步换成 `autorelease: tagged`；这一仓库刻意让它 `skip-github-release`，那一换就永远不发生，而它下次起草时只要看到任何**已合并、仍带 pending** 的 PR 就直接放弃开新 PR（日志里那句是 `There are untagged, merged release PRs outstanding - aborting`，而那条 run 全绿）。所以 `release.yml` 在 GitHub Release 建成之后紧跟着一步 `Clear release-please pending label`，把标题写着这个版本号的那一个 PR 的标签换掉。**它失败不会翻发布**，只会在 Job Summary 里留一段指引——看到那段就去 GitHub 上手工把标签改成 `autorelease: tagged`，否则下一次发版的 PR 不会来。

**走过 §2.3 手工 bump，上面那一步会扫不到东西，得人工换**。清扫按**标题里写着本版本号**来筛已合并的发布 PR，而手工 bump 意味着发出去的号不是机器人 PR 标题上那一个（2026-09-30 那一次：PR #1 的标题写的是 `chore(main): release 1.3.1`，推出去的 tag 比它高一级）。日志会老实说一句「没有待清理的 release-please PR（可能这一版是 §2.3 的手工 bump）」然后正常退出——**这不是失败**，但那个 PR 仍带 `pending`，机器人下次起草时看到它就当场放弃。所以手工发版后要自己去看一眼有没有已合并却仍带 `pending` 的发布 PR，人工换成 `tagged`（症状与处置见 §4「机器人不再开新的发布 PR」那一行）。

**手工换那一格有两个静默假成功的坑**（2026-10-07 踩在第一个上）。① `POST /issues/{n}/labels` 是**追加**而不是覆盖：用它提交 `["autorelease: tagged"]`，HTTP 回 200，GET 回来却是 `pending | tagged` 两个并存，而 release-please 的判据是「有没有**已合并仍带 `pending`** 的发布 PR」——卡点原样还在，界面却看着像已经改好了。覆盖整个标签集要用 `PUT`，且换完必须 GET 一次确认那个数组里只剩 `tagged`。② 换完不会立刻有下文：`release-please.yml` 只有 `push: branches: [main]` 一个触发器，没配 `workflow_dispatch`，所以解开卡点之后还得再推一笔 main 它才会重新起草——这一笔提交本身就是为了这件事存在的。

**`pnpm test` 不再要求你去翻「复述当前版本号」的文档**：那三处（`docs/llms-full.txt` 两句与 `.github/ISSUE_TEMPLATE/bug_report.yml` 的示例版本）已经改成不带号的指针，指向 CHANGELOG 的最新小节。改带号的守卫反而会把机器人自己的发布 PR 判红——它在同一个 PR 里抬 `package.json`，却写不了散文。取而代之的是一条按文件清单放的断言：**除「写号是它的职责」的那几处**（`package.json`、`.release-please-manifest.json`、`CHANGELOG.md`、`CHROMEWEBSTORE.md`、`docs/**` 说的商店在装版本、HAR 规范字段、锁文件）**以外，任何被跟踪的文本文件都不许复述开发中的版本号**；新地方想写号，要么改措辞成指针，要么把那个文件连理由一起加进清单。

落地页页脚、schema 的 `softwareVersion` 与 `CHROMEWEBSTORE.md` §8 表里的历史行说的是**商店在装的已发布版本**，不在 bump 范围内——它们要到 tag 真的推出去那一刻才按 §2.2 翻。

可见文案或能力有变化时，按 `AGENTS.md` 的文档矩阵同步 `README.md`（中文主文档）/ `README.en.md` / `locales/` / `CHROMEWEBSTORE.md` / `docs/`（中英必须同事实）。商店 `name` ≤ 75、`description` ≤ 132 字符由 `pnpm test` 守卫。

### 2.1 商店的「更新说明」要人粘

`wxt submit` 没有对应参数，包上传时那一栏是空的（GitHub Release 的说明反倒是自动的，从 `CHANGELOG.md` 切）。所以 Run 页面显示提审成功后，去 Dashboard 该条目 → 更新信息 → 把 [`CHROMEWEBSTORE.md` §8.1](./CHROMEWEBSTORE.md) 的中英文两块分别粘进对应语言列表，一分钟内可完成，漏了不报错、只是这一版对用户没有说明。

### 2.2 tag 推出去之后那批「此刻为真、推完就为假」的句子

落地页页脚版本与日期、`llms*.txt` 里关于 tag 的句子、README 方式 B 的 Releases 提示、`CHROMEWEBSTORE.md` §8 的提审状态——清单只有一个出口：[`CHROMEWEBSTORE.md` §12](./CHROMEWEBSTORE.md)。它现在是一张**翻牌记录**：八行已经全部翻过（2026-10-01 那一次），最后一列写着每处当前的措辞；其中第 4、5、7、8 行说的是**商店在装的版本**，所以商店每真正吃到一个新包就要回来再翻一次，而行 1、2、3、6 讲的是 tag 的存在性，翻了就不再回来。翻完跑 `pnpm test` 与本次改动文件的 `pnpm exec prettier --check`。

### 2.3 不用机器人的那条路（紧急修复、或机器人没跑）

手工 bump 依然完全有效，`release.yml` 不在乎号是谁写的：

```bash
npm version patch --no-git-tag-version          # 或 minor / major
# 手工在 CHANGELOG.md 顶部补 `## [X.Y.Z] - YYYY-MM-DD`（写法必须是行首 `## [数字`，
# 它是机器人下一次找插入点的锚；写成 `## [Unreleased]` 那种占位标题会把整份历史挪位）
```

**走完这条路必须顺手把 `.release-please-manifest.json` 改成同一个号**，否则机器人的基准落后一级，下一次它算出来的就是刚刚发过的那个版本（`tests/docs-consistency.test.ts` 会当场红，这是那条评论存在的原因）。

## 3. 手动补跑 / 灰度 / 只传草稿

Actions → **Release** → **Run workflow**：

| 输入             | 用途                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `tag`            | 已存在的标签，如 `v1.0.0`——用于 Secrets 补齐后把首个版本交出去          |
| `publish-target` | `default` 为正式分组；`trustedTesters` 只发给测试者，先验证再走正式     |
| `skip-review`    | 勾上 = 只上传 zip 成草稿，不提交审核，去 Dashboard 人工核对后再手动提审 |

Release 创建步骤是幂等的：同一个 tag 重跑会更新说明并 `--clobber` 覆盖资产，不会报"已存在"。

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

| 现象                                              | 原因与处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 合了代码但机器人没开发布 PR                       | 大概率正常：这一批只有 `docs` / `chore` / `test` / `ci` / `build` / `style` 类型，它们不进 CHANGELOG 也不 bump。否则看那条 run 是不是 pending（§1.5 第 1 条）或报错                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 机器人的发布 PR 上一个检查都没有                  | `GITHUB_TOKEN` 开的 PR 不触发 CI（§1.5 第 2 条），不是链路坏了                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 机器人把版本号抬错级别                            | 它只读提交类型，不懂业务风险：在 PR 里同时改 `package.json` 与 `.release-please-manifest.json`，或用 `Release-As: X.Y.Z` 脚注强制                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 机器人的 PR 里 CHANGELOG 小节只有一行行提交标题   | 正常，那是它写得出来的全部；中英长文由人在合并前并进那一节（§2 第 2 步 b）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 下一次机器人开出的号等于刚发过的那个号            | 手工 bump（§2.3）后没同步 `.release-please-manifest.json`，两个号脱钩了                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CHANGELOG 里已有 `## [X.Y.Z]`，远端却没有那个 tag | bump 的 PR 合了、tag 没推（或走过 §3 的本机直传——那条链路压根不碰 git tag）。**先做的那一步是换标签**：那一个已合并的发布 PR 仍带 `autorelease: pending`，而机器人下次起草时只要看见这种 PR 就当场放弃开新 PR（判据见 §2 末，症状是下一行那一条），所以「等它算号」今天等不来任何东西——去 PR 页面手工把它换成 `autorelease: tagged`。换完才轮到第二件事：机器人仍以 `.release-please-manifest.json` 为准算号，**不会重发那个号，内容并进下一个号**，所以不丢东西，代价只是那一节的 compare 链接指向不存在的 tag。2026-10-03 实测正是这个形状：商店在装 1.3.0、GitHub Release 最新是 `v1.4.0`，`package.json` 与 `.release-please-manifest.json` 已比远端最新的 tag 高一级（那个号本地远端都没有 tag），而那个已合并的发布 PR 当时仍带 pending。别把另一件事混进这一行：`v1.4.0` 那次 run 里 `Submit to Chrome Web Store` 是 skipped（四个 `CHROME_*` secrets 未配），那是 tag **已经**推出去、只差商店那一步，按 §3 补跑即可。处置：**不要补推一个追认性质的旧 tag**（§6 第一条同理），把落后那几个小节的要点并进这一次要发的那个号，商店只交最新那一份包（§3） |
| 机器人不再开新的发布 PR，可那条 run 全绿          | 有一个**已合并却仍带 `autorelease: pending`** 的发布 PR 卡着它（`There are untagged, merged release PRs outstanding`）。走过 §2.3 手工 bump 时 `release.yml` 的按标题清扫会扫不到它（见 §2），去 PR 页面把标签手工换成 `autorelease: tagged`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `标签 v1.0.1 与 package.json 的 1.0.0 不一致`     | 先 `npm version` 再打 tag，别改 tag 迁就文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Release 说明变成自动生成的流水账                  | `CHANGELOG.md` 里那一节的小节号与版本对不上；补上后手动补跑即可覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `gh: ... set the GH_TOKEN environment variable`   | 用 `gh` 的那一步没声明 `GH_TOKEN`。GitHub **不把 `GITHUB_TOKEN` 注入 `run` 步骤**，而 `gh` 在 Actions 里只认前者；`release.yml` 里 Publish 与清标签两个步骤各写一份，缺哪个红哪个（首次于 2026-09-30 真发生过，症状是 Release 没建成、下游全 skip）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Job Summary 显示"Chrome Web Store 发布已跳过"     | Secrets 缺失，按 §1.3 补齐后用 §3 补跑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `invalid_grant` / 401                             | refresh token 过期或 OAuth consent screen 还在 Testing 模式（改成 Published 或加测试用户）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `The requested profile could not be found`        | `CHROME_EXTENSION_ID` 拼错，或该条目不属于这个开发者账号                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 上传成功但商店里版本没变                          | 只上传未提审：确认 `skip-review` 是否为 true，去 Dashboard 手动提交                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Pages not enabled`（另一条 deploy-pages 链路）   | `GITHUB.md` §5 的 Source 开关没切到 GitHub Actions，与商店发布无关                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

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
