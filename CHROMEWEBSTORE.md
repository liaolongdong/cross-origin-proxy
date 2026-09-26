# Chrome Web Store Listing — 跨域代理助手 / Cross-Origin Proxy

> Last Updated: 2026-09-22
> 本文件是商店上架的唯一素材源：把这里的内容逐项复制进 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)。
> 商店表单（名称/描述/截图/权限理由/数据披露）无法由 API 代写，只能手动粘；**包上传与提审已经自动化**，见第 11 节。
> 本文件位于仓库根目录，不在 `.output/chrome-mv3` 内，因此不会被打进上传包。

## 0. Keyword strategy（为什么这么写）

Chrome 应用商店搜索的权重顺序是 **名称 > 摘要（manifest description）> 详细描述 > 分类/语言**。三条自动化链路都在名称上收手：名称结构已经是「品牌名 - 能力 A · 能力 B · 能力 C」，每个词对应真实功能，再往上堆词就是拿审核换曝光。当前中文 36/75、英文 52/75，剩下的预算**刻意不吃**——2026-09-12 复核过一次并确认维持现状，不要因为「预算还没用满」就去扩名称。

优化重心因此放在后两个字段：

| 字段     | 预算       | 当前投入               | 说明                                                                                                                                                                                                                                                                                                                       |
| -------- | ---------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名称     | 75 码点    | 36 / 52                | 只承载品牌 + 三个真实能力词，不再扩张（堆砌是拒审高危字段）                                                                                                                                                                                                                                                                |
| 摘要     | 132 码点   | 100 / 127              | 中文补齐最高意图词「跨域」「联调」，英文补 `retry`；两边都留白以免搜索结果被截断                                                                                                                                                                                                                                           |
| 详细描述 | 16000 码点 | 中约 5.8K / 英约 15.9K | 中文侧余量充足，**英文侧只剩 88 码点**：中英按「行数 / 条目数 / 段落数」逐行对等同步（`tests/docs-consistency.test.ts` 守卫），所以**扩写瓶颈在英文，不在中文**。往下加新段落的唯一前提是先在英文侧腾出等量空间，见 §0.1；加字只加**新的内容类型**或补本节关键词表已承诺、正文却缺失的落点，不把同一批能力换个说法重述一遍 |

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
- **规则选择机制段**（2026-09-22 加）：「两条规则都能匹配，生效的是哪条」与「目标地址留空为什么也能用」是 Support 里的两类问题，前者决定排查顺序，后者是本扩展真实存在、却只在代码与 README 里写过的能力（只代发、不改地址）。商店描述是搜索结果与详情页唯一会读到的地方，缺了它就是让人靠试。
- **同源策略解释段**：§0 关键词表把 `同源策略` / `same-origin policy` 的落点写在「CORS 解释段」上，而 2026-09-22 之前正文里根本没有这一段——表格承诺了、正文没兑现就是漂移。它同时给上面那段报错说明提供前置定义（scheme/host/port、预检、ACAO），使「为什么报错」不再只是一句结论。
- **「它不是什么」段**：本扩展名称里的 `proxy` 与「跨域」两词在检索侧撞上 VPN / 系统级代理 / 抓包工具，这些错误预期正是差评与卸载理由；按类别（公开 CORS 中转、VPN、抓包调试器、API 平台、服务端网关）逐条划线，同时给 AI 检索一份实体消歧材料。它受本节末尾那条既有约束——**只写类别，不点名产品**。
- **两条新 FAQ**（会不会波及别的标签页与线上环境 / 换电脑或同事要同一套配置）：前者是内网开发者的第一顾虑，答案不写进商店就等于让人赌；后者把「规则活在你的 Chrome profile 里」这个已知限制翻译成一条可执行路径（导出 JSON / 导入合并），与「差别」段末尾那句诚实的边界是一对。
- **与抓包代理/项目配置的共存与越界段**：不装证书、不改系统设置、不占系统代理端口、不写项目文件——这些是相对系统级代理与 devServer 配置的真实差异化成本账，写在「差别」段里而不是散进能力清单。
- **零远端依赖段**：面向企业内网与合规审查的说法，同时给审核对「数据不外传」的疑问一个可核对的落点。
- **排查清单**：`<all_urls>` 类扩展的差评与申诉几乎都来自「装了没生效」，把排查顺序写进商店描述能同时降低差评率与审核沟通成本；其中「正则必须覆盖整条 URL」是本扩展两通道的真实差异（见第 9 节）。

刻意**不做**的事：不在名称里堆同义词（Chrome 会因 "misleading keyword stuffing" 拒审，且 AI 检索研究里关键词堆砌反而降低可见度）；不写 "best"、"#1"、"free" 这类词；不出现 "Chrome" 字样冒充官方；不引用其他产品商标（详细描述里的对比段只写**方案类别**，不点名产品，避免不可核验的主张）；详细描述里不写版本号，避开每次发版都要改商店文案；不为了吃满 16000 码点而把同一批能力换说法重述。

### 0.1 中英详细描述为什么码点差 2.7 倍、下次扩写先动谁

**这个差不是「中文写得少」**。两份详细描述逐行对等：28 个段落、64 个 `- ` 条目、134 行，一条不多一条不少（`tests/docs-consistency.test.ts` 的「中英详细描述结构对等」按 `{lines, bullets, paragraphs}` 全等断言）。差的只有语言密度——2026-09-22 这一轮新增的五处内容块，中文侧 +852 码点，英文镜像 +2,781 码点，**约 3.3 倍**。所以「把中文字数追到和英文一样」只能靠给中文单独加行，而那当场就会让对等守卫变红；**不要把码点不等当缺陷去"修"**，它和「英文列表以 FAT/UAT 开头」是同一类事实：语言特性，不是覆盖差。

真正的约束因此落在英文那一份上。商店按语言各填一份详细描述、各自吃 16000 上限，中文列表还剩约 10.2K，英文只剩 **88 码点**；但因为结构必须对等，**英文一满，中文同时封顶**。

要再扩中文，按这个顺序腾空间：

1. **先在英文侧做等行数内的措辞压缩**——不增删行、不合并段落，只把句子收紧。这是唯一不触发对等守卫的回收方式，也是本轮新增段落最该被压的地方（新写的英文镜像按「说清楚」优先，没有按字节优化过）。
2. 不够就**整块换掉**已经失去转化或检索理由的内容块（上面那份清单就是判据；换段落，段落数不变）。
3. **不要为了腾空间动这三处**：`Limits:` 段、隐私政策 URL、反馈与源码入口。前一个是审核要看的能力边界，后两个由 `docs-consistency` 直接断言必须出现在详细描述里。

改完先量，再决定动谁（中英各段落的码点分布，顺序即文件内顺序）：

````bash
python3 - <<'PY'
import re
doc = open('CHROMEWEBSTORE.md', encoding='utf-8').read()
# 小节号写成参数再拼前缀：把带前缀的完整标题字面量写进 §0，会抢在真标题前被检索到。
def body(a, b):
    a, b = '### ' + a, '### ' + b
    s = doc.index(a); e = doc.index(b, s)
    m = list(re.finditer(r'```\n([\s\S]*?)```', doc[s:e]))[2].group(1)
    return m[:-1] if m.endswith('\n') else m
for lang, (a, b) in (('zh', ('1.1', '1.2')), ('en', ('1.2', '1.3'))):
    text = body(a, b)
    print(lang, 'total=%d cp, paras=%d' % (len(text), len(text.split('\n\n'))))
    for i, p in enumerate(text.split('\n\n')):
        print('  %2d %5d  %s' % (i, len(p), p.split('\n')[0][:60]))
PY
````

这条命令数出来的 `total` 就是 §0 预算表该写的数（除以 1000 保留一位小数；守卫用 `toBeCloseTo(..., 1)`，即 ±50 码点内）。改完正文必须回来同表更新，然后 `npx vitest run tests/docs-consistency.test.ts` 一次看三条（结构对等、≤16000、预算表），最后 `pnpm exec prettier --write CHROMEWEBSTORE.md` 重排表格列宽。

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
- 按规则携带目标环境的 Cookie（默认关闭）：开启后由扩展以 credentials: 'include' 代发，带上你在该环境已有的会话，不必把 Cookie 抄进请求头覆盖
- 响应改写：替换响应状态码、响应头，或按路径替换 JSON 里的某个字段（如 data.token）
- 假数据 / Mock：接口还没写好时，直接返回你准备的 JSON / 文本 / HTML / XML
- 条件化 Mock：一条规则里配多个条件（URL 正则、请求方法、查询参数），首个命中的条件决定响应体、状态码与 Content-Type
- 注入 0–60000 毫秒延迟模拟弱网，用来验证骨架屏、加载态与超时处理
- 阻断请求，用来验证异常提示与离线兜底；被阻断的请求不会被回退重发
- 失败自动重试：网络错误、5xx 响应与单次 30 秒超时都会触发，重试 1–5 次、间隔 100–30000 毫秒可调
- 按 HTTP 方法限定规则（GET/POST/PUT/DELETE/PATCH/OPTIONS/HEAD），或在代理后的地址上追加、覆盖查询参数（灰度标识、__env=uat）
- 转发 WebSocket 长连接，让实时功能跟着同一套环境走
- 只做 URL 重写的简单规则由浏览器网络层完成（declarativeNetRequest），不给页面增加脚本开销；关闭总开关时这层规则一并卸载，不会留下隐形重定向

规则是怎么被选中的：
- 列表顺序就是优先级，数值越小越先匹配；一条请求只交给第一条命中的规则，后面的规则不再参与评估
- 「URL 匹配测试」会把同样命中这条地址、但排在它后面的规则一并列出来，调整顺序前先看这里
- 目标地址留空表示不换环境，只把这条请求交给扩展代发——需要改写请求头或响应、又不想换地址时用它

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
- 配置以 JSON 导出；导出默认开启分享模式，剔除 Authorization / Cookie 一类请求与响应头以及 token 类查询参数（取消勾选即原样备份），导入支持覆盖或合并两种模式，同事导入即可复现同一套规则
- 两条通道各自的命中统计：网络层取近 5 分钟的命中记录，后台通道自上次配置变更起累计（内存计数，后台工作线程被回收后从 0 重新开始）

一点说明（不是缺陷）：只重写 URL 的简单规则由浏览器网络层完成，那条请求不经过扩展的脚本，所以请求日志里不会出现它。这类规则可以看弹窗右上格「本页 · 近 5 分钟」的网络层命中数、用「URL 匹配测试」验证，或看规则表里的命中次数；带任何改写、Mock、延迟能力的规则会正常出现在日志里。

改了规则却没生效，按这个顺序检查：
1. 弹窗里的总开关是否开启（关闭时网络层规则也会一起卸载）
2. 这条规则本身是否处于启用状态
3. 页面是否重新加载过——已经发出的请求不会被追溯改写
4. 在「URL 匹配测试」里输入实际请求地址，看是否被一条优先级数字更小（更靠前）的规则遮蔽
5. 使用正则时确保它覆盖整条 URL：网络层会用替换结果整体替换 URL，而后台通道只替换命中的片段，覆盖不全的正则在两条通道上结果不同

关于同源策略：页面只能读取与自己同源（协议、域名、端口三者都相同）的响应，带自定义请求头的调用还要先过一次预检（OPTIONS）。预检或正式响应里缺少允许你来源的 Access-Control-Allow-Origin，请求就到不了业务代码——「Network 里看得到响应、Console 却报错」正是同一件事的两面。这个扩展不改后端，也不假装让校验消失：简单规则改的是请求要去哪个地址，复杂规则改的是这个请求由谁发出。

规则生效了、地址也换过去了，控制台却还是报 CORS——这通常不是没生效：只重写地址的请求在浏览器里仍然受同源策略约束，目标环境没允许你的来源就照样被拦。此时给这条规则加任一改写能力（最省事的是加一个响应头覆盖），它就改由后台通道代发：那一次请求由扩展发出，页面拿到的是扩展构造的响应，页面侧的跨域校验不再适用。「URL 匹配测试」会直接告诉你这条地址现在走的是哪条通道。

与常见方案的差别：
- 相比在每个项目里配 devServer 代理：规则配在浏览器里，一次配好对所有项目生效，而且能改写响应，不只是转发
- 相比系统级抓包代理：不需要安装本地证书、不改动系统网络设置、不占用系统代理端口，只作用于浏览器里的页面；公司的 VPN 与抓包工具照常工作，两者可以叠加——改写发生在浏览器侧，抓包工具看到的是改写之后的请求
- 相比改项目配置或构建脚本：它不写任何项目文件、不进任何构建产物，同事不需要在你的仓库里找到那行代理配置，也不会有人把你的本地地址提交上去
- 相比 API 客户端或改请求头插件：它处理页面真实发出的请求，不需要把请求手工搬进另一个工具里重放
- 它的边界也说清楚：这是浏览器内的工具，帮不到服务端对服务端的调用；规则存在你的 Chrome 配置里，需要协作时用 JSON 导出交给同事

它不是什么：
- 不是公共 CORS 中转服务：请求只发往你规则里写的那个地址，不经过任何第三方服务器
- 不是 VPN 或系统代理：它不改系统网络设置、不接管其他应用的流量，只管浏览器里你写了规则的那些请求
- 不是抓包调试工具：不安装本地证书、不解析 TLS、不做全流量录制，也不替你保存历史响应
- 不是接口管理平台：Mock 用来顶替还没写好的接口，不承担接口文档、用例管理与团队协作
- 不是服务端网关或反向代理：目标地址由你在浏览器里填，任何配置都不会写进项目文件或基础设施

界面：
- 中文 / English 双语界面，6 套主题与浅色 / 深色 / 跟随系统
- 弹窗提供总开关、经扩展请求数（只统计后台通道）、本页近 5 分钟的网络层命中数、自动关闭倒计时、「本页地址命中哪条规则」的预览（浏览器不会应用的网络层规则会标红），以及「为这个页面创建规则」
- 代理自动关闭：30 分钟 / 1 小时 / 2 小时 / 4 小时，基于浏览器定时器，服务工作线程重启后仍然生效
- 快捷键：⌘⇧P（Windows/Linux 为 Ctrl+Shift+P）切换代理；配置页内 N 新建规则、/ 或 ⌘F 聚焦搜索、Esc 关闭弹窗

关于数据：
- 规则、日志与偏好全部保存在你本机的浏览器存储中，没有账号、没有统计埋点、不连接任何自有服务器
- 唯一的网络流量就是你自己要求代理的接口流量；导出文件也只写到本地
- 扩展自身零远端依赖：不加载远程脚本、不请求任何远端接口，界面、规则与日志全部从本机读取（你要求代理的那个接口当然仍然需要网络可达）
- 关于「更改您访问的网站上的数据」权限：被代理的请求发生在每个开发者自己的内网域名、localhost 与各个测试环境之间，这些地址无法在扩展里预先枚举。扩展用它只做两件事——在你浏览的页面上注入拦截器、按你亲手创建的规则代发请求，不向任何第三方或开发者服务器发送数据
- 关于「携带 Cookie」：默认关闭。某条规则开启后，带出去的是你在该规则指向的那个目标环境已有的会话，请求仍然只发往该地址，不经过第三方或我们的服务器
- 隐私政策：https://liaolongdong.github.io/cross-origin-proxy/privacy.html
- 产品说明页：https://liaolongdong.github.io/cross-origin-proxy/

限制：最多 200 条规则、最近 500 条日志、请求体上限 10MB、延迟 0–60000 毫秒、Mock 与改写的状态码钳制在 200–599（否则前端无法构造有效响应）。需要较新版本的桌面 Google Chrome（Manifest V3）。

问题反馈与源码：https://github.com/liaolongdong/cross-origin-proxy

常见问题：

需要后端配合吗？
不需要。规则全部在浏览器里生效，不用改后端代码、不用请后端加 CORS 头或重新部署。

规则加了没生效怎么办？
按这个顺序检查：弹窗总开关是否开启 → 该规则是否启用 → 页面是否重新加载（已发出的请求不会被追溯改写）→ 在「URL 匹配测试」里看是否被更靠前的规则遮蔽 → 正则是否覆盖整条 URL（网络层替换整个 URL，后台通道只替换命中片段，覆盖不全结果不同）。

规则生效了但控制台仍报 CORS？
只重写地址的请求仍受同源策略约束——目标环境没允许你的来源就照样被拦。给这条规则加任一改写能力（最省事的是加一个响应头覆盖），它就改由后台通道代发，页面侧的跨域校验不再适用。「URL 匹配测试」会告诉你当前走哪条通道。

会跟系统代理或抓包工具冲突吗？
不会。它只在浏览器内工作，不改系统代理设置，与公司 VPN 和 Charles 等抓包工具可以共存——改写发生在浏览器内部，外部工具看到的是改写后的请求。

支持哪些匹配方式？
三种：通配符（以 * 结尾）、前缀匹配和正则表达式。通配符和前缀规则由浏览器网络层直接处理，零脚本开销；正则和带改写、Mock、延迟、阻断、重试、请求头覆盖等高级能力的规则由扩展后台代发。

规则有数量限制吗？
最多 200 条规则、最近 500 条日志、请求体上限 10MB、延迟 0–60000 毫秒、Mock 与改写的状态码钳制在 200–599。

数据会上传到服务器吗？
不会。规则、日志与偏好全部保存在本机浏览器存储中，没有账号、没有埋点、不连接任何自有服务器，唯一的网络流量就是你自己要求代理的接口请求。

支持哪些浏览器？
需要较新版本的桌面 Google Chrome（Manifest V3），不支持 Firefox、Safari、Edge 或移动端浏览器。

会影响其他标签页或线上环境吗？
不会自动影响。只有处于启用状态、且地址匹配上的请求才会被处理；总开关一关，网络层那层规则也一起卸载。不想让代理一直挂着，可以设 30 分钟到 4 小时的自动关闭倒计时。

换电脑，或同事要同一套配置怎么办？
把配置导出成 JSON（默认开启分享模式，剔掉凭据类请求/响应头与 token 类查询参数），对方导入时可以选择覆盖或合并；整套规则也能存成命名环境快照，在多个环境之间一键切换。规则本身只存在你本机的浏览器存储里，没有云同步。
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
- Send the target environment's cookies per rule, off by default: when a rule turns it on the extension issues the request with credentials: 'include', carrying the session you already have there instead of a cookie pasted into the header overrides
- Response overrides: the status code, the response headers, or individual JSON fields by dot-notation path (`data.token`)
- Mock responses with your own fake data (JSON / text / HTML / XML) when the API is not built yet
- Conditional mock responses: give one rule several conditions (URL pattern, request method, query parameters) and the first match decides the body, status and Content-Type
- Add 0–60000 ms of latency to throttle a slow network and exercise loading, skeleton and timeout states
- Block requests to verify error handling and offline fallbacks; a blocked request is never replayed
- Retry automatically on network errors, 5xx responses and the 30-second per-attempt timeout — off, or 1–5 attempts with a 100–30000 ms interval
- Limit a rule to specific HTTP methods (GET/POST/PUT/DELETE/PATCH/OPTIONS/HEAD), or append and override query parameters on the proxied URL (gray-release tags, __env=uat)
- Forward WebSocket connections, so real-time features follow the same environment switch
- Rules that only rewrite a URL are resolved inside the browser's network layer (declarativeNetRequest), adding no script work to your page; turning the global switch off uninstalls those rules too, so no invisible redirect is left behind

How a rule gets picked:
- List order is priority — the lowest number matches first, and a request is handed to the first rule that matches it; the rules below are never evaluated
- The URL match tester also lists the rules that match the same URL but sit behind it, so you can see the effect of a reorder before you make one
- An empty target URL means "stay on this environment": the request is issued by the extension without changing its address, which is how you add a header or response override without redirecting anything

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
- Export configuration as JSON; share mode is on by default, stripping Authorization / Cookie style request and response headers plus token-like query parameters (untick it for a verbatim backup). On import you replace the current rules or merge into them, so a teammate gets the identical setup
- Per-rule hit counts for both channels: the network layer over the last 5 minutes, the background channel since the last config change (an in-memory count that restarts when the worker is recycled)

One thing that is by design, not a bug: a rule that only rewrites the URL is handled by the browser's network layer, so that request never passes through the extension's scripts and does not appear in the request log. For those rules, read the "This tab · 5 min" network-layer counter in the popup, verify with the URL match tester, or check the rule's hit count; anything with an override, mock or delay shows up in the log normally.

If a rule seems not to take effect, check in this order:
1. The global switch in the popup is on (switching it off also removes the network-layer rules)
2. That rule itself is enabled
3. You reloaded the page — requests already sent are not rewritten retroactively
4. Test the actual URL in the URL match tester: an enabled rule with a lower priority number may be matching first and shadowing it
5. For regex rules, make sure the pattern covers the whole URL: the network layer replaces the entire URL while the background channel replaces only the part your pattern matched

About the same-origin policy: a page may only read responses that come from the same origin — same scheme, same host, same port — and a call carrying custom request headers first has to survive a preflight (OPTIONS). If the preflight or the real response is missing an Access-Control-Allow-Origin that allows your origin, the request never reaches your application code: "the response is right there in the Network tab, but the console reports an error" is the same event seen from both sides. This extension changes nothing on the backend and does not pretend the check disappears — a simple rule changes the address a request goes to, a complex rule changes who issues it.

The rule took effect, the address did change, and the console still says CORS — that usually is not a broken rule. A request whose only rewrite happened in the network layer is still a cross-origin request the browser checks against the same-origin policy, so a target environment that does not allow your origin gets blocked. Add any capability to that rule (a response header override is the cheapest) and it moves to the background channel: the extension issues the request and hands the page a response it constructed, so the page's CORS check never runs. The URL match tester shows which channel a given address is currently taking.

How it differs from the usual options:
- Versus a per-project dev-server proxy: rules live in the browser, apply to every project at once, and can rewrite responses instead of only forwarding
- Versus a system-wide capture proxy: no local certificate to install, no system network settings to change, no system proxy port to configure, and it only touches pages in the browser. A company VPN or a capture tool keeps working alongside it — the rewrite happens inside the browser, so those tools see the rewritten request rather than competing with it
- Versus editing project config or build scripts: it writes no file in your repository and appears in no build output, so a teammate never has to find the proxy line in your project — and nobody commits their localhost address
- Versus an API client or a header-modifier extension: it works on the requests the page actually makes, instead of asking you to replay them in another tool
- Its limits, stated plainly: it is a browser tool. It cannot help a server-to-server call, and its rules live in your Chrome profile — export JSON when a teammate needs them.

What it is not:
- Not a public CORS relay: a request only ever goes to the address written in your own rule, never through somebody else's server
- Not a VPN or a system proxy: it changes no system network setting and carries no other application's traffic — only the browser requests your rules name
- Not a packet-capture debugger: no local root certificate, no TLS inspection, no recording of everything the machine sends, no archive of past responses
- Not an API platform: mocking stands in for an endpoint that is not written yet; it is not interface documentation, test-case management, or a collaboration backend
- Not a server-side gateway or reverse proxy: you type the target address in the browser, and no configuration ends up in a project file or in infrastructure

Interface:
- English and Chinese UI, six themes, light / dark / system modes
- Popup with a global switch, the request count via the extension (background channel only), this tab's network-layer hit count over the last 5 minutes, an auto-off countdown, a preview of which rule matches the page you have open (network-layer rules Chrome won't apply go red), and "create a rule for this page"
- Auto-off countdown of 30 minutes, 1, 2 or 4 hours, built on browser alarms so it survives service-worker restarts
- Keyboard shortcut Ctrl+Shift+P (⌘⇧P on macOS) to toggle proxying; on the options page N adds a rule, / or ⌘F focuses search, Esc closes the topmost dialog

About your data:
- Rules, logs and preferences are stored in your browser's local storage on your own device. No accounts, no analytics, no telemetry, no servers of ours
- The only network traffic is the API traffic you ask it to proxy; exports are written locally
- The extension itself has zero remote dependencies: no remote scripts, no calls to any endpoint of ours, and its UI, rules and logs are all read from local storage (the API you proxy obviously still has to be reachable)
- About the "change the data on websites you visit" permission: proxied requests happen on each developer's own internal domains, localhost and staging hosts, which cannot be enumerated in advance. The extension uses that permission for two things only — injecting the interceptor into pages you browse, and issuing requests on your behalf according to rules you created. Nothing is sent to any third party or to a developer-controlled server
- About "Send cookies": off by default. When a rule turns it on, the session that goes out is the one you already have at the environment that rule points at, and the request still travels only to that address — never through a third party or our servers
- Privacy policy: https://liaolongdong.github.io/cross-origin-proxy/privacy.html
- Product overview: https://liaolongdong.github.io/cross-origin-proxy/

Limits: 200 rules, the last 500 log entries, 10 MB request body, delays of 0–60000 ms, and mocked or overridden status codes clamped to 200–599 so the page can always build a valid response. Requires a recent desktop Google Chrome (Manifest V3).

Source code and issue tracker: https://github.com/liaolongdong/cross-origin-proxy

FAQ:

Does it require backend changes?
No. Rules take effect entirely inside the browser. No backend code changes, no CORS headers to add, no redeployment needed.

I added a rule but nothing changed — what do I check?
In order: Is the global switch in the popup on? Is the rule itself enabled? Did you reload the page (sent requests are not rewritten retroactively)? Test the URL in the match tester — a higher-priority rule may be shadowing it. For regex, make sure the pattern covers the whole URL: the network layer replaces the entire URL while the background channel replaces only the matched part.

The rule works but the console still says CORS?
A URL-only rewrite is still a cross-origin request subject to same-origin policy — if the target does not allow your origin, it gets blocked. Add any override capability to that rule (a response header override is the cheapest) and it moves to the background channel, where the page's CORS check no longer applies. The URL match tester shows which channel a given address is currently taking.

Does it conflict with system proxies or capture tools?
No. It works only inside the browser and does not change system proxy settings. Company VPNs and capture tools like Charles keep working — the rewrite happens inside the browser, so external tools see the rewritten request.

What matching modes are supported?
Three: wildcard (ending with *), prefix match, and regular expression. Wildcard and prefix rules are handled by the browser's network layer with zero JavaScript overhead; regex and rules with advanced capabilities (override, mock, delay, block, retry, header override, query parameter injection) are handled by the extension's background.

Are there limits on rules?
Up to 200 rules, the last 500 log entries, 10 MB request body, delays of 0–60000 ms, and mocked or overridden status codes clamped to 200–599.

Is any data uploaded to a server?
No. Rules, logs and preferences are stored in your browser's local storage only. No accounts, no analytics, no remote endpoints. The only network traffic is the API traffic you ask it to proxy.

Which browsers are supported?
A recent desktop Google Chrome (Manifest V3) is required. Firefox, Safari, Edge and mobile browsers are not supported — the extension relies on Chrome-specific APIs.

Will it touch my other tabs or production?
Nothing happens by itself. Only enabled rules act, and only on requests whose URL matches one of them; switching the global toggle off removes the network-layer rules with it. If you would rather not leave proxying on all day, set the auto-off countdown to 30 minutes, 1, 2 or 4 hours.

I changed machines — how does a teammate get the same setup?
Export the configuration as JSON (share mode is on by default and strips credential-like request and response headers plus token-like query parameters) and let them import it either over their rules or merged into them; a whole rule set can also be saved as a named environment profile and switched in one click. The rules themselves live only in your browser's local storage — there is no cloud sync.
```

**Category**: Developer Tools
**Languages**: 中文（中国）+ English（两个本地化列表都建，中文为默认）

### 1.3 Single purpose（表单里的一句话，必须窄）

```
Redirects a page's API requests to another backend environment and lets developers modify those requests and responses for cross-environment debugging.
```

## 2. Graphics & Assets

运行 `pnpm assets`（中文版）与 `pnpm assets:en`（英文版）生成，产物在 `store-assets/`（已 gitignore，可再生）。原图按语言分两套：`screenshots/*.png` 是中文界面（落地页与 README 用），`screenshots/en/*.png` 是英文界面——`--en` 生成商店图时优先取后者，**英文列表因此配的是英文截图**。截图于 2026-09-22 用 1.1.0 构建实拍重拍（演示数据，7 条规则）。

| Asset                  | Dimensions  | Status   | Filename                                                                              |
| ---------------------- | ----------- | -------- | ------------------------------------------------------------------------------------- |
| Store icon             | 128×128 PNG | ✅ Ready | `public/icon/128.png`                                                                 |
| Screenshot 1（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/01-rules-overview.png`                                   |
| Screenshot 2（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/02-rule-editor.png`                                      |
| Screenshot 3（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/03-url-tester.png`                                       |
| Screenshot 4（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/04-request-log.png`                                      |
| Screenshot 5（中文）   | 1280×800    | ✅ Ready | `store-assets/screenshots-zh/05-popup.png`                                            |
| Screenshot 1–5（英文） | 1280×800    | ✅ Ready | `store-assets/screenshots-en/0X-*.png`（英文界面，标题与说明为英文）                  |
| Small promo tile       | 440×280     | ✅ Ready | `store-assets/tiles/small-tile-zh.png` / `small-tile-en.png`                          |
| Marquee promo tile     | 1400×560    | ✅ Ready | `store-assets/tiles/marquee-zh.png` / `marquee-en.png`                                |
| GitHub social preview  | 1280×640    | ✅ Ready | `store-assets/tiles/github-social-preview.png`（仓库 Settings → Social preview 上传） |

**Screenshot notes**：每张图顶部带一句能力标题 + 一行说明，主体是真实界面截图（非 mockup、不含任何真实内网域名或 token）。商店只接受 **1280×800 或 640×400**，像素级校验，最多 5 张——顺序按「先讲清主用途 → 再讲能力 → 最后讲开关可见性」排列。标题与说明只写**这张图里画得出来的东西**：规则表单是可滚动的，所以 02 说「匹配 / 重写 / 方法 / 查询参数 / 请求头 + `{{凭据变量}}`」，Mock、延迟、阻断留给详细描述与落地页。落地页与 README 另有两张不进商店的图（`config-import`、`credential-variables`），因为 5 张是硬上限。

## 3. Permissions Justification

审核要求逐条给具体理由，"needed for the extension to work" 会被拒。以下文案可直接粘贴。

| Permission                      | Type             | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                       | permissions      | Saves the user's proxy rules, credential variables, environment profiles, config restore points, request logs and UI preferences in `chrome.storage.local`. Nothing leaves the device and no other storage area is used.                                                                                                                                                                                                                                                     |
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

Rationale to paste if the form asks for clarification: request and response data of proxied calls is read **inside the user's browser** to perform the transformation the user configured, and is written only to `chrome.storage.local`. The extension contains no analytics, no telemetry and no remote endpoint of its own; there is no code path that uploads user data. Blocked/mock responses never reach a third party. One per-rule switch is worth naming: **Send cookies** is off by default, and a rule that turns it on sends the request with `credentials: 'include'`, so the browser attaches the session the developer already has on that same target environment. It changes nothing about who receives data — the request still goes only to the address the user's own rule points at, never to us. A second, opposite-direction control is worth naming too: **Credential variables** let the developer keep a token out of the rule itself, writing `{{NAME}}` where the value is resolved on-device at the moment the proxied request is issued. The table lives in `chrome.storage.local` next to the rules, and the only thing that leaves the extension's process is the expanded header or query value on the request the user asked for — the same destination the rule already names. A third local-only mechanism deserves a line: **config restore points** keep the previous rule set whenever an operation is about to replace all of it (a replace-mode import, loading a profile, a batch delete), so an accidental wipe is reversible; at most five snapshots are kept, they hold the same data as the rules themselves — credential slots stay `{{NAME}}` references — and they never leave the device.

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
for p in "" en.html privacy.html; do
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

| 字段           | 值                                                                          | 说明                                                            |
| -------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Publisher Name | Better                                                                      | 与 `package.json` 的 `author.name` 一致                         |
| Contact Email  | 924902324@qq.com                                                            | 商店页面公开显示；Google 的整改通知发到这里，必须是能收信的邮箱 |
| Support URL    | `https://github.com/liaolongdong/cross-origin-proxy/issues`                 |                                                                 |
| Homepage URL   | `https://liaolongdong.github.io/cross-origin-proxy/`                        |                                                                 |
| Store URL      | `https://chromewebstore.google.com/detail/dednngakllblfilbndkaggphohmpgcbg` |                                                                 |

> 仓库已公开（`liaolongdong/cross-origin-proxy`，2026-09-07），[GITHUB.md](./GITHUB.md) §0.1 记录哪些一次性动作已经落地。提审前唯一必须复核的是**隐私政策可访问**：

```bash
for p in "" en.html privacy.html llms.txt llms-full.txt; do
  printf '%-16s ' "/$p"
  curl -s -o /dev/null -w '%{http_code}\n' "https://liaolongdong.github.io/cross-origin-proxy/$p"
done
```

> 联系邮箱会在商店页与隐私政策页公开，可能被爬虫采集用于发送 Spam。若希望隔离，可改用 GitHub 专用可收信地址（`用户名+编号@users.noreply.github.com`），并同步更新本节与 `docs/privacy.html`。

## 8. Version History

完整版本历史以 [CHANGELOG.md](./CHANGELOG.md) 为唯一事实源（发版链路会把它对应小节切成 GitHub Release 的说明）；本表只记**已经打进 `v*` tag 交出去的版本**，加上**此刻备好、等着第一个 tag 的那一包**——所以「待提审」最多只有一行，它是 `package.json` 里那个版本。

| Version | Date       | Changes                                                                                                                                                                                                                                                                                                                                                                         | Status                                         |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1.2.0   | 待提审     | 动效收进令牌层（弹窗与抽屉进 320ms / 出 150ms、换配色与换语言走整页交叉淡入、规则行拖完有 FLIP 归位、新落进来的日志行有一笔淡色底），「减少动态效果」补齐漏掉的 `transition-delay` / `animation-delay` 那一半，日志抽屉满 500 条时首行从 3.7–4.9s 降到 0.4–0.8s，弹窗「为当前页创建规则」先看这一页在调哪些接口，「这一笔为什么没走代理」给出一句话归因，落地页可当场试一条规则 | 已备好，等首个 `v*` tag（`v1.2.0`）推出去      |
| 1.1.0   | 未单独出包 | 弹窗诊断补两处「不知道」与「没有」的区分（本页尚未收到最新配置 / 页面自报的拦截活动）、配置恢复点、导入预览、凭据变量 `{{NAME}}`、HAR 与 cURL 导出链路完善、双通道命中数分格、关闭总开关时卸载网络层规则                                                                                                                                                                        | 没打过 `v1.1.0` tag，内容随 1.2.0 那一包一起交 |
| 1.0.0   | 2026-09-18 | 首次提交：双通道代理（DNR + 后台）、请求/响应改写、Mock/延迟/阻断、方法与查询参数控制、WebSocket 转发、HAR/cURL 导入导出、环境快照、中英双语与 6 主题                                                                                                                                                                                                                           | Published                                      |

> ⚠️ **商店在线的 1.0.0 与第 1 节描述之间有一条已知不一致**：描述承诺「关闭总开关时这层规则一并卸载」，而 1.0.0 的包里 `utils/dnrRules.ts` 并未按总开关清空动态规则。该行为修复住在 [CHANGELOG.md](./CHANGELOG.md) 的 `## [1.1.0]` 小节，**在它提审通过之前，商店页上这句话对已安装用户是不成立的**——这正是第 9 节要求「关总开关 → 请求不再被转发」实机验证一次的原因，也是本表刻意把提审状态与 `CHANGELOG.md` 分开记的理由。
>
> 上表 Changes 列只描述条目范围，不代表 2026-09-07 那一节的功能清单。

### 8.1 新版本要粘贴的「更新说明 / Release notes」

**这一步只能手工，别去工作流里找它。** GitHub Release 的说明由 `release.yml` 从本表对应的 `CHANGELOG.md` 小节自动切出，商店那一栏却没有任何自动化通路：实测于 2026-09-22，`pnpm exec wxt submit --help`（底层 `publish-extension/4.0.5`）只有 `--chrome-zip` / `--chrome-extension-id` / 三个凭据 / `--chrome-publish-target` / `--chrome-deploy-percentage` / `--chrome-review-exemption` / `--chrome-skip-submit-review` 这几项，**没有 whats-new 类参数**。所以下面两块文本是提审时在 Dashboard「更新信息 / Release notes」栏粘贴的素材，粘贴动作发生在包上传之后。

写作约束与商店描述同源：不带版本号（这一栏本来就绑在版本上，写了反而在改包重传时变假）、不出现 `best` / `free` / 排名类措辞、不承诺下面第 9 节没被实机验证过的能力。中英文条目数一一对应，删减时**两边同步删**，只删一边就是下一次审计的一条发现。

中文（粘贴进「中文（中国）」列表）：

```
- 复杂规则没生效时终于能看出卡在哪：弹窗新增「这一页尚未收到最新配置」提示，并多一行页面自报的拦截活动。
- 修复复杂规则在 iframe 里从来没生效过的问题——此前只注入顶层页面。
- 导入前先预览：说清哪几条算新增、哪几条保留；替换式导入、加载快照与批量删除之后，都能从「设置 · 配置恢复点」整包回退（最多 5 份）。
- 凭据变量库：token 在规则里写成 {{名称}} 引用，真值只存在本机、只在后台代发那一刻展开，规则详情、导出文件与请求日志里始终只有这个引用。
- 导出更放心：配置导出与 HAR 导出默认走「分享模式」，凭据类请求头与响应头不再跟着文件走。
- 新增按规则的「携带 Cookie」开关，默认关闭。
- 命中次数按两条通道分两格显示，「这条规则不走该通道」不再被画成 0；规则表与 URL 匹配预演会标出「浏览器不会应用这条规则」并说明原因。
- 稳定性：被阻断的请求不再因后台重新匹配而真的发出；请求取消、超时、204/205/304 与含非 Latin-1 字符的响应头不再让页面请求永久挂起；同步 XHR 改为回退原生请求，而不是给页面一个空响应。
- 关闭总开关时，浏览器网络层的重定向规则一并卸载——此前仅重写 URL 的简单规则仍会继续改写请求。
- 界面细节：小屏菜单高亮当前区块、主题首帧不再闪默认配色、扩展内界面尊重系统的「减少动态效果」设置。
```

English（粘贴进 English 本地化列表）：

```
- When a complex rule does not take effect you can now see where it stalls: the popup adds a "this page has not received the latest config" notice and a page-reported interception line.
- Fixed complex rules never applying inside iframes — only the top frame was injected before.
- Preview an import before it lands: see which entries count as new and which stay, and roll back a whole replace-style import, a loaded snapshot or a bulk delete from "Settings · Config restore points" (up to 5).
- Credential variables: write tokens in rules as a {{NAME}} reference. Real values stay on your machine and are expanded only at the moment the background sends the request, so rule details, exported files and request logs carry just the reference.
- Safer exports: config and HAR exports now run through "share mode" by default, so credential headers no longer travel with the file.
- New per-rule "send cookies" switch, off by default.
- Hit counts are split into one column per channel, and "this rule does not use that channel" no longer renders as 0; the rule table and the URL match tester now flag rules the browser will not apply, with the reason.
- Stability: blocked requests are no longer actually sent after a background re-match; cancelled requests, timeouts, 204/205/304 responses and response headers containing non Latin-1 characters no longer leave page requests pending forever; synchronous XHR falls back to a native request instead of handing the page an empty response.
- Turning the global toggle off now unloads the network-layer redirect rules too — previously URL-rewrite-only rules kept rewriting requests.
- Interface details: the small-screen menu highlights the current section, the first frame no longer flashes the default palette, and the extension UI honours the system "reduce motion" setting.
```

字段长度上限无法从本机核实（这一栏只在登录后的 Dashboard 出现，本仓库机器访问不到商店域名），所以上面按「一条一句」写：中文 10 条 599 码点、英文 10 条 1,821 字符，两边条目数一致。若粘贴时被截断，**两边同步删到最后 4 条**（每条独立成句，删尾部不伤前面），不要只删一边。重算上面两个数（本文件的代码块不是从 §1 起就成对闭合的，按「末尾两个代码块」取会错位，所以这里按小节标题定位）：

````bash
python3 - <<'PY'
t = open('CHROMEWEBSTORE.md', encoding='utf-8').read()
for marker in ('中文（粘贴进「中文（中国）」列表）：', 'English（粘贴进 English 本地化列表）：'):
    a = t.index('```', t.index(marker)) + 4
    print(len(t[a : t.index('```', a)].strip('\n')), '码点')
PY
````

## 9. Pre-Publish Checklist

每轮提交都从头走一遍：这里的 `[ ]` 是运行时勾选，不是一次性记录，换一个包就得重走。仓库侧的一次性配置见 [GITHUB.md](./GITHUB.md)，上架后要做的翻转见第 12 节。

仓库与托管（提审前置，配好之后每轮复核）：

- [ ] 第 5 节的三个 URL 外加 `/llms.txt`、`/llms-full.txt` 实测都是 200——隐私政策打不开是首审最常见的拒审理由
- [ ] About 描述 / website / topics 三项已填（[GITHUB.md](./GITHUB.md) §1–§3）；三项全空等于放弃 GitHub 搜索摘要与话题页这两条被动流量
- [ ] Social preview 已上传（[GITHUB.md](./GITHUB.md) §4，无可用 API，只能设置页手动传）
- [ ] 已勾选私密漏洞报告（[GITHUB.md](./GITHUB.md) §6；`SECURITY.md` 把私密上报列为首选，本扩展拿的是 `<all_urls>`）
- [ ] 首个 `v*` tag 已推：Releases 有可下载 zip、README 的 `Release` 徽章转绿。商店已上架所以这一步不再影响「有没有安装入口」，但它决定「方式 B」是否成立，并且推完要按第 12 节 ① 那六处把「尚无 tag」的句子翻正

包与清单：

- [ ] `pnpm build:zip` 通过，zip 根目录就是 `manifest.json`
- [ ] `manifest.json` 的 `name` / `description` 与本文档第 1 节完全一致（Chrome 硬校验 ≤75 / ≤132，`pnpm test` 已守卫）
- [ ] 版本号 > 商店已发布版本（首次忽略）
- [ ] 包内无 `.git`、`node_modules`、源码 map、测试、`README.md`、本文件
- [ ] 第 1 节承诺的「关闭总开关时这层规则一并卸载」确实在包里——`utils/dnrRules.ts` 里那行 `proxyEnabled ? … : []` 是它的实现；装一次实测「开总开关 → 规则表命中数增长 → 关总开关 → 请求不再被转发」比读代码可靠。描述与包体行为不一致既是拒审风险，也是最容易吃差评的地方

商店信息：

- [ ] 分类 = Developer Tools；默认语言 = 中文（中国），并新增 English 本地化列表
- [ ] Single purpose 一句话填写（第 1.3 节）
- [ ] 本次新版本的「更新说明」已粘贴（第 8.1 节两块文本，中英各一份，两边同步删减）——`wxt submit` 没有这个参数，自动化不会替你填
- [ ] 每一项权限与 host 权限的理由都粘贴（第 3 节），`<all_urls>` 单独说明
- [ ] 数据披露按第 4 节勾选，与隐私政策文本一致
- [ ] 描述里的每条能力主张都对得上要提交的那个包，尤其是按实现收窄过的六处：URL 匹配测试的遮蔽方向、日志只落文本 body、cURL 仅限日志条目、覆盖/合并是**导入**模式、后台命中数是内存计数、弹窗「经扩展 · 今日」只含后台通道，网络层命中另占一格；2026-09-20 又按实现补了四处：长连接上只有地址重写、查询参数注入与阻断生效（请求头/请求体/响应改写、Mock、延迟、重试、携带 Cookie 对 socket 无效）、两条通道的命中数不可相加（窗口口径不同，且不适用的一格画「—」而不是 0）、HAR 导出与配置导出共用「分享模式」、携带 Cookie 是默认关闭的按规则开关
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
- [ ] 通道判定用「URL 匹配测试」面板核对：它直接显示命中的通道（网络层 / 后台）。简单规则在该面板显示网络层重定向、请求能正常转发，且弹窗右上格「本页 · 近 5 分钟」会出现网络层命中数、规则表的「命中次数」列会增长——但**请求日志里不会有这一条**（日志只由后台通道写入，网络层重定向不经过扩展脚本）；复杂规则在面板显示后台且日志有对应行。日志抽屉另有一个只统计网络层命中的面板可交叉验证
- [ ] Mock、延迟、阻断、响应改写、方法过滤、查询参数注入逐项生效
- [ ] WebSocket 规则能转发 `wss://` 连接；规则列表里 WS 徽标的悬停说明与实现一致——只有地址重写、查询参数注入与阻断在长连接上生效，其余能力画了也不会作用到 socket
- [ ] 「携带 Cookie」默认关闭时，目标环境收到的请求不带它的 Cookie；某条规则打开后请求以 `credentials: 'include'` 发出，且「URL 匹配测试」显示这条规则走后台通道（网络层无法表达该能力）
- [ ] 凭据变量：在「设置 → 凭据变量」建一个 `UAT_TOKEN`，把规则的请求头覆盖值写成 `{{UAT_TOKEN}}`，目标环境收到的是真值，而规则详情、配置导出、环境快照与请求日志里始终只有这个字面量引用（日志的 URL 那栏是未展开形态）；引用一个不存在的名字时请求把 `{{名称}}` 原样发出、控制台只点名不点值；WebSocket 规则的查询参数填 `{{名称}}` 在保存时被当场拒绝并说明原因
- [ ] 导入预览：粘贴/选择一个配置后点「预览」，报出的「预计新增 / 保留」与随后真正写入的结果一致；改过目标地址的同名规则被算作新增而不是更新，预览会点名它；坏 JSON 与来自更新版本的文件各有各的提示，且两种情况下输入原样保留、弹窗不关
- [ ] 配置恢复点：连续做替换式导入、加载快照、批量删除，「设置 → 配置恢复点」按从新到旧列出（最多 5 份），逐条能看出是哪一类操作；任选一份回退，规则集换回去、总开关不动，且回退自身也在列表里多出一条「回退前」
- [ ] 日志详情的凭据头默认打码（长值留尾 4 位），打开「显示凭据原值」能看到真值，关掉抽屉后自动收回；「复制为 cURL」始终写真实头值（打了码的命令重放不了）；方法筛选下拉覆盖 GET/POST/PUT/DELETE/PATCH/OPTIONS/HEAD 七项
- [ ] 页面里的同步 XHR（`open(m, u, false)`）命中复杂规则时回退原生并留下一条控制台提示：`send()` 返回时 `status`/`response` 已就绪，不能被异步化；命中阻断规则时不回退
- [ ] 命中次数列分两格（网络层 / 后台），两格数字相加**不等于**弹窗里的任何一格，这是预期：前者近 5 分钟、后者自配置变更起累计；每格只代表自己那条通道——那条规则不走该通道、或网络层读不到时，那一格显示「—」而不是 0，悬停给出的是各自那句原因
- [ ] 导出 HAR：默认（分享模式）逐条剔除 `Authorization`/`Cookie` 等凭据类请求/响应头，正文与 URL 原样保留（截断 URL 就看不出请求打到了哪）；取消勾选后为全量。配置导出走同一个勾选，还会额外剔掉 token 类查询参数覆盖
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
- **不在这条链路里的两件事**：①新建商店条目（见上一条的一次性准备）；②**新版本绑定的「更新说明」**——`wxt submit` 的参数表里没有它，只能提审时在 Dashboard 粘贴第 8.1 节那两块文本。GitHub Release 的说明反而是自动的（工作流把 `CHANGELOG.md` 对应小节切出来），两边别互相以为对方已经填了。
- **Secrets 未配时的行为**：Release 照建，商店那一步跳过并在 Run 页面留指引，不报红。
- **先验后提审**：首次接管已有条目时，用 `Run workflow` 勾选 `skip-review`（只上传成草稿）或选 `publish-target=trustedTesters`，人工核对完再走 `default`。
- **与商店表单的耦合点**：详细描述里刻意不写版本号，避开每次发版都要改商店文案；但限制条数（200 规则 / 500 日志 / 10MB）与能力清单必须与 `README.md`、`docs/` 落地页、`CHANGELOG.md` 保持同一事实。

## 12. 安装漏斗的两段状态与还没翻的句子

安装链路有两个**互相独立**的状态变化，不要合并成一次改：

| 翻转       | 触发                      | 变化                                                                                  | 状态                           |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------ |
| ① 打出 tag | 推 `v*` tag（见第 11 节） | GitHub Release 带上预构建 zip，README 的 `Release` 徽章转绿，「方式 B」这时才真的可用 | **未做**——仓库至今 0 个 tag    |
| ② 商店上架 | 审核通过并公开发布        | 出现商店 URL，安装主入口从源码构建换成商店                                            | **已于 2026-09-20 改完**，见下 |

②的落点已全部落地，留此一行避免有人再去「补」：`docs/index.html` 与 `docs/en.html` 的 hero 主按钮是「添加到 Chrome / Add to Chrome」，两页 `#install` 卡片以商店为默认路径，两份 README 的 `### A` 就是 Chrome Web Store、首屏 CTA 第一位也换成它（页内锚点「三种安装方式 / Install options」退到第二位），`llms*.txt` 也已把商店 URL 列为第一个安装路径，本文件 §7 另有 Store URL 一行。商店表单文案本身从来不需要为上架而改——名称、摘要、详细描述都不含安装路径，这正是当初不写版本号的收益。

**①还没做，所以这几句此刻为真、推完 tag 就变假**，逐个改掉：

| #   | 文件                                        | 位置                                       | 现在写的是                                                  | 推 tag 后改成                                    |
| --- | ------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------ |
| 1   | `docs/llms.txt` 与 `llms-full.txt` 的链接节 | 预构建产物那一行                           | 「尚未发布第一个 tag / no tag published yet」（两份各一处） | 删掉那半句，保留「每个 tag 自动附带」            |
| 2   | `docs/llms-full.txt`                        | 安装路径 B                                 | 「**No tag has been published yet**，这条路不可用」         | 整句删除，B 成为可用的回退路径                   |
| 3   | `docs/llms-full.txt`                        | 「常见误解」第 6 条                        | 「商店为真，但没有任何 git tag」                            | 不再构成误解，删掉或改成「商店与 Releases 都有」 |
| 4   | 四页落地页与 `llms*.txt`                    | 页脚 `v1.0.0`、`softwareVersion`、页脚日期 | 仍是 1.0.0 / 旧日期                                         | 与 `package.json` 对齐，日期与 sitemap 同日      |
| 5   | 本文件 §8                                   | 最新那一行（此刻是 `1.2.0`）               | 「待提审」                                                  | 填实际提审日期与状态                             |
| 6   | `README.md` / `.en.md`                      | `### B. GitHub Releases`                   | 那句 ⚠️「仓库还没有打出第一个 tag，此刻 Releases 是空的」   | 删掉那一句——首个 tag 之后它是假的                |
| 7   | `docs/llms-full.txt`                        | 头部 `Last verified` 那一行                | 「working version is 1.2.0, **not yet released**」          | 改成已发布版本，与页脚与 `softwareVersion` 同值  |

改完必须跑的守卫：`pnpm test`（`tests/docs-consistency.test.ts` 对中英落地页逐条对等，第 4 项两页同改；它同时要求 `CHANGELOG.md` 存在 `## [<package.json 版本>]` 小节，并在 §0 预算表偏离正文实测码点时变红）+ `pnpm exec prettier --check` 只作用于本次改动的 `.md`。落地页正文若动过，把该页 `dateModified`、页脚「最后更新」与 `docs/sitemap.xml` 对应 `<lastmod>` 一起推到同一天。`pnpm assets` 生成的商店图里烧的是**产品站地址**，不含版本号也不含商店 URL，所以①不需要重跑图——除非界面本身变了，那要走第 2 节重拍。
