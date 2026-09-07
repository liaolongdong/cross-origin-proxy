# 发版与 Chrome 应用商店提审 — 跨域代理助手 / Cross-Origin Proxy

> 本文讲**怎么发一个版本**。GitHub 仓库侧的展示信息（About / website / topics / Pages 开关）在 [GITHUB.md](./GITHUB.md)，商店表单文案在 [CHROMEWEBSTORE.md](./CHROMEWEBSTORE.md)。
>
> 自动化边界只有一处：**首次上架必须手动**。`publish-extension`（`wxt submit` 的底层工具）不提供"新建商店条目"的能力，官方 README 原文是 _You are responsible for uploading and submitting an extension for the first time by hand_。拿到 Extension ID 之后，每个版本都可以由工作流提审。

## 0. 链路全貌

```
本地：npm version → CHANGELOG.md → commit → tag v X.Y.Z → push main + tag
                                                        │
GitHub Actions（.github/workflows/release.yml，tag 触发）
  ├─ Verify            复用 CI 的 .github/actions/verify（lint/style/format/typecheck/build:zip/test）
  ├─ Guard             tag 必须等于 package.json 的 version，否则终止
  ├─ GitHub Release    附 .output/*-chrome.zip，说明取 CHANGELOG 对应小节
  └─ Chrome Web Store  4 个 Secrets 齐 → `wxt submit` 上传并提审；缺 → 跳过并写 Job Summary 指引
```

产品站（含隐私政策）走另一条独立链路 `.github/workflows/deploy-pages.yml`，改动 `docs/**` 即自动部署，不需要任何 Secrets。

## 1. 一次性准备（只做一次，约 30 分钟）

### 1.1 手动建商店条目并上传首个包

1. `pnpm build:zip` → `.output/cross-origin-proxy-<version>-chrome.zip`。
2. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **New item** → 上传该 zip。
3. 从条目编辑页 URL 取 Extension ID（32 位小写字母串，形如 `abcdefghijklmnopqrstuvwxyzabcdef`）。
4. 按 `CHROMEWEBSTORE.md` §1–§5 填名称/摘要/详细描述/截图/权限理由/数据披露，**先不提审**——自动化从第二个版本开始接管，或者在本机配好凭据后用 §3 的手动补跑把首个版本也交出去。

### 1.2 Google Cloud OAuth 凭据

前置条件：发布/更新扩展要求该 Google 账号**已开启两步验证**（官方硬性要求，未开启时报错信息很隐晦）。

1. [Google Cloud Console](https://console.cloud.google.com/) 新建项目 → 搜索栏输入 **Chrome Web Store API** → 启用。
2. **OAuth 同意屏幕** → 选 **External** → 填应用名、用户支持邮箱、开发者联系邮箱；Scopes 跳过；先把**自己的邮箱加进 Test users**，这样无需审核流程就能用。
3. **凭据 → 创建凭据 → OAuth 客户端 ID**：走官方推荐的 [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) 路径时，应用类型选 **Web 应用**，已获授权的重定向 URI 填 `https://developers.google.com/oauthplayground`；记下 Client ID 与 Client secret。
4. 打开 Playground → 右上角设置选 **Use your own OAuth credentials** 填入上一步两个值 → **Input your own scopes** 填 `https://www.googleapis.com/auth/chromewebstore` → **Authorize APIs** 并以开发者账号授权 → **Exchange authorization code for tokens**，返回体里的 `refresh_token` 就是要存的值（令牌交换端点是 `https://oauth2.googleapis.com/token`）。

> 注意：`redirect_uri=urn:ietf:wg:oauth:2.0:oob` 那条老路径 Google 早已下线，任何还在写 OOB 的教程都换不到 refresh token。
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

## 2. 日常发版

版本号只写在 `package.json`（`wxt.config.ts` 刻意不再声明 `manifest.version`，WXT 会回落并把它规整成 `X.Y.Z`），`tests/build-verification.test.ts` 守卫两者一致。

```bash
# 1) 改版本号（不自动 commit/tag，便于先把 CHANGELOG 一起写进同一个提交）
npm version patch --no-git-tag-version     # 或 minor / major

# 2) 在 CHANGELOG.md 顶部补 `## [<新版本>] - YYYY-MM-DD` 小节
#    它是版本历史的唯一事实源：Release 说明就是从这里切出来的

pnpm exec prettier --check CHANGELOG.md package.json   # 只查改动文件

# 3) 全套校验（等价于 CI，本地先红先改）
pnpm lint && pnpm typecheck && pnpm lint:style && pnpm test && pnpm build

# 4) 提交、打 tag、推送（tag 一到即触发发布链路）
git add -A && git commit -m "chore(release): v1.0.1"
git tag v1.0.1
git push origin main v1.0.1
```

可见文案或能力有变化时，按 `AGENTS.md` 的文档矩阵同步 `README.md` / `README.zh-CN.md` / `locales/` / `CHROMEWEBSTORE.md` / `docs/`（中英必须同事实）。商店 `name` ≤ 75、`description` ≤ 132 字符由 `pnpm test` 守卫。

## 3. 手动补跑 / 灰度 / 只传草稿

Actions → **Release** → **Run workflow**：

| 输入             | 用途                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `tag`            | 已存在的标签，如 `v1.0.0`——用于 Secrets 补齐后把首个版本交出去          |
| `publish-target` | `default` 为正式分组；`trustedTesters` 只发给测试者，先验证再走正式     |
| `skip-review`    | 勾上 = 只上传 zip 成草稿，不提交审核，去 Dashboard 人工核对后再手动提审 |

Release 创建步骤是幂等的：同一个 tag 重跑会更新说明并 `--clobber` 覆盖资产，不会报"已存在"。

**灰度**：`wxt submit` 支持 `--chrome-deploy-percentage`（1–100），本工作流默认全量。需要灰度时把该 flag 加进 `Submit to Chrome Web Store` 步骤，或本机直接跑：

```bash
pnpm exec wxt submit --chrome-zip .output/cross-origin-proxy-1.0.1-chrome.zip --chrome-deploy-percentage 25
```

**回滚**：Chrome 商店不提供"撤回已发布版本"的按钮式操作，只能在 Dashboard 上传上一个版本的 zip 作为新版本提交（需重新走审核）。所以发布前 `Verify` 与 §1.4 的鉴权预检不要跳过。

## 4. 失败排查

| 现象                                            | 原因与处置                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `标签 v1.0.1 与 package.json 的 1.0.0 不一致`   | 先 `npm version` 再打 tag，别改 tag 迁就文件                                               |
| Release 说明变成自动生成的流水账                | `CHANGELOG.md` 缺 `## [x.y.z]` 小节；补上后手动补跑即可覆盖                                |
| Job Summary 显示"Chrome Web Store 发布已跳过"   | Secrets 缺失，按 §1.3 补齐后用 §3 补跑                                                     |
| `invalid_grant` / 401                           | refresh token 过期或 OAuth consent screen 还在 Testing 模式（改成 Published 或加测试用户） |
| `The requested profile could not be found`      | `CHROME_EXTENSION_ID` 拼错，或该条目不属于这个开发者账号                                   |
| 上传成功但商店里版本没变                        | 只上传未提审：确认 `skip-review` 是否为 true，去 Dashboard 手动提交                        |
| `Pages not enabled`（另一条 deploy-pages 链路） | `GITHUB.md` §5 的 Source 开关没切到 GitHub Actions，与商店发布无关                         |

## 5. 没有配 Secrets 时仓库会怎样

发版链路照常走完校验、构建与 GitHub Release，只是商店那一步被跳过并在 Run 页面留一段指引。**"预构建 zip"从第一个 tag 起就永久可下载**，`README.md`、`docs/` 落地页与 `llms.txt` 指向 Releases 的入口也都因此成立。

## 6. 不要做的事

- 不把 `.env.submit` 或任何 token 提交进仓库（`.gitignore` 已宽泛排除 `.env*`，别用 `git add -f` 绕过）。
- 不在 `wxt.config.ts` 里重新加回 `manifest.version`：双写必然漂移，而漂移的代价是一个版本号错乱的包进商店。
- 不为了让发布变绿而跳过 `Verify`、降低断言或删测试。
- 不手改 GitHub Release 的资产名去凑商店期望（包名由 `wxt zip` 按 `<package-name>-<version>-<browser>.zip` 生成，zip 里的版本号是 WXT 削去预发布后缀后的 `manifest.version`）。
- 不用 `npm version prerelease`：WXT 会把 `1.1.0-beta.0` 削成 `1.1.0` 写进 manifest，与已发布的 `1.1.0` 正式版撞同号，商店会直接拒收更新。发版只用 `major` / `minor` / `patch`。
- 不擅自给 Firefox/Edge 配凭据：本项目声明不支持 Firefox（`declarativeNetRequest` 差异），要扩大目标平台先与产品决策对齐。
