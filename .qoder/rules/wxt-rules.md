---
trigger: always_on
---

# 跨域代理助手（cross-origin-proxy）项目铁律

> 精简的 always-on 硬性规则。架构总览、关键文件速查、约定细节与常见陷阱见根目录 `AGENTS.md`。

1. **技术栈**：必须使用 WXT + Manifest V3 + Vue 3 + TypeScript + Element Plus + Vite + Vitest，均为最新稳定版；Element Plus 通过 `ElementPlusResolver` 按需引入，禁止整包导入，控制打包体积。
2. **代码质量**：保持可维护性、可扩展性、可复用性；重复逻辑、公共方法与组件必须抽离复用（纯函数入 `utils/`，响应式/生命周期入 `composables/`，界面入 `components/`）；复杂或安全关键代码遵循 JSDoc 规范。
3. **改动后自检**：完成功能或修复 bug 后必须做代码审核并执行自动化验证，禁止因优化或修复引入新问题、破坏存量功能与交互。
4. **格式化与静态检查**：统一使用 ESLint + Prettier + Stylelint；Stylelint 已启用 recess-order 属性排序，新增样式必须符合属性顺序规范。
5. **文件引入**：同级目录用 `./`，其它本地模块用 `@/`（已在 `wxt.config.ts`、`vitest.config.ts`、`tsconfig.json` 配置）；类型导入用 `import type`。
6. **日志**：运行时代码统一使用 `utils/logger.ts`，禁止裸用 `console`。已知例外：`console.warn`/`console.error` 为 ESLint 允许；MAIN-world 拦截器 `entrypoints/main-interceptor.content.ts` 必须自包含（不能 import logger/chrome），直接使用 console；`utils/logger.ts` 与 `scripts/` 豁免。
7. **提交前验证**：本仓库未配置 husky/lint-staged，提交前必须手动通过 `pnpm lint`、`pnpm format:check`、`pnpm lint:style`、`pnpm typecheck`、`pnpm test`；涉及入口/manifest/依赖/打包时另跑 `pnpm build`。CI 与发布共用的校验清单唯一收在 `.github/actions/verify`（加一项检查只改那里）；版本号只在 `package.json`（`wxt.config.ts` 不得再声明 `manifest.version`），发版是推 `v*` tag（见 `RELEASING.md`），仓库展示信息（About/website/topics/Pages 源）只能手动在 UI 填（见 `GITHUB.md`）。
8. **禁止规避规则**：新增代码必须通过 `pnpm lint`，禁止用宽泛 `eslint-disable`、`@ts-ignore` 或降低规则来绕过问题；确需例外仅限最小行范围并说明原因。
9. **国际化**：新增或修改可见文案必须同时补 `locales/zh_CN/` 与 `locales/en/` 对应命名空间（`common`/`options`/`popup`），中英 key 集保持一致；manifest 名称/描述改 `public/_locales/{zh_CN,en}/messages.json`；同步更新 `README.md` 与 `README.zh-CN.md`（涉及 manifest 描述再改 `wxt.config.ts`）与 `docs/` 中英两页（条目数必须对等，`tests/docs-consistency.test.ts` 已守卫）；用户可感知变化另需在 `CHANGELOG.md` 顶部记一条。
10. **优化边界**：大文件拆分、重复代码/组件/类型抽离、公共方法封装、变量提取等优化，必须在不改变原有功能与交互体验的前提下进行；一旦可能影响功能、交互、视觉、默认值、数据格式、权限或性能取舍，必须停下来说明并询问确认。
11. **改动评审重点**：评审改动不得影响存量功能与交互，尤其关注：popup/options 首屏体积、弹窗 `defineAsyncComponent` 异步加载、内容脚本非阻塞与 MAIN-world fallback 行为、DNR 与 SW 双通道分流一致性、Service Worker 可回收安全。
12. **安全**：把页面 DOM、导入文件（HAR/cURL/JSON）、runtime message、storage 数据都视为不可信输入，在边界处校验；状态修改类消息必须经 `isTrustedSender` 校验；遵循最小权限，不擅自扩大 `permissions`/`host_permissions`。注意：`proxyHandler.ts` 里的头名/CRLF/状态码钳制/请求体上限与 `messageRouter.ts` 的 `isTrustedSender` 目前是私有函数，**没有单测入口**，改它们只能手动验证（已记在 `SECURITY.md` 的「已知缺口」）。
