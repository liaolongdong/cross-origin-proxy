/**
 * cURL 命令解析（纯函数模块，便于单元测试）
 *
 * 将用户粘贴的 cURL 命令（浏览器 DevTools「复制为 cURL」产物或手工编写）
 * 解析为结构化请求描述，供「cURL 导入」预填规则表单。
 *
 * 支持：行续符、单/双引号分词、-X、-H、-d 系列、--json、--url、
 * -A/-e/-b 快捷头、-u Basic 认证；未知选项安全跳过。
 */

export interface ParsedCurl {
  /** 请求 URL（绝对地址，已通过 new URL 校验） */
  url: string;
  /** 请求方法（大写） */
  method: string;
  /** 请求头（按出现顺序，同名后者覆盖前者） */
  headers: Record<string, string>;
  /** 请求体（多个 -d 以 & 连接；无则为 undefined） */
  body?: string;
}

/** 需要消耗下一个 token 作为参数的选项 */
const OPTIONS_WITH_ARG = new Set([
  '-X',
  '--request',
  '-H',
  '--header',
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-ascii',
  '--data-urlencode',
  '--json',
  '--url',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '-b',
  '--cookie',
  '-u',
  '--user',
  '-o',
  '--output',
  '-c',
  '--cookie-jar',
  '-F',
  '--form',
  '-T',
  '--upload-file',
  '-x',
  '--proxy',
  '-U',
  '--proxy-user',
  '--connect-timeout',
  '-m',
  '--max-time',
  '--retry',
  '--retry-delay',
  '-w',
  '--write-out',
  '--resolve',
]);

/**
 * 将 cURL 命令分词（状态机）：
 * - 单引号内原样保留；双引号内支持反斜杠转义（\" \\ \$ \`）
 * - 引号外的反斜杠转义下一个字符；空白分词
 */
export function tokenizeCurl(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let mode: 'normal' | 'single' | 'double' = 'normal';

  const push = () => {
    if (hasToken) {
      tokens.push(current);
      current = '';
      hasToken = false;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (mode === 'single') {
      if (ch === "'") {
        mode = 'normal';
      } else {
        current += ch;
      }
      continue;
    }
    if (mode === 'double') {
      if (ch === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) {
        current += text[i + 1];
        i++;
      } else if (ch === '"') {
        mode = 'normal';
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'") {
      mode = 'single';
      hasToken = true;
    } else if (ch === '"') {
      mode = 'double';
      hasToken = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      current += text[i + 1];
      hasToken = true;
      i++;
    } else if (/\s/.test(ch)) {
      push();
    } else {
      current += ch;
      hasToken = true;
    }
  }
  push();
  return tokens;
}

/** 解析单个 -H 值（"Name: value"），名称非法返回 null */
function parseHeaderToken(raw: string): [string, string] | null {
  // curl 语义：末尾分号表示发送空值头（"X-Empty;" → 空值，无需冒号）
  const hasEmptyValueMarker = raw.endsWith(';');
  const cleaned = hasEmptyValueMarker ? raw.slice(0, -1) : raw;
  const index = cleaned.indexOf(':');
  if (index < 0) {
    const name = cleaned.trim();
    if (!hasEmptyValueMarker || !name || /[\s()<>@,;:\\"/[\]?={}\r\n]/.test(name)) return null;
    return [name, ''];
  }
  if (index === 0) return null;
  const name = cleaned.slice(0, index).trim();
  const value = cleaned.slice(index + 1).trim();
  if (!name || /[\s()<>@,;:\\"/[\]?={}\r\n]/.test(name)) return null;
  return [name, value];
}

/** user:pass → Basic 认证头（非 ASCII 凭据时放弃，避免 btoa 抛错） */
function toBasicAuth(credentials: string): string | null {
  try {
    return `Basic ${btoa(credentials)}`;
  } catch {
    return null;
  }
}

/**
 * 解析 cURL 命令
 * @returns 解析结果；输入不是有效 cURL 命令（缺少可用 URL）时返回 null
 */
export function parseCurlCommand(text: string): ParsedCurl | null {
  if (typeof text !== 'string') return null;

  // 去掉 shell 提示符残留与行续符
  const normalized = text
    .trim()
    .replace(/^\$\s+/, '')
    .replace(/\\\r?\n/g, ' ');

  const tokens = tokenizeCurl(normalized);
  if (tokens.length === 0) return null;

  let start = 0;
  if (tokens[0] === 'curl' || tokens[0].endsWith('/curl')) start = 1;

  let url: string | undefined;
  let explicitMethod: string | undefined;
  const headers: Record<string, string> = {};
  const dataParts: string[] = [];

  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];

    if (!token.startsWith('-')) {
      if (!url) url = token;
      continue;
    }

    // 合并 --opt=value 形式
    let option = token;
    let inlineValue: string | undefined;
    const eqIndex = token.indexOf('=');
    if (token.startsWith('--') && eqIndex > 0) {
      option = token.slice(0, eqIndex);
      inlineValue = token.slice(eqIndex + 1);
    }

    const needsArg = OPTIONS_WITH_ARG.has(option);
    let arg = inlineValue;
    if (arg === undefined && needsArg) {
      arg = tokens[++i];
      if (arg === undefined) break;
    }

    switch (option) {
      case '-X':
      case '--request':
        if (arg) explicitMethod = arg.toUpperCase();
        break;
      case '-H':
      case '--header': {
        if (!arg) break;
        const parsed = parseHeaderToken(arg);
        if (parsed) headers[parsed[0]] = parsed[1];
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
      case '--data-urlencode':
        if (arg !== undefined) dataParts.push(arg);
        break;
      case '--json':
        if (arg !== undefined) {
          dataParts.push(arg);
          if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/json';
          }
        }
        break;
      case '--url':
        if (arg) url = arg;
        break;
      case '-A':
      case '--user-agent':
        if (arg) headers['User-Agent'] = arg;
        break;
      case '-e':
      case '--referer':
        if (arg) headers['Referer'] = arg;
        break;
      case '-b':
      case '--cookie':
        if (arg) headers['Cookie'] = arg;
        break;
      case '-u':
      case '--user': {
        if (!arg) break;
        const auth = toBasicAuth(arg);
        if (auth) headers['Authorization'] = auth;
        break;
      }
      default:
        // 未知选项：已知带参数的已被消耗，其余为布尔开关，安全跳过
        break;
    }
  }

  if (!url) return null;
  try {
    url = new URL(url).href;
  } catch {
    return null;
  }

  const method = explicitMethod || (dataParts.length > 0 ? 'POST' : 'GET');

  return {
    url,
    method,
    headers,
    body: dataParts.length > 0 ? dataParts.join('&') : undefined,
  };
}
