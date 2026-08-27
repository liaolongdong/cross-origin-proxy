# 跨域代理助手

[English](./README.md) | **简体中文**

一款 Chrome 扩展（Manifest V3），用于在不同环境之间代理前端 API 请求——例如让 FAT 前端直接调用 UAT 后端接口，无需改动业务代码或后端 CORS 配置。

技术栈：[WXT](https://wxt.dev) + Vue 3 + Element Plus + TypeScript。

## 功能特性

- **规则化 URL 重写** — 支持通配符、前缀、正则三种匹配方式，将命中的请求重定向到目标环境
- **双通道代理架构**
  - 简单规则（无请求头覆盖）走 `declarativeNetRequest`（DNR）动态规则，由浏览器网络层直接重定向，零 JS 开销
  - 复杂规则（含请求头覆盖）走 Service Worker `fetch` 通道，拦截页面 `fetch`/XHR 后转发
- **请求头覆盖** — 按规则注入或替换请求头（如目标环境的鉴权 Token）
- **规则管理** — 添加 / 编辑 / 复制 / 删除、优先级排序、单条与批量启停、搜索筛选
- **请求日志** — 展示最近代理请求的方法、状态码、耗时，以及 DNR 命中统计
- **导入 / 导出** — 以 JSON 格式备份和恢复完整规则配置
- **Popup 快速面板** — 代理总开关、今日统计、最近请求，一键直达 Options 的添加规则 / 日志 / 导入导出
- **国际化与主题** — 中英文界面切换，六套配色主题

## 安装

### 从源码构建

```bash
pnpm install
pnpm build
```

打开 `chrome://extensions`，开启**开发者模式**，点击**加载已解压的扩展程序**，选择 `.output/chrome-mv3` 目录。

### 本地开发

```bash
pnpm dev   # 启动 WXT 开发服务（HMR，端口 8899）
```

## 使用说明

1. 点击扩展图标，打开**代理开关**。
2. 在 Popup 中点击**规则管理** — Options 页面打开并自动弹出添加规则表单（若已有打开的 Options 标签页则直接复用，不会重复打开）。
3. 创建规则：

   | 字段 | 说明 |
   |---|---|
   | 匹配类型 | `通配符`（`https://fat-api.example.com/*`）、`前缀`、`正则表达式` |
   | 匹配模式 | 需要拦截的 URL 模式 |
   | 目标 URL | 命中请求的重定向目标 |
   | 优先级 | 数值越小越优先匹配 |
   | 请求头覆盖 | 可选，配置后该规则走 SW fetch 通道 |

4. 任意页面中命中已启用规则的请求会被透明重定向，可在**请求日志**中查看代理记录。

> DNR 通道要求正则规则兼容 RE2 语法；不兼容的正则会跳过 DNR 同步（控制台告警），但配置了请求头覆盖时仍可在 SW 通道正常工作。

## 架构

```
页面 fetch / XHR
   │
   ├── 命中简单规则 ──► DNR 动态规则 ──► 浏览器网络层直接重定向
   │
   └── 命中复杂规则 ──► MAIN world 拦截器（postMessage）
                          └► ISOLATED world 桥接层（chrome.runtime）
                               └► Background SW fetch ──► 响应原路返回页面
```

- `entrypoints/background/` — DNR 同步、消息路由、SW 代理执行、保活
- `entrypoints/main-interceptor.content.ts` — MAIN world `fetch`/XHR 拦截器（任何失败均回退原生请求）
- `entrypoints/content.ts` — 页面与 Service Worker 之间的 ISOLATED world 桥接层
- `components/options/` — Options 界面（规则表格、表单弹窗、日志抽屉、导入导出）
- `utils/` — 存储、DNR 规则构建、URL 匹配、国际化

## 权限说明

| 权限 | 用途 |
|---|---|
| `storage` | 持久化规则、日志与偏好设置 |
| `declarativeNetRequest` | 简单规则的网络层 URL 重定向 |
| `declarativeNetRequestFeedback` | 日志抽屉中的 DNR 命中统计 |
| `alarms` | Service Worker 周期性保活 |
| `<all_urls>` | 在任意站点上拦截并代理请求 |

## 限制

- 最多 **200 条规则**（添加时强制校验）
- 请求日志保留最近 **500 条**

## 常用命令

```bash
pnpm dev         # 开发模式（HMR）
pnpm build       # 生产构建，输出到 .output/chrome-mv3
pnpm build:zip   # 构建并打包 zip（用于商店上传）
pnpm test        # vitest 单元测试
pnpm typecheck   # tsc --noEmit 类型检查
pnpm lint        # eslint 检查
pnpm format      # prettier 格式化
```
