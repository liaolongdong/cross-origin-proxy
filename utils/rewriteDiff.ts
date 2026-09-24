/**
 * 改写差异：把「这条规则到底动了哪一段」说出来
 *
 * 规则表单的预演、URL 匹配测试、弹窗的本页命中预览都在展示改写前后的两个地址，但读者要自己
 * 逐字比对才知道改了什么——而最需要看懂的恰恰是通配符 `*` 捕获到的那截到底去了哪里。
 * 这里给的是**公共前后缀**之外的中间段：它不试图理解 URL 结构（那是 `urlMatcher` 的活），
 * 只回答「这两个字符串差在哪」。因此它永远与两边的实际值等价，不会另造一套语义。
 *
 * 三处界面共用一份，是为了让同一件事在三处看起来一模一样：高亮的是同一段字符，
 * 而不是每个组件各自算一遍 diff（三份实现迟早分叉）。
 */

/** 目标地址相对源地址的差异切分：`before + changed + after === target` */
export interface RewriteDiff {
  /** 与源地址共用的开头 */
  before: string;
  /** 这一次改写真正换进来的部分；未改写时为空串 */
  changed: string;
  /** 与源地址共用的结尾 */
  after: string;
}

/**
 * 词段里的字符：拉丁字母、数字、常用汉字（`U+4E00–U+9FFF` 基本区，假名与扩展区按分隔符算）。
 * URL 的分隔符（`:` `/` `?` `&` `.` `-` `_` `%`）都不在其中，所以「推到分隔符为止」
 * 等价于「不越过一段主机名 / 路径段 / 查询参数的边界」。
 */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9一-鿿]/.test(char);
}

/**
 * 按公共前后缀切出改写中被换掉的那一段，再把这一段对齐到它所在的词段
 *
 * 两个地址完全相同时 `changed` 为空串——界面据此不画高亮，而不是画一个空的强调块。
 * 前后缀刻意不允许重叠（后缀最多取到前缀之后），否则 `abc` → `abc` 这类输入会让
 * 中间段算成负长度。
 *
 * 为什么要往外扩一格：裸的最小字符编辑在 `fat-api` → `uat-api` 上会把 `at` 算成共用
 * 后缀，于是高亮只剩一个 `u`——那既不是「被改掉的那一段」，也不告诉读者换成了什么，
 * 逐字对读的活儿又还给了用户。所以高亮段的两头一律推到分隔符为止（`-` `.` `/` `:` 之类），
 * 让「uat」「v2」这样整段被换掉的词段完整地被染上。**只在确实有高亮时扩**：纯删除
 * （目标里没有新字符）时把隔壁那个没动过的词段也染上，是凭空圈人——比不圈更糟。
 */
export function diffRewrite(source: string, target: string): RewriteDiff {
  if (source === target) return { before: target, changed: '', after: '' };

  const maxPrefix = Math.min(source.length, target.length);
  let prefix = 0;
  while (prefix < maxPrefix && source[prefix] === target[prefix]) prefix += 1;

  // 后缀只在「前缀之后」比，两段共用字符是不允许的
  let suffix = 0;
  while (suffix < maxPrefix - prefix && source[source.length - 1 - suffix] === target[target.length - 1 - suffix]) {
    suffix += 1;
  }

  let lo = prefix;
  let hi = target.length - suffix;
  if (hi > lo) {
    // 段首是词字符才往左吃，且不吃过分隔符；段尾同理往右
    if (isWordChar(target[lo])) while (lo > 0 && isWordChar(target[lo - 1])) lo -= 1;
    if (isWordChar(target[hi - 1])) while (hi < target.length && isWordChar(target[hi])) hi += 1;
  }

  return {
    before: target.slice(0, lo),
    changed: target.slice(lo, hi),
    after: target.slice(hi),
  };
}
