# Chrome Web Store 自动化发布配置指南

> 本文档说明如何配置 GitHub Actions 自动发布到 Chrome Web Store，与 `account-password-helper` 插件保持一致。

## 1️⃣ GitHub Secrets 配置

在 **GitHub Repository Settings → Secrets and variables → Actions** 中添加以下 4 个 Secret：

| Secret 名称 | 用途 | 获取方式 |
|------------|------|----------|
| `CHROME_EXTENSION_ID` | Chrome Web Store 扩展 ID（32 位 a-p 小写字母） | 首次手动上传到 CWS Dashboard 后获得 |
| `CHROME_CLIENT_ID` | Google OAuth 客户端 ID | Google Cloud Console 创建 OAuth 凭据时获得 |
| `CHROME_CLIENT_SECRET` | Google OAuth 客户端密钥 | 同上 |
| `CHROME_REFRESH_TOKEN` | OAuth Refresh Token | 通过 OAuth Playground 授权获得 |

---

## 2️⃣ 获取 OAuth 凭据详细步骤

### Step 1: Google Cloud Console 设置

```bash
1. 打开 https://console.cloud.google.com/
2. 创建新项目或选择已有项目
3. 搜索 "Chrome Web Store API" 并启用
```

### Step 2: OAuth 同意屏幕配置

```bash
1. 导航到 "OAuth 同意屏幕"
2. 选择 "External" 
3. 填写应用名称、用户支持邮箱、开发者联系邮箱
4. 将您的测试邮箱添加到 Test users
```

### Step 3: 创建 OAuth 凭据

```bash
1. 导航到 "凭据" → "创建凭据" → "OAuth 客户端 ID"
2. 应用类型选择 "桌面应用" (Desktop app)
3. 记下 Client ID 和 Client Secret
```

### Step 4: 获取 Refresh Token

#### 方法 A - 使用 OAuth Playground（推荐）

```bash
1. 打开 https://developers.google.com/oauthplayground/
2. 右上角设置 → 勾选 "Use your own OAuth credentials"
3. 填入上一步获得的 Client ID 和 Client Secret
4. 在 Input your own scopes 中填入：
   https://www.googleapis.com/auth/chromewebstore
5. 点击 "Authorize APIs" 并以开发者账号授权
6. 点击 "Exchange authorization code for tokens"
7. 复制返回的 refresh_token
```

#### 方法 B - 直接访问授权 URL

```bash
# 替换 YOUR_CLIENT_ID 为实际的 Client ID
https://accounts.google.com/o/oauth2/auth?
  response_type=code&
  scope=https://www.googleapis.com/auth/chromewebstore&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=urn:ietf:wg:oauth:2.0:oob

# 授权后将获得 Authorization Code，再用它换取 Refresh Token
```

---

## 3️⃣ 不同插件的发布流程对比

| 插件 | 版本管理 | 触发方式 | 上传工具 |
|------|---------|---------|---------|
| **transfer-any-file** | 手动 tag | `v1.0.0` tag 推送 | `wxt-publish-extension` CLI |
| **account-password-helper** | Release Please | Conventional Commits | `mnao305/chrome-extension-upload` action |
| **cross-origin-proxy** ✨ | Release Please | Conventional Commits | `wxt submit` CLI |

---

## 4️⃣ 发布流程说明

### 🔄 自动化发布（Release Please）

```bash
# 日常开发 - 提交符合规范的 commit
feat: 添加新功能
fix: 修复 bug
docs: 更新文档

# Release Please 会自动：
1. 分析 commit 历史计算版本号
2. 生成 CHANGELOG.md 更新
3. 创建 Pull Request
4. 合并 PR 后自动打 tag 并触发 release.yml
5. release.yml 自动构建并发布到 Chrome Web Store
```

### 📦 手动发布（紧急修复）

```bash
# 本地操作
npm version patch --no-git-tag-version  # 或 minor/major
git add CHANGELOG.md package.json
git commit -m "chore(release): v1.0.1"
git tag v1.0.1
git push origin main v1.0.1  # 触发 release.yml

# release.yml 会：
1. 验证版本一致性
2. 执行全量检查（lint/typecheck/test/build）
3. 构建 zip 包
4. 创建 GitHub Release
5. 自动发布到 Chrome Web Store
```

---

## ⚠️ 重要提示

### 🔐 首次上架必须手工操作

```bash
❌ API 无法完成：
  - 创建商店条目
  - 填写商品文案（名称/描述/截图）
  - 隐私政策申报
  - 权限说明

✅ 必须先做：
  1. pnpm build:zip
  2. 登录 Chrome Developer Dashboard
  3. 手动上传首个 zip 包
  4. 填写所有表单信息
  5. 获取 Extension ID（32 位 a-p 小写字母）
  6. 配置 GitHub Secrets
  7. 之后才能自动化发布
```

### 🎫 OAuth Token 有效期

```bash
Testing 模式：约 7 天过期（最常见）
In Production 模式：长期有效（需 Google 审核）

💡 如果收到 401 / invalid_grant 错误：
  - 重新走 OAuth 授权流程获取新的 refresh_token
  - 或将 OAuth 应用发布为 In production
```

### 📝 扩展 ID 格式要求

```bash
✅ 正确：abcdefghijklmnopqrstuvwxyzabcdef
❌ 错误：abc defghijklmnopqrstuvwxyzabcdef (有空格)
❌ 错误：ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF (大写)

💡 复制时注意：
  - 不要带入空格/换行等不可见字符
  - 确保是纯小写 a-p 字母（不含 q-z）
  - 长度必须是 32 位
```

---

## 🔧 故障排查

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| `invalid_grant` / 401 | Refresh token 过期 | 重新获取 refresh_token |
| `The requested profile could not be found` | Extension ID 错误或账号不匹配 | 检查 ID 格式，确认账号权限 |
| CI 失败 | 代码检查未通过 | 运行 `pnpm lint` / `pnpm test` / `pnpm build` |
| 商店版本未更新 | 只上传未提审 | 检查 `skip-review` 是否勾选 |
| 标签与版本不一致 | Tag 与 package.json 不匹配 | 先改版本号再打 tag |

---

## 📚 相关文档

- [`RELEASING.md`](./RELEASING.md) - 详细的发版流程
- [`RELEASE-SETUP.md`](./RELEASE-SETUP.md) - Release Please 配置说明
- [`CHROMEWEBSTORE.md`](./CHROMEWEBSTORE.md) - Chrome Web Store 上架配置
- [`GITHUB.md`](./GITHUB.md) - GitHub 仓库设置指南
