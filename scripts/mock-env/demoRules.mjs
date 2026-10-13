/**
 * 演示规则集：18 条，覆盖扩展的两条通道与全部 SW 专属能力
 *
 * 这份文件是**生成**出来的，不是手抄的：`index.mjs` 每次启动都按当前的 `--base` 与
 * `--canonical` 重写 `presets/demo-rules.json`，所以「规则里的端口」与「服务实际听在哪个端口」
 * 不可能各说各话。手写副本的失效方式是静默的——换个 `--base` 之后每一格都连到不存在的地址，
 * 而界面上一切正常。
 *
 * 四条设计约束，改这份之前先读：
 *
 * 1. **通道由能力决定，不由名字决定**。`utils/urlMatcher.ts` 的 `isSimpleRule()` 只要看到
 *    头/体/响应覆盖、Mock、delay、block、retry、方法过滤、查询注入、`sendCredentials`、WS
 *    或不以 `*` 结尾的 wildcard，就把这条规则推给后台代发通道。所以「纯重写」那几条必须是
 *    干净的（只有 matchPattern + targetUrl），否则演示不出双通道分流。
 * 2. **异常形状由规则制造，不由服务端制造**。Node 的 `res.writeHead()` 会先抛
 *    `ERR_INVALID_CHAR`，所以码点 > 255 的状态行与响应头在夹具这一侧根本造不出来；中文
 *    statusText 与越界状态码只能写在 `responseOverrides` 里，落点（`/api/edge/*`）本身是
 *    一份干净的 200。观察点因此在扩展侧的钳制与清洗，不在服务端。
 * 3. **纯重写那几条只能落在 `wildcard` 那一档**。实测（Chrome for Testing 155）：一条把请求改写
 *    到**另一个原点**的 declarativeNetRequest 规则，目标收到的 `Origin` 是 `null`，不是页面自己的
 *    来源（同一原点内的改写不受影响）。所以回显式的三档（`local`/`harness`/`none`）一律接不住这种
 *    请求，页面只剩 `net::ERR_FAILED`——dev 因此必须是 `wildcard`，把这几条的落点换回其它档就是
 *    当场把「网络层重写」这一组演示全数弄坏，而规则列表看上去一切正常。
 * 4. **默认关掉两条**。`FAT → PROD（纯重写 · 仍受 CORS 约束）` 与
 *    `FAT → UAT（携带该环境 Cookie）` 是「打开才看得出差别」的对照组：前者关掉时基线是
 *    200 · env=fat，打开后是 CORS 失败（PROD 不放行任何来源，加上第 3 条那层 `Origin: null`，
 *    两重都挡住它）；后者关掉时 `hasCookie=false`，打开后为 true。
 *    全默认开就没有对照，只能靠禁用一条来制造，而那会改动列表顺序。
 *
 * 路径互不遮蔽：每条规则各占一个前缀，`/api/v2/(.*)` 的正则与 `/api/v1/data` 的 Mock 不重叠，
 * 两条 WS 规则靠 `priority` 让「阻断」排在「重写」之前（数值越小越先匹配）。
 */

/** 固定时间戳：让同一组参数生成的文件逐字节一致，重复启动不会把工作树弄脏 */
const PRESET_TIMESTAMP = 1791849600000;

const ENVS = { web: 0, dev: 1, fat: 2, uat: 3, prod: 4 };

/**
 * @param base 起始端口（与 `index.mjs --base` 同一个数）
 * @param canonical 浏览器地址栏里那个 host（服务监听地址是另一个，见 `index.mjs` 的文件头）
 */
function origins(base, canonical) {
  const at = offset => `http://${canonical}:${base + offset}`;
  return { web: at(ENVS.web), dev: at(ENVS.dev), fat: at(ENVS.fat), uat: at(ENVS.uat), prod: at(ENVS.prod) };
}

/**
 * 长连接那两条把 `http` 换成 `ws`：`utils/urlMatcher.ts` 的 `isWebSocketRule()` 认的就是
 * matchPattern / targetUrl 上的 ws 协议，于是这条规则自动落到拦截器的握手通道。
 */
function wsOrigin(httpOrigin) {
  return httpOrigin.replace(/^http/, 'ws');
}

/** 把 host 里的正则元字符（`127.0.0.1` 的点）收成字面量，供 regex 规则的 matchPattern 用 */
function reEscape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const PRESET_FILE = 'demo-rules.json';

/**
 * 组装可导入的演示配置（形状与扩展自己「导出配置」的产物一致：`ExportData`）。
 *
 * `config.enabled: true` 是有意的：替换式导入下这个键决定总开关，缺省会被判成「导入完就把代理关掉」，
 * 于是第一格就跑出基线读数，看起来像规则没生效。
 *
 * @param opts.base 起始端口，默认 5300
 * @param opts.canonical 浏览器使用的 host，默认 localhost
 * @param opts.version 扩展版本号，写进 `version` 字段（仅用于文件里看得懂，导入侧不参与判读）
 */
export function buildDemoRules({ base = 5300, canonical = 'localhost', version = '0.0.0' } = {}) {
  const o = origins(base, canonical);
  const wsFat = wsOrigin(o.fat);
  const wsUat = wsOrigin(o.uat);
  const rule = (priority, name, fields) => ({
    id: `demo-${String(priority).padStart(2, '0')}`,
    name,
    enabled: true,
    matchType: 'prefix',
    priority,
    createdAt: PRESET_TIMESTAMP,
    updatedAt: PRESET_TIMESTAMP,
    ...fields,
  });

  const rules = [
    rule(1, 'FAT（阻断埋点上报）', {
      matchPattern: `${o.fat}/api/telemetry`,
      // 空 targetUrl = 不改写地址，只阻断：这条的存在就是让 /api/telemetry 那一格失败，
      // 并让服务端的 accepted 计数停在原值（对照 /env）
      targetUrl: '',
      blocked: true,
    }),
    rule(2, 'WS FAT（阻断带 block=1 的握手）', {
      matchPattern: `${wsFat}/ws?block=1`,
      targetUrl: '',
      blocked: true,
    }),
    rule(3, 'WS FAT → UAT（地址重写）', {
      matchPattern: `${wsFat}/ws`,
      targetUrl: `${wsUat}/ws`,
    }),
    rule(4, 'FAT → DEV（纯重写 · 网络层）', {
      matchPattern: `${o.fat}/api/list`,
      targetUrl: `${o.dev}/api/list`,
    }),
    rule(5, 'FAT → DEV（图片资源 · 网络层）', {
      matchPattern: `${o.fat}/api/binary`,
      targetUrl: `${o.dev}/api/binary`,
    }),
    rule(6, 'FAT → PROD（纯重写 · 仍受 CORS 约束）', {
      matchPattern: `${o.fat}/api/health`,
      targetUrl: `${o.prod}/api/health`,
      // 默认关：这一条打开之后仍然失败，它存在的意义就是把「网络层重写不改变同源判定」演一遍
      enabled: false,
    }),
    rule(7, 'PROD → PROD（加一项响应头 · 切后台通道）', {
      matchPattern: `${o.prod}/api/v1`,
      targetUrl: `${o.prod}/api/v1`,
      responseOverrides: { headers: { 'X-Cop-Proxied': 'by-service-worker' } },
    }),
    rule(8, 'FAT → DEV（注入凭据头 {{API_TOKEN}}）', {
      matchPattern: `${o.fat}/api/user/profile`,
      targetUrl: `${o.dev}/api/user/profile`,
      headerOverrides: { Authorization: 'Bearer {{API_TOKEN}}', 'X-Api-Key': '{{API_KEY}}' },
    }),
    rule(9, 'FAT → UAT（注入查询参数）', {
      matchPattern: `${o.fat}/api/query`,
      targetUrl: `${o.uat}/api/query`,
      queryOverrides: { via: 'proxy', tenant: 'demo-tenant' },
    }),
    rule(10, 'FAT → UAT（5xx 重试 2 次）', {
      matchPattern: `${o.fat}/api/flaky`,
      targetUrl: `${o.uat}/api/flaky`,
      retryCount: 2,
      retryDelay: 400,
    }),
    rule(11, 'FAT → DEV（只代理 GET）', {
      matchPattern: `${o.fat}/api/text`,
      targetUrl: `${o.dev}/api/text`,
      methods: ['GET'],
    }),
    rule(12, 'FAT → DEV（慢网络 +1500ms）', {
      matchPattern: `${o.fat}/api/slow`,
      targetUrl: `${o.dev}/api/slow`,
      delayMs: 1500,
    }),
    rule(13, 'FAT → DEV（Mock 用户资料 · 条件化）', {
      matchPattern: `${o.fat}/api/v1/data`,
      targetUrl: `${o.dev}/api/v1/data`,
      mockResponse: {
        contentType: 'application/json; charset=utf-8',
        status: 200,
        body: JSON.stringify({ mock: 'default', env: 'mock', user: { id: 42, name: '演示用户', roles: ['admin'] } }),
        conditions: [
          {
            matchQuery: { p: '1' },
            contentType: 'application/json; charset=utf-8',
            status: 201,
            body: JSON.stringify({ mock: 'condition-p1', env: 'mock', note: '这一份来自规则的条件分支，不是任何后端' }),
          },
        ],
      },
    }),
    rule(14, 'FAT → DEV（正则捕获组 · 网络层）', {
      matchType: 'regex',
      matchPattern: `^${reEscape(o.fat)}/api/v2/(.*)$`,
      targetUrl: `${o.dev}/api/$1`,
    }),
    rule(15, 'FAT → DEV（改中文 statusText 与响应头）', {
      matchPattern: `${o.fat}/api/edge/text`,
      targetUrl: `${o.dev}/api/edge/text`,
      responseOverrides: {
        statusText: '服务正常（中文描述）',
        headers: { 'X-Cop-Note': '中文头值', 'X-Cop-Ascii': 'ascii-survives' },
      },
    }),
    rule(16, 'FAT → DEV（写越界状态码 999）', {
      matchPattern: `${o.fat}/api/edge/code`,
      targetUrl: `${o.dev}/api/edge/code`,
      responseOverrides: { status: 999 },
    }),
    rule(17, 'FAT → UAT（携带该环境 Cookie）', {
      matchPattern: `${o.fat}/api/cookies`,
      targetUrl: `${o.uat}/api/cookies`,
      sendCredentials: true,
      // 默认关：开启等于把该环境的会话交给这条规则命中的所有路径，演示也应当是一次显式动作
      enabled: false,
    }),
    rule(18, 'FAT → DEV（上传通道 · 10MB 请求体上限）', {
      matchPattern: `${o.fat}/api/upload`,
      targetUrl: `${o.dev}/api/upload`,
      // 必须复杂到走后台代发：`MAX_BODY_SIZE` 那道上限制住在 `proxyHandler.ts`，
      // 网络层重写根本不读请求体。加一项响应头覆盖就是把这一条推到后台的那一下。
      responseOverrides: { headers: { 'X-Cop-Upload': 'via-service-worker' } },
    }),
  ];

  return {
    version,
    schemaVersion: 2,
    exportTime: PRESET_TIMESTAMP,
    config: { enabled: true, rules },
  };
}
