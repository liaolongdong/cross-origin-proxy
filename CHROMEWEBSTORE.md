# Chrome Web Store Listing — 跨域代理助手 / Cross-Origin Proxy

> Last Updated: 2026-09-15
> 本文件是商店上架的唯一素材源：把这里的内容逐项复制进 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)。
> 商店表单（名称/描述/截图/权限理由/数据披露）无法由 API 代写，只能手动粘；**包上传与提审已经自动化**，见第 11 节。
> 本文件位于仓库根目录，不在 `.output/chrome-mv3` 内，因此不会被打进上传包。

## 0. Keyword strategy（为什么这么写）

Chrome 应用商店搜索的权重顺序是 **名称 > 摘要（manifest description）> 详细描述 > 分类/语言**。三条自动化链路都在名称上收手：名称结构已经是「品牌名 - 能力 A · 能力 B · 能力 C」，每个词对应真实功能，再往上堆词就是拿审核换曝光。当前中文 36/75、英文 52/75，剩下的预算**刻意不吃**——2026-09-12 复核过一次并确认维持现状，不要因为「预算还没用满」就去扩名称。

优化重心因此放在后两个字段：

| 字段     | 预算       | 当前投入                | 说明                                                                                                                     |
| -------- | ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 名称     | 75 码点    | 36 / 52                 | 只承载品牌 + 三个真实能力词，不再扩张（堆砌是拒审高危字段）                                                              |
| 摘要     | 132 码点   | 100 / 127               | 中文补齐最高意图词「跨域」「联调」，英文补 `retry`；两边都留白以免搜索结果被截断                                         |
| 详细描述 | 16000 码点 | 中约 3.79K / 英约 9.89K | 参与索引且仍有大量余量；扩容只加**新的内容类型**或补本节关键词表已承诺、正文却缺失的落点，不把同一批能力换个说法重述一遍 |

| 目标查询                                                    | 用户怎么搜                     | 落点                                                                  |
| ----------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `cors` / `cross origin` / `跨域`                            | 报错来搜的人，量最大、意图最强 | 名称（中英）、摘要（中英）、详细描述症状行与「规则生效后仍报 CORS」段 |
| `同源策略` / `same-origin policy`                           | 先查概念再找解法的人           | CORS 解释段                                                           |
| `api proxy` / `request proxy` / `请求转发`                  | 明确要代理工具                 | 名称、摘要、能力清单                                                  |
| `environment switch` / `环境切换` / `联调`                  | 中文前端场景词，竞争小、转化高 | 中文名称、摘要、详细描述                                              |
| `mock api` / `mock 数据` / `假数据` / `fake data`           | 后端未就绪的前端               | 名称（Mock）、能力清单、典型配置示例、「谁会用上它」                  |
| `modify request headers` / `response override` / `throttle` | 抓包改包与弱网模拟需求         | 能力清单、典型配置示例                                                |
| `websocket proxy`                                           | 长连接联调，几乎无同类扩展     | 摘要 + 能力清单 + 症状行（差异化点）                                  |
| `devserver proxy` / `devServer` / `本地跨域`                | 想换掉逐项目配置的人           | 首段痛点、症状行、与「开发代理」与「改项目配置」的对比段              |
| `timeout` / `http 500` / `弱网` / `超时模拟`                | 要验异常与兜底态的人           | 能力清单、典型配置示例、「谁会用上它」（QA 那一行）                   |

> 2026-09-15 复核过这一列，**最高意图词不在详细描述首句是刻意的，别去"补"**。实测：中文名 `跨域` ×2、英文名 `Cross-Origin` + `CORS`，两边摘要各命中一次，详细描述里中文 `跨域` 只出现 1 次（在「跨域校验不再适用」那段）、英文 `cross-origin` 3 次——首句都留给了 FAT→UAT 场景，症状行留给了 `blocked by CORS policy` 这个报错原话。Chrome 对同一个词只索引一次，而这两个词已经落在权重最高的名称与摘要上，再去改首句等于拿转化率换一次重复索引。2026-09-15 同时确认英文名已含 `cross-origin` / `CORS` / `environment`，因此英文摘要开头保留 FAT/UAT 场景叙事、不换成跨域措辞。

描述里的内容块各自都有一个转化或检索目的，不是为了把字数填满：

- **症状行**（「控制台报 blocked by CORS policy……」）：用户搜商店时用症状词而不是功能词，这一段把那些说法原样落进索引，同时让读者在前几行认出「说的就是我」。
- **典型配置示例**：给出可直接照抄的 match → target 形状，把「能力清单」翻译成「我下一步会怎么填」，并在截图之外提供可抽取的文本。
- **角色分组**（「谁会用上它」）：同一种能力在前端、全栈、测试、交接四种说法下被检索，按角色切分比把能力清单复述一遍更能命中查询措辞，也直接回答「这算不算给我这个场景做的」。
- **CORS 仍报错那一段**：与「装了没生效」并列的头号差评来源，且它是**真实机制**（纯地址重写仍是页面的跨域请求），只写在 README 与落地页等于把最容易误解的点留给差评。
- **与抓包代理/项目配置的共存与越界段**：不装证书、不改系统设置、不占系统代理端口、不写项目文件——这些是相对系统级代理与 devServer 配置的真实差异化成本账，写在「差别」段里而不是散进能力清单。
- **零远端依赖段**：面向企业内网与合规审查的说法，同时给审核对「数据不外传」的疑问一个可核对的落点。
- **排查清单**：`<all_urls>` 类扩展的差评与申诉几乎都来自「装了没生效」，把排查顺序写进商店描述能同时降低差评率与审核沟通成本；其中「正则必须覆盖整条 URL」是本扩展两通道的真实差异（见第 9 节）。

刻意**不做**的事：不在名称里堆同义词（Chrome 会因 "misleading keyword stuffing" 拒审，且 AI 检索研究里关键词堆砌反而降低可见度）；不写 "best"、"#1"、"free" 这类词；不出现 "Chrome" 字样冒充官方；不引用其他产品商标（详细描述里的对比段只写**方案类别**，不点名产品，避免不可核验的主张）；详细描述里不写版本号，避开每次发版都要改商店文案；不为了吃满 16000 码点而把同一批能力换说法重述。

## 1. Store listing

### 1.1 中文（中国）列表 — 默认语言

**Extension Name**（≤75 字符，当前 36）

```
跨域代理助手 - CORS 跨域调试 · API 环境切换 · Mock
```

**Short description / manifest description**（≤132 码点，当前 100，与 `public/_locales/zh_CN/messages.json` 的 `extensionDescription` 同源）

```
前端跨域联调不用改代码，也不用请后端改 CORS：把 API 请求代理到 FAT/UAT/PROD 环境，支持 URL、请求头与响应改写、条件化 Mock、延迟、阻断、重试与 WebSocket 转发
```

**Detailed description**（≤16000 字符；商店会剥掉 Markdown，故用换行与短横线排版）

```
前端连着 FAT，要验的改动只在 UAT——这个扩展让你在浏览器里加一条规则就完成跨环境联调：不用改应用代码，不用在每个项目里维护 devServer 代理表，也不用请后端加一条 CORS 配置再发一次版。

如果你遇到过下面任意一种情况，它能直接省掉那一步：
- 控制台报 blocked by CORS policy / Access-Control-Allow-Origin，而后端不是你负责部署的
- 本地 localhost 起的页面要调内网测试环境的接口
- 接口还没写好，前端要先把界面跑通
- 要验证超时、500、断网时的兜底 UI，却没法让后端配合制造这些情况
- 想给请求换一套目标环境的鉴权 token，又不想把它写进代码里
- 实时功能（WebSocket）也要跟着同一套环境切换走
- 想把一整套联调配置交给同事，而不是靠口述和截图

它能做什么：
- 按通配符、前缀或正则匹配请求地址，转发到你指定的另一个环境
- 注入或替换请求头（例如目标环境的鉴权 token），替换请求体
- 响应改写：替换响应状态码、响应头，或按路径替换 JSON 里的某个字段（如 data.token）
- 假数据 / Mock：接口还没写好时，直接返回你准备的 JSON / 文本 / HTML / XML
- 条件化 Mock：一条规则里配多个条件（URL 正则、请求方法、查询参数），首个命中的条件决定响应体、状态码与 Content-Type
- 注入 0–60000 毫秒延迟模拟弱网，用来验证骨架屏、加载态与超时处理
- 阻断请求，用来验证异常提示与离线兜底；被阻断的请求不会被回退重发
- 失败自动重试：网络错误、5xx 响应与单次 30 秒超时都会触发，重试 1–5 次、间隔 100–30000 毫秒可调
- 按 HTTP 方法限定规则（GET/POST/PUT/DELETE/PATCH/OPTIONS/HEAD），或在代理后的地址上追加、覆盖查询参数（灰度标识、__env=uat）
- 转发 WebSocket 长连接，让实时功能跟着同一套环境走
- 只做 URL 重写的简单规则由浏览器网络层完成（declarativeNetRequest），不给页面增加脚本开销；关闭总开关时这层规则一并卸载，不会留下隐形重定向

典型配置（示例域名换成你自己的）：
- 跨环境转发：匹配 https://fat-api.example.com/* → 目标 https://uat-api.example.com
- 换目标环境的鉴权：在上面这条里加一个请求头覆盖 Authorization: Bearer <你的 UAT token>
- 接口未就绪：开启 Mock，状态 200、Content-Type application/json、响应体贴你的示例 JSON
- 弱网与超时：开启延迟，填 3000–8000 毫秒
- 异常兜底：开启阻断，或把响应状态码改写成 500
- 灰度与 A/B：在代理后的地址上追加查询参数 __env=uat
- 只把写操作打到测试环境：把规则限定在 POST / PUT / DELETE

谁会用上它：
- 前端：后端接口还在别人手里，你要先把页面跑完——用代理换环境，用 Mock 顶替未就绪的接口
- 全栈：本地起的服务要调内网测试环境，不想在每个项目里维护一份 devServer 代理表
- 测试与联调支持：要复现超时、5xx、断网和慢网络，开延迟与阻断就能造出来，不用请后端配合
- 做多环境或灰度：用查询参数注入打灰度标识，用环境快照在 FAT / UAT / PROD 之间一键切换
- 要把配置交出去：JSON 导出、HAR 录制转规则、cURL 粘贴建规则，同事导入就是同一套

调试与协作：
- 请求日志记录方法、状态、耗时与命中的规则，点开可看请求与响应的头与文本 body（二进制响应体不落盘），JSON 自动格式化
- 顶部「URL 匹配测试」输入任意地址（可带方法），实时显示命中的规则、重写后的地址、走哪条通道，以及还有哪些规则同样命中、但被它遮蔽
- 把任意一条日志复制为 cURL（按原始请求地址）；支持 HAR 1.2 导出、HAR 导入（由录制流量生成规则，新规则默认停用，确认后自行启用）、cURL 粘贴导入
- 规则可拖拽排序、单条与批量启停/删除，按名称、匹配模式或目标地址搜索，并按状态与匹配类型筛选
- 环境轮换时批量迁移目标域名，并给出逐条变更预览
- 规则列表为空时可直接点快速模板（通配符代理、前缀匹配、鉴权头、改请求头）起步；删除一条规则后能立即撤销，误删不用重填
- 把整套规则保存成命名环境快照，在 FAT / UAT / PROD 间一键切换
- 配置以 JSON 导出；导入支持覆盖或合并两种模式，同事导入即可复现同一套规则
- 两条通道各自的命中统计：网络层取近 5 分钟的命中记录，后台通道自上次配置变更起累计（内存计数，后台工作线程被回收后从 0 重新开始）

一点说明（不是缺陷）：只重写 URL 的简单规则由浏览器网络层完成，那条请求不经过扩展的脚本，所以请求日志里不会出现它。这类规则请用「URL 匹配测试」验证，或看规则表里的命中次数；带任何改写、Mock、延迟能力的规则会正常出现在日志里。

改了规则却没生效，按这个顺序检查：
1. 弹窗里的总开关是否开启（关闭时网络层规则也会一起卸载）
2. 这条规则本身是否处于启用状态
3. 页面是否重新加载过——已经发出的请求不会被追溯改写
4. 在「URL 匹配测试」里输入实际请求地址，看是否被一条优先级数字更小（更靠前）的规则遮蔽
5. 使用正则时确保它覆盖整条 URL：网络层会用替换结果整体替换 URL，而后台通道只替换命中的片段，覆盖不全的正则在两条通道上结果不同

规则生效了、地址也换过去了，控制台却还是报 CORS——这通常不是没生效：只重写地址的请求在浏览器里仍然受同源策略约束，目标环境没允许你的来源就照样被拦。此时给这条规则加任一改写能力（最省事的是加一个响应头覆盖），它就改由后台通道代发：那一次请求由扩展发出，页面拿到的是扩展构造的响应，页面侧的跨域校验不再适用。「URL 匹配测试」会直接告诉你这条地址现在走的是哪条通道。

与常见方案的差别：
- 相比在每个项目里配 devServer 代理：规则配在浏览器里，一次配好对所有项目生效，而且能改写响应，不只是转发
- 相比系统级抓包代理：不需要安装本地证书、不改动系统网络设置、不占用系统代理端口，只作用于浏览器里的页面；公司的 VPN 与抓包工具照常工作，两者可以叠加——改写发生在浏览器侧，抓包工具看到的是改写之后的请求
- 相比改项目配置或构建脚本：它不写任何项目文件、不进任何构建产物，同事不需要在你的仓库里找到那行代理配置，也不会有人把你的本地地址提交上去
- 相比 API 客户端或改请求头插件：它处理页面真实发出的请求，不需要把请求手工搬进另一个工具里重放
- 它的边界也说清楚：这是浏览器内的工具，帮不到服务端对服务端的调用；规则存在你的 Chrome 配置里，需要协作时用 JSON 导出交给同事

界面：
- 中文 / English 双语界面，6 套主题与浅色 / 深色 / 跟随系统
- 弹窗提供总开关、今日请求数（只统计后台通道）、自动关闭倒计时、「当前页面命中哪条规则」的预览，以及「为这个页面创建规则」
- 代理自动关闭：30 分钟 / 1 小时 / 2 小时 / 4 小时，基于浏览器定时器，服务工作线程重启后仍然生效
- 快捷键：⌘⇧P（Windows/Linux 为 Ctrl+Shift+P）切换代理；配置页内 N 新建规则、/ 或 ⌘F 聚焦搜索、Esc 关闭弹窗

关于数据：
- 规则、日志与偏好全部保存在你本机的浏览器存储中，没有账号、没有统计埋点、不连接任何自有服务器
- 唯一的网络流量就是你自己要求代理的接口流量；导出文件也只写到本地
- 扩展自身零远端依赖：不加载远程脚本、不请求任何远端接口，界面、规则与日志全部从本机读取（你要求代理的那个接口当然仍然需要网络可达）
- 关于「更改您访问的网站上的数据」权限：被代理的请求发生在每个开发者自己的内网域名、localhost 与各个测试环境之间，这些地址无法在扩展里预先枚举。扩展用它只做两件事——在你浏览的页面上注入拦截器、按你亲手创建的规则代发请求，不向任何第三方或开发者服务器发送数据
- 隐私政策：https://liaolongdong.github.io/cross-origin-proxy/privacy.html

限制：最多 200 条规则、最近 500 条日志、请求体上限 10MB、延迟 0–60000 毫秒、Mock 与改写的状态码钳制在 200–599（否则前端无法构造有效响应）。需要较新版本的桌面 Google Chrome（Manifest V3）。

问题反馈与源码：https://github.com/liaolongdong/cross-origin-proxy
```

### 1.2 English listing（本地化列表）

**Extension Name**（≤75 字符，当前 52）

```
Cross-Origin Proxy - CORS & API Environment Switcher
```

**Short description**（≤132 码点，当前 127，与 `public/_locales/en/messages.json` 的 `extensionDescription` 同源）

```
Proxy API calls to FAT/UAT/PROD, no code or CORS changes. Rewrite URLs/headers/responses, mock, delay, block, retry, WebSocket.
```

**Detailed description**

```
Your frontend talks to FAT, but the change you need to verify only exists on UAT. This extension lets you add one rule in Chrome instead of editing a dev-server proxy in every project, hardcoding a token, or asking the backend to open CORS and redeploy.

Reach for it if any of these is familiar:
- The console says blocked by CORS policy / Access-Control-Allow-Origin and you do not own the backend deployment
- A localhost dev page needs to call an internal test environment
- The API is not written yet, but the UI has to move forward
- You need to exercise the timeout, HTTP 500 and offline fallback states without asking a backend engineer to reproduce them
- You want another environment's auth token on the request without putting it in source control
- Real-time features (WebSocket) have to follow the same environment switch
- You want to hand a whole debugging setup to a teammate without describing it in chat

What it does:
- Match requests by wildcard, prefix or regular expression and forward them to another environment
- Inject or replace request headers (such as the target environment's auth token) and replace request bodies
- Response overrides: the status code, the response headers, or individual JSON fields by dot-notation path (`data.token`)
- Mock responses with your own fake data (JSON / text / HTML / XML) when the API is not built yet
- Conditional mock responses: give one rule several conditions (URL pattern, request method, query parameters) and the first match decides the body, status and Content-Type
- Add 0–60000 ms of latency to throttle a slow network and exercise loading, skeleton and timeout states
- Block requests to verify error handling and offline fallbacks; a blocked request is never replayed
- Retry automatically on network errors, 5xx responses and the 30-second per-attempt timeout — off, or 1–5 attempts with a 100–30000 ms interval
- Limit a rule to specific HTTP methods (GET/POST/PUT/DELETE/PATCH/OPTIONS/HEAD), or append and override query parameters on the proxied URL (gray-release tags, __env=uat)
- Forward WebSocket connections, so real-time features follow the same environment switch
- Rules that only rewrite a URL are resolved inside the browser's network layer (declarativeNetRequest), adding no script work to your page; turning the global switch off uninstalls those rules too, so no invisible redirect is left behind

Typical rules (swap the example hosts for your own):
- Cross-environment switch: match https://fat-api.example.com/* → target https://uat-api.example.com
- Use the other environment's credentials: add a request header override Authorization: Bearer <your UAT token> to that rule
- API not ready yet: enable Mock with status 200, Content-Type application/json, and your sample JSON as the body
- Slow network: enable delay with 3000–8000 ms
- Failure states: enable Block, or override the response status to 500
- Gray release / A-B branch: append the query parameter __env=uat on the proxied URL
- Send only writes to the test backend: restrict the rule to POST / PUT / DELETE

Who reaches for it:
- Frontend work: the API belongs to someone else and the page still has to move — proxy to another environment, or mock the endpoint that is not finished
- Full-stack work: a localhost dev server calling an internal test backend, without a dev-server proxy table to maintain in every project
- QA and integration support: timeouts, HTTP 500, offline and slow-network paths reproduced from delay and block, with nobody on the backend having to cooperate
- Multi-environment or gray-release work: tag the proxied URL with a query parameter, switch FAT / UAT / PROD with a named profile
- Handing a setup over: JSON export, HAR-to-rules, paste-a-cURL-to-a-rule — your teammate imports the identical configuration

Debugging and teamwork:
- A request log with method, status, duration and the rule that matched; open any entry for request and response headers and text bodies (a binary response body is not stored), JSON auto-formatted
- A URL match tester in the header bar: type any URL (optionally with a method) to see in real time which rule matches, what the rewritten URL is, which channel it takes, and which other rules match the same URL but lose to it
- Copy any logged request as cURL, using its original URL; HAR 1.2 export, HAR import that generates rules from recorded traffic (those rules arrive disabled until you enable them), and cURL paste import
- Drag to reorder rule priority, enable/disable/delete one at a time or in batch, search by name, pattern or target, and filter by status and match type
- Batch-migrate target domains across rules with a per-rule change preview
- Start from a quick template while the list is still empty (wildcard proxy, prefix match, auth header, header override), and undo a delete immediately — a mistaken removal does not mean retyping the rule
- Save the whole rule set as a named environment profile and switch between FAT, UAT and PROD in one click
- Export configuration as JSON; on import you replace the current rules or merge into them, so a teammate gets the identical setup
- Per-rule hit counts for both channels: the network layer over the last 5 minutes, the background channel since the last config change (an in-memory count that restarts when the worker is recycled)

One thing that is by design, not a bug: a rule that only rewrites the URL is handled by the browser's network layer, so that request never passes through the extension's scripts and does not appear in the request log. Verify those rules with the URL match tester or the rule's hit count; anything with an override, mock or delay shows up in the log normally.

If a rule seems not to take effect, check in this order:
1. The global switch in the popup is on (switching it off also removes the network-layer rules)
2. That rule itself is enabled
3. You reloaded the page — requests already sent are not rewritten retroactively
4. Test the actual URL in the URL match tester: an enabled rule with a lower priority number may be matching first and shadowing it
5. For regex rules, make sure the pattern covers the whole URL: the network layer replaces the entire URL while the background channel replaces only the part your pattern matched

The rule took effect, the address did change, and the console still says CORS — that usually is not a broken rule. A request whose only rewrite happened in the network layer is still a cross-origin request the browser checks against the same-origin policy, so a target environment that does not allow your origin gets blocked. Add any capability to that rule (a response header override is the cheapest) and it moves to the background channel: the extension issues the request and hands the page a response it constructed, so the page's CORS check never runs. The URL match tester shows which channel a given address is currently taking.

How it differs from the usual options:
- Versus a per-project dev-server proxy: rules live in the browser, apply to every project at once, and can rewrite responses instead of only forwarding
- Versus a system-wide capture proxy: no local certificate to install, no system network settings to change, no system proxy port to configure, and it only touches pages in the browser. A company VPN or a capture tool keeps working alongside it — the rewrite happens inside the browser, so those tools see the rewritten request rather than competing with it
- Versus editing project config or build scripts: it writes no file in your repository and appears in no build output, so a teammate never has to find the proxy line in your project — and nobody commits their localhost address
- Versus an API client or a header-modifier extension: it works on the requests the page actually makes, instead of asking you to replay them in another tool
- Its limits, stated plainly: it is a browser tool. It cannot help a server-to-server call, and its rules live in your Chrome profile — export JSON when a teammate needs them.

Interface:
- English and Chinese UI, six themes, light / dark / system modes
- Popup with a global switch, today's request count (background channel only), an auto-off countdown, a preview of which rule matches the page you have open, and "create a rule for this page"
- Auto-off countdown of 30 minutes, 1, 2 or 4 hours, built on browser alarms so it survives service-worker restarts
- Keyboard shortcut Ctrl+Shift+P (⌘⇧P on macOS) to toggle proxying; on the options page N adds a rule, / or ⌘F focuses search, Esc closes the topmost dialog

About your data:
- Rules, logs and preferences are stored in your browser's local storage on your own device. No accounts, no analytics, no telemetry, no servers of ours
- The only network traffic is the API traffic you ask it to proxy; exports are written locally
- The extension itself has zero remote dependencies: no remote scripts, no calls to any endpoint of ours, and its UI, rules and logs are all read from local storage (the API you proxy obviously still has to be reachable)
- About the "change the data on websites you visit" permission: proxied requests happen on each developer's own internal domains, localhost and staging hosts, which cannot be enumerated in advance. The extension uses that permission for two things only — injecting the interceptor into pages you browse, and issuing requests on your behalf according to rules you created. Nothing is sent to any third party or to a developer-controlled server
- Privacy policy: https://liaolongdong.github.io/cross-origin-proxy/privacy.html

Limits: 200 rules, the last 500 log entries, 10 MB request body, delays of 0–60000 ms, and mocked or overridden status codes clamped to 200–599 so the page can always build a valid response. Requires a recent desktop Google Chrome (Manifest V3).

Source code and issue tracker: https://github.com/liaolongdong/cross-origin-proxy
```

**Category**: Developer Tools
**Languages**: 中文（中国）+ English（两个本地化列表都建，中文为默认）

### 1.3 Single purpose（表单里的一句话，必须窄）

```
Redirects a page's API requests to another backend environment and lets developers modify those requests and responses for cross-environment debugging.
```

## 2. Graphics & Assets

运行 `pnpm assets`（中文版）与 `pnpm assets:en`（英文版）生成，产物在 `store-assets/`（已 gitignore，可再生）。

| Asset                  | Dimensions  | Status   | Filename                                                                              |
| ---------------------- | ----------- | -------- | ------------------------------------------------------------------------------------- |
| Store icon             | 128×128 PNG | ✅ Ready | `public/icon/128.png`                                                                 |
| Screenshot 1（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/01-rules-overview.png`                                   |
| Screenshot 2（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/02-rule-editor.png`                                      |
| Screenshot 3（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/03-url-tester.png`                                       |
| Screenshot 4（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/04-request-log.png`                                      |
| Screenshot 5（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/05-popup.png`                                            |
| Screenshot 1–5（英文） | 1280×800    | ✅ Ready | `store-assets/screenshots-en/0X-*.png`                                                |
| Small promo tile       | 440×280     | ✅ Ready | `store-assets/tiles/small-tile-zh.png` / `small-tile-en.png`                          |
| Marquee promo tile     | 1400×560    | ✅ Ready | `store-assets/tiles/marquee-zh.png` / `marquee-en.png`                                |
| GitHub social preview  | 1280×640    | ✅ Ready | `store-assets/tiles/github-social-preview.png`（仓库 Settings → Social preview 上传） |

**Screenshot notes**：每张图顶部带一句能力标题 + 一行说明，主体是真实界面截图（非 mockup、不含任何真实内网域名或 token）。商店只接受 **1280×800 或 640×400**，像素级校验，最多 5 张——顺序按「先讲清主用途 → 再讲能力 → 最后讲开关可见性」排列。

## 3. Permissions Justification

审核要求逐条给具体理由，"needed for the extension to work" 会被拒。以下文案可直接粘贴。

| Permission                      | Type             | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                       | permissions      | Saves the user's proxy rules, environment profiles, request logs and UI preferences in `chrome.storage.local`. Nothing leaves the device and no other storage area is used.                                                                                                                                                                                                                                                                                                  |
| `declarativeNetRequest`         | permissions      | The core feature. Rules that only rewrite a request URL are installed as dynamic redirect rules so the browser's network stack performs the redirect without per-request JavaScript. Dynamic rules are rebuilt from proxy rules the user authored in the extension's own UI (including imports the user initiates); they are removed when a rule is disabled or deleted, and the whole set is cleared when the global proxy switch is turned off.                            |
| `declarativeNetRequestFeedback` | permissions      | Reads which dynamic rules actually matched, to show a per-rule hit count in the request-log drawer. This is the only way the user can see network-layer redirects, because those requests never reach the extension's JavaScript and therefore produce no per-request log entry. Used for display only; results are kept locally.                                                                                                                                            |
| `alarms`                        | permissions      | Two timers: a keepalive ping so the background worker survives while proxying is active, and the user-configured auto-off countdown that turns proxying off after a set number of minutes. Minimum period is one minute; no second-precision scheduling is used.                                                                                                                                                                                                             |
| `<all_urls>`                    | host_permissions | The extension must work on whatever origin the developer's frontend runs on — internal domains, `localhost` dev servers and staging hosts cannot be enumerated in advance, and they differ per developer. It is used to (a) inject the request interceptor on pages the user browses and (b) issue proxied requests on the user's behalf for rules the user authored. The extension sends no data to any third-party or developer-controlled server; see the privacy policy. |

**为什么不用更窄的方案**（审核常追问，先答清楚）：`activeTab` 不满足需求——被代理的请求发生在用户浏览任意页面时的 `fetch`/XHR/WebSocket 调用中，不是用户点击扩展图标那一刻；按域名白名单也不可行，目标环境是每个开发者自己的内网域名。若审核要求收窄，可提议改为「用户手动授权当前站点」的降级方案。

## 4. Privacy & Data Use

### 4.1 Data collection

**Does the extension collect user data?** **No.**

| Data Type                    | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
| ---------------------------- | ---------- | ----------------------- | ------- | -------------------------- |
| Personally identifiable info | No         | No                      | —       | No                         |
| Health info                  | No         | No                      | —       | No                         |
| Financial info               | No         | No                      | —       | No                         |
| Authentication info          | No         | No                      | —       | No                         |
| Personal communications      | No         | No                      | —       | No                         |
| Location                     | No         | No                      | —       | No                         |
| Web history                  | No         | No                      | —       | No                         |
| User activity                | No         | No                      | —       | No                         |
| Website content              | No         | No                      | —       | No                         |

Rationale to paste if the form asks for clarification: request and response data of proxied calls is read **inside the user's browser** to perform the transformation the user configured, and is written only to `chrome.storage.local`. The extension contains no analytics, no telemetry and no remote endpoint of its own; there is no code path that uploads user data. Blocked/mock responses never reach a third party.

> ⚠️ 2026-08-01 起 Chrome 应用商店执行了更严格的数据收集与「最小必要」基准。提交前请以 Dashboard 当时的表单文案为准复核一遍上表，尤其确认 `declarativeNetRequestFeedback` 的命中统计是否被归入需要声明的类别。

### 4.2 Data use certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes
- [x] Data is NOT used to inform personalized advertising

## 5. Privacy Policy

**URL**: `https://liaolongdong.github.io/cross-origin-proxy/privacy.html`（仓库 `docs/privacy.html`，中英双语同页）

该页由 `.github/workflows/deploy-pages.yml` 在 `main` 上改动 `docs/**` 时自动部署，但**部署源必须先在 Settings → Pages 里切成「GitHub Actions」**（一次性开关，见 [GITHUB.md](./GITHUB.md) §5）。提审前用下面命令确认三个页面都是 200——隐私政策 URL 打不开是最常见的首审被拒原因：

```bash
for p in "" zh.html privacy.html; do
  printf '%-14s ' "/$p"
  curl -s -o /dev/null -w '%{http_code}\n' "https://liaolongdong.github.io/cross-origin-proxy/$p"
done
```

## 6. Distribution

- **Visibility**: Public
- **Regions**: All regions
- **Pricing**: Free
- **Package**: `pnpm build:zip` → `.output/cross-origin-proxy-<version>-chrome.zip`（即 `<package-name>-<version>-<browser>.zip`；`manifest.json` 位于 zip 根目录，包内不含源码、测试与本文档）。版本号只在 `package.json` 维护，发版链路见 [RELEASING.md](./RELEASING.md)。

## 7. Developer Info

| 字段           | 值                                                          | 说明                                                            |
| -------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Publisher Name | Better                                                      | 与 `package.json` 的 `author.name` 一致                         |
| Contact Email  | 924902324@qq.com                                            | 商店页面公开显示；Google 的整改通知发到这里，必须是能收信的邮箱 |
| Support URL    | `https://github.com/liaolongdong/cross-origin-proxy/issues` |                                                                 |
| Homepage URL   | `https://liaolongdong.github.io/cross-origin-proxy/`        |                                                                 |

> 仓库已建立并公开（`liaolongdong/cross-origin-proxy`，2026-09-07）。剩下的一次性动作全部列在 [GITHUB.md](./GITHUB.md)：About 描述与 website、topics、社交预览图、**Pages 源切到 GitHub Actions**、私密漏洞报告入口。**确认 `privacy.html` 能打开后再提审。**
>
> 联系邮箱会在商店页与隐私政策页公开，可能被爬虫采集用于发送 Spam。若希望隔离，可改用 GitHub 专用可收信地址（`用户名+编号@users.noreply.github.com`），并同步更新本节与 `docs/privacy.html`。

## 8. Version History

完整版本历史以 [CHANGELOG.md](./CHANGELOG.md) 为唯一事实源（发版链路会把它对应小节切成 GitHub Release 的说明）；本表只记**已向商店提审**的版本与状态。

| Version | Date   | Changes                                                                                                                                               | Status |
| ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1.0.0   | 待提交 | 首次提交：双通道代理（DNR + 后台）、请求/响应改写、Mock/延迟/阻断、方法与查询参数控制、WebSocket 转发、HAR/cURL 导入导出、环境快照、中英双语与 6 主题 | Draft  |

> ⚠️ 第 1 节描述承诺了「关闭总开关时这层规则一并卸载」，而这条行为修复目前只记在 [CHANGELOG.md](./CHANGELOG.md) 的 `## [Unreleased]` 段（`1.0.0` 尚未打 tag）。首次提审的 zip 必须带上它——商店描述与包体行为不一致，既是拒审风险也是最容易吃差评的地方。上表的 Changes 列只描述条目范围，不代表 2026-09-07 那一节的功能清单。

## 9. Pre-Publish Checklist

每轮提交都从头走一遍：这里的 `[ ]` 是运行时勾选，不是一次性记录，换一个包就得重走。仓库侧的一次性配置见 [GITHUB.md](./GITHUB.md)，上架后要做的翻转见第 12 节。

仓库与托管（提审前置，配好之后每轮复核）：

- [ ] 第 5 节的三个 URL 外加 `/llms.txt`、`/llms-full.txt` 实测都是 200——隐私政策打不开是首审最常见的拒审理由
- [ ] About 描述 / website / topics 三项已填（[GITHUB.md](./GITHUB.md) §1–§3）；三项全空等于放弃 GitHub 搜索摘要与话题页这两条被动流量
- [ ] Social preview 已上传（[GITHUB.md](./GITHUB.md) §4，无可用 API，只能设置页手动传）
- [ ] 已勾选私密漏洞报告（[GITHUB.md](./GITHUB.md) §6；`SECURITY.md` 把私密上报列为首选，本扩展拿的是 `<all_urls>`）
- [ ] 首个 `v*` tag 已推：Releases 有可下载 zip、README 的 `Release` 徽章转绿——上架前做掉，安装漏斗不必先落到「clone 源码」

包与清单：

- [ ] `pnpm build:zip` 通过，zip 根目录就是 `manifest.json`
- [ ] `manifest.json` 的 `name` / `description` 与本文档第 1 节完全一致（Chrome 硬校验 ≤75 / ≤132，`pnpm test` 已守卫）
- [ ] 版本号 > 商店已发布版本（首次忽略）
- [ ] 包内无 `.git`、`node_modules`、源码 map、测试、`README.md`、本文件
- [ ] 第 1 节承诺的「关闭总开关时这层规则一并卸载」确实在包里——`utils/dnrRules.ts` 里那行 `proxyEnabled ? … : []` 是它的实现；装一次实测「开总开关 → 规则表命中数增长 → 关总开关 → 请求不再被转发」比读代码可靠。描述与包体行为不一致既是拒审风险，也是最容易吃差评的地方

商店信息：

- [ ] 分类 = Developer Tools；默认语言 = 中文（中国），并新增 English 本地化列表
- [ ] Single purpose 一句话填写（第 1.3 节）
- [ ] 每一项权限与 host 权限的理由都粘贴（第 3 节），`<all_urls>` 单独说明
- [ ] 数据披露按第 4 节勾选，与隐私政策文本一致
- [ ] 描述里的每条能力主张都对得上要提交的那个包，尤其是按实现收窄过的六处：URL 匹配测试的遮蔽方向、日志只落文本 body、cURL 仅限日志条目、覆盖/合并是**导入**模式、后台命中数是内存计数、弹窗今日请求数只含后台通道
- [ ] 隐私政策 URL 已可公开访问（第 5 节）
- [ ] 开发者联系邮箱已验证（Developer Dashboard → Account）

图片（尺寸与顺序见第 2 节；商店只收 1280×800 或 640×400，最多 5 张，像素级校验）：

- [ ] 中文列表 5 张按 `01-rules-overview` → `05-popup` 的顺序上传——前 3 张在搜索结果里可见，顺序别打乱
- [ ] 先切到 English 本地化列表再传 `screenshots-en/` 的 5 张；英文图不要传进默认语言
- [ ] 小型图块 440×280 与大型图块 1400×560 各按语言传对应版本（`store-assets/tiles/`）
- [ ] 没有把第 6 张深色主题图传进商店——它只用于产品站
- [ ] 截图与这次要提交的包体行为一致，且不含任何真实内网域名或 token（示例统一 `fat-api.example.com` / `uat-api.example.com`）

功能自检（提交前在本地最新版 Chrome 手动过一遍）：

- [ ] 通配 / 前缀 / 正则三类规则均能命中并重写（正则注意：网络层重定向替换的是整个 URL，想两通道结果一致就写覆盖整条 URL 的正则）
- [ ] 通道判定用「URL 匹配测试」面板核对：它直接显示命中的通道（网络层 / 后台）。简单规则在该面板显示网络层重定向、请求能正常转发，且规则表的「命中次数」列会增长——但**请求日志里不会有这一条**（日志只由后台通道写入，网络层重定向不经过扩展脚本）；复杂规则在面板显示后台且日志有对应行。日志抽屉另有一个只统计网络层命中的面板可交叉验证
- [ ] Mock、延迟、阻断、响应改写、方法过滤、查询参数注入逐项生效
- [ ] WebSocket 规则能转发 `wss://` 连接
- [ ] 拦截异常时页面回退原生请求，且阻断请求不会被回退发出
- [ ] 弹窗、配置页、日志抽屉、导入导出无报错（`chrome://extensions` 查看 service worker 控制台）
- [ ] 关闭总开关后不再代理任何请求；自动关闭倒计时到期真的关掉
- [ ] 中英文切换、6 主题与深浅模式无残留样式
- [ ] 卸载扩展后无残留副作用（storage 随扩展清除）

## 10. Review Risk Notes

| 风险                                | 为什么会被盯                   | 应对                                                                                                                                       |
| ----------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `<all_urls>` 权限过大               | 商店明确偏好窄权限             | 第 3 节已给出「无法枚举内网域名 + activeTab 不满足时机」的具体论证，并主动提出可降级为按站点授权                                           |
| 名称含 `CORS`/`Mock` 被判关键词堆砌 | 名称是搜索权重最高字段         | 名称结构为「品牌名 - 能力 A · 能力 B · 能力 C」，每个词对应真实功能，无重复词、无最高级、无 "free/best"                                    |
| 数据披露与代码不一致                | 拒审主因                       | 全仓库无 `fetch` 到自有域名、无埋点 SDK；命中统计仅本地展示；已在第 4 节写明可粘贴的依据                                                   |
| 截图与实际不符                      | 会要求重传                     | 截图由 `screenshots/` 真实界面派生，且不含真实内网域名（示例统一 `fat-api.example.com` / `uat-api.example.com`）                           |
| 描述与实际行为不符（overclaim）     | 会被要求整改，且直接转化成差评 | 2026-09-13 逐条对照代码核验，收窄六处（见第 9 节自检项）：这些限定词是**事实口径**，不要为了卖点更强再改回去                               |
| 远程代码                            | MV3 红线                       | 无 CDN 脚本、无 `eval`；构建产物 `esbuild.drop: ['debugger']`（保留 `logger.warn/error` 以便定位「请求为什么没走代理」），全部脚本随包发布 |

### Rejection History

| Date | Reason | Fix Applied | Resubmitted |
| ---- | ------ | ----------- | ----------- |
| —    | 暂无   | —           | —           |

## 11. 自动化发布（包上传与提审）

第 1–10 节是人工填写的商店表单；一旦条目存在，包体本身就不该再手工传。

- **一次性准备（无法绕开的手动部分）**：`publish-extension` 不提供「新建商店条目」能力，必须在 Dashboard 手动上传一次 zip 才能拿到 Extension ID；同时在 Google Cloud 建 OAuth 客户端换 refresh token。四个值落到仓库 Secrets：`CHROME_EXTENSION_ID` · `CHROME_CLIENT_ID` · `CHROME_CLIENT_SECRET` · `CHROME_REFRESH_TOKEN`。逐步命令见 [RELEASING.md](./RELEASING.md) §1。
- **日常**：推 `v*` 标签即触发 `.github/workflows/release.yml`——全量校验 → 打 zip → 建 GitHub Release → `pnpm exec wxt submit` 上传并提审。版本号必须与 `package.json` 一致，不一致时工作流直接终止（商店收到错版本号的包是静默失败）。
- **Secrets 未配时的行为**：Release 照建，商店那一步跳过并在 Run 页面留指引，不报红。
- **先验后提审**：首次接管已有条目时，用 `Run workflow` 勾选 `skip-review`（只上传成草稿）或选 `publish-target=trustedTesters`，人工核对完再走 `default`。
- **与商店表单的耦合点**：详细描述里刻意不写版本号，避开每次发版都要改商店文案；但限制条数（200 规则 / 500 日志 / 10MB）与能力清单必须与 `README.md`、`docs/` 落地页、`CHANGELOG.md` 保持同一事实。

## 12. 上架后的安装漏斗切换

第 1 节的描述、两份 README、落地页两页与 `llms*.txt` 目前全部按「商店还没上架、只能源码构建」写——这句话一共散在 17 处。上架不是一次翻转，而是**两次互相独立**的状态变化，不要合并成一次改：

| 翻转       | 触发                      | 变化                                                                                                           |
| ---------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ① 打出 tag | 推 `v*` tag（见第 11 节） | GitHub Release 带上预构建 zip，README 的 `Release` 徽章从 unknown 转绿；「方式 A」这时才真的可用，商店与否无关 |
| ② 商店上架 | 商店审核通过并公开发布    | 出现商店 URL，安装主入口从 GitHub 换成商店；下表在这一步一次性改完                                             |

**②必须在拿到真实商店 URL 之后做**：URL 里的 Extension ID 只能由第 11 节那次「Dashboard 手动上传首个 zip」产生，提前用猜的 ID 写进文档会让所有链接 404——而隐私政策与商店链接打不开正是首审最常见的拒审理由。

### 12.1 翻转②要改的位置

| #   | 文件                 | 位置（按可见文案定位，别记行号）                      | 现在写的是                                                          | 改成                                                                    |
| --- | -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `docs/index.html`    | hero 区主按钮 `class="btn btn-primary"`               | `View source on GitHub` → 仓库                                      | `Add to Chrome` → 商店 URL；原 GitHub 链接降为 ghost 按钮留作次入口     |
| 2   | `docs/zh.html`       | hero 区主按钮 `class="btn btn-primary"`               | `在 GitHub 查看源码`                                                | `添加到 Chrome`，同上                                                   |
| 3   | `docs/index.html`    | `#install` 区第一张卡 `Runtime requirements`          | 「The store listing is in preparation, so load the unpacked build」 | 商店装法是默认路径，源码构建改为「开发者」小节的补充说明                |
| 4   | `docs/zh.html`       | `#install` 区第一张卡「运行环境」                     | 「商店上架准备中，因此需以『加载已解压的扩展程序』方式加载」        | 同上                                                                    |
| 5   | `README.md`          | `## Install` 首句 + `### A. Prebuilt package`         | 「The Chrome Web Store listing is in preparation」                  | 商店为方式 A；「从源码构建」降为方式 B，并把「首个 tag 之前请用 B」删掉 |
| 6   | `README.zh-CN.md`    | 同上（`## 安装` / `### 方式 A`）                      | 「Chrome 应用商店上架准备中」                                       | 同上                                                                    |
| 7   | `docs/llms.txt`      | 运行要求段                                            | 「the only install path is to build from source」                   | 商店 URL 列为第一个安装路径，源码构建附后                               |
| 8   | `docs/llms-full.txt` | 头部 `Store listing / 商店状态`                       | 「no store URL exists yet」                                         | 直接写商店 URL，并把「上架准备中」整句删掉                              |
| 9   | `docs/llms-full.txt` | 安装路径 B（`Tagged release`）                        | 「No tag has been published yet」                                   | 打 tag 后这条就不再成立，改为描述 Releases 是回退路径                   |
| 10  | `docs/llms-full.txt` | 安装路径 C（`Chrome Web Store`）                      | 「In preparation; there is no store URL」                           | 写商店 URL；C 提到最前或与 B 调换顺序                                   |
| 11  | `docs/llms-full.txt` | 「常见误解」清单第 6 条（「它在 Chrome 商店可下载」） | 「not yet」                                                         | 这条误解不再成立，整条删除或改成「已上架，商店 URL 见上」               |
| 12  | `CHROMEWEBSTORE.md`  | 第 8 节 Version History 的 Status 列                  | `Draft`                                                             | 改 `Published` 并补发布日期；同时清掉该节下方的 ⚠️ 待发布提示           |
| 13  | `CHROMEWEBSTORE.md`  | 第 7 节 Developer Info                                | 只有 Support URL / Homepage URL                                     | 可增一行 Store URL，便于后续文档互链                                    |

第 1 节的**商店表单文案本身不用改**——名称、摘要、详细描述都不含安装路径或版本号，这也是当初不写版本号的收益。同一批能力主张继续与 `README.md`、`docs/`、`CHANGELOG.md` 保持同一事实即可。

### 12.2 改完必须跑的守卫

- `pnpm test`：`tests/docs-consistency.test.ts` 对中英落地页做**逐条对等**校验（`<summary>` 列表、FAQ 答案文本、结构化数据），所以第 1–4 项必须**两页同时改**，只改英文页会直接红。
- 同一支测试的 `PAGES_URL_SOURCES` 要求清单里每个文件仍然引用至少一个 Pages URL。第 8–11 项若把 `llms-full.txt` 里的站点信息整段替换，确认页脚/源码链接没被一起删掉。
- 第 5–6 项改完跑一次 `pnpm exec prettier --check README.md README.zh-CN.md`（两份 README 的徽章与表格格式由 prettier 管）。
- 第 3–4 项改完在浏览器里目测两页 `#install` 区（含禁用 JS 的降级态），确认没有残留「上架准备中」的半句。
- 商店侧动作与本节无关：`pnpm assets` 生成的图里烧的是**产品站地址**，不含商店 URL，所以②不需要重跑图。
