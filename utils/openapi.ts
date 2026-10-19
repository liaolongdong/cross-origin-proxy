import { MAX_OPENAPI_ORIGINS } from '@/utils/constants';
import type { ProxyRule } from '@/utils/types';

/**
 * 把 OpenAPI / Swagger 文档转成「按接口来源换环境」的代理规则
 *
 * 为什么要有这一条进口：一份 swagger 就是这套 API 的**地址清单**。调试时真正想说的往往是一句话
 * ——「`fat-api.example.com/v3` 这一整套，今天都打到 `uat-api.example.com/v3` 去」。以前用户只能
 * 要么照着文档手敲一条规则、要么先跑一遍页面再导 HAR（后者还要求那个接口真的被点过）。
 * 与 HAR 那条同源：**按来源折叠，不拆 path 级**，所以一份几百个接口的文档只产出个位数规则。
 *
 * 全部判据收在这个纯函数里（不碰 `chrome`、不读文件、不看 DOM），因为这条路上最容易出错的是
 * **把文档里的地址当真**：`servers[].url` 与 Swagger 2 的 `host` 是别人写进文件的字符串，
 * 可以是任意协议、可以是 `{version}` 模板、可以带空格或根本不是一个 URL。三条硬口径：
 * - 只认 http(s)，任何一条读不出来源就跳过它并在返回值里计数，**绝不**留一条坏规则；
 * - 留空目标时产出的形状与「这条进口还不存在」时完全一致（自映射 + 默认停用），与 HAR 同一口径；
 * - 上限 `MAX_OPENAPI_ORIGINS` 只是让「明显不是给人看的文档」少占内存，真正的写入天花板仍是 `MAX_RULES`
 *   （由批量新增那侧拒绝，界面上会点名是超限而不是静默截断）。
 */

/** 解析文档这一步的失败原因——只用于界面选文案，绝不进任何回包的 `error` 字段（那会被 `ElMessage.error` 原样画出来） */
export type OpenApiFailure = 'notJson' | 'notObject' | 'unsupportedSpec' | 'noServers';

/** 一条可用的接口来源 */
export interface OpenApiOrigin {
  /** 折叠后的匹配前缀：origin + basePath（不带末尾斜杠） */
  prefix: string;
  /** 来源 origin，仅用于展示与命名 */
  origin: string;
  /** 文档声明的 basePath；根路径时为空串 */
  basePath: string;
}

/** 从文档里读出来的可导入信息 */
export interface OpenApiSpec {
  /** `info.title`（清洗过、可能为空） */
  title: string;
  /** 去重后的接口来源，按文档出现顺序，最多 `MAX_OPENAPI_ORIGINS` 条 */
  origins: OpenApiOrigin[];
  /** 读不出 http(s) 来源或因模板无法展开而**被跳过**的 server 条数（不含去重丢掉的） */
  skipped: number;
}

export type OpenApiParseResult = { ok: true; spec: OpenApiSpec } | { ok: false; reason: OpenApiFailure };

/** 规则名里那个标题片段的长度上限（名字只是给人看的标签，不是判据） */
const MAX_TITLE_SEGMENT = 48;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 清洗成规则名里可用的片段
 *
 * `info.title` 来自别人的文件，长度与字符都不受我们控制；规则列表那一列被一个 300 字的标题撑破
 * 是真实界面故障，所以先掐长度再去掉换行（换行会让 tooltip 与表格排版一起乱）。
 */
function titleSegment(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_TITLE_SEGMENT ? `${cleaned.slice(0, MAX_TITLE_SEGMENT)}…` : cleaned;
}

/**
 * 把文档里写的一个地址分成三档：完整 http(s) URL / `host[:port][/路径]` / 读不出
 *
 * 难点是「冒号」有两种意思：`https://a.com` 里它前面是协议，`a.com:8443` 里它前面是主机。
 * 分不开就会把 `ftp://files.example.com` 当成主机、补上 `https://` 交给 URL 解析器
 * （实测它能解析出主机 `ftp` 与路径 `//files.example.com`），于是产出一条永远匹配不上的规则。
 * 判据取「冒号后面紧跟一串数字才算端口」——协议名不会全是数字。
 */
function toHttpUrl(value: string, fallbackProtocol: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('{') || trimmed.includes(' ')) return null;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (schemeMatch) {
    const rest = trimmed.slice(schemeMatch[1].length + 1);
    const isPort = /^\d+([/\\?#]|$)/.test(rest);
    if (!isPort) {
      // 声明了协议名的，只认 http(s)，且必须跟 `//`（`https:x` 那种残缺写法不当地址用）
      if (!/^https?$/i.test(schemeMatch[1]) || !rest.startsWith('//')) return null;
      return trimmed;
    }
  }
  // Swagger 2 的 `host`（可带端口与路径）与 `//cdn.example.com` 这类省略协议的写法：补上兜底协议
  return `${fallbackProtocol}://${trimmed.replace(/^\/+/, '')}`;
}

/**
 * 把一个 URL 形状的值收成 `origin + basePath`
 *
 * @returns 读不出 http(s) 来源时返回 `null`（调用方计数并跳过，绝不修补成「看起来能用」的值）
 */
function toPrefix(value: string, fallbackProtocol: string): OpenApiOrigin | null {
  const candidate = toHttpUrl(value, fallbackProtocol);
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // 解析不出主机就等于读不出来源：没有它连「这一条管哪些请求」都说不清
  if (!url.hostname) return null;
  const basePath = url.pathname.replace(/\/+$/, '');
  return { prefix: `${url.origin}${basePath}`, origin: url.origin, basePath };
}

/** OpenAPI 3 的 `servers[].url` 里 `{var}` 模板：能用 `variables[].default` 展开就展开 */
function expandServerVariables(url: string, variables: unknown): string {
  if (!url.includes('{') || !isRecord(variables)) return url;
  return url.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
    const entry = variables[name];
    const fallback = isRecord(entry) ? entry.default : undefined;
    return typeof fallback === 'string' && fallback && !fallback.includes('{') ? fallback : whole;
  });
}

/** 文档声明的协议列表：优先 https（换环境这件事本来就发生在带证书的环境里） */
function protocolOf(schemes: unknown): string {
  if (!Array.isArray(schemes)) return 'https';
  const list = schemes.filter((s): s is string => typeof s === 'string').map(s => s.toLowerCase());
  if (list.includes('https')) return 'https';
  if (list.includes('http')) return 'http';
  return 'https';
}

/** `paths` 存在与否只用来认「这大概是一份接口文档」；一份没有 paths 的文档不值得导成规则 */
function looksLikeSpec(root: Record<string, unknown>): boolean {
  return isRecord(root.paths);
}

/**
 * 解析 OpenAPI 3 / Swagger 2 文档正文
 *
 * 判定顺序是「先说清它是不是接口文档，再说它有没有可用地址」——两类失败给用户的动作不一样：
 * 前者是「选错文件了」，后者是「这份文档没写 servers」，混成一句就会让人去翻一个不存在的问题。
 */
export function parseOpenApiSpec(text: string): OpenApiParseResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'notJson' };
  }
  if (!isRecord(root)) return { ok: false, reason: 'notObject' };

  const isOpenApi3 = typeof root.openapi === 'string' && root.openapi.startsWith('3');
  const isSwagger2 = typeof root.swagger === 'string';
  if (!isSwagger2 && !isOpenApi3) return { ok: false, reason: 'unsupportedSpec' };
  if (!looksLikeSpec(root)) return { ok: false, reason: 'unsupportedSpec' };

  const collected: OpenApiOrigin[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  const push = (raw: string, fallbackProtocol: string): void => {
    if (collected.length >= MAX_OPENAPI_ORIGINS) {
      skipped += 1;
      return;
    }
    const parsed = toPrefix(raw, fallbackProtocol);
    if (!parsed) {
      skipped += 1;
      return;
    }
    if (seen.has(parsed.prefix)) return;
    seen.add(parsed.prefix);
    collected.push(parsed);
  };

  if (isOpenApi3) {
    const servers = Array.isArray(root.servers) ? root.servers : [];
    for (const server of servers) {
      if (!isRecord(server) || typeof server.url !== 'string') {
        skipped += 1;
        continue;
      }
      push(expandServerVariables(server.url, server.variables), 'https');
    }
    if (collected.length === 0) return { ok: false, reason: 'noServers' };
  } else {
    // Swagger 2：`host` 可以缺省（此时按文档分发地址算，而我们没有那个上下文）→ 读不出就是读不出
    const hosts = typeof root.host === 'string' && root.host.trim() ? [root.host] : [];
    if (hosts.length === 0) return { ok: false, reason: 'noServers' };
    const protocol = protocolOf(root.schemes);
    const basePath = typeof root.basePath === 'string' ? root.basePath.trim() : '';
    // `basePath` 是相对 host 的路径：拼成一个完整 URL 再走同一套收口，避免出现第二份路径规则
    for (const host of hosts) push(`${host}${basePath === '/' ? '' : basePath}`, protocol);
    if (collected.length === 0) return { ok: false, reason: 'noServers' };
  }

  return {
    ok: true,
    spec: {
      title: titleSegment(root.info && (root.info as Record<string, unknown>).title),
      origins: collected,
      skipped,
    },
  };
}

/**
 * 由解析结果生成规则
 *
 * 与 `harEntriesToRules` 同一条契约：**不传目标环境时，产出的形状与这条进口不存在时一致**
 * （自映射、`enabled: false`、优先级 100 排在用户手写规则之后）。填了合法目标才改地址，
 * 且启用与否只由调用方传进来的 `enabled` 决定（界面上那个复选框不出现时一律按未勾参与）。
 *
 * @param spec {@link parseOpenApiSpec} 成功时的结果
 * @param opts `targetOrigin` 已按 `apiOriginOf` 收口过的目标 origin；`enabled` 是否导入后立即启用
 */
export function openApiSpecToRules(
  spec: OpenApiSpec,
  opts?: { targetOrigin?: string; enabled?: boolean },
): ProxyRule[] {
  const targetOrigin = opts?.targetOrigin?.trim() || '';
  const enabled = targetOrigin ? opts?.enabled === true : false;
  const now = Date.now();
  const label = spec.title || 'OpenAPI';

  // 不在这里掐上限：静默丢掉一部分来源，等于替用户说「这份文档就这些接口」，
  // 而真正该说的是「超出 200 条了，删几条再导入」——那件事由批量写入那侧拒绝、界面点名。
  return spec.origins.map((item, index) => {
    // 前缀里带 basePath 时，目标也要带上同一段：文档说这套 API 挂在 `/v3`，换环境后不该落到根上
    const target = targetOrigin ? `${targetOrigin}${item.basePath}` : item.prefix;
    return {
      id: `openapi_${now.toString(36)}_${index.toString(36)}`,
      name: `${label} · ${item.prefix.replace(/^https?:\/\//, '')}`,
      enabled,
      matchPattern: item.prefix,
      targetUrl: target,
      matchType: 'prefix',
      priority: 100,
      createdAt: now,
      updatedAt: now,
    };
  });
}
