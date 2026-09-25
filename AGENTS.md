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

| 用途     | 命令                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------- |
| 开发     | `pnpm dev`（WXT HMR，端口 8899）                                                                     |
| 构建     | `pnpm build`（输出 `.output/chrome-mv3`）                                                            |
| 打包     | `pnpm build:zip`（产出 `.output/<name>-<version>-chrome.zip`，发布链路用的就是它）                   |
| 商店素材 | `pnpm assets` / `pnpm assets:en`（生成商店图与落地页图）                                             |
| 发版     | `npm version patch --no-git-tag-version` + `CHANGELOG.md` 小节 + `git tag vX.Y.Z && git push --tags` |
| 鉴权预检 | `pnpm exec wxt submit --dry-run`（只验商店凭据，不上传不提审；需 `.env.submit`，已 gitignore）       |
| 类型检查 | `pnpm typecheck`（`tsc --noEmit`）                                                                   |
| Lint     | `pnpm lint`（修复 `pnpm lint:fix`）                                                                  |
| 样式检查 | `pnpm lint:style`                                                                                    |
| 格式检查 | `pnpm format:check`（格式化 `pnpm format`，慎用）                                                    |
| 测试     | `pnpm test`（`vitest run`）                                                                          |

> 本仓库未配置 husky/lint-staged；提交前需手动通过上述检查。CI 与发布共用的检查清单唯一收在 `.github/actions/verify`，加一项检查就改那里。

### 关键文件速查

| 职责                      | 文件                                                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公共类型与消息判别联合    | `utils/types.ts`（`ProxyRule`/`MessageType`/`RuntimeMessage` 等）                                                                                                                                                                                                                             |
| 常量与 Storage 键         | `utils/constants.ts`（`STORAGE_KEYS`、`MAX_RULES=200`、`MAX_VARIABLES=50`、`MAX_CONFIG_HISTORY=5`、`MAX_LOG_ENTRIES=500`、`MAX_LOG_BODY_SIZE`/`MAX_LOG_FIELD_SIZE`/`MAX_LOG_HEADER_COUNT`/`MAX_LOG_TOTAL_SIZE`、`DNR_MAX_PRIORITY`、alarm 名）                                                |
| 存储门面                  | `utils/storage.ts`（`storage.local` + 互斥锁 + 内存缓存 + 日志缓冲写入 + `configRules()` 取规则数组）                                                                                                                                                                                         |
| DNR 规则构建（纯函数）    | `utils/dnrRules.ts`                                                                                                                                                                                                                                                                           |
| URL 匹配/重写与分流判定   | `utils/urlMatcher.ts`（`findMatchingRule`/`rewriteUrl`/`isSimpleRule`/`isRegexSafe`）                                                                                                                                                                                                         |
| 边界校验与导出脱敏        | `utils/headerValidation.ts`（表单与导入共用的头判据）、`utils/exportSanitize.ts`（分享模式剔除凭据，`sanitizeExportData` 管配置、`sanitizeExportedLogs` 管 HAR）、`utils/dnrSupport.ts`（RE2/替换引用可用性判定，供「未生效」标记）                                                           |
| 回包整形与采样状态        | `utils/proxyResponse.ts`（桥接层兜底，形状约束被 MAIN world 镜像）、`utils/dnrSample.ts`（`DnrSample` → 五态判据 + `isDnrCountReadable`，popup/options/规则列表共用）                                                                                                                         |
| 规则级统计聚合            | `utils/ruleStats.ts`（`computeLogStats`、`groupHitStatsByRule` → `{net, ext}`：两通道窗口不同，**只分格、绝不相加**）                                                                                                                                                                         |
| 归因、重写差异与接口候选  | `utils/diagnosis.ts`（「这一笔为什么没走代理」的判据，只管「没命中为什么」）＋ `composables/useDiagnosis.ts`（唯一措辞出口）、`utils/rewriteDiff.ts`（重写结果掐头去尾求差）、`utils/pageApiOrigins.ts` ＋ `utils/pageApiProbe.ts`（本页接口来源：判据纯函数、IO 一处）                       |
| 凭据变量与头打码          | `utils/variables.ts`（`{{名称}}` 的校验、收集与**单轮**展开，纯函数、不碰 chrome）、`utils/storage.ts` 的 `getVariables`/`saveVariables`、`utils/headerMask.ts`（详情视图按 `exportSanitize` 同一套判据打码）                                                                                 |
| 导入预览与配置恢复点      | `utils/importPlan.ts`（`planImport` 与真实写入共用 `ruleConflicts.ts` 的 `ruleMergeKey`/`deduplicateRules`）、`utils/ruleValidation.ts`（导入与恢复点共用的结构判据）、`utils/storage.ts` 的 `pushConfigHistory`/`getConfigHistory`/`restoreConfigHistory`、`composables/useConfigHistory.ts` |
| 消息路由                  | `entrypoints/background/messageRouter.ts`（`isTrustedSender` 安全校验）                                                                                                                                                                                                                       |
| SW 代理执行               | `entrypoints/background/proxyHandler.ts`（mock/delay/block/override/retry；`resolveSelectedRule` 尊重页面侧已选规则）                                                                                                                                                                         |
| DNR 同步与广播            | `entrypoints/background/dnrManager.ts`（同步与逐标签页推送）、`entrypoints/background/configSyncState.ts`（推送的送达账）＋ `utils/configSync.ts`（读取端判据）                                                                                                                               |
| DNR 命中统计              | `entrypoints/background/dnrSampler.ts`（`getMatchedRules` 的唯一出口，配额受限）、`entrypoints/background/dnrStats.ts`（id 映射与命中折叠）                                                                                                                                                   |
| 拦截器自报统计            | `entrypoints/background/interceptorStats.ts`（按 `(tabId, frameId)` 的**内存** Map，上限按标签页计、读端跨 frame 求和、与 `swProxied` 交叉校验、不落 storage）、`utils/interceptorStats.ts`（界面侧五态判据，与 `dnrSample` 同类适配器）                                                      |
| SW 保活 / 自动关闭 / 徽章 | `entrypoints/background/{keepalive,autoOff,badgeManager}.ts`                                                                                                                                                                                                                                  |
| i18n（自研响应式）        | `utils/i18n/index.ts` + 根 `locales/{zh_CN,en}/{common,options,popup}.json`                                                                                                                                                                                                                   |
| 主题                      | `utils/theme.ts` + `assets/theme/tokens.css`（`--cop-*`，6 主题 + light/dark/system）                                                                                                                                                                                                         |
| Vue 应用工厂              | `utils/createVueApp.ts`（`createAndMountApp`）                                                                                                                                                                                                                                                |
| 商店文案与权限理由        | `CHROMEWEBSTORE.md`（上架唯一素材源，不在扩展包内）                                                                                                                                                                                                                                           |
| 发版与商店提审 runbook    | `RELEASING.md`（一次性凭据、日常发版、失败排查）                                                                                                                                                                                                                                              |
| GitHub 仓库展示信息       | `GITHUB.md`（About 描述 / website / topics / 社交预览 / Pages 源 / 私密漏洞报告入口，一次性手动清单）                                                                                                                                                                                         |
| 版本历史                  | `CHANGELOG.md`（唯一事实源；release 工作流把对应小节切成 GitHub Release 说明）                                                                                                                                                                                                                |
| 三条自动化链路            | `.github/workflows/{ci,deploy-pages,release}.yml`；共用校验 `.github/actions/verify`                                                                                                                                                                                                          |
| 产品落地页 / 隐私政策     | `docs/index.html`（中，站点根）、`docs/en.html`（英）、`docs/privacy.html`、`docs/llms.txt`（新增页面必须中英成对）                                                                                                                                                                           |
| 商店/落地页图生成         | `scripts/generate-store-assets.mjs`（从 `screenshots/` 派生 1280×800 等精确尺寸）                                                                                                                                                                                                             |
| WXT / 测试配置            | `wxt.config.ts`、`vitest.config.ts`（纯 vitest，alias `@` + node 环境）                                                                                                                                                                                                                       |

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
- **配置下发**：`storage.onChanged` 触发 `dnrManager` 重新同步 DNR，并用 `tabs.sendMessage` 向所有标签页广播（`runtime.sendMessage` 不会到达内容脚本）；MAIN-world 拦截器就绪后主动 `REQUEST_CONFIG` 回放，消除两 world 注入时序竞态。广播按标签页记一笔送达账（只有 http(s) 且 `complete` 的页面参与，桥接层必须同步回执才算送达），弹窗据此说「此页尚未收到最新配置」，详见「项目特有约定」。
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
- `docs/`：GitHub Pages 产品站（静态 HTML/CSS + 两个零依赖、自托管的渐进增强脚本 `docs/assets/landing.js`（交互装配）与 `docs/assets/preview-engine.js`（落地页预演面板用的那份 `utils/urlMatcher.ts` + `utils/dnrRules.ts` 手工副本——它面向读者随手填的四个输入框，说错就是拿产品承诺开玩笑，所以 `tests/landingPreview.test.ts` 按「输入 → 答案」逐个核，抄错一遍就红；零外部 CDN、零远程字体；不参与 WXT 构建）。**中文是默认语言**：中文页占据站点根 `docs/index.html`，英文页带 `en` 前缀（`en.html`、`en-alternatives.html`），新增页面必须中英成对。装配脚本只加 `html.js` 类并接管截图廊控件、滚动淡入、导航高亮、回顶导轨、页头滚动进度条、微信号一键复制、首屏流程图巡航的入视闸门、卡片指针追光、重写预演面板与对比表整列高亮，**所有依赖 JS 的样式状态写在 `html.js` 选择器下**，因此禁用或删除 JS 时页面内容依旧完整可读、可导航（复制按钮不出现，号码本身是可选中文本，预演面板连同它的输入框整个不出现——`html.js.try-ready` 之外的 `.try` 是 `display: none`，措辞与理由码全在 HTML 的 `data-*` 里、脚本只挑属性名，追光与入视闸门不绑定，动画要么不出现要么照常运行，没有任何内容依赖它）；改页面结构时要维持这个降级前提。微信交流群模块（`docs/assets/img/wechat-qr.png` + 微信号 `lld_1025` + 备注关键词 `cxp`）**只出现在两份落地页**：对比页与隐私页保持中立叙述，`CHROMEWEBSTORE.md` 的商店文案里不得出现——详细描述里引导添加个人微信会被判为站外引流。`docs/assets/img/` 需入库供 Pages 访问。
- `store-assets/`、`marketing/`：均为本地可再生/仅本地产物，已进 `.gitignore`；`.test-tmp/` 严禁入库（曾因误提交 Chrome for Testing 二进制把 `.git` 撑到 195MB，2026-09 已重写历史清除）。
- `.github/`：`workflows/{ci,deploy-pages,release}.yml` 三条链路 + `actions/verify/`（CI 与发布共用的唯一校验入口）+ `ISSUE_TEMPLATE/` 与 PR 模板；不参与扩展构建，也无法用 `act`/`docker` 在本机实跑。根目录的运维文档与它同属仓库侧：`GITHUB.md`（手动设置清单）、`RELEASING.md`（发版）、`CHANGELOG.md`（版本历史）、`SECURITY.md`（披露渠道）——均不入库到扩展包，也不放 `docs/`（那是公开站点根）。

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
- 修改消息处理时校验消息结构与 sender；状态修改类消息必须经 `isTrustedSender` 校验；读取类消息**只有** `messageRouter.ts` 的 `CREDENTIAL_READING_TYPES` 那两个例外（`GET_VARIABLES`、`GET_CONFIG_HISTORY`）同样过门禁，判据是「页面永远不会问它、而回包是凭据或整包本地数据」，不是「它属于读取」；除此之外只读消息（含 `GET_IMPORT_PLAN`：纯计算，回包是条数统计加同名同模式条目的「规则名 / 匹配模式 / 新旧目标地址」——它确实会把现网规则的目标地址带回界面，留在门禁外的理由是页面根本没有通往它的路径：桥接层通往 SW 只有 `GET_PROXY_CONFIG`（页面那侧写作 `REQUEST_CONFIG`）、`INTERCEPTOR_STATS`、`CANCEL_REQUEST` 与 `PROXY_REQUEST` 四个出口，这份清单由 `tests/contentBridge.test.ts` 末尾按源码钉住，加一个出口就得回来重判一次 gate）与 `PROXY_REQUEST` 不得加 gate——内容脚本的 `sender.url` 就是页面 URL，加上去代理当场失效。异步 `sendResponse` 路径必须 `return true` 保持通道，并保证每条路径都有响应或明确终止。
- Background SW 随时可能被回收：不得把全局内存当持久事实来源，短期缓存必须可重建、可失效，以 `chrome.storage.local` 为准；长期任务用 `chrome.alarms`（最小周期 1 分钟，不期望秒级精度）。
- DNR 同步前必须过滤非法规则：regex 需经 `isRegexSupported`（RE2）校验、替换串捕获引用不得越界（`isSubstitutionValid`），否则 `updateDynamicRules` 会整批拒绝。
- 向内容脚本广播配置用 `tabs.sendMessage`（`runtime.sendMessage` 不到达内容脚本）；只有 http(s) 且已加载完的页面参与，未送达的按标签页记一笔只存内存的账（`entrypoints/background/configSyncState.ts`），让弹窗说得出「这一页还没收到最新配置」，不再是单纯的静默忽略。
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
- 凭据的三条落点边界（改任一处都要重新看这一段）：规则里的 `{{名称}}` 引用**只在 `proxyHandler` 代发的那一刻展开**，日志、URL 匹配预演与页面侧配置一律保持字面量（`proxyHandler` 因此把 `loggedUrl`/`proxiedUrl` 与 `targetUrl` 分开算）；展开**不递归**，变量值里再写 `{{OTHER}}` 就是它自己；日志详情视图按 `utils/headerMask.ts` 打码显示，判据与导出（`exportSanitize`）同一套，但**只改显示、不改落盘**，「显示凭据原值」不进 storage、抽屉关闭即收回。
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

- 新增 Vue 代码默认使用 Composition API 和 `<script setup lang="ts">`；SFC 顺序保持 `<template>`、`<script>`、`<style>`（仓库现状：14/14 个 `.vue` 都是 `template` 在前，ESLint 未启用 `vue/component-tags-order`，所以这条只靠约定；不要为「对齐文档」去重排已有的 14 个文件）。
- 单一事实来源：源状态尽量少，派生值用纯 `computed`，watcher 只承担副作用并正确清理异步任务。
- Props 只读、事件向上；组件边界用类型化 `defineProps`/`defineEmits`；只有真正的双向契约才用 `defineModel` 或 `v-model:xxx`。
- 根入口组件（`App.vue`）保持为组合与装配层；重型或低频弹窗用 `defineAsyncComponent` 拆出首屏，避免扩大 popup/options 首屏体积。
- 模板保持声明式；列表用稳定 primitive key；避免同元素混用 `v-if` 与 `v-for`；避免在模板中执行昂贵过滤/排序（放入 `computed`）。
- 组件样式默认 `scoped`，优先 class selector；复用 `assets/theme/tokens.css` 的 `--cop-*` 令牌，避免硬编码颜色；`:deep()` 仅用于必要的第三方组件覆盖。
- Element Plus 组件与命令式 API（`ElMessage`/`ElMessageBox`）保持按需加载，其样式需在入口手动 import；不硬编码可见文案，统一走 `useI18n()` 的 `t()`。
- 保持键盘操作、焦点管理、可读标签、对比度与 reduced-motion 等可访问性；不要只用颜色表达状态。

## 国际化与文档

- 单一自研响应式 i18n（`utils/i18n`）：`currentLocale` 为模块级共享 ref，`t(key, substitutions)` 支持 `$1..$9` 占位，**单轮替换**且实参按字面量插入（实参里含 `$&`、`$1` 不会被二次展开，缺失的实参保留占位符本身而不是留空）；组件侧经 `composables/useI18n.ts` 使用；偏好持久化在 `storage.local` 并镜像到 `localStorage`（消除首帧闪烁），`initLocaleSync()` 实现跨页实时同步。**镜像写入的不变量对语言与主题两份同时成立**（`cop_locale` 与 `cop_theme`/`cop_mode`）：镜像只在 `storage.local` 落成功之后刷新——它说的是「下次打开首帧该画什么」，落盘失败时提前写就让镜像领先于事实来源，之后每次打开先按用户没选定的那个值画一帧、再被异步校正回来，恰好是镜像本该消掉的那次闪色；两处各按运行时测，见 `tests/localeMirror.test.ts` 与 `tests/themeMirror.test.ts`。**本仓库无 `i18n-lite`/`tl()` 双体系。**
- 应用文案在根 `locales/{zh_CN,en}/{common,options,popup}.json`，构建期静态合并为扁平字典；新增/删除/重命名 key 时中英 key 集必须一致。
- manifest 名称/悬停短名/描述/命令文案走 `chrome.i18n`，仅维护 `public/_locales/{zh_CN,en}/messages.json`（`extensionName`/`extensionShortName`/`extensionDescription`/`commandToggleProxy`）。**Chrome 上传时硬校验 `name` ≤ 75、`description` ≤ 132 字符（按码点计数），超出直接拒包**；`tests/build-verification.test.ts` 已加回归守卫。
- 商店关键词只加在 `public/_locales` 的 `extensionName`。它仍会出现在 Chrome 应用商店、安装确认弹窗、`chrome://extensions` 列表与工具栏扩展菜单——这是承载关键词的**已知代价**，无法由权限或代码消除；浏览器 UI 上接受显示长名。可收短的两处已收短：工具栏悬停提示走 `extensionShortName`，标签页标题由 `entrypoints/{options,popup}/main.ts` 用应用内 i18n 设置。**测试守卫的是“悬停短名 = HeaderBar 品牌名 = popup 标题”三者一致**；`optionsPageTitle` 带「- 配置 / - Options」后缀是故意设计，不要“顺手对齐”删掉后缀。
- 文档按影响范围更新，中英文表达同一事实：
  - 用户功能、安装或用法变化：`README.md`（中文主文档）与 `README.en.md`（英），并在 `CHANGELOG.md` 顶部记一条（发版时它就是 Release 说明）。
  - 发布、CI、Pages、仓库展示信息变化：`RELEASING.md`（凭据与发版流程）、`GITHUB.md`（一次性仓库设置清单）、`.github/workflows/*` 与 `.github/actions/verify`。
  - manifest 描述、权限、命令或配置变化：`wxt.config.ts` 及对应 `_locales` 文案；同时同步 `CHROMEWEBSTORE.md`（商店文案/权限/截图清单）与 `docs/` 落地页（能力、FAQ、隐私政策）。
  - 商店图或落地页图变化：改 `scripts/generate-store-assets.mjs` 后跑 `pnpm assets && pnpm assets:en`，不手工改图片。

## 测试与验证

- 测试位于 `tests/*.test.ts`，Vitest node 环境；纯函数模块（`dnrRules`/`urlMatcher`/`curlParser`/`har`/`formatters`）可直接单测。
- **已经跑起来测的层，与两类钉不住的层**：除纯函数单测外，存储门面（锁与两份缓存）、桥接层消息流、拦截器三条通道（`interceptorFetch` / `interceptorXhr` 测结局，`interceptorWebSocket` 测选址）、后台 `dnrManager` / `autoOff` / `badgeManager`，以及界面读数层 `composables/{useRequestLog,useProxyStatus}`（`tests/composablesReadouts.test.ts`）与凭据/恢复点读写层 `composables/{useVariables,useConfigHistory}`（`tests/composablesCredentials.test.ts`，含 `SettingsDialog.vue` 那两个布尔闸门怎么被用），以及 DNR 可用性判定的采纳时序 `composables/useDnrSupport`（`tests/composablesDnrSupport.test.ts`：过期轮次整包作废、抛错维持上一份结论）与导入预览的三条失败面 `composables/useImportExport`（`tests/importConfig.test.ts`：本地格式判据一条消息都不发、空回包与抛错各有专属码、`importing` 只锁写入不锁预览）都是**假 `window` / 假 `chrome` ＋ 真实现**按外部可观察面测的。仍没有运行时对应物的两类：① Vue 组件的渲染与交互——node 环境无 DOM，`jsdom` / `@vue/test-utils` 未装（新增 devDependency 需先获批准），这些位置只能靠源码契约（`full-verification` / `docs-consistency`）；② `onMounted` / `onUnmounted` 在组件实例外永不触发，所以 composable 的「挂载即拉、卸载即停表」一律另按源码契约钉，并在文件头写明「本环境测不到的那半」。补这类用例时有三个反复踩到的坑：断言的值必须与「这一轮什么都没发生」**可区分**（初值就是 `false` 时，`toggleProxy(false)` 那一句是空话；同理「落定后为 false」钉不住「压根没置起 true」，忙闲旗标要有一格在途读数），源码契约里被钉的那个表达式若在组件内有多个调用点，`toContain` 只看得到第一处，必须改成数次数，判据是否承重只由单点变异说了算（`.test-tmp/mutate-*.py`，不入库）。
- 修改前先找现有测试；修 bug 优先加“修复前失败、修复后通过”的回归测试；新增逻辑覆盖成功、失败与关键边界。
- 交付前按改动范围执行：
  - TypeScript/Vue/运行时代码：`pnpm typecheck`、`pnpm lint`、相关 `pnpm test`。
  - 通用逻辑、存储、消息路由或跨入口改动：`pnpm test`（全量）。
  - Vue/CSS 样式：`pnpm lint:style`。
  - 入口、manifest、WXT/Vite 配置、依赖或打包行为：`pnpm build`。
  - 文档、JSON 等格式改动：对本次修改文件运行 `pnpm exec prettier --check <files...>`。
  - `docs/` 落地页与隐私政策：除 prettier 外需 `pnpm lint:style`（`docs/assets/landing.css` 受 recess-order 约束），`docs/assets/landing.js` 需过 `pnpm lint`（浏览器全局已在 `eslint.config.js` 的 `docs/**` 覆盖块中声明），并在浏览器里目测渲染（含禁用 JS 的降级态）。中英两页的可见文案、FAQ 条目数与 `FAQPage` 结构化数据必须一一对应：`FAQPage` 的问答需与页面 `<details>` 文本一致，两页的条目顺序也需一致。微信交流群模块只允许出现在两份落地页（对比页/隐私页/商店文案出现即红），中英 README 的章节数、语言互链方向、微信号 `lld_1025`、备注关键词 `cxp` 与二维码路径可解析性由同一支测试守着——只改一边会直接红。改了落地页正文要手工把该页 `dateModified`、页脚「最后更新」与 `docs/sitemap.xml` 里那条的 `<lastmod>` 一起推到同一天（守卫只校验三者**彼此一致**，不校验具体值）。
  - 商店文案改动：`pnpm test`（含 `name`/`description` 字符上限守卫）+ 同步 `CHROMEWEBSTORE.md`。注意 `CHROMEWEBSTORE.md` §0 预算表里的中英详细描述码点数是从正文反算的，改正文必须同表更新（`toBeCloseTo(..., 1)`，即 ±50 码点内），并对该文件跑一次 prettier（表格列宽会随之重排）。
  - `.github/**`（工作流、复合动作、Issue/PR 模板）：`pnpm test`（`tests/docs-consistency.test.ts` 守卫关键契约与 YAML 可解析），并对改动文件跑 prettier；本机无 `act`/`docker`，**工作流无法本地实跑，必须把这一点作为未验证项写进交付说明**。
  - 发版：按 `RELEASING.md` §2（`npm version` + `CHANGELOG.md` 小节 + 全量校验 + `git tag`），推 tag 即触发发布链路。
- 不用会改写整个仓库的 `pnpm format` 处理局部任务；需要自动修复时只作用于本次修改文件。
- 不为通过测试而弱化断言、删除、跳过测试或隐藏错误；命令因既有问题或环境限制无法运行时，交付时如实说明未验证项与原因。

## 项目特有约定

- **双通道分流**：`isSimpleRule` 决定走 DNR 还是 SW。wildcard（以 `*` 结尾）与 prefix 的重写在两通道语义一致，**regex 不一致**：SW 走 `url.replace(regex, targetUrl)`，只替换匹配到的片段；DNR 的 `regexSubstitution` 整体替换整个 URL。因此覆盖不全的正则两通道结果必然不同，这是已知差异而非待修缺陷（只有「规则该走哪条通道」的分流判定需要保持一致）。**新增任何 SW 专属能力都必须让 `isSimpleRule` 返回 false**，否则该能力在网络层通道上静默失效（`sendCredentials` 就是这么加的）。
- **两处已接受的通道差异**（不要再试图"修平"，改之前先读注释与 `tests/channel-consistency.test.ts`）：① wildcard 末尾 `*` 捕获为空时，DNR 的静态模板补分隔斜杠（`https://b.com/`）而 `rewriteUrl` 省略（`https://b.com`）——两者指向同一资源，且既有测试刻意守护 SW 输出；② regex 的整体替换 vs 片段替换（见上一条）。
- **MAIN world 镜像必须同步**：`entrypoints/main-interceptor.content.ts` 自包含、无法 import，其中的 `rewriteWsUrl`、`applyWsQuery`、`normalizePriority`、`methodAllowed` 是 `utils/urlMatcher.ts` 的手工副本（`methodAllowed` 在页面侧被 HTTP 与握手两条通道各调一遍），`DEFAULT_RULE_PRIORITY` 是 `utils/constants.ts` 的手工副本，`null body 状态` / `statusText` / 响应头的 ByteString 过滤是 `utils/proxyResponse.ts` 的语义副本。改这几处 utils 的匹配、重写、查询参数编码、优先级或回包形状约束，必须在同一改动里镜像到拦截器，否则 WebSocket 通道与 HTTP 通道行为分叉、或约束只在桥接层生效（页面侧仍会因 `new Response()` 抛错而永久 pending）；`tests/channel-consistency.test.ts` 末尾的「MAIN world 镜像与 utils 侧同源」按源码契约守卫前一组，`tests/interceptorResponseGuard.test.ts` 守卫后一组，`tests/interceptorWebSocket.test.ts` 末尾那组再补一份**按输入比答案**的行为等价（实测过它的独占方向：只改 `utils/urlMatcher.ts`、忘了镜像时，全仓只有那一组红——文本 grep 与固定断言都拦不住这个方向）。这一组里 `methodAllowed` 那条用的是**整段函数体逐字相同**（空白归一化后比对）：它只拦「有人只改一边」，两份一起等价改写必须保持绿——语义本身由 `tests/urlMatcher.test.ts`（条目侧大小写、`methods: []`）与 `tests/interceptorXhr.test.ts`（页面侧那条通道的落点）分头负责。**长连接的能力面只有三件事**：地址重写（`rewriteWsUrl`）、查询参数注入（`applyWsQuery` → `queryOverrides`）、阻断（连到 `ws://127.0.0.1:1`）；头/体/响应覆盖、Mock、delay、retry、`sendCredentials` 在握手上一律不生效，方法过滤把握手当 `GET` 处理。这条边界由 `tests/wsCapabilitySurface.test.ts` 守着——UI 侧的规则能力徽章与落地页文案都必须按它说话，不要把「WebSocket 支持 Mock/改头」写成卖点。
- **三世界内容脚本**：MAIN 自包含拦截 + ISOLATED 桥接 + SW 执行；两个内容脚本入口都声明 `allFrames: true`（**必须成对改**，只加一边就是半份注入：桥接在 iframe 里收发正常但对端拦截器不存在，复杂规则静默走原生请求，比「整页不生效」更难查——由 `tests/channel-consistency.test.ts` 的「注入范围成对声明」按源码契约守着）；所有 `postMessage` 用 `window.location.origin` 作 targetOrigin（非 `*`）。**targetOrigin 只挡跨窗口，挡不住同页任意脚本**，所以桥接层下发前还要按「本 world 用不用得到」收窄（`entrypoints/content.ts` 的 `toInterceptorConfig` / `PAGE_IRRELEVANT_FIELDS`）：只发复杂规则，并剥掉头/体/响应覆盖、Mock、`sendCredentials`，非 WS 规则连 `queryOverrides` 一起剥——留着就等于把用户放进规则的凭据广播给站点。桥接层还多应答一种**弹窗发来的只读探测**（`entrypoints/content.ts` 的 `PAGE_API_PROBE`：把这一页自己的资源计时里的 fetch / XHR 折成「来源 + 次数」回给弹窗）：它刻意**不进** `MessageType`，因为它只有一个发送方（弹窗）和一个应答方（桥接层），走 `tabs.sendMessage`，所以既不给上面那四个出口添一个，也不占 `isTrustedSender` 的分档；回包里没有任何扩展侧数据（页面自己 `performance.getEntries()` 就读得到同样的东西），因此也不需要门禁。
- **配置广播的送达账只记已知失败**：`broadcastConfigToTabs`（导出仅为可测性）逐个 `http(s)` 且 `status === 'complete'` 的标签页推送，桥接层对 `UPDATE_PROXY_CONFIG` **同步回执** `{received:true}`，后台据此 fulfilled 清账、rejected 记档，而且**逐页各记各的**——一次广播要等最慢的那一页，把记账攒到 `allSettled` 全部落定再做，会把中途刷新那一页刚清掉的账又盖回去（假警告）。`entrypoints/background/configSyncState.ts`：内存 `Set`，上限 `CONFIG_SYNC_TAB_CACHE_SIZE=200`——一次扩展重载会让所有已打开页面同时未同步，收得太紧就是静默丢掉警告；`tabs.onRemoved`、`onUpdated('loading')` 与**内容脚本自己拉配置**（`messageRouter` 的 `GET_PROXY_CONFIG` 顺手清账，因为它下一秒用的就是这份配置）都会清，SW 回收即归零，**不落 `storage`、不参与任何判定**。弹窗那句「此页尚未收到最新配置」经 `GET_CONFIG_SYNC` 读，与 `GET_DNR_STATS`/`GET_INTERCEPTOR_STATS` 同档**不设** `isTrustedSender`。三处刻意排除，否则警告沦为噪声：非 http(s) 页（永远收不到、刷新也救不回）、正在加载的文档（新文档自己会去拉配置）、从来没有这笔账的页面（「不知道」绝不画成「有问题」）；清账只认 `loading` 不认 `complete`，因为需要这句话的页面恰恰早已 `complete`。回包判据只有 `utils/configSync.ts` 一个出口（必须是带布尔 `synced` 的对象，否则连「读到过账」这道闸门都不推开，与 `utils/dnrSample.ts` 同一类「把读端状态收成一句」的适配器）。已知边界：账是**标签页**粒度——不带 `frameId` 的 `tabs.sendMessage` 一次发给全部 frame，任一 frame 的回执、任一 frame 的拉取都会抹掉整页的账，所以这句话说的是「这一页有没有在跑最新配置的 frame」，顶层仍跑旧配置而某个 iframe 刚接住推送时它不会出现；分开两个方向需要 `webNavigation` 级别的定位，刻意不为它加权限。
- **凭据变量只在最后一刻展开**：规则的头/查询值可写 `{{名称}}`，真值存在 `STORAGE_KEYS.VARIABLES`（`'variables'`）里（`utils/variables.ts` 判定与展开、`storage.ts` 读写、上限 `MAX_VARIABLES=50`）。判据是「名称合法 + 表里有值」，**未定义的名字原样保留**并在告警里点名（绝不点值）。三处刻意**不展开**，别把它们改成一致就「修好」了：日志（`proxyHandler` 用未展开的 `loggedUrl`，展开后的 `targetUrl` 只用于代发）、URL 匹配预演、页面侧配置（`content.ts` 下发的是收窄后的规则对象，天然只带字面量）。因为头/查询覆盖本就使 `isSimpleRule` 返回 false，这个能力**不需要**再加分流分支——它必然是后台通道的。展开不递归；WebSocket 规则的查询参数由 MAIN world 拦截器在页面侧拼，那一侧读不到变量表，所以表单保存时就拒绝这种组合（`variableWsQueryUnsupportedError`），不要留到运行时静默失效。两道保存闸门都只拦**这次带进来的**引用（`newlyIntroducedRefs`，基线取存储里那条规则，两闸门各一份）——否则一条导入进来、或手改进 storage 的规则从此连优先级都改不动；WS 那份基线还额外要求存储里那条本身就是 WS，把非 WS 规则改成 WS 时查询参数里的引用按新增算。变量表经 `GET_VARIABLES`/`SET_VARIABLES` 读写，两者都在 `isTrustedSender` 门禁内，`SET_VARIABLES` 还拒绝非键值对象载荷。设置页是**整表覆盖写**，所以读失败时必须拦住下一次提交（`SettingsDialog.vue` 的 `variablesLoadFailed`）——读失败后列表是空的，此时任何一次失焦保存都会把用户已有凭据抹掉，这是新功能自身的数据丢失路径，不是"少显示一条"。
- **页面侧选定的规则必须被 SW 尊重**（`proxyHandler.ts` 的 `resolveSelectedRule`）：拦截器把它命中的 `ruleId` 随 `PROXY_REQUEST` 发出，SW 侧复核（存在 + enabled + 仍匹配该 url/method）后才采纳，不过则回落全量重匹配。这个 id 属不可信输入，**只能当候选校验**，绝不能拿它直接取规则执行——否则伪造 id 就能借别的规则的能力。漏了这道尊重，一条更宽的简单规则会抢走页面已选的窄规则（头注入/Mock 静默失效，`blocked` 形同可绕过）。
- **storage 锁 + 缓存**：read-modify-write 走 `withStorageLock` 避免竞态；配置内存缓存随 `storage.onChanged` 失效。
- **导入预览与配置恢复点**：`utils/importPlan.ts` 的 `planImport` 直接调用存储层用的 `deduplicateRules`，合并键取自 `ruleConflicts.ts` 的 `ruleMergeKey`（`name::matchPattern`）——**判据同源是这支功能存在的全部理由**，预览另写一份差集就会出现「预览说 3 条、实际进 2 条」这种比没有预览更糟的结果。合并必须原子，所以真实写入在锁内重算，界面措辞只能是「预计新增」；合并语义下「同一条规则改了 `targetUrl`」是**新增**而不是更新，预览最大的作用就是把这件事说清楚。恢复点写在 `STORAGE_KEYS.CONFIG_HISTORY`，只由三类整套替换落下：替换式导入、加载快照、真正删掉了东西的批量删除，回退再补一条 `before-restore`；**四例一律排在主写入之后**，且传进去的必须是写之前就已拿在手里的旧配置（写完再读回来就是新配置了）——这一笔最大可到 1M 字符，写在前面会去抢主写入要的配额——安全网自己落盘成功，却把用户要的那次替换挤失败；代价是两次写之间 SW 恰好被回收时这次替换少一份退路。先后顺序由 `tests/configHistory.test.ts` 按**落盘顺序**钉住（四个调用点各一条，只改一处剩下的照样是先记再写），并有一条把整包配额卡在「新配置＋恢复点」之下的用例证明这个先后承重。写入是尽力而为，四条失败面都**只跳过这一份**（快照自己不带规则数组——它同样是 storage 原文、读旧账抛错、新快照单份就越预算、写配额失败），绝不让已经落盘的主写入翻成失败，也**绝不能顺手抹掉已在预算内的旧恢复点**——用户刚做完整套替换，那几份是他唯一的退路；预算自己收口（`MAX_CONFIG_HISTORY` ＋ `MAX_CONFIG_HISTORY_TOTAL_SIZE`，**不用** `getBytesInUse()`——Chrome 已不报 `quotaBytes`），读侧再按 `MAX_CONFIG_HISTORY` 截一次，兜住手改进 storage 的无界列表。`restoreConfigHistory` **不动总开关**（快照记了 `enabled` 但不采用），并拒绝 `ruleCount > MAX_RULES` 的快照；页面侧读它只能经 `GET_CONFIG_HISTORY`（门禁内），因为快照里可能是被手改过的规则原文。`SCHEMA_VERSION=2` 由导出盖章、由 `readImportPayload` 与导入共用判读，分得出 `INVALID_CONFIG` 与 `SCHEMA_TOO_NEW`——**只拒新、不拒旧**，别让既有 v1 文件失效。同源判据、恢复点触发条件与门禁分档分别由 `tests/importPlan.test.ts`、`tests/configHistory.test.ts` 与 `tests/messageRouter.test.ts` 守着。
- **日志缓冲写入**：达 10 条或 1s 防抖 flush，且 flush 串行化避免并发覆盖丢失；`onSuspend` 时 `flushLogs`。flush 失败要把快照放回缓冲（仍按 `MAX_LOG_ENTRIES` 收口），否则配额持续失败时缓冲区只涨不落。写入前两道收口（都在 `utils/storage.ts` 的 `capLogEntry` 一处，因为 `proxyHandler` 有五条分支写日志）：正文超 `MAX_LOG_BODY_SIZE` 截断留痕，URL/方法/规则名/错误文案/头值超 `MAX_LOG_FIELD_SIZE` 同样截断、头表超 `MAX_LOG_HEADER_COUNT` 条丢弃多余；`trimLogsToBudget` 再按 `MAX_LOG_TOTAL_SIZE`（**整条日志的字符量**，不只正文）从最新一条开始累加、超预算即丢弃其后（至少留最新一条，避免整份清空）。
- **DNR 命中统计**：`getMatchedRules` 近 5 分钟窗口，配额约每 10 分钟 20 次；采样出口只有 `entrypoints/background/dnrSampler.ts`（全局 60s TTL、按标签页 15s TTL、滑窗 18 次预算、超限 60s 退避，退避期返回 `stale: true` 的缓存而不是报错）。读端返回的是 `DnrSample`，UI 侧的五态判据只有 `utils/dnrSample.ts`：`fresh`/`stale`/`notApplicable`（无生效的网络层规则）/`unavailable`（读不到）/`pending`，「0 次」与「不知道」绝不能合并成一句，也绝不能渲染成 0；能不能把计数当命中数画出来，只问 `isDnrCountReadable`（`fresh`/`stale` 才是「有读数」），`hits: null` 统一表达「没有读数」。两个统计窗口（DNR 的近 5 分钟 vs SW 的自配置变更以来）**不可相加**，聚合入口 `utils/ruleStats.ts` 的 `groupHitStatsByRule` 返回 `{ net, ext }`，规则列表因此分两格显示、绝不相加；**每格只画属于自己那条通道的数**——通道逐条由 `isSimpleRule` 判定（刻意不经总开关，否则刚禁用的网络层规则会在滚动窗口里丢掉真实命中数），不适用的那一格画「—」并配一句点名通道的提示（`hitStatsNetNotApplicable` / `hitStatsExtNotApplicable`），网络层那一格在读不到时同样是「—」，两格都是「—」时整列折叠成「-」。
- **代理自动关闭**：总开关开启且配置时长时用 `chrome.alarms` 倒计时（跨 SW 重启持久化），到期自动关闭总开关。
- **主题**：`--cop-*` 令牌 + `data-theme`/`data-mode`；6 主题（sky/green/pink/mauve/orange/slate）+ light/dark/system；同步覆盖 Element Plus `--el-color-primary` 梯度。新增引用必须在 `assets/theme/tokens.css` 里已定义（未定义的 `var()` 让整条声明在计算值阶段静默失效），`-rgb` 通道令牌存的是空格分隔值、只能写成 `rgb(var(--cop-primary-rgb) / 15%)`；两条契约由 `tests/designTokens.test.ts` 守卫。首帧不闪：`initThemeSync()` 在挂载前用 `localStorage` 镜像键 `cop_theme`/`cop_mode` 同步打上标记（`storage.local` 仍是事实来源，镜像只是消掉首帧的默认主题），该契约由 `tests/themeMirror.test.ts` 守着。
- **容量限制**：`MAX_RULES=200`（新增、批量新增与导入的两种模式都超限拒绝，恢复点回退同样拒绝超限快照）、`MAX_VARIABLES=50`（凭据变量表：名称合法、值 trim 后非空且不超长才落盘，其余按 `dropped` 计数回报）、`MAX_CONFIG_HISTORY=5` ＋ `MAX_CONFIG_HISTORY_TOTAL_SIZE=1M` 字符（配置恢复点：从新到旧收口，**刻意不保留至少一份**——单份就超预算时跳过这一份（预算内的旧账原样留着），不能撑爆配额，也不能顺手抹掉退路）、`MAX_LOG_ENTRIES=500`（环形缓冲）＋ `MAX_LOG_BODY_SIZE=32K` 字符／`MAX_LOG_FIELD_SIZE=8K` 字符／`MAX_LOG_HEADER_COUNT=64` 条／`MAX_LOG_TOTAL_SIZE=4M` 字符（见「日志缓冲写入」）。
- **四处已确认的可访问性/首屏取舍（前 3 处 2026-09-14 定，第 4 处 2026-09-21 定，不要「顺手修」）**：
  1. **次要文字对比度维持 Element Plus 默认**：`--cop-text-color-secondary: #909399` 在白底 3.08:1、`--cop-text-color-placeholder: #c0c4cc` 1.56:1，低于 WCAG AA 的 4.5:1。刻意不压暗——这两个值与整个组件库同源，单独调会让本扩展界面与 `el-*` 其余部分观感割裂。
  2. **规则拖拽排序只有指针路径**：`RuleTable.vue` 的行 `dragstart` 无键盘等价物。键盘用户改优先级数值可达到同样的生效顺序，只有「列表顺序」这一件事是鼠标独占。
  3. **7 个 Options 弹窗不做 `v-if` 惰性挂载**：`defineAsyncComponent` 只保证分片不进首屏 chunk，页面挂载时仍会取回并实例化全部弹窗（约 130kB JS + 60kB CSS）。收益仅几毫秒到二十毫秒，而改造要碰每个弹窗的初始化路径——见「常见陷阱 · Element Plus / i18n」。
  4. **弹窗「页面自报」那一行的完整四个数只有指针可达**：句子上只带两个数，其余三个数与采信时刻走原生 `title` 悬停，没有点击展开、也没有 `focus`/键盘唤出。这一行是**纯展示的诊断线索**（可被同页脚本伪造，绝不参与判定），为它加可聚焦语义与展开状态，把「最不该被当结论的数据」抬成了界面主角；句子本身已经说了最该先知道的那件事。
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
- 业务优先级与 DNR 优先级方向相反（数值越小越先匹配 → `toDnrPriority` 反转）。反转结果必须钳制在 `[1, DNR_MAX_PRIORITY]`：`priority` 越界与 NaN/小数同罪，是**整批** `updateDynamicRules` 被拒，而表单给不出的负数优先级（导入文件、手改 storage）恰好会翻过上限。

### 内容脚本

- `runtime.sendMessage` 不到达内容脚本，广播配置需 `tabs.sendMessage`（未注入页面报错；这类失败现在按标签页记账，见「项目特有约定」的送达账一条）。
- **桥接层对 `UPDATE_PROXY_CONFIG` 的回执是后台唯一的送达信号**：那句 `sendResponse({ received: true })` 删掉之后页面功能一点不受影响，但 `tabs.sendMessage` 的 Promise 在「有监听器却不作答」与「压根没有内容脚本」两种情况下同样 reject，送达账于是把每个页面都记成没收到，弹窗对整站警告一句「刷新即可」——一个只在渲染上看不出的改动，却把诊断变成了噪声。新增任何「靠回执判断送达」的广播都照这条办，由 `tests/configSyncState.test.ts` 的源码契约钉住。
- **桥接层的 `PROXY_REQUEST` 解构排在 `try` 之外**：`entrypoints/content.ts` 里 `const { data } = event.data` 与紧接着那句 `logger.debug(..., data.requestId)` 都在 `try` 之前，所以一条缺 `data` 的同频道消息会在监听器里抛 TypeError——不走 catch 那份 `status: 0` 信封、也不落 `logger.error`，只是这一 frame 多一个未处理拒绝（真实拦截器永远带 `data`；同页脚本伪造它也误代理不了任何请求，越权面在规则匹配那侧）。挪进 `try` 会让页面收到一份 `requestId` 为空串的回包，那是改行为，已列为待确认点；现状由 `tests/contentBridge.test.ts` 末尾「现状记录」那条钉住，**别当成断言空转删掉**。
- MAIN-world 必须自包含：重复类型定义、无 `chrome.*`、不能 import logger（直接用 `console.warn`）。
- **注入到全部 frame 之后，「这一页」的账是跨 frame 合起来的**：拦截器的四个计数是**每个 frame 各自**从 1 数起的，所以 SW 侧的交叉校验基线也必须按 `(tabId, frameId)` 各记一本（见 `entrypoints/background/interceptorStats.ts`），否则顶层已代发的数会把 iframe 那份诚实的自报整包判成谎话、弹窗那一行从此冻结；`swProxied` 与四个数在**读端**才求和，`updatedAt` 取最近一次被采信的时刻。取消登记的 `requestId` 同样只在 frame 内唯一，键必须是 `tabId + frameId + requestId`（`proxyRequestKey`）。已知边界：`tabs.onUpdated` 只跟主框架导航，iframe 单独换文档时它那本账不会复位，表现是界面维持上一次的旧读数（陈旧，不是假数），刻意不为此加 `webNavigation` 权限。
- 阻断规则不得回退原生 `fetch`/`XHR`/`WebSocket`，否则被阻断的请求会实际发出；非字符串 body（FormData/Blob/ArrayBuffer）不能跨 `postMessage`，除阻断外回退原生。
- **同步 XHR（`open(m, u, false)`）同样只能回退原生**：代理要经 postMessage 往返 ISOLATED world 与 SW，响应只能在调用栈返回**之后**到达，而 `send()` 返回时结果必须已就绪——代理它等于把 `status`/`response` 读成空值，比报错更糟（看起来像服务端返回了空响应）。判据只认第三个实参**显式为 `false`**（省略即异步），`__proxySync && !rule.blocked` 才走回退，回退提示一个页面只打一次（同步 XHR 常在循环里）；由 `tests/syncXhrFallback.test.ts` 按源码契约守着。
- 回包形状三处约束（`204/205/304` 只能配 null 正文；`statusText` 与响应头的名/值必须是 ByteString，即码点 ≤ 255 且不含 CR/LF）任何一处漏了，`new Response()`/`new Headers()` 就在 `resolve` 回调里抛 TypeError——超时已被 `clearTimeout` 摘掉、又不走 reject，页面的 fetch/XHR 从此永久 pending。判据住在 `utils/proxyResponse.ts`（桥接层）并被 MAIN world 镜像一份（那边自包含无法 import），拦截器另有 `try/catch → reject` 兜底；两侧契约由 `tests/proxyResponseGuard.test.ts` 与 `tests/interceptorResponseGuard.test.ts` 守着。
- **拦截器自报计数是旁路观测，不得反过来参与判断**：`entrypoints/main-interceptor.content.ts` 的 `bump(kind)` 只挂在四个既有时机上（命中规则后、交给后台后、回退原生处、超时回调里），调用点共 8 处——`intercepted` 在 fetch 与 XHR 命中处各一次，`fellBack` 四处（fetch 的非字符串 body、fetch 的代理失败、XHR 的同步请求、XHR 的非字符串 body；**XHR 的代理失败不在其中**——那条不回退原生，它直接把 `status` 置 0 派发 `error`，所以只落 `intercepted` 一笔），**不加 `try/catch`、不新增分支、不参与任何 fallback 决策**（少一笔计数可以，影响用户的请求路径不行）。四个数按节流 `postMessage` 给桥接层，桥接层**只挑这四个键**转发（不带 URL/头/body），SW 侧 `entrypoints/background/interceptorStats.ts` 按 `(tabId, frameId)` 分账存在**内存** Map（外层键是标签页、内层是 frame，上限 `INTERCEPTOR_TAB_CACHE_SIZE` 按标签页计，按最近写入序逐出——自报与代发各刷新一次位置，popup 读取不刷新，所以不是 LRU；`tabs.onRemoved` 与文档 `loading` 时清空，SW 回收即归零）。这些数**由页面自报、同页脚本可伪造**（桥接层只认 `event.source === window` + channel，与 `PROXY_REQUEST` 同级），因此只在弹窗那一行「页面自报」显示、绝不写 storage、绝不做 gate、绝不参与判定；唯一不受页面影响的校验是 SW 自己数的 `swProxied` 基线——自报的 `proxied`/`intercepted` 低于它就整包拒收，界面因此**维持上一次被采信的读数**（从没采信过时才落到「无可采信读数」那一句），绝不画出可疑的数（此外两道都只看包内：任一计数非法、四个数自相矛盾（`proxied`/`fellBack` 超过 `intercepted`，或 `timedOut` 超过 `proxied`——诚实路径必然满足）、四个数全 0（诚实的拦截器发不出这种包，它只会把上一条真读数盖成绿色的「拦到 0 个」）都整包丢弃）。五种状态（`noData`/`noReport`/`fellBack`/`timedOut`/`active`）各占一句话，优先级是回退 > 超时 > 正常（一句话只放得下最该先知道的那件事，其余的数在悬停里），其余情况整条不显示，「不知道」与「没有」绝不合并，判据只有 `utils/interceptorStats.ts` 一个出口（与 `utils/dnrSample.ts` 同一类「把读端三元组收成状态」的适配器，但没有配额那一半）。WebSocket 握手刻意不计数。由 `tests/interceptorStats.test.ts`（含 MAIN world 与桥接层的源码契约）守着；页面侧节流与那一行的渲染无法在 node 环境单测，2026-09-21 已在真浏览器（Chrome for Testing + CDP）量过：一笔请求发两包（首包立刻、尾包 +1s），25 笔并发只多发 5 包，终值收敛为「拦到 27 · 交给后台 26 · 回退原生 1」，五种状态在弹窗真实宽度（`.popup-container` 352px）下中英文都不被裁。

- **拦截器的三条通道按运行时测**（`tests/interceptorFetch.test.ts` / `tests/interceptorXhr.test.ts` / `tests/interceptorWebSocket.test.ts`：假 `window` ＋ 真的 `main()`，断言的是「这一笔到底发出去了没有、以什么落定」，而不是「那几行字还在」）。XHR 那份假对象有两处形状是承重的，改夹具前先读它的文件头：① 六个只读响应属性必须是**原型上的访问器**（Chrome 就是如此）——放在实例上时 `defineProperty` 缺省的 `configurable` 等于「不改」，「实例复用第二遍回填抛 `TypeError`」这个真实失败面永远重现不出来；② 换实现那一步不需要夹具配合（ES class 的原型方法本就 `writable: true`，这里曾写过一条相反的要求，是错的），真正承重的是**每次挂载都新建一份假类**——拦截器在 `main()` 开头把 `prototype.open/send/abort` 存成「原生方法」，沿用上一次的实例就等于把被替换过的那份当成原始实现存下来。顺带核到的一件事：那两个旗标**并不对称**——只漏 `configurable: true` 就会让复用实例的第二遍回填当场抛（新建的那份 own 属性不可重定义），只漏 `writable: true` 不会（`configurable` 还在时整份重定义本就允许改值），所以承重的是 `configurable`，`writable` 是防御性的第二道；两侧各是一条变异锚点，别把任一处当冗余删掉。WebSocket 那条通道测的是**选址**，不是通话：假构造器只登记「交给原生那一份的实参」，其中承重的是两处形状——它是 `main()` 开头存下的**原生**那一份，以及它记的是**实参个数**（`protocols ? …` 走真假值，空串与「没传」在值上同形、在个数上不同形，而真浏览器把 `new WebSocket(url, '')` 判成非法子协议）。握手与帧语义刻意不造假（假握手本身会变成被测物的主要风险源），那半仍只有源码契约（`wsCapabilitySurface`）——再往握手语义加行为时，优先想办法补运行时用例。

### Storage

- 统一使用 `storage.local`（无 `storage.session`、无加密）；read-modify-write 必须走 `withStorageLock` 避免竞态。
- **锁与两份缓存按运行时测**（`tests/storageLockCache.test.ts`：并发 `addRule` / `toggleProxy` / `deleteRule` 不互相盖掉、`storage.onChanged` 让配置与凭据表失效、命中缓存不再读盘）。给这类测试做 `chrome.storage` 桩时**必须让 `get` 返回深拷贝**：真实 Chrome 给的是反序列化副本，而桩若返回同一个对象，两个并发读者天然共享同一个数组，「锁有没有生效」就成了自证——摘掉锁也照样绿。两件事顺带钉住：① `withStorageLock` 里那两处吞拒绝的写法互为备份，单独摘任一处都不改变任何可观察结果（变异清单里两半各摘过一次，都不红），一起摘掉才是另一回事：**失败之后的每一笔都不再执行、直接以第一次那个拒绝落定**——队列没有挂起，但从那一刻起谁也写不进 storage，所以别把其中任何一处当冗余删掉；② **写入失败同样要失效缓存**（`saveProxyConfig` 的 `finally`），否则内存里留下一份 storage 中不存在的配置，而下一次「读出→就地改→写回」会把它当真写回去。
- **`getProxyConfig()` 交出的是缓存对象本身，不是副本**：同一上下文里的就地改因此对后续读者立刻可见，也省掉一次深拷贝。别把这条当成「改成返回副本会丢更新」的理由——`toggleProxy` / `addRule` / `updateRule` 全是「改完把同一个对象交给 `saveProxyConfig`」，返回副本照样写对。身份真正的后果是一个已记录的口子：存储里没有 `proxy_config` 键时，交出的就是 `DEFAULT_PROXY_CONFIG` **那个模块常量本身**，于是就地改会写脏常量（同一份常量还被 `background.ts` 的 install 分支原样写进 storage；可达窗口很窄：首次安装、或 devtools 手删该键，与下面那条徽章边界同源）。现状由该文件的「现状记录」那条钉住，并由该文件 `beforeEach` 里的常量守卫兜住，修（回落时给一份新副本）会让前者红，届时请连同待确认点一起更新，别只删断言。
- **从 storage 读出的配置对象不能直接 `.rules.filter(...)`**：手改或被截断的旧数据能让那个键变成对象/字符串/缺失，`.filter` 当场抛 `TypeError`，而 `storage.onChanged` 监听器没有接手人——徽章从此停在改动前那个数字。取规则数组只走 `utils/storage.ts` 的 `configRules()`（非数组一律当空），`badgeManager` / `background.ts` 的徽章监听 / `proxyHandler.getProxyStatus` / `proxyHandler` 的代发入口四处共用它。**唯一的读取侧例外是 `messageRouter.ts` 的 `handleImportPlan`**：那里 `config.rules` 是预演的对照物，「读不出」当不成「现网是空的」——换成 `configRules()` 会把「预览失败」一律升级成「预览说谎」（`replaces` 报假数、已有条目全算成新增），所以让它抛；坏数据的三种表现（键不见→两种模式都抛、`rules` 是字符串→替换模式把字符数当成现网条数、收口成「当空」→ 报出一个好看的假数）与「调用点原样交 `config.rules`」这条本身，由 `tests/importPlan.test.ts` 末尾的现状记录钉住。**两个内容脚本 world 是刻意的例外**：`toInterceptorConfig` 与拦截器的 `SYNC_RULES` 分支各自本地判一次 `Array.isArray`（MAIN world 自包含；桥接层引它会连带存储门面和一个用不到的 `chrome.storage.onChanged` 监听进每个 frame），只补一边就是半边同步照旧抛——症状是那一页的复杂规则静默走原生请求，成对性由 `tests/channel-consistency.test.ts` 钉住。**存储写入路径两边都不用**：那里 `rules` 不是数组就该失败得响亮，当成空数组写回去等于抹掉用户已有的规则。一条**已知未收口的边界**：监听器外面那层 `if (newConfig?.rules)` 在键整个不见时直接不重算，徽章同样停在旧数字——`configRules()` 管不到它（收口要改的是「什么时候重算」，属于既有语义取舍）。同族的另一件事：**把形状当闸门的 `Array.isArray` 不是取值，不归它管**。`dnrManager` 有三处这样的闸门（配置变更监听器要求数组才同步、广播早退、启动同步把非数组当空集重建），它们选的是「输入坏了以后保留上一份规则集、还是撤掉网络层重定向」，三处方向并不一致——同一份坏 storage 在 SW 重启前后网络层行为不同，而那一刻弹窗的「活跃规则」已经是 0。统一任一侧都是改行为，已作为待确认点交付；现状由 `tests/dnrManagerSync.test.ts` 逐条钉住。

### 仓库体积

- `.test-tmp/`（含下载的 Chrome for Testing，约 558MB）只能留在磁盘、绝不能入库；已进 `.gitignore`，历史已于 2026-09 用 `filter-branch` 清除（`.git` 195MB → 2.2MB）。
- GitHub 单文件硬上限 100MB；任何二进制、抓包产物、浏览器下载件都不得提交，新增图片前先确认体积与必要性。

### WXT 构建

- 当 popup 入口 HTML 存在**非空 `<title>`** 时，WXT 会用它推导 `manifest.action.default_title` 并覆盖 `wxt.config.ts` 里的同名声明（`wxt/dist/core/utils/manifest.mjs`，实测于 0.20.27）。因此悬停提示只能改 `entrypoints/popup/index.html` 的标题；若将来 popup 标题被删空，配置里的值会重新生效——升级 WXT 后需复核这一行为。
- Chrome **不替换**扩展页面 HTML 里的 `__MSG_x__` 占位符（只对 manifest.json 生效），所以页面 `<title>` 里写占位符会直接以字面量出现在标签页上；需本地化时用入口 `main.ts` 设 `document.title`，静态值只作首帧兜底。
- 干净检出跑 `pnpm typecheck` 前必须先 `pnpm exec wxt prepare`（`.wxt/` 不入库，CSS 模块与 `import.meta.env` 类型均来自它）。

### 发布与 CI

- **版本号只在 `package.json`**。`wxt.config.ts` 刻意不声明 `manifest.version`（WXT 回落并削去预发布后缀），加回去就是双份事实源；`tests/build-verification.test.ts` 故意拒绝两者不一致。
- **首次商店条目必须手动建**。`publish-extension`（`wxt submit` 的底层）不提供新建能力，必须先在 Dashboard 上传一次 zip 拿 Extension ID；之后才能由 `release.yml` 上传+提审。
- **GitHub Pages 的 Source 必须是「GitHub Actions」**，否则 `deploy-pages` 报 "Pages not enabled"；而 `docs/` 就是站点根，`/privacy.html` 已写进商店详细描述与 `llms.txt`，改路径基、目录布局或仓库名都会打断隐私政策。
- **仓库展示信息（About 描述 / website / topics / Pages 源 / 社交预览图）不能靠 `GITHUB_TOKEN` 改**，只能仓库所有者在 UI 手动填（逐项值见 `GITHUB.md`）。
- **工作流 YAML 本地无法跑**（本仓库机器无 `act`/`docker`）：改 `.github/**` 后至少做 YAML 解析校验（`tests/docs-consistency.test.ts` 已覆盖关键契约），并如实把「未实跑」写进交付说明；首跑就是在 GitHub 上跑。
- **`.env.submit` 永远不入库**（`wxt submit init` 会写进去，内含 refresh token）；`store-assets/`、`marketing/`、`.test-tmp/` 同样不得入库。

### Element Plus / i18n

- 禁止整包导入；`ElMessage`/`ElMessageBox` 为显式导入，其样式需在入口手动 import。
- **异步弹窗的初始化必须挂在带 `immediate` 的 watcher 上**：7 个弹窗都是 `defineAsyncComponent` 分片，两条路径会让分片**带着 `visible === true` 挂载**——`#add-rule` / `#add-rule-from-tab=` / `#profiles` 在 `App.vue` 的 `onMounted` 里同步置位，以及首次点击时分片尚未取回。只监听变化的 `watch(() => props.visible)` 在那条路径上永不触发，初始化被静默跳过。`RuleFormDialog` / `ProfilesDialog` / `SettingsDialog` 三处现已统一带 `immediate: true`，`ProfilesDialog` 也不再靠 `el-dialog` 的 `@open` 拉列表（该事件只在 `modelValue` 的 watcher 里 emit，挂载即可见那条分支不调它）。新增弹窗若用 `props.visible` watcher 做初始化或拉数据，必须带 `immediate`、不得只靠 `@open`；`tests/full-verification.test.ts` 三条源码契约守住这两点，外加「hash 入口对应的弹窗必须在守卫清单内」。
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
