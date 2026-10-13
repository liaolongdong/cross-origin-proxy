/**
 * 触发页（跑在 web 环境，即默认端口 5300）
 *
 * 这份页面是**客户端那一侧的测试夹具**：扩展能做的所有事都发生在「页面发一个请求」之后，
 * 所以没有它，上面那套多环境后端只能被 curl 量到，量不到拦截、桥接与代发那一段。
 * 用例按扩展的能力分组，每条都写明「这一格本来该看到什么」——包括那些
 * **预期失败**的格子（CORS 拦下、阻断、超时、回退原生），它们和成功格同样承重。
 *
 * 页面用纯 DOM、零依赖、零构建：它不属于扩展产物，也不参与 WXT 打包。
 */

/**
 * 用例表。
 *
 * `kind` 决定走哪条真实通道，这几条各有不可替代的理由：
 * - `fetch` / `xhr`：两条 HTTP 拦截面（`main-interceptor` 各包一遍）
 * - `sync`：同步 XHR，按文档必须回退原生（代理要跨 world 往返，`send()` 返回时结果拿不到）
 * - `formdata` / `blob`：非字符串请求体，同样只能回退原生
 * - `abort`：页面 `AbortSignal` → 后台要掐掉那一笔上游
 * - `xhrtimeout`：页面自己设的 `xhr.timeout` 到期，不能误伤下一笔
 * - `ws`：长连接（只有地址重写 / 查询注入 / 阻断三件事）
 * - `img`：以 `image` 资源类型进网络层，验证 DNR 的 resourceTypes 覆盖面
 *
 * `env` 是这一笔**发给谁**（页面自己的来源恒为 `web`）。
 */
const CASES = [
  // ── 基线：不加任何规则时，这一笔本来什么样 ──────────────────────────────
  {
    g: '基线（先跑这一组，确认夹具本身是好的）',
    id: 'same-origin',
    label: '同源 GET /api/health',
    kind: 'fetch',
    env: 'web',
    expect: '200 · env=web',
  },
  {
    g: '基线（先跑这一组，确认夹具本身是好的）',
    id: 'fat-health',
    label: 'GET fat/api/health',
    kind: 'fetch',
    env: 'fat',
    path: '/api/health',
    expect: '200 · env=fat（FAT 放行本机来源）',
  },
  {
    g: '基线（先跑这一组，确认夹具本身是好的）',
    id: 'uat-health',
    label: 'GET uat/api/health',
    kind: 'fetch',
    env: 'uat',
    path: '/api/health',
    expect: '200 · env=uat（UAT 只放行触发页来源）',
  },
  {
    g: '基线（先跑这一组，确认夹具本身是好的）',
    id: 'prod-health',
    label: 'GET prod/api/health',
    kind: 'fetch',
    env: 'prod',
    path: '/api/health',
    expect: 'TypeError: Failed to fetch —— PROD 不放行任何来源；导入前后都是这一句，它是夹具的对照格',
  },

  // ── 通道分流 ────────────────────────────────────────────────────────
  {
    g: '双通道分流（同一条重写，落点不同）',
    id: 'dnr-success',
    label: 'GET fat/api/list?page=1',
    kind: 'fetch',
    env: 'fat',
    path: '/api/list?page=1&size=3',
    expect:
      '导入「FAT → DEV（纯重写 · 网络层）」后 env 应变成 dev。这一格接得住，是因为 DEV 回 Access-Control-Allow-Origin: *——跨原点的改写在目标看来 Origin 是 null，只有这一档接得住',
  },
  {
    g: '双通道分流（同一条重写，落点不同）',
    id: 'dnr-cors',
    label: 'GET fat/api/health（重写指向 PROD）',
    kind: 'fetch',
    env: 'fat',
    path: '/api/health',
    expect:
      '启用「FAT → PROD（纯重写 · 仍受 CORS 约束）」后应依然 net::ERR_FAILED：落点换成了 PROD，而跨原点的改写让目标收到 Origin: null，PROD 又不放行任何来源。同一台 PROD 交给后台代发（下一格）就通——这两条合起来是「网络层重写仍受 CORS 约束、后台通道不受」的对照',
  },
  {
    g: '双通道分流（同一条重写，落点不同）',
    id: 'sw-cors',
    label: 'GET prod/api/v1/proxied（后台通道）',
    kind: 'fetch',
    env: 'prod',
    path: '/api/v1/proxied',
    expect:
      '启用「PROD → PROD（加一项响应头 · 切后台通道）」后这一格应变成 200 · env=prod——同一台 PROD 依旧不放行任何来源，只是改由后台代发',
  },

  // ── 方法与请求体 ────────────────────────────────────────────────────
  {
    g: '方法与请求体',
    id: 'post-order',
    label: 'POST fat/api/orders（JSON）',
    kind: 'fetch',
    env: 'fat',
    method: 'POST',
    path: '/api/orders',
    body: '{"sku":"A-100","qty":2}',
    expect: '201 · 回显 body',
  },
  {
    g: '方法与请求体',
    id: 'put-order',
    label: 'PUT fat/api/orders/42',
    kind: 'fetch',
    env: 'fat',
    method: 'PUT',
    path: '/api/orders/42',
    body: '{"qty":9}',
    expect: '200 · id=42',
  },
  {
    g: '方法与请求体',
    id: 'delete-order',
    label: 'DELETE fat/api/orders/7',
    kind: 'fetch',
    env: 'fat',
    method: 'DELETE',
    path: '/api/orders/7',
    expect: '200 · deleted=7',
  },
  {
    g: '方法与请求体',
    id: 'delete-204',
    label: 'DELETE fat/api/orders/7?empty=1',
    kind: 'fetch',
    env: 'fat',
    method: 'DELETE',
    path: '/api/orders/7?empty=1',
    expect: '204 · 无正文',
  },
  {
    g: '方法与请求体',
    id: 'patch-order',
    label: 'PATCH fat/api/orders/8',
    kind: 'fetch',
    env: 'fat',
    method: 'PATCH',
    path: '/api/orders/8',
    body: '{"note":"x"}',
    expect: '200',
  },
  {
    g: '方法与请求体',
    id: 'xhr',
    label: 'XHR GET fat/api/echo',
    kind: 'xhr',
    env: 'fat',
    path: '/api/echo',
    expect: '200（页面侧另一条拦截通道）',
  },
  {
    g: '方法与请求体',
    id: 'sync-xhr',
    label: '同步 XHR fat/api/health',
    kind: 'sync',
    env: 'fat',
    path: '/api/health',
    expect: '必须回退原生 → 状态来自 FAT 本身，日志里那一行不该出现',
  },
  {
    g: '方法与请求体',
    id: 'formdata',
    label: 'FormData POST fat/api/upload',
    kind: 'formdata',
    env: 'fat',
    path: '/api/upload',
    expect: '非字符串请求体 → 回退原生，界面「页面自报」会点出回退数',
  },
  {
    g: '方法与请求体',
    id: 'blob',
    label: 'Blob POST fat/api/upload',
    kind: 'blob',
    env: 'fat',
    path: '/api/upload',
    expect: '同上：Blob 不能跨 postMessage',
  },
  {
    g: '方法与请求体',
    id: 'upload-9m',
    label: 'POST 9MB fat/api/upload',
    kind: 'bigbody',
    env: 'fat',
    path: '/api/upload',
    mb: 9,
    expect: '启用「FAT → DEV（上传通道 · 10MB 请求体上限）」后这一笔走后台代发：9MB 在上限内 → 200 · env=dev',
  },
  {
    g: '方法与请求体',
    id: 'upload-11m',
    label: 'POST 11MB fat/api/upload',
    kind: 'bigbody',
    env: 'fat',
    path: '/api/upload',
    mb: 11,
    expect:
      '超过 10MB → 由扩展侧（proxyHandler 的 MAX_BODY_SIZE）拒掉，不是服务端 413；实测拒收后拦截器回退原生，这一笔照样发给 FAT（页面 200 · env=fat，SW 记 status=0），上限只管代发通道、关掉上一格那条规则也是原生 200',
  },

  // ── 请求头与凭据 ────────────────────────────────────────────────────
  {
    g: '请求头与凭据（{{变量}} 只在代发那一刻展开）',
    id: 'profile-401',
    label: 'GET fat/api/user/profile（不带凭据）',
    kind: 'fetch',
    env: 'fat',
    path: '/api/user/profile',
    expect: '401 ——「FAT → DEV（注入凭据头 {{API_TOKEN}}）」启用后这一格应变 200',
  },
  {
    g: '请求头与凭据（{{变量}} 只在代发那一刻展开）',
    id: 'profile-direct',
    label: 'GET uat/api/user/profile（直连）',
    kind: 'fetch',
    env: 'uat',
    path: '/api/user/profile',
    expect: '恒为 401：那条注入规则只覆盖 fat 前缀，页面自己塞真值也不等于代理生效',
  },
  {
    g: '请求头与凭据（{{变量}} 只在代发那一刻展开）',
    id: 'query-inject',
    label: 'GET fat/api/query?a=1',
    kind: 'fetch',
    env: 'fat',
    path: '/api/query?a=1',
    expect: '启用「FAT → UAT（注入查询参数）」后 query 里应多出注入的那几项，且 env=uat',
  },
  {
    g: '请求头与凭据（{{变量}} 只在代发那一刻展开）',
    id: 'cookie-probe',
    label: 'POST uat/api/set-cookie?value=<随机>（SameSite=None）',
    kind: 'setcookie',
    env: 'uat',
    path: '/api/set-cookie',
    expect:
      '给 UAT 那台埋一个 cop_probe Cookie——下一条 sendCredentials 规则读的就是它；这一笔自带 credentials，跨原点响应的 Set-Cookie 只在带凭据的请求上落地',
  },
  {
    g: '请求头与凭据（{{变量}} 只在代发那一刻展开）',
    id: 'cookie-read',
    label: 'GET fat/api/cookies',
    kind: 'fetch',
    env: 'fat',
    path: '/api/cookies',
    expect: 'hasCookie=false（页面默认不带）；启用「FAT → UAT（携带该环境 Cookie）」这一格应同时变 env=uat 与 true',
  },

  // ── 响应形状 ────────────────────────────────────────────────────────
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'status-201',
    label: 'GET fat/api/status/201',
    kind: 'fetch',
    env: 'fat',
    path: '/api/status/201',
    expect: '201 + 正文',
  },
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'status-204',
    label: 'GET fat/api/status/204',
    kind: 'fetch',
    env: 'fat',
    path: '/api/status/204',
    expect: '204 + 无正文（null body 那一档）',
  },
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'status-304',
    label: 'GET fat/api/status/304',
    kind: 'fetch',
    env: 'fat',
    path: '/api/status/304',
    expect: '304 + 无正文',
  },
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'status-500',
    label: 'GET fat/api/status/500',
    kind: 'fetch',
    env: 'fat',
    path: '/api/status/500',
    expect: '500（代理不改写失败语义）',
  },
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'status-600',
    label: 'GET fat/api/status/600',
    kind: 'fetch',
    env: 'fat',
    path: '/api/status/600',
    expect: '400：服务端只接受 100-599，越界的不该由它来演',
  },
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'big-64k',
    label: 'GET fat/api/big?kb=64',
    kind: 'fetch',
    env: 'fat',
    path: '/api/big?kb=64',
    expect: '正文 64K → 日志抽屉里应被截到 32K 并标注原始长度',
  },
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'text',
    label: 'GET fat/api/text',
    kind: 'fetch',
    env: 'fat',
    path: '/api/text',
    expect: 'text/plain：不该被当 JSON 格式化',
  },
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'latin1',
    label: 'GET fat/api/raw/latin1',
    kind: 'fetch',
    env: 'fat',
    path: '/api/raw/latin1',
    expect: '200 + 状态行乱码（服务端直写 UTF-8 字节，浏览器按 latin1 解）',
  },
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'img',
    label: '<img> 加载 fat/api/binary',
    kind: 'img',
    env: 'fat',
    path: '/api/binary',
    expect: '8x8 解得开 = image 这一类资源确实进了网络层；落到哪一台看日志抽屉与 DNR 命中，页面读不到响应头',
  },
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'redirect',
    label: 'GET fat/api/redirect?to=/api/health',
    kind: 'fetch',
    env: 'fat',
    path: '/api/redirect?to=%2Fapi%2Fhealth',
    expect: '302 → 跟随到 health',
  },
  {
    g: '响应形状（回包约束与日志抽屉）',
    id: 'redirect-loop',
    label: 'GET fat/api/redirect-loop',
    kind: 'fetch',
    env: 'fat',
    path: '/api/redirect-loop',
    expect: '重定向成环 → 浏览器报错，界面应留一条失败日志',
  },

  // ── 时序与失败 ──────────────────────────────────────────────────────
  {
    g: '时序与失败',
    id: 'slow-3s',
    label: 'GET fat/api/slow?ms=3000',
    kind: 'fetch',
    env: 'fat',
    path: '/api/slow?ms=3000',
    expect: '200 · env=dev，耗时 ≈ 3000 + 1500ms（同一条延迟规则，用来对上「上游 + delay」这笔账）',
  },
  {
    g: '时序与失败',
    id: 'delay-rule',
    label: 'GET fat/api/slow?ms=100（几乎不耗时，只看规则侧延迟）',
    kind: 'fetch',
    env: 'fat',
    path: '/api/slow?ms=100',
    expect: '启用「FAT → DEV（慢网络 +1500ms）」后总耗时应 ≈ 1600ms，且 env=dev；关掉这一条就是 ~100ms',
  },
  {
    g: '时序与失败',
    id: 'slow-40s',
    label: 'GET fat/api/slow?ms=40000',
    kind: 'fetch',
    env: 'fat',
    path: '/api/slow?ms=40000',
    expect: '超过后台代发等待预算（35s + delay/重试）→ 报超时，页面不能永久 pending',
  },
  {
    g: '时序与失败',
    id: 'abort',
    label: 'fetch + 300ms 后 abort()',
    kind: 'abort',
    env: 'fat',
    path: '/api/slow?ms=5000',
    expect: 'AbortError，且后台那笔上游应被掐掉',
  },
  {
    g: '时序与失败',
    id: 'xhr-timeout',
    label: 'XHR 页面侧 timeout=500ms',
    kind: 'xhrtimeout',
    env: 'fat',
    path: '/api/slow?ms=3000',
    expect: 'timeout 事件；迟到的响应不得改口成这一笔的结果',
  },
  {
    g: '时序与失败',
    id: 'sse',
    label: 'GET fat/api/sse?n=3',
    kind: 'fetch',
    env: 'fat',
    path: '/api/sse?n=3&gap=200',
    expect: '正文是 3 段 event-stream 拼起来的文本',
  },

  // ── Mock / 阻断 / 重试 ──────────────────────────────────────────────
  {
    g: 'Mock / 阻断 / 重试',
    id: 'mock-list',
    label: 'GET fat/api/list?page=8&size=3（末页短页）',
    kind: 'fetch',
    env: 'fat',
    path: '/api/list?page=8&size=3',
    expect: '真实分页对照：total=23、size=3 → 末页只有 2 条；启用「FAT → DEV（纯重写 · 网络层）」后 env 变 dev',
  },
  {
    g: 'Mock / 阻断 / 重试',
    id: 'v1-data',
    label: 'GET fat/api/v1/data（走 Mock 默认分支）',
    kind: 'fetch',
    env: 'fat',
    path: '/api/v1/data',
    expect: '启用「FAT → DEV（Mock 用户资料 · 条件化）」后这一格应回规则里那份默认 JSON，而不是 dev 的真实响应',
  },
  {
    g: 'Mock / 阻断 / 重试',
    id: 'v1-data-p1',
    label: 'GET fat/api/v1/data?p=1（走 Mock 条件分支）',
    kind: 'fetch',
    env: 'fat',
    path: '/api/v1/data?p=1',
    expect: '同一规则「FAT → DEV（Mock 用户资料 · 条件化）」的条件分支：应回另一份 JSON + 规则里指定的 status',
  },
  {
    g: 'Mock / 阻断 / 重试',
    id: 'telemetry',
    label: 'POST fat/api/telemetry',
    kind: 'fetch',
    env: 'fat',
    method: 'POST',
    path: '/api/telemetry',
    body: '{"evt":"demo"}',
    expect: '启用「FAT（阻断埋点上报）」后这一格应失败，且服务端 accepted 计数不涨（对照 /env）',
  },
  {
    g: 'Mock / 阻断 / 重试',
    id: 'flaky',
    label: 'GET fat/api/flaky?key=case&fail=2',
    kind: 'flaky',
    env: 'fat',
    path: '/api/flaky?fail=2',
    expect: '「FAT → UAT（5xx 重试 2 次）」应在第 3 次拿到 200 · env=uat；先点「重置」再跑',
  },
  {
    g: 'Mock / 阻断 / 重试',
    id: 'flaky-reset',
    label: 'POST fat/api/flaky/reset?key=<本轮>',
    kind: 'flakyreset',
    env: 'fat',
    path: '/api/flaky/reset',
    expect: '把上一格的计数器归零',
  },
  {
    g: 'Mock / 阻断 / 重试',
    id: 'method-filter',
    label: 'GET fat/api/text（方法白名单只放 GET）',
    kind: 'fetch',
    env: 'fat',
    path: '/api/text',
    expect: '启用「FAT → DEV（只代理 GET）」后这一格 env 应变成 dev',
  },
  {
    g: 'Mock / 阻断 / 重试',
    id: 'method-filter-post',
    label: 'POST fat/api/text（同一规则不覆盖 POST）',
    kind: 'fetch',
    env: 'fat',
    method: 'POST',
    path: '/api/text',
    expect: 'POST 不在白名单 → 这条规则整体不适用，env 仍是 fat（对照上一格）',
  },

  // ── 正则重写与回包边界 ──────────────────────────────────────────────
  {
    g: '正则重写与回包边界（异常形状由规则制造，不由服务端）',
    id: 'v2-regex',
    label: 'GET fat/api/v2/orders/7（正则捕获组）',
    kind: 'fetch',
    env: 'fat',
    path: '/api/v2/orders/7',
    expect: '启用「FAT → DEV（正则捕获组 · 网络层）」后应落到 dev 的 /api/orders/7，id=7（捕获组 $1 换成 orders/7）',
  },
  {
    g: '正则重写与回包边界（异常形状由规则制造，不由服务端）',
    id: 'edge-text',
    label: 'GET fat/api/edge/text（规则改中文 statusText 与中文头）',
    kind: 'fetch',
    env: 'fat',
    path: '/api/edge/text',
    expect:
      '启用「FAT → DEV（改中文 statusText 与响应头）」后应 200 且不永久 pending：中文 statusText 与非 ByteString 头被清洗，ASCII 那个头保留',
  },
  {
    g: '正则重写与回包边界（异常形状由规则制造，不由服务端）',
    id: 'edge-code',
    label: 'GET fat/api/edge/code（规则写 status 999）',
    kind: 'fetch',
    env: 'fat',
    path: '/api/edge/code',
    expect: '启用「FAT → DEV（写越界状态码 999）」后 999 应被钳到 599；页面拿到的是 599，不是原生 200',
  },

  // ── WebSocket ───────────────────────────────────────────────────────
  {
    g: 'WebSocket（能力面只有三件事）',
    id: 'ws',
    label: '连 fat/ws 并发一条消息',
    kind: 'ws',
    env: 'fat',
    path: '/ws?src=harness',
    expect: '启用「WS FAT → UAT（地址重写）」后 hello 帧的 env 应报 uat',
  },
  {
    g: 'WebSocket（能力面只有三件事）',
    id: 'ws-push',
    label: '连 fat/ws 后请求 push×3',
    kind: 'wspush',
    env: 'fat',
    path: '/ws',
    expect: '三帧 push + 一帧 done',
  },
  {
    g: 'WebSocket（能力面只有三件事）',
    id: 'ws-blocked',
    label: '连被「WS FAT（阻断带 block=1 的握手）」覆盖的地址',
    kind: 'ws',
    env: 'fat',
    path: '/ws?block=1',
    expect: '连到 ws://127.0.0.1:1 → onerror，绝不能真的握手成功',
  },

  // ── COEP / CORP：响应自己把你拦下的那一类 ────────────────────────────
  {
    g: 'COEP / CORP（本页需带 ?coep=1 才看得见差别）',
    id: 'corp-img',
    label: '<img> 加载 fat/api/binary（服务端不带 CORP）',
    kind: 'img',
    env: 'fat',
    path: '/api/binary',
    expect:
      '不带 ?coep=1 时正常载入；带上之后本机报 net::ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep。导入规则也救不了这一格：网络层重写改的是落点，改不了响应头，而 <img> 本来就不走拦截器',
  },
  {
    g: 'COEP / CORP（本页需带 ?coep=1 才看得见差别）',
    id: 'corp-img-ok',
    label: '<img> 加载 fat/api/binary?corp=cross-origin',
    kind: 'img',
    env: 'fat',
    path: '/api/binary?corp=cross-origin',
    expect:
      '两种页面都该正常载入：服务端补上 Cross-Origin-Resource-Policy: cross-origin，COEP 就放行了——这一类失败的正解在响应头，不在代理',
  },
  {
    g: 'COEP / CORP（本页需带 ?coep=1 才看得见差别）',
    id: 'corp-fetch',
    label: 'GET uat/api/health?corp=same-origin（CORS 模式）',
    kind: 'fetch',
    env: 'uat',
    path: '/api/health?corp=same-origin',
    expect:
      '本机实测 200 · env=uat：同一份 CORP: same-origin 挡住了上面那格 <img>，却不参与 CORS 模式的 fetch——两格合起来说明 CORP 只管 no-cors 子资源',
  },
];

const GROUPS = [...new Set(CASES.map(c => c.g))];

/**
 * 渲染触发页
 *
 * @param {{ports: Record<string, number>, host: string, canonicalHost: string, withWs: boolean}} options
 */
export function renderHarness(options) {
  const { ports, canonicalHost } = options;
  const wsNote = options.withWs
    ? 'ws  /ws — 长连接（握手成功后服务端主动推一条 hello，里面的 env 说明这一笔连到了哪台）'
    : '（本次以 --no-ws 启动，长连接未挂载）';
  const rows = GROUPS.map(group => {
    const items = CASES.filter(c => c.g === group)
      .map(
        c => `
        <tr data-id="${c.id}">
          <td><button class="run" data-run="${c.id}">跑</button></td>
          <td class="label">${esc(c.label)}<div class="note">期望：${esc(c.expect)}</div></td>
          <td class="target">${c.env === 'web' ? '同源' : `${c.env} · :${ports[c.env]}`}</td>
          <td class="out" id="out-${c.id}">—</td>
        </tr>`,
      )
      .join('');
    return `<tr class="group"><th colspan="4">${esc(group)}</th></tr>${items}`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>跨域代理助手 · 本地验证夹具</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 20px 24px 60px; font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f6f7f9; color: #1f2329; }
  @media (prefers-color-scheme: dark) { body { background: #17181c; color: #e6e6e6; } .card, th, td { background: #1f2126; border-color: #33363d; } .note { color: #9aa0a6; } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b7280; margin: 0 0 16px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { background: #fafafa; font-weight: 600; }
  tr.group th { background: #eef2ff; color: #3730a3; }
  .label { width: 40%; }
  .note { color: #8a919e; font-size: 12px; margin-top: 2px; }
  .target { width: 90px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .out { font-family: ui-monospace, Menlo, monospace; font-size: 12px; word-break: break-all; }
  .ok { color: #0a7d3c; } .bad { color: #c9252c; } .mid { color: #b45309; }
  button { font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid #c7ccd4; background: #fff; cursor: pointer; }
  button.primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }
  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  code { background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 4px; }
  #summary { font-weight: 600; }
  .preview { height: 22px; vertical-align: middle; }
</style>
</head>
<body>
<h1>跨域代理助手 · 本地验证夹具</h1>
<p class="sub">
  五个端口一台机器：${Object.entries(ports)
    .map(([k, p]) => `<code>${k}:${p}</code>`)
    .join(' ')}。
  本页跑在 <code>web</code>，其余四台是「后端」。<b>PROD 不放行任何来源</b>，所以那一格不加规则必然失败——
  这正是用来验证后台通道的那一面。
</p>

<div class="card">
  <div class="bar">
    <button class="primary" id="run-all">整组顺序跑一遍</button>
    <button id="stop">停下</button>
    <label>把每条用例的目标改成 <select id="override"><option value="">按用例本身</option>${Object.keys(ports)
      .filter(k => k !== 'web')
      .map(k => `<option value="${k}">全部打到 ${k}</option>`)
      .join('')}</label>
    <span id="coep-box"><a href="#" id="coep-link">COEP</a></span>
    <span id="summary">尚未运行</span>
  </div>
  <div class="note">
    页面侧 <code>TypeError: Failed to fetch</code> 分不清「被 CORS 拦下」与「断网」，所以界面里那一行只写「疑似」；
    这一格的判定靠上面那句「期望」，不靠颜色。
  </div>
  <div class="note">
    <b>COEP 那一档</b>是给最后三格用的：打开后本页文档带上 <code>Cross-Origin-Embedder-Policy: require-corp</code>，
    于是跨域的 <code>&lt;img&gt;</code> 若没有 <code>Cross-Origin-Resource-Policy</code> 就会被拦——
    这一类失败由响应头决定，代理的两条通道都不改响应头（后台代发只接管 fetch/XHR/WebSocket，不管 <code>&lt;img&gt;</code>），
    所以它不是「代理没生效」，别按那条线索去查。
  </div>
  <div class="note">
    <b>网络层重写的那条硬边界</b>（本机实测，Chrome for Testing 155）：一条把请求改写到<b>另一个原点</b>的
    declarativeNetRequest 规则，目标收到的 <code>Origin</code> 是 <code>null</code>，不是本页自己的来源；
    同一原点内的改写不受影响。所以回显 <code>Origin</code> 的后端接不住跨原点重写的那几格，
    只有 DEV 那样回 <code>Access-Control-Allow-Origin: *</code> 的一档接得住——「双通道分流」那一组因此全落在 DEV。
    同一台 PROD 交给后台代发就通，因为扩展持有 <code>&lt;all_urls&gt;</code>，后台那一次 <code>fetch</code> 本来就不受 CORS 约束。
  </div>
  <div class="note">
    <b>代发失败不等于请求被挡住</b>：后台拒掉的那一笔（比如正文超 <code>MAX_BODY_SIZE</code> 10MB）会回到页面手里，
    拦截器按「代理失败」<b>回退原生</b>再发一次——实测那格页面拿到 <code>200 · env=fat</code>，而 SW 同刻记着
    <code>status=0 · Request body exceeds 10485760 bytes</code>。所以「日志里有一笔失败」与「这一笔没发出去」是两件事，
    只有 <b>block</b>（阻断）那一档才真的不发；排查时别看错方向。
  </div>
  <div class="note">
    <b>红色不等于缺陷</b>：<code>telemetry</code>（阻断）、<code>prod-health</code>（PROD 不放行 CORS）、
    <code>redirect-loop</code>（重定向成环）、<code>xhr-timeout</code>（页面侧 500ms 到期）这四格的「期望」
    写的就是失败——它们红了才对。真缺陷看的是<b>绿得不对</b>或<b>与期望不符</b>，逐格对照左边那行字。
  </div>
</div>

<div class="card">
  <table>
    <thead><tr><th></th><th>用例</th><th>目标</th><th>结果</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>

<div class="card">
  <b>接口清单</b>
  <div id="routes" class="note">加载中…</div>
</div>

<script>
const PORTS = ${JSON.stringify(ports)};
const HOST = ${JSON.stringify(canonicalHost)};
const WS_NOTE = ${JSON.stringify(wsNote)};
const CASES = ${JSON.stringify(CASES.map(c => ({ id: c.id, kind: c.kind, env: c.env, path: c.path || '/api/health', method: c.method || 'GET', body: c.body || null, mb: c.mb || 0 })))};
const byId = Object.fromEntries(CASES.map(c => [c.id, c]));
let runAll = false;
let flakyKey = 'case-' + Date.now();

function origin(env) { return HOST + ':' + PORTS[env]; }
function target(c) {
  const override = document.getElementById('override').value;
  const env = override && c.env !== 'web' ? override : c.env;
  return { env, url: origin(env) + c.path };
}
/**
 * 写一格的结果。preview 只有 <img> 那几格会传：图要留着给人看，但判据必须同时落成文字，
 * 否则真机对照读到的是一格空白（脚本看不见像素，人也分不清「载入」和「挡住」）。
 */
function setOut(id, cls, text, preview) {
  const el = document.getElementById('out-' + id);
  el.className = 'out ' + cls;
  if (preview) el.replaceChildren(document.createTextNode(text + ' · '), preview);
  else el.textContent = text;
}
function brief(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > 260 ? s.slice(0, 260) + '…(' + s.length + ')' : s;
}
/** 往 URL 上补一个参数：路径自带查询时必须用 &，否则参数名会被拼坏 */
function withParam(url, key, value) {
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + key + '=' + value;
}

/** fetch 与代发通道共用的一段：返回可读的结果描述，抛错时带上耗时 */
async function doFetch(c, url, init) {
  const t0 = performance.now();
  const res = await fetch(url, init);
  const ms = Math.round(performance.now() - t0);
  const type = (res.headers.get('content-type') || '');
  let payload;
  if (type.indexOf('json') >= 0) { const txt = await res.text(); payload = txt ? brief(txt) : '<无正文>'; }
  else if (type.indexOf('image') >= 0 || type.indexOf('octet') >= 0) payload = '<binary ' + (await res.arrayBuffer()).byteLength + 'B>';
  else payload = brief(await res.text());
  const env = res.headers.get('x-cop-env');
  const cls = res.ok ? 'ok' : 'mid';
  return { cls, text: res.status + ' · ' + ms + 'ms' + (env ? ' · header:' + env : '') + ' · ' + payload };
}

function xhrRun(c, url, opts) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    const t0 = performance.now();
    x.open(c.method, url, opts && opts.async !== false);
    if (c.method === 'POST' || c.method === 'PUT' || c.method === 'PATCH') x.setRequestHeader('Content-Type', 'application/json');
    if (opts && opts.timeout) x.timeout = opts.timeout;
    x.onload = () => resolve({ cls: x.status >= 400 ? 'mid' : 'ok', text: 'XHR ' + x.status + ' · ' + Math.round(performance.now() - t0) + 'ms · ' + brief(x.responseText) });
    x.onerror = () => reject(new Error('XHR onerror（status=' + x.status + '，被 CORS 拦下或被阻断时就是这个形状）'));
    x.ontimeout = () => reject(new Error('XHR timeout（页面侧设的 ' + opts.timeout + 'ms 到期）'));
    try { x.send(c.body); } catch (e) { reject(e); }
  });
}

async function run(c) {
  const { env, url } = target(c);
  try {
    switch (c.kind) {
      case 'fetch': {
        const init = { method: c.method };
        if (c.body) { init.headers = { 'Content-Type': 'application/json' }; init.body = c.body; }
        return await doFetch(c, url, init);
      }
      case 'xhr':
        return await xhrRun(c, url, {});
      case 'sync': {
        const x = new XMLHttpRequest();
        x.open('GET', url, false);
        x.send();
        return { cls: x.status >= 400 ? 'mid' : 'ok', text: '同步 XHR ' + x.status + ' · ' + brief(x.responseText) + '（同步请求只能回退原生）' };
      }
      case 'xhrtimeout':
        return await xhrRun(c, url, { timeout: 500 });
      case 'formdata': {
        const fd = new FormData();
        fd.append('note', 'from harness');
        fd.append('file', new Blob(['hello cop'], { type: 'text/plain' }), 'note.txt');
        const t0 = performance.now();
        const r = await fetch(url, { method: 'POST', body: fd });
        return { cls: r.ok ? 'ok' : 'mid', text: 'FormData ' + r.status + ' · ' + Math.round(performance.now() - t0) + 'ms · ' + brief(await r.text()) + '（非字符串 body → 回退原生）' };
      }
      case 'blob': {
        const t0 = performance.now();
        const r = await fetch(url, { method: 'POST', body: new Blob(['blob body'], { type: 'text/plain' }) });
        return { cls: r.ok ? 'ok' : 'mid', text: 'Blob ' + r.status + ' · ' + Math.round(performance.now() - t0) + 'ms · ' + brief(await r.text()) };
      }
      case 'bigbody': {
        const payload = 'x'.repeat(c.mb * 1024 * 1024);
        const t0 = performance.now();
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
        return { cls: r.ok ? 'ok' : 'mid', text: c.mb + 'MB ' + r.status + ' · ' + Math.round(performance.now() - t0) + 'ms · ' + brief(await r.text()) };
      }
      case 'abort': {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 300);
        const t0 = performance.now();
        try {
          await fetch(url, { signal: ctrl.signal });
        } catch (e) {
          return { cls: 'mid', text: '按预期中止：' + e.name + ' · ' + Math.round(performance.now() - t0) + 'ms（后台那笔上游应一起掐掉）' };
        }
        return { cls: 'bad', text: '竟然跑完了，abort 没生效' };
      }
      case 'setcookie': {
        const u = withParam(url, 'value', 'probe-' + Date.now()) + '&sameSite=None&secure=1';
        // 跨原点响应里的 Set-Cookie 只在带凭据的请求上落地：不带 credentials:'include' 时这一笔
        // 200 得干干净净、jar 却是空的（2026-10-14 本机实测），下一条 sendCredentials 用例就永远
        // 读不到 Cookie，测试的人会去怪扩展，而缺陷在这张页自己。
        const r = await fetch(u, { method: 'POST', credentials: 'include' });
        return { cls: r.ok ? 'ok' : 'mid', text: r.status + ' · ' + brief(await r.text()) };
      }
      case 'flaky': {
        const u = url.replace('fail=2', 'key=' + encodeURIComponent(flakyKey) + '&fail=2');
        return await doFetch(c, u, { method: 'GET' });
      }
      case 'flakyreset': {
        const u = withParam(url, 'key', flakyKey);
        return await doFetch(c, u, { method: 'POST' });
      }
      case 'img': {
        return await new Promise(resolve => {
          const el = document.createElement('img');
          el.className = 'preview';
          const t0 = performance.now();
          el.onload = () => resolve({ cls: 'ok', text: '<img> 载入 · ' + el.naturalWidth + 'x' + el.naturalHeight + ' · ' + Math.round(performance.now() - t0) + 'ms', el });
          el.onerror = () => resolve({ cls: 'bad', text: '<img> 载入失败（网络层重写或 CORS 挡住了这一格）' });
          el.src = withParam(url, 't', Date.now());
        });
      }
      case 'ws':
      case 'wspush':
        return await wsRun(url, c);
      default:
        return { cls: 'bad', text: '未知用例类型 ' + c.kind };
    }
  } catch (e) {
    return { cls: 'bad', text: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)) };
  }
}

function wsRun(url, c) {
  return new Promise(resolve => {
    const lines = [];
    const wsUrl = url.replace(/^http/, 'ws');
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { resolve({ cls: 'bad', text: '构造失败 ' + e.message }); return; }
    const done = cls => resolve({ cls, text: lines.join(' | ').slice(0, 300) || '没收到任何帧（被阻断或连不上）' });
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} done(lines.length ? 'ok' : 'bad'); }, 6000);
    ws.onmessage = ev => {
      lines.push(String(ev.data).slice(0, 120));
      if (c.kind === 'wspush' && lines.length === 1) ws.send(JSON.stringify({ action: 'push', n: 3, gapMs: 300 }));
      if (c.kind === 'ws' && lines.length === 1) ws.send('hello from harness');
      if (c.kind === 'wspush' && lines.some(l => l.indexOf('push-done') >= 0)) { clearTimeout(timer); try { ws.close(); } catch (_) {} done('ok'); }
      if (c.kind === 'ws' && lines.some(l => l.indexOf('"echo"') >= 0)) { clearTimeout(timer); try { ws.close(); } catch (_) {} done('ok'); }
    };
    ws.onerror = () => { if (c.kind === 'ws' && url.indexOf('block=1') >= 0) { clearTimeout(timer); resolve({ cls: 'mid', text: '按预期连不上：' + lines.join(' | ') + '（阻断规则把它连到了 ws://127.0.0.1:1）' }); } };
    ws.onclose = () => { clearTimeout(timer); if (lines.length) done('ok'); else done('bad'); };
  });
}

async function runOne(id) {
  const c = byId[id];
  setOut(id, '', '跑中…');
  const r = await run(c);
  setOut(id, r.cls, r.text, r.el);
  return r.cls;
}

// COEP 开关：整页档次要变，只能靠重载（文档头是服务端写的，页面自己改不了）
(function initCoep() {
  const on = new URLSearchParams(location.search).get('coep') === '1';
  const link = document.getElementById('coep-link');
  link.textContent = on ? 'COEP：已开启（点此关掉并重载）' : 'COEP：未开启（点此开启并重载）';
  link.href = on ? location.pathname : location.pathname + '?coep=1';
})();

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-run]');
  if (!btn) return;
  runOne(btn.getAttribute('data-run'));
});

document.getElementById('run-all').addEventListener('click', async () => {
  runAll = true;
  let ok = 0, bad = 0, mid = 0;
  for (const c of CASES) {
    if (!runAll) break;
    const cls = await runOne(c.id);
    if (cls === 'ok') ok++; else if (cls === 'bad') bad++; else mid++;
    document.getElementById('summary').textContent = '进度 ' + (ok + bad + mid) + '/' + CASES.length + ' · 绿 ' + ok + ' · 异常 ' + mid + ' · 红 ' + bad;
    await new Promise(r => setTimeout(r, 120));
  }
  runAll = false;
});

document.getElementById('stop').addEventListener('click', () => { runAll = false; document.getElementById('summary').textContent = '已停止整组运行'; });

fetch(origin('fat') + '/env').then(r => r.json()).then(d => {
  const box = document.getElementById('routes');
  box.textContent = '';
  for (const x of d.routes || []) {
    const line = document.createElement('div');
    const code = document.createElement('code');
    code.textContent = x.method + ' ' + x.path;
    line.appendChild(code);
    line.appendChild(document.createTextNode(' — ' + x.purpose));
    box.appendChild(line);
  }
  const wsLine = document.createElement('div');
  wsLine.textContent = WS_NOTE;
  box.appendChild(wsLine);
}).catch(e => { document.getElementById('routes').textContent = '读不到 fat/env：' + e.message; });
</script>
</body>
</html>`;
}

/** 塞进模板字符串前先转义，避免用例文案里的引号打断 HTML 结构 */
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
