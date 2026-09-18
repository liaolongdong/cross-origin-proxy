/**
 * 搜索关键字高亮的分段计算（纯函数，供 HighlightText.vue 使用）
 *
 * 拆出来是为了「不构造 HTML 字符串」这个安全前提可被单测锁住：旧实现先把文本转成
 * HTML 实体、再用正则往字符串里塞标签，于是搜索 `amp` 会打断 `&amp;`、搜索 `;`
 * 会让单元格显示成乱码，而搜索词为空时干脆跳过转义，等于把用户输入当 HTML 解析。
 * 现在只做文本分段，渲染侧按文本节点输出，转义交给框架。
 */

export interface HighlightSegment {
  /** 原文切片（未做任何 HTML 处理） */
  text: string;
  /** 是否为搜索关键字命中的片段 */
  hit: boolean;
}

/** 缓存高亮正则，避免每次渲染都 new RegExp（表格每行每列都会调用） */
let cachedPattern = '';
let cachedRegex: RegExp | null = null;

function getHighlightRegex(pattern: string): RegExp | null {
  if (pattern === cachedPattern) return cachedRegex;
  cachedPattern = pattern;
  // 关键字里的正则元字符全部转义：搜索 `a.*b` 应当按字面量匹配
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  cachedRegex = pattern ? new RegExp(escaped, 'gi') : null;
  return cachedRegex;
}

/**
 * 按关键字把文本切成命中/未命中交替片段。
 *
 * 关键字为空、文本为空或无命中时返回单段未命中，调用方可直接渲染。
 * 返回的切片拼起来必须严格等于原文（由测试守卫）。
 */
export function splitHighlight(text: string, keyword: string): HighlightSegment[] {
  if (!text) return [];
  const regex = keyword ? getHighlightRegex(keyword) : null;
  if (!regex) return [{ text, hit: false }];

  const result: HighlightSegment[] = [];
  let cursor = 0;
  // 元字符已转义，命中内容必非空，不存在零宽死循环
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > cursor) result.push({ text: text.slice(cursor, match.index), hit: false });
    result.push({ text: match[0], hit: true });
    regex.lastIndex = match.index + match[0].length;
    cursor = regex.lastIndex;
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor), hit: false });
  return result;
}
