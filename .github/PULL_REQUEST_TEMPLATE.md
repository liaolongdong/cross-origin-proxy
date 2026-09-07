<!--
中文或英文都可。删掉与本次无关的小节，但不要删检查项——不适用的项请勾「不适用」并写明原因。
-->

## 这个 PR 在做什么 / What

- 关联 Issue：`#`
- 一句话说明：

## 改动前的行为 → 改动后的行为 / Behaviour before and after

> 这是评审最关键的一栏。写不出来通常说明还没真正界定影响面。

- 改动前：
- 改动后：
- 用户可见差异（界面 / 文案 / 默认值 / 日志）：

## 影响面 / Impact

- [ ] 不改变 URL 匹配与重写语义、DNR 与后台通道的分流结果
- [ ] 不改变 mock / delay / block / override / retry 的行为（阻断类不回退原生请求）
- [ ] 不改变 `chrome.storage.local` 的数据结构与默认值（若改变：迁移方案见下）
- [ ] 不改变消息协议与响应结构（新增消息已处理未知类型、异步 `sendResponse` 有 `return true`）
- [ ] 不改变权限、内容脚本匹配范围与 CSP
- [ ] 不影响 Service Worker 可回收安全性（内存缓存可重建并在 `storage.onChanged` 失效）
- [ ] 不影响 popup / options 首屏体积（重型弹窗仍走 `defineAsyncComponent`）
- 以上任一项确实改变了：说明为什么值得，以及迁移/降级路径

## 跑了哪些检查 / Checks run

按 `AGENTS.md` 与 `CONTRIBUTING.md` 的矩阵，只跑与改动相关的项，并把结果写在下面（绿了才贴，红了说明原因）。

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`（全量或指明跑了哪些文件）
- [ ] `pnpm lint:style`（改了 CSS / `<style>` / `docs/assets/landing.css` 时）
- [ ] `pnpm exec prettier --check <改动文件>`（文档、JSON、Markdown、YAML）
- [ ] `pnpm build`（入口 / manifest / 依赖 / 打包行为变化时）
- 备注与未验证项：

## 国际化与文档 / i18n and docs

- [ ] 可见文案已同时补 `locales/zh_CN/` 与 `locales/en/` 对应命名空间，中英 key 集一致
- [ ] manifest 名称/描述变化时同步了 `public/_locales/{zh_CN,en}/messages.json`（≤75 / ≤132 字符由测试守卫）
- [ ] 用户可见功能变化时同步了 `README.md` 与 `README.zh-CN.md`
- [ ] 涉及权限 / 配置 / 商店文案时同步了 `wxt.config.ts`、`CHROMEWEBSTORE.md`、`docs/` 落地页（中英一一对应）
- [ ] 值得用户感知的变化已在 `CHANGELOG.md` 顶部补条目（发版时该小节会变成 Release 说明）

## 测试 / Tests

- [ ] 新增或修改了用例（bug 修复应有一条**修复前失败、修复后通过**的回归用例）
- 没有新用例的原因：

## 安全 / Security

- [ ] 新的输入边界（DOM、导入文件、runtime message、storage、远端响应）已在边界处校验并安全降级
- [ ] 未对不可信内容使用 `v-html` / `innerHTML` / `eval` / `new Function`
- [ ] 日志与测试夹具里没有真实 token、账号、内网域名或抓包数据
- [ ] 运行时代码使用 `utils/logger.ts`（MAIN world 拦截器、logger 自身与 `scripts/` 除外）
