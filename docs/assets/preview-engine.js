/**
 * 落地页「重写预演」引擎 —— `utils/urlMatcher.ts` 与 `utils/dnrRules.ts` 的手工副本
 *
 * 为什么单独一个文件、而不是写进 `landing.js`：这份判据是**会说谎或会说对**的东西——它告诉读者
 * 一条规则命中之后地址被改写成什么、走哪条通道。`landing.js` 里其余的增强（轮播、淡入、追光）
 * 画错了对正确性无损，这一份画错就是拿产品承诺开玩笑。拆成独立文件后
 * `tests/landingPreview.test.ts` 能用同一批输入把它和真实现**逐个答案比对**，
 * 而不是只 grep 一遍源码文本（文本 grep 拦不住「抄的时候改了个条件」这个方向）。
 *
 * 维护契约：改动 `utils/urlMatcher.ts` 的匹配与重写、`utils/dnrRules.ts` 的
 * `buildRegexFilter` / `buildRegexSubstitution` / `countCaptureGroups` / `maxSubstitutionRef`，
 * 或 `isSimpleRule` 中只依赖「匹配类型 + 模式 + 目标地址」的那三条分支
 * （空目标、通配符末尾非 `*`、WebSocket），必须回到这里镜像；两份答案不一致时以真实现为准。
 *
 * 已知做不到的那一半：网络层规则还要过 Chrome 的 RE2 校验（`isRegexSupported`），
 * 那是扩展进程里的异步 API，网页无从调用，所以正则模式的「浏览器会不会应用」在这里不表态，
 * 由界面文案把这句话交代给扩展内的「未生效」标记。
 *
 * 零依赖、零外链；只挂一个 `window.copRewritePreview`，不参与页面渲染。
 */

(() => {
  'use strict';

  /** 与 `escapeRegex` / `wildcardToRegex` 同一个字符集：`*` 由调用方单独处理 */
  const SPECIAL = /[.+?^${}()|[\]\\]/g;
  const WS_SCHEME = /wss?:\/\//i;
  /**
   * 替换串展开之后还得是一个能跳转的地址。
   *
   * 扩展侧没有这条判据（`isSubstitutionValid` 只看捕获引用越不越界），因为它要防的是
   * 「一条非法规则让 `updateDynamicRules` 整批被拒」，而「换出来不是一个地址」是匹配那一刻
   * 才不会跳转——两通道在这里给出的结论不同，正是要预演给人看的那件事。
   */
  const ABSOLUTE_URL = /^https?:\/\//i;

  /** 与 `isRegexSafe` 同一份嵌套量词清单——ReDoS 的判据不能有两份 */
  const UNSAFE_REGEX = [/\([^)]*[+*][^)]*\)[+*]/, /\([^)]*[+*][^)]*\)\{/, /(\+|\*)\1/];

  const escapeSpecial = text => text.replace(SPECIAL, '\\$&');

  /** 镜像 `getCompiledRegex`：语法不过或撞上嵌套量词，一律当「这个模式不会被接受」 */
  const compile = pattern => {
    if (UNSAFE_REGEX.some(re => re.test(pattern))) return null;
    try {
      return new RegExp(pattern);
    } catch {
      return null;
    }
  };

  /** 镜像 `wildcardToRegex` */
  const wildcardRegex = pattern => new RegExp(`^${escapeSpecial(pattern).replace(/\*/g, '.*')}$`);

  /** 镜像 `wildcardTailRegex`：末尾 `*` 变成捕获组，模式不以 `*` 结尾则不重写 */
  const tailRegex = pattern => {
    if (!pattern.endsWith('*')) return null;
    const base = escapeSpecial(pattern.slice(0, -1)).replace(/\*/g, '.*');
    try {
      return new RegExp(`^${base}(.*)$`);
    } catch {
      return null;
    }
  };

  /** 镜像 `countCaptureGroups`（转义感知，非捕获构造不计入） */
  const countGroups = filter => {
    let count = 0;
    for (let i = 0; i < filter.length; i += 1) {
      const ch = filter[i];
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch !== '(') continue;
      if (filter[i + 1] !== '?') {
        count += 1;
        continue;
      }
      if (filter[i + 2] === '<' && /[A-Za-z]/.test(filter[i + 3] || '')) count += 1;
    }
    return count;
  };

  /** 镜像 `maxSubstitutionRef`：`\\` 是字面量反斜杠，其后的数字不构成引用 */
  const maxRef = substitution => {
    let max = -1;
    for (let i = 0; i < substitution.length; i += 1) {
      if (substitution[i] !== '\\') continue;
      const next = substitution[i + 1];
      if (next === undefined) break;
      i += 1;
      if (next >= '0' && next <= '9') max = Math.max(max, Number(next));
    }
    return max;
  };

  /** 后台通道（`rewriteUrl`）：SW 只替换正则匹配到的片段，且只替换第一处 */
  const rewriteExt = (url, matchType, pattern, target) => {
    if (!target) return url;
    if (matchType === 'wildcard') {
      const re = tailRegex(pattern);
      const matched = re && re.exec(url);
      if (!matched) return url;
      const rest = matched[1];
      const sep = pattern.slice(0, -1).endsWith('/') && rest ? '/' : '';
      return `${target.replace(/\/$/, '')}${sep}${rest}`;
    }
    if (matchType === 'prefix') {
      if (!url.startsWith(pattern)) return url;
      const rest = url.slice(pattern.length);
      const sep = pattern.endsWith('/') ? '/' : '';
      return `${target.replace(/\/$/, '')}${sep}${rest}`;
    }
    const re = compile(pattern);
    if (!re) return url;
    return url.replace(re, target);
  };

  /**
   * 网络层（`buildRegexFilter` + `buildRegexSubstitution`）：把 `\n` 引用展开成捕获组
   *
   * 与后台通道的关键差异在这里落地：DNR 的替换是**整个地址**被替换成替换串，
   * 而 `String.replace` 只替换匹配到的片段——正则模式下两通道结果本就不同（这是
   * 仓库里那条「已接受的通道差异」，预演要把它画出来，不是抹平）。
   */
  const rewriteNet = (url, matchType, pattern, target) => {
    const targetBase = target.replace(/\/$/, '');
    let filter;
    let substitution;

    // 通配符模式只有末尾是 `*` 才会进网络层（`isSimpleRule` 那条分支），所以这里不必搬
    // `starCount === 0` 时的静态替换串——那个输入在下面算不出合法 filter。
    if (matchType === 'wildcard') {
      filter = `^${escapeSpecial(pattern).replace(/\*/g, '(.*)')}$`;
      substitution = `${targetBase}${pattern.replace(/\*$/, '').endsWith('/') ? '/' : ''}\\${(pattern.match(/\*/g) || []).length}`;
    } else if (matchType === 'prefix') {
      filter = `^${escapeSpecial(pattern).replace(/\*/g, '\\*')}(.*)`;
      substitution = `${targetBase}${pattern.endsWith('/') ? '/' : ''}\\1`;
    } else {
      filter = pattern;
      substitution = target.replace(/\$(\d)/g, '\\$1');
    }

    if (maxRef(substitution) > countGroups(filter)) return { url: null, skip: 'substitutionInvalid' };

    // 能走到这一格的输入已在上面按同一套判据命中，filter 与那边是同一个式子；`|| ['']` 只是
    // 不让一次理论上的落差把预演面板抛成死控件，不承担判定。
    const groups = new RegExp(filter).exec(url) || [''];

    let out = '';
    for (let i = 0; i < substitution.length; i += 1) {
      if (substitution[i] === '\\') {
        const next = substitution[i + 1];
        if (next !== undefined) {
          i += 1;
          if (next >= '0' && next <= '9') out += groups[Number(next)] || '';
          else out += next;
          continue;
        }
      }
      out += substitution[i];
    }
    return { url: out, skip: null };
  };

  /**
   * 预演一条「只带匹配类型、模式与目标地址」的规则
   * @param {{matchType: string, pattern: string, target: string, url: string}} input 界面四项输入
   * @returns {{usable: boolean, matched: boolean, channel: string, codes: string[],
   *            extUrl: string, netUrl: string|null, netSkip: string|null, diverged: boolean}}
   *   `usable` 模式本身会不会被接受；`codes` 是走后台通道的理由码；
   *   `netSkip` 是网络层这一格不适用或不会被应用的理由码（`notSimple` / `substitutionInvalid` /
   *   `notUrl`；`null` = 给出了一个可跳转的改写结果）；
   *   `diverged` 只在两通道都给出了地址时可能为真
   */
  const preview = input => {
    const matchType = input.matchType;
    const pattern = (input.pattern || '').trim();
    const target = (input.target || '').trim();
    const url = (input.url || '').trim();
    const base = {
      usable: true,
      matched: false,
      channel: '',
      codes: [],
      extUrl: url,
      netUrl: null,
      netSkip: null,
      diverged: false,
    };

    if (matchType === 'regex' && !compile(pattern)) return { ...base, usable: false };
    // 测试地址留空时不谈命中：空模式配空地址在真实现里算「匹配」，而这里是一格还没填完的输入框。
    if (!url) return base;

    let matched;
    if (matchType === 'wildcard') matched = wildcardRegex(pattern).test(url);
    else if (matchType === 'prefix') matched = url.startsWith(pattern);
    else matched = compile(pattern).test(url);
    if (!matched) return base;

    // 分流判据只搬与这三项输入相关的分支；头/体/响应覆盖、Mock、延迟、阻断、重试、
    // 方法过滤、查询参数、凭据那几条在预演里恒为「没配」，所以不需要搬。
    const codes = [];
    if (!target) codes.push('noTarget');
    if (WS_SCHEME.test(pattern) || WS_SCHEME.test(target)) codes.push('websocket');
    if (matchType === 'wildcard' && !pattern.endsWith('*')) codes.push('wildcardNoStar');

    const extUrl = rewriteExt(url, matchType, pattern, target);
    if (codes.length) return { ...base, matched: true, channel: 'ext', codes, extUrl, netSkip: 'notSimple' };

    const net = rewriteNet(url, matchType, pattern, target);
    return {
      ...base,
      matched: true,
      channel: 'net',
      extUrl,
      netUrl: net.url,
      // 网络层这一格照旧画出展开结果（两行不一样正是这块面板要教的那件事），但换出来不是一个
      // 地址时点名：浏览器拿着它不会跳转， headline 不能再说「这一笔由网络层改写」。
      netSkip: net.skip || (net.url !== null && !ABSOLUTE_URL.test(net.url) ? 'notUrl' : null),
      diverged: net.url !== null && net.url !== extUrl,
    };
  };

  window.copRewritePreview = { preview };
})();
