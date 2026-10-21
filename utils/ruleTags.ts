/**
 * 规则标签：清洗、去重、计数与筛选判据的唯一出口
 *
 * 标签只服务一件事——在一屏几十上百条规则里「把这一批挑出来」，它**不参与**匹配、分流与任何判定，
 * 所以加这个字段不改变任何一条请求的走向。也正因为它是纯分类物，这里的取舍偏「留住用户写的那一份」：
 * 宁可丢一个超长的尾巴，也不整条拒绝一条本来合法的文件。
 *
 * 三条判据只能住在这一个文件里，两侧（表单保存 / 导入清洗）共用：
 * - 表单侧另写一遍，就会变成「界面存得下、导入进不来」；
 * - 导入侧另写一遍，就是 `tests/importPlan.test.ts` 那条老教训的标签版（预览与实际写入判据同源）。
 *
 * `isValidRuleShape` 只做**类型**判定（是字符串数组吗），值域（长度、条数）在这里，与 `methods` 同一口径：
 * 类型不过 → 整条规则被拒（它会让界面与匹配循环读到非字符串）；值越界 → 钳制并留痕，不连坐整条规则。
 */

import { MAX_RULE_TAG_LENGTH, MAX_RULE_TAGS } from '@/utils/constants';
import { logger } from '@/utils/logger';
import type { ProxyRule } from '@/utils/types';

/** 筛选下拉里代表「没有标签的规则」那一项的哨兵值；它同时是一个**被禁用的标签字面量**（见 `sanitizeTags` 与 `visibleTags`）——否则用户真打上这个标签那天，选中它筛出来的会是「没标签的规则」而不是打了这个标签的规则 */
export const UNTAGGED = '__untagged__';

/** 清洗结果：`tags` 为 `undefined` 表示「这条规则没有标签」——刻意不落空数组，让无标签规则的形状与这个字段存在之前逐字节相同 */
export interface TagSanitization {
  tags?: string[];
  /** 因为「不是字符串 / trim 后为空 / 撞上哨兵字面量 / 超码点上限被截 / 条数越界」而没留下来的条目数 */
  dropped: number;
}

/**
 * 把任意输入清洗成可存的标签表
 *
 * 去重按 **trim + 小写** 不敏感比对，保留用户第一次写下的那种拼法：`FAT` 与 `fat` 当成同一个标签，
 * 否则筛选下拉里会出现两条只差大小写的选项，而它们其实筛的是同一批规则。
 * 长度按码点截断（`.length` 会把 emoji 的代理对算成两个字符，截半留下孤立代理位）。
 */
export function sanitizeTags(input: unknown): TagSanitization {
  if (!Array.isArray(input)) return { dropped: 0 };
  const kept: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of input) {
    if (typeof raw !== 'string') {
      dropped += 1;
      continue;
    }
    // 内部连续空白折成一个空格：「结算 中心」与「结算 中心」不该在筛选列表里算两个标签
    let tag = raw.trim().replace(/\s+/g, ' ');
    if (!tag) {
      dropped += 1;
      continue;
    }
    // 哨兵字面量不让进：它已经是下拉里「（无标签）」那一项的 value，同名标签会被读成那个意思
    if (tag === UNTAGGED) {
      dropped += 1;
      continue;
    }
    const chars = [...tag];
    if (chars.length > MAX_RULE_TAG_LENGTH) {
      tag = chars.slice(0, MAX_RULE_TAG_LENGTH).join('');
      dropped += 1;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    kept.push(tag);
  }
  if (kept.length > MAX_RULE_TAGS) {
    dropped += kept.length - MAX_RULE_TAGS;
    kept.length = MAX_RULE_TAGS;
  }
  return kept.length > 0 ? { tags: kept, dropped } : { dropped };
}

/** 只要标签表本身，供不关心「丢了几条」的调用方（导入清洗与恢复点回读） */
export function normalizeTags(input: unknown): string[] | undefined {
  return sanitizeTags(input).tags;
}

/** 导入侧的留痕：值越界只 `logger.warn`，不静默、也不连坐整条规则 */
export function normalizeTagsWithLog(input: unknown, ruleName: string): string[] | undefined {
  const { tags, dropped } = sanitizeTags(input);
  if (dropped > 0) {
    logger.warn(`规则「${ruleName}」的标签有 ${dropped} 项被清洗（非字符串 / 空 / 占用保留名 / 超长度或超条数上限）`);
  }
  return tags;
}

/**
 * 一个列表里现有哪些标签、各被多少条规则用到；按用量降序、同用量按名排
 *
 * 计数按 **小写键** 合并、保留第一次写下的那种拼法——筛选比对本来就是大小写不敏感的，
 * 若这里不合并，下拉里就会出现「FAT (1)」与「fat (1)」两条筛同一批规则的选项，
 * 用户得先猜哪一条才是自己要的。
 */
export function collectRuleTags(rules: readonly Pick<ProxyRule, 'tags'>[]): { tag: string; count: number }[] {
  const byKey = new Map<string, { tag: string; count: number }>();
  for (const rule of rules) {
    for (const tag of visibleTags(rule.tags)) {
      const key = tag.toLowerCase();
      const entry = byKey.get(key);
      if (entry) entry.count += 1;
      else byKey.set(key, { tag, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * 界面可读的那份标签表：非数组一律当空（手改过 storage 的旧数据不能让 `.slice` 抛）
 *
 * 与 `configRules()` 同一条规矩——从 storage 读出的东西先收口再点。
 * 这里也一道剔掉哨兵字面量：写入侧早已不让它进来，这一格管的是它已经躺在 storage 里的那种情况（手改
 * 那一份数据），留着它，规则会既出现在「（无标签）」的筛选结果里、又出现在一条同名 chip 上。
 */
export function visibleTags(tags: unknown): string[] {
  return Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '' && tag !== UNTAGGED)
    : [];
}

/**
 * 筛选判据：多选之间是**任一命中**（OR），并支持 {@link UNTAGGED} 这一项筛「没打标签的规则」。
 *
 * 刻意不做 AND：标签是分类名，交集常常是空的，用户会得到一张白屏表并以为规则丢了。
 * 空选择 = 不筛，与关键字 / 状态 / 匹配方式三个筛选项同一条口径。
 */
export function ruleMatchesTagFilter(rule: Pick<ProxyRule, 'tags'>, selected: readonly string[]): boolean {
  if (selected.length === 0) return true;
  const tags = visibleTags(rule.tags);
  for (const want of selected) {
    if (want === UNTAGGED) {
      if (tags.length === 0) return true;
      continue;
    }
    const key = want.toLowerCase();
    if (tags.some(tag => tag.toLowerCase() === key)) return true;
  }
  return false;
}
