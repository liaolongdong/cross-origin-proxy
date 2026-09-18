# Release Please Setup — cross-origin-proxy

> 本文档说明如何配置 Release Please 自动化发布工作流，使本插件与 account-password-helper 保持一致。

## 已完成配置

以下文件已创建并同步至仓库：

### 1. release-please-config.json

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "include-component-in-tag": false,
  "packages": {
    ".": {
      "release-type": "node"
    }
  },
  "changelog-sections": [
    { "type": "feat", "section": "Features" },
    { "type": "fix", "section": "Bug Fixes" },
    { "type": "perf", "section": "Performance Improvements" },
    { "type": "revert", "section": "Reverts" },
    { "type": "refactor", "section": "Code Refactoring" },
    { "type": "docs", "section": "Documentation" },
    { "type": "style", "section": "Styles" },
    { "type": "build", "section": "Build System" },
    { "type": "ci", "section": "Continuous Integration" },
    { "type": "test", "section": "Tests" },
    { "type": "chore", "section": "Chores" }
  ]
}
```

**作用**：定义 Release Please 的行为规则，包括版本类型、变更日志分段等。

### 2. .release-please-manifest.json

```json
{
  ".": "1.0.0"
}
```

**作用**：记录已发布版本的快照，避免重复生成 Release。

## 需要配置的 GitHub Secrets

在 **GitHub Repository Settings → Secrets and variables → Actions** 中添加以下 Secret：

| Secret Name | 用途 | 获取方式 |
|-------------|------|----------|
| `RELEASE_PLEASE_TOKEN` | Release Please 自动创建 GitHub Release | GitHub Personal Access Token（需有 `repo` 权限） |
| `CWS_EXTENSION_ID` | Chrome Web Store 扩展 ID | Chrome Dev Console 中上传首个包后获得（32 位小写字母） |
| `CWS_CLIENT_ID` | Google OAuth 客户端 ID | Google Cloud Console 创建 OAuth 凭据时获得 |
| `CWS_CLIENT_SECRET` | Google OAuth 客户端密钥 | 同上 |
| `CWS_REFRESH_TOKEN` | Google OAuth 刷新令牌 | Google OAuth Playground 授权后获得 |

> **注意**：前 4 个 Secret 用于 Release Please 自动生成 GitHub Release；后 4 个 Secret 用于自动发布到 Chrome Web Store。

## 工作流程

### Release Please 触发条件

当向 `main` 分支推送符合约定式提交规范（Conventional Commits）的 commit 时，Release Please 会自动：

1. 分析 commit 历史，计算下一个版本号
2. 生成 CHANGELOG.md 更新
3. 创建 Pull Request 合并更改
4. 合并 PR 后创建 Git Tag 和 GitHub Release

### 示例提交格式

```bash
feat: 添加新的代理功能
fix: 修复 WebSocket 重连问题
docs: 更新使用说明
chore: 更新依赖版本
```

### 与现有 release.yml 的关系

当前仓库已有 `.github/workflows/release.yml`，它通过手动打 tag 触发。Release Please 的工作流是：

```
Conventional Commits → Release Please → Tag → release.yml (自动) → Chrome Web Store
```

两者可以共存，但建议：

- **日常开发**：使用 Release Please 自动管理版本
- **紧急修复**：可继续使用手动 tag 方式（见 RELEASING.md §3）

## 首次运行

1. 配置上述 GitHub Secrets
2. 安装 Release Please Action：[googleapis/release-please-action](https://github.com/googleapis/release-please-action)
3. 创建第一个正式提交（带 conventional commit 前缀）
4. 等待 Release Please 自动创建 PR

## 参考文档

- [RELEASING.md](./RELEASING.md) - 发版流程详细指南
- [CHROMEWEBSTORE.md](./CHROMEWEBSTORE.md) - Chrome Web Store 上架配置
- [GITHUB.md](./GITHUB.md) - GitHub 仓库展示信息设置
- [Release Please 官方文档](https://github.com/googleapis/release-please)

## 对比 account-password-helper

本配置与 `account-password-helper` 完全一致，确保两个插件的发布流程统一：

| 文件 | 状态 | 说明 |
|------|------|------|
| `release-please-config.json` | ✅ 已创建 | 与 account-password-helper 相同 |
| `.release-please-manifest.json` | ✅ 已创建 | 初始版本为 1.0.0 |
| `.github/workflows/release.yml` | ✅ 已存在 | 已支持自动发布到 Chrome Web Store |
| `RELEASING.md` | ✅ 已存在 | 详细的发版流程文档 |
| `CHROMEWEBSTORE.md` | ✅ 已存在 | 商店上架配置文档 |
