# AGENTS.md · 跨域代理助手（cross-origin-proxy）

## 适用范围与优先级

- 本文件适用于整个仓库，是项目的详细约定参考；精简的 always-on 铁律见 `.qoder/rules/wxt-rules.md`。
- 这是一个本地优先的跨环境 API 请求代理扩展（如让 FAT 前端调用 UAT 后端），无需修改应用代码或后端 CORS。处理改动时按以下顺序权衡：功能正确性与请求安全、数据与行为兼容性、可维护性、性能、代码风格。
- 开始修改前先阅读相关实现与测试；不要仅凭文件名或猜测改变行为。
- 只做满足当前需求的最小完整改动；保留工作区用户改动，不覆盖、不回退、不顺手格式化或重构无关文件。
- 未经用户明确要求，不改变既有功能、交互、默认值、存储结构、匹配/重写语义或浏览器权限；确有必要时先说明影响并询问确认。
- 未经用户明确要求，不提交、推送、发布代码，也不升级依赖或改写 lockfile。

## 快速参考

### 常用命令

| 用途     | 命令                                                     |
| -------- | -------------------------------------------------------- |
| 开发     | `pnpm dev`（WXT HMR，端口 8899）                         |
| 构建     | `pnpm build`（输出 `.output/chrome-mv3`）                |
| 打包     | `pnpm build:zip`（商店上传用）                           |
| 商店素材 | `pnpm assets` / `pnpm assets:en`（生成商店图与落地页图） |
| 类型检查 | `pnpm typecheck`（`tsc --noEmit`）                       |
| Lint     | `pnpm lint`（修复 `pnpm lint:fix`）                      |
| 样式检查 | `pnpm lint:style`                                        |
| 格式检查 | `pnpm format:check`（格式化 `pnpm format`，慎用）        |
| 测试     | `pnpm test`（`vitest run`）                              |

> 本仓库未配置 husky/lint-staged；提交前需手动通过上述检查。

### 关键文件速查

| 职责                      | 文件                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 公共类型与消息判别联合    | `utils/types.ts`（`ProxyRule`/`MessageType`/`RuntimeMessage` 等）                                                   |
| 常量与 Storage 键         | `utils/constants.ts`（`STORAGE_KEYS`、`MAX_RULES=200`、`MAX_LOG_ENTRIES=500`、alarm 名）                            |
| 存储门面                  | `utils/storage.ts`（`storage.local` + 互斥锁 + 内存缓存 + 日志缓冲写入）                                            |
| DNR 规则构建（纯函数）    | `utils/dnrRules.ts`                                                                                                 |
| URL 匹配/重写与分流判定   | `utils/urlMatcher.ts`（`findMatchingRule`/`rewriteUrl`/`isSimpleRule`）                                             |
| 消息路由                  | `entrypoints/background/messageRouter.ts`（`isTrustedSender` 安全校验）                                             |
| SW 代理执行               | `entrypoints/background/proxyHandler.ts`（mock/delay/block/override/retry）                                         |
| DNR 同步与广播            | `entrypoints/background/dnrManager.ts`                                                                              |
| DNR 命中统计              | `entrypoints/background/dnrStats.ts`（`getMatchedRules`，配额受限）                                                 |
| SW 保活 / 自动关闭 / 徽章 | `entrypoints/background/{keepalive,autoOff,badgeManager}.ts`                                                        |
| i18n（自研响应式）        | `utils/i18n/index.ts` + 根 `locales/{zh_CN,en}/{common,options,popup}.json`                                         |
| 主题                      | `utils/theme.ts` + `assets/theme/tokens.css`（`--cop-*`，6 主题 + light/dark/system）                               |
| Vue 应用工厂              | `utils/createVueApp.ts`（`createAndMountApp`）                                                                      |
| 商店文案与权限理由        | `CHROMEWEBSTORE.md`（上架唯一素材源，不在扩展包内）                                                                 |
| 产品落地页 / 隐私政策     | `docs/index.html`（英）、`docs/zh.html`（中）、`docs/privacy.html`、`docs/llms.txt`（GitHub Pages 以 `/docs` 为根） |
| 商店/落地页图生成         | `scripts/generate-store-assets.mjs`（从 `screenshots/` 派生 1280×800 等精确尺寸）                                   |
| WXT / 测试配置            | `wxt.config.ts`、`vitest.config.ts`（纯 vitest，alias `@` + node 环境）                                             |

## 架构总览

代理请求按规则复杂度走两条通道，由 `utils/urlMatcher.ts` 的 `isSimpleRule()` 判定：

```
页面 fetch / XHR / WebSocket
   │
   ├── 命中简单规则 ──► DNR 动态规则（浏览器网络层重定向，零 JS 开销）
   │
   └── 命中复杂规则 ──► MAIN-world 拦截器（postMessage，origin 受限）
                          └► ISOLATED-world 桥接（chrome.runtime）
                               └► Background SW fetch ──► 响应回传页面
```

- **简单规则**：仅 URL 重写（无 header/body/response 覆盖、mock、delay、block、retry，且 wildcard 以 `*` 结尾）→ 由 `dnrManager` 同步为 `declarativeNetRequest` 动态重定向规则。
- **复杂规则**：含任一 SW 专属能力 → 由 `main-interceptor.content.ts`（MAIN world）拦截页面 `fetch`/`XMLHttpRequest`/`WebSocket`，经 `content.ts`（ISOLATED world）桥接到 SW 的 `proxyHandler` 用 `fetch` 执行。
- **配置下发**：`storage.onChanged` 触发 `dnrManager` 重新同步 DNR，并用 `tabs.sendMessage` 向所有标签页广播（`runtime.sendMessage` 不会到达内容脚本）；MAIN-world 拦截器就绪后主动 `REQUEST_CONFIG` 回放，消除两 world 注入时序竞态。
- **状态源**：`chrome.storage.local` 是唯一事实来源；SW 内存缓存（`cachedConfig`、`swHitStats`、正则缓存）均可重建、随配置变更失效。

## 仓库结构约定

- `entrypoints/`：WXT 入口，只负责初始化与装配，复杂逻辑下沉到模块。
  - `background.ts` + `background/`：SW 生命周期、消息路由、DNR 同步、代理执行、保活、自动关闭、徽章、统计。
  - `content.ts`（ISOLATED world 桥接）、`main-interceptor.content.ts`（MAIN world 拦截器，自包含）。
  - `options/`、`popup/`：Vue 页面入口（`main.ts` 调 `initThemeSync()` + `initLocaleSync()` + `createAndMountApp()`）。
- `components/options/`：Options UI 组件（`App.vue` 为装配层，弹窗/抽屉用 `defineAsyncComponent` 异步加载，不进首屏 chunk）。
- `composables/`：响应式状态与副作用（`useRuleManagement`/`useProxyStatus`/`useRequestLog`/`useImportExport`/`useI18n`）。
- `utils/`：与 Vue 生命周期无关的领域逻辑与纯函数（`dnrRules`/`urlMatcher`/`curlParser`/`har`/`formatters`/`generateId`/`storage`/`theme`/`i18n`/`logger`）。
- `locales/`：应用内 i18n 文案；`public/_locales/`：仅 manifest 名称/描述。`assets/theme/tokens.css`：`--cop-*` 设计令牌。`tests/`：Vitest 单测（node 环境）。
- `docs/`：GitHub Pages 产品站（静态 HTML/CSS + 一个零依赖、自托管的渐进增强脚本 `docs/assets/landing.js`，零外部 CDN、零远程字体；不参与 WXT 构建）。该脚本只加 `html.js` 类并接管截图廊控件、滚动淡入、导航高亮与回顶导轨，**所有依赖 JS 的样式状态写在 `html.js` 选择器下**，因此禁用或删除 JS 时页面内容依旧完整可读、可导航；改页面结构时要维持这个降级前提。`docs/assets/img/` 需入库供 Pages 访问。
- `store-assets/`、`marketing/`：均为本地可再生/仅本地产物，已进 `.gitignore`；`.test-tmp/` 严禁入库（曾因误提交 Chrome for Testing 二进制把 `.git` 撑到 195MB，2026-09 已重写历史清除）。

## 代码改动与优化边界

### 修改功能或修复问题时

- 修改既有代码时，同时检查触及范围内是否有明显的大文件职责混杂、重复逻辑、散落类型或可独立测试的公共方法；能证明行为等价且风险可控时可随当前改动做局部优化。
- 顺带优化必须服务于当前任务，只限直接相关模块，不扩展成全仓库重构，不借机改名、换风格或调整无关交互。
- 修复 bug 前先用测试或可复现步骤固定预期行为；发现任务之外的问题先记录说明，不顺手改行为。
- 不为形式上的“抽象”增加层级；只有当抽取后职责更清晰、能减少真实重复或能独立测试时才新建组件/composable/类型/工具方法。

### 明确进行优化或重构时

- 默认目标是内部结构改善，必须保持外部可观察行为不变，包括：URL 匹配与重写语义、DNR/SW 双通道分流结果、mock/delay/block/override/retry 行为、消息协议与响应结构、storage 数据结构与默认值、拦截器 fallback 行为、UI 布局与文案、主题与 i18n、权限与网络行为。
- 优化前先读调用方与现有测试，明确被优化模块的职责、入口、输出、副作用与兼容边界；必要时先补特征/回归测试再移动或重写。
- 大文件拆分按稳定职责与数据流划分，保持原入口为薄编排层，避免循环依赖、双向状态同步与跨层访问。
- 重复代码抽离前确认各处语义、错误处理与生命周期一致；相似但业务约束不同的代码不得强行合并。
- 迁移、重命名或抽取后及时删除死代码并更新所有引用、测试与必要文档，但不改动无关文件；优化后用相同场景与测试验证行为等价。

### 必须暂停并询问确认的情况

- 如果优化需要或可能改变任何功能、业务规则、交互、视觉、默认值、数据格式、兼容性、权限或性能取舍，立即停止实现，先说明当前行为、拟议变化、原因、影响范围与可选方案，获得确认后再继续。
- 无法可靠判断重构是否行为等价时，视为可能影响功能，必须先询问确认，不以“应该没影响”作为继续依据。
- 纯内部、范围明确、已有验证覆盖且可证明行为等价的重构可直接执行；交付时仍须列出优化内容与验证证据。

## 技术栈与包管理

- 使用 WXT、Manifest V3、Vue 3、TypeScript、Element Plus、Vite、Vitest。
- 使用 `pnpm`（以 `package.json` 的 `packageManager` 与 `pnpm-lock.yaml` 为准），不混用 npm 或 yarn。
- 优先复用现有依赖与 Web/Chrome 原生 API；新增或升级依赖前先证明必要性并评估包体积、安全、权限与兼容性影响。
- Element Plus 通过现有 resolver 按需引入，禁止整包导入；保持 TypeScript strict，不降低 `tsconfig.json`、ESLint、Stylelint 或测试规则来绕过问题。

## Chrome 扩展约定

- 只使用 Manifest V3 API；不引入 MV2 API、远程执行代码、内联事件处理器或违反扩展 CSP 的实现。
- 调用 `chrome.*` 前确认当前上下文可用；Background、content script（MAIN/ISOLATED world）、popup、options 能力边界不可混用。
- 修改消息处理时校验消息结构与 sender；状态修改类消息必须经 `isTrustedSender` 校验；异步 `sendResponse` 路径必须 `return true` 保持通道，并保证每条路径都有响应或明确终止。
- Background SW 随时可能被回收：不得把全局内存当持久事实来源，短期缓存必须可重建、可失效，以 `chrome.storage.local` 为准；长期任务用 `chrome.alarms`（最小周期 1 分钟，不期望秒级精度）。
- DNR 同步前必须过滤非法规则：regex 需经 `isRegexSupported`（RE2）校验、替换串捕获引用不得越界（`isSubstitutionValid`），否则 `updateDynamicRules` 会整批拒绝。
- 向内容脚本广播配置用 `tabs.sendMessage`（`runtime.sendMessage` 不到达内容脚本）；未注入页面会报错，静默忽略。
- 注册事件、observer、timer、alarm 或 DOM 监听器时保证幂等初始化并在生命周期结束时清理（content script 用 `ctx.addEventListener`）。
- 引用图标或资源前确认文件存在（图标源 `public/icon.svg` + `public/icon/` 多尺寸 PNG，由 `scripts/generate-icons.mjs` 生成）；用户可见操作失败时给出反馈，不静默吞掉保存/导入导出/权限错误。

## 安全与隐私基线

- 把页面 DOM、导入文件（HAR/cURL/JSON）、runtime message、storage 数据与外部响应都视为不可信输入：在边界处校验类型、长度、格式与来源，失败时安全降级（如导入规则经 `normalizeImportedRules` 过滤非法项并重新生成 id）。
- 请求头注入防护：校验头名（`HEADER_NAME_RE`）且值不含 CRLF；页面传入头宽容过滤（跳过个别非法项），规则配置头严格校验（任一非法即整体拒绝并提示修正）。
- 响应状态码钳制在 200-599（否则前端无法构造 `Response` 会静默回退原生请求）；请求体大小上限 10MB（`MAX_BODY_SIZE`）。
- ReDoS 防护：用户正则经 `isRegexSafe` 检测嵌套量词，DNR 侧经 RE2 校验。
- 最小权限：`storage`、`declarativeNetRequest`、`declarativeNetRequestFeedback`、`alarms`、`<all_urls>`；修改 `permissions`/`host_permissions`/CSP/内容脚本匹配范围时说明必要性并更新文档。
- 禁止对不可信内容使用 `v-html`、`innerHTML`、`eval`、`new Function` 或内联脚本。
- 日志与导出仅在本地；新增网络请求、遥测、分析、远程资源或任何用户数据外传前必须获得用户明确确认并更新隐私说明。
- 运行时代码统一使用 `utils/logger.ts`，日志参数不含真实 token、账号或私密数据；不把敏感数据写入源码、测试夹具、截图、文档或提交记录。

## TypeScript 与通用代码规范

- 新增代码不使用 `any`；对不可信数据使用 `unknown` 并通过类型守卫收窄（`@typescript-eslint/no-explicit-any` 虽已关闭，仍应优先显式类型）。
- 同目录文件用 `./`，其它本地模块用 `@/` 别名；类型导入用 `import type`。
- 消息协议使用判别联合（`utils/types.ts` 的 `RuntimeMessage`）；新增消息必须处理未知类型降级、失败响应与异步通道生命周期。
- 类型就近放置，只有被多个模块稳定共享时才上移到 `utils/types.ts`；抽离类型不得弱化约束或用可选字段掩盖非法状态。
- 公共或复杂 API、关键安全假设与非显然算法使用简洁 JSDoc（解释“为什么”与约束，而非逐行复述“做什么”）。
- 所有异步边界都应有明确错误处理；面向用户的错误提供可理解反馈，内部错误通过不含敏感数据的日志记录。
- 禁止宽泛 `eslint-disable`、`@ts-ignore` 或降低规则规避问题；确需例外限最小行范围并说明（`utils/logger.ts`、`scripts/`、MAIN-world 拦截器为已知例外）。

## Vue 3 与界面规范

- 新增 Vue 代码默认使用 Composition API 和 `<script setup lang="ts">`；SFC 顺序保持 `<script>`、`<template>`、`<style>`。
- 单一事实来源：源状态尽量少，派生值用纯 `computed`，watcher 只承担副作用并正确清理异步任务。
- Props 只读、事件向上；组件边界用类型化 `defineProps`/`defineEmits`；只有真正的双向契约才用 `defineModel` 或 `v-model:xxx`。
- 根入口组件（`App.vue`）保持为组合与装配层；重型或低频弹窗用 `defineAsyncComponent` 拆出首屏，避免扩大 popup/options 首屏体积。
- 模板保持声明式；列表用稳定 primitive key；避免同元素混用 `v-if` 与 `v-for`；避免在模板中执行昂贵过滤/排序（放入 `computed`）。
- 组件样式默认 `scoped`，优先 class selector；复用 `assets/theme/tokens.css` 的 `--cop-*` 令牌，避免硬编码颜色；`:deep()` 仅用于必要的第三方组件覆盖。
- Element Plus 组件与命令式 API（`ElMessage`/`ElMessageBox`）保持按需加载，其样式需在入口手动 import；不硬编码可见文案，统一走 `useI18n()` 的 `t()`。
- 保持键盘操作、焦点管理、可读标签、对比度与 reduced-motion 等可访问性；不要只用颜色表达状态。

## 国际化与文档

- 单一自研响应式 i18n（`utils/i18n`）：`currentLocale` 为模块级共享 ref，`t(key, substitutions)` 支持 `$1..$9` 占位；组件侧经 `composables/useI18n.ts` 使用；偏好持久化在 `storage.local` 并镜像到 `localStorage`（消除首帧闪烁），`initLocaleSync()` 实现跨页实时同步。**本仓库无 `i18n-lite`/`tl()` 双体系。**
- 应用文案在根 `locales/{zh_CN,en}/{common,options,popup}.json`，构建期静态合并为扁平字典；新增/删除/重命名 key 时中英 key 集必须一致。
- manifest 名称/悬停短名/描述/命令文案走 `chrome.i18n`，仅维护 `public/_locales/{zh_CN,en}/messages.json`（`extensionName`/`extensionShortName`/`extensionDescription`/`commandToggleProxy`）。**Chrome 上传时硬校验 `name` ≤ 75、`description` ≤ 132 字符（按码点计数），超出直接拒包**；`tests/build-verification.test.ts` 已加回归守卫。
- 商店关键词只加在 `public/_locales` 的 `extensionName`。它仍会出现在 Chrome 应用商店、安装确认弹窗、`chrome://extensions` 列表与工具栏扩展菜单——这是承载关键词的**已知代价**，无法由权限或代码消除；浏览器 UI 上接受显示长名。可收短的两处已收短：工具栏悬停提示走 `extensionShortName`，标签页标题由 `entrypoints/{options,popup}/main.ts` 用应用内 i18n 设置。**测试守卫的是“悬停短名 = HeaderBar 品牌名 = popup 标题”三者一致**；`optionsPageTitle` 带「- 配置 / - Options」后缀是故意设计，不要“顺手对齐”删掉后缀。
- 文档按影响范围更新，中英文表达同一事实：
  - 用户功能、安装或用法变化：`README.md`（英）与 `README.zh-CN.md`（中）。
  - manifest 描述、权限、命令或配置变化：`wxt.config.ts` 及对应 `_locales` 文案；同时同步 `CHROMEWEBSTORE.md`（商店文案/权限/截图清单）与 `docs/` 落地页（能力、FAQ、隐私政策）。
  - 商店图或落地页图变化：改 `scripts/generate-store-assets.mjs` 后跑 `pnpm assets && pnpm assets:en`，不手工改图片。

## 测试与验证

- 测试位于 `tests/*.test.ts`，Vitest node 环境；纯函数模块（`dnrRules`/`urlMatcher`/`curlParser`/`har`/`formatters`）可直接单测。
- 修改前先找现有测试；修 bug 优先加“修复前失败、修复后通过”的回归测试；新增逻辑覆盖成功、失败与关键边界。
- 交付前按改动范围执行：
  - TypeScript/Vue/运行时代码：`pnpm typecheck`、`pnpm lint`、相关 `pnpm test`。
  - 通用逻辑、存储、消息路由或跨入口改动：`pnpm test`（全量）。
  - Vue/CSS 样式：`pnpm lint:style`。
  - 入口、manifest、WXT/Vite 配置、依赖或打包行为：`pnpm build`。
  - 文档、JSON 等格式改动：对本次修改文件运行 `pnpm exec prettier --check <files...>`。
  - `docs/` 落地页与隐私政策：除 prettier 外需 `pnpm lint:style`（`docs/assets/landing.css` 受 recess-order 约束），`docs/assets/landing.js` 需过 `pnpm lint`（浏览器全局已在 `eslint.config.js` 的 `docs/**` 覆盖块中声明），并在浏览器里目测渲染（含禁用 JS 的降级态）。中英两页的可见文案、FAQ 条目数与 `FAQPage` 结构化数据必须一一对应：`FAQPage` 的问答需与页面 `<details>` 文本一致，两页的条目顺序也需一致。
  - 商店文案改动：`pnpm test`（含 `name`/`description` 字符上限守卫）+ 同步 `CHROMEWEBSTORE.md`。
- 不用会改写整个仓库的 `pnpm format` 处理局部任务；需要自动修复时只作用于本次修改文件。
- 不为通过测试而弱化断言、删除、跳过测试或隐藏错误；命令因既有问题或环境限制无法运行时，交付时如实说明未验证项与原因。

## 项目特有约定

- **双通道分流**：`isSimpleRule` 决定走 DNR 还是 SW；两通道的 URL 重写语义必须一致（wildcard 末尾 `*` 捕获、prefix、regex）。
- **三世界内容脚本**：MAIN 自包含拦截 + ISOLATED 桥接 + SW 执行；所有 `postMessage` 用 `window.location.origin` 作 targetOrigin（非 `*`）。
- **storage 锁 + 缓存**：read-modify-write 走 `withStorageLock` 避免竞态；配置内存缓存随 `storage.onChanged` 失效。
- **日志缓冲写入**：达 10 条或 1s 防抖 flush，且 flush 串行化避免并发覆盖丢失；`onSuspend` 时 `flushLogs`。
- **DNR 命中统计**：`getMatchedRules` 近 5 分钟窗口，配额约每 10 分钟 20 次，由 UI 手动刷新触发，超配额静默返回上次结果。
- **代理自动关闭**：总开关开启且配置时长时用 `chrome.alarms` 倒计时（跨 SW 重启持久化），到期自动关闭总开关。
- **主题**：`--cop-*` 令牌 + `data-theme`/`data-mode`；6 主题（sky/green/pink/mauve/orange/slate）+ light/dark/system；同步覆盖 Element Plus `--el-color-primary` 梯度。
- **容量限制**：`MAX_RULES=200`（新增/合并超限拒绝）、`MAX_LOG_ENTRIES=500`（环形缓冲）。
- **商店文案**：`public/_locales` 承载搜索关键词（CORS/跨域/环境切换/Mock），`CHROMEWEBSTORE.md` 是商店表单的唯一素材源；截图由 `pnpm assets` 生成（商店只接受 1280×800 或 640×400，最多 5 张，像素级校验）。
- **命名身份（两层，互为直译，不得混用）**：工程身份 = `cross-origin-proxy`（`package.json` 的 `name`、GitHub 仓库名、Pages 路径基、`pnpm build:zip` 产物名）；品牌身份 = 「跨域代理助手 / Cross-Origin Proxy」（商店名 `extensionName`、`extensionShortName`、HeaderBar、popup 标题、落地页 `<title>` 与 schema `name`）。品牌名是描述性短语（与用户查询语序一致，利于商店搜索与 AI 实体消歧），刻意不造臆造品牌词——FAT/UAT 是中国研发语境黑话，中文是主市场。工程身份曾被写成 `web-cross-origin`、`web-proxy` 并残留于包名，2026-09 已统一；`web-proxy` 在 GitHub `in:name` 有 5471 个仓库（且语义撞 VPN/翻墙代理）、`web-cross-origin` 不是任何检索短语，两者都不要再改回去。起量后若要加品牌前缀，只改商店名称字段与 HeaderBar：扩展 ID 不变、已装用户无感；**仓库名与 Pages 地址不动**，因为隐私政策 URL 是商店审核项，改动需重新提审。

## 常见陷阱

### Service Worker

- 全局内存非持久，SW 随时被回收；短期缓存必须可重建、可失效，以 `storage.local` 为事实来源。
- 异步 `sendResponse` 必须 `return true`，否则通道立即关闭、响应丢失。
- `chrome.alarms` 最小周期 1 分钟（keepalive/autoOff 均受限），不要期望秒级精度。

### DNR

- `regexSubstitution` 必须配合 `regexFilter` 的捕获组（旧实现用 `urlFilter` + `\1` 从未生效）。
- regex 需 RE2 兼容（`isRegexSupported` 校验），替换引用不得越界（`isSubstitutionValid`）；任一非法会导致 `updateDynamicRules` 整批被拒，故同步前必须过滤。
- 业务优先级与 DNR 优先级方向相反（数值越小越先匹配 → `toDnrPriority` 反转）。

### 内容脚本

- `runtime.sendMessage` 不到达内容脚本，广播配置需 `tabs.sendMessage`（未注入页面报错，静默忽略）。
- MAIN-world 必须自包含：重复类型定义、无 `chrome.*`、不能 import logger（直接用 `console.warn`）。
- 阻断规则不得回退原生 `fetch`/`XHR`/`WebSocket`，否则被阻断的请求会实际发出；非字符串 body（FormData/Blob/ArrayBuffer）不能跨 `postMessage`，除阻断外回退原生。

### Storage

- 统一使用 `storage.local`（无 `storage.session`、无加密）；read-modify-write 必须走 `withStorageLock` 避免竞态。

### 仓库体积

- `.test-tmp/`（含下载的 Chrome for Testing，约 558MB）只能留在磁盘、绝不能入库；已进 `.gitignore`，历史已于 2026-09 用 `filter-branch` 清除（`.git` 195MB → 2.2MB）。
- GitHub 单文件硬上限 100MB；任何二进制、抓包产物、浏览器下载件都不得提交，新增图片前先确认体积与必要性。

### WXT 构建

- 当 popup 入口 HTML 存在**非空 `<title>`** 时，WXT 会用它推导 `manifest.action.default_title` 并覆盖 `wxt.config.ts` 里的同名声明（`wxt/dist/core/utils/manifest.mjs`，实测于 0.20.27）。因此悬停提示只能改 `entrypoints/popup/index.html` 的标题；若将来 popup 标题被删空，配置里的值会重新生效——升级 WXT 后需复核这一行为。
- Chrome **不替换**扩展页面 HTML 里的 `__MSG_x__` 占位符（只对 manifest.json 生效），所以页面 `<title>` 里写占位符会直接以字面量出现在标签页上；需本地化时用入口 `main.ts` 设 `document.title`，静态值只作首帧兜底。
- 干净检出跑 `pnpm typecheck` 前必须先 `pnpm exec wxt prepare`（`.wxt/` 不入库，CSS 模块与 `import.meta.env` 类型均来自它）。

### Element Plus / i18n

- 禁止整包导入；`ElMessage`/`ElMessageBox` 为显式导入，其样式需在入口手动 import。
- 中英 key 必须一致；单一自研 i18n 体系（无 `i18n-lite`/`tl`）；`public/_locales` 仅放 manifest 名称/悬停短名/描述/命令文案。

## ESLint 已知例外

- `@typescript-eslint/no-explicit-any` 已关闭（但仍优先 `unknown` + 类型守卫）。
- `vue/multi-word-component-names` 已关闭。
- `no-console` 设为 warn，仅允许 `console.warn`/`console.error`；运行时代码仍应使用 `utils/logger.ts`。
- `utils/logger.ts`、`scripts/**` 显式豁免 `no-console`；MAIN-world 拦截器因自包含直接使用 `console.warn`。
- `docs/**/*.js`（产品站渐进增强脚本）在 `eslint.config.js` 中声明为 `sourceType: 'script'` + 少量浏览器全局（`document`/`window`/`matchMedia`/`IntersectionObserver`/`setTimeout`/`clearTimeout`），因为它无构建、无模块系统；新增全局需在此块中显式补充。

## 完成标准

- 需求已满足，既有功能、交互、数据与权限边界未发生未经确认的变化。
- 已自查 diff，确认没有敏感数据、调试代码、无关改动、重复实现或未处理的异常路径。
- 相关 `typecheck`、`lint`、`lint:style`、`format:check`、`test`、`build` 按上述矩阵通过，或已明确报告限制。
- 交付说明包含：改了什么、关键设计原因、执行了哪些验证、仍存在什么风险或未验证项。
