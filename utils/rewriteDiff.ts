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
 * 按公共前后缀切出改写中被换掉的那一段
 *
 * 两个地址完全相同时 `changed` 为空串——界面据此不画高亮，而不是画一个空的强调块。
 * 前后缀刻意不允许重叠（后缀最多取到前缀之后），否则 `abc` → `abc` 这类输入会让
 * 中间段算成负长度。
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

  return {
    before: target.slice(0, prefix),
    changed: target.slice(prefix, target.length - suffix),
    after: target.slice(target.length - suffix),
  };
}
