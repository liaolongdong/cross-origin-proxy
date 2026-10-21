/**
 * 规则标签：清洗、计数与筛选判据按「输入 → 答案」逐个核
 *
 * 这个字段本身不影响任何一条请求的走向，所以它唯一的风险面是**数据形状**：
 * 表格与筛选下拉直接对 `tags` 调 `.some()` / `.slice()`，一条手改过或被截断的 storage 数据
 * 让它变成字符串/对象，就是一整张规则表在渲染时抛错（与 `configRules()` 当年处理 `rules` 同一件事）。
 * 因此这里的用例都盯着两件事：越界的输入怎么收口，以及收口之后有没有如实报数（不静默吃标签）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 桩就地写：`vi.mock` 会被提到文件最顶端，工厂里引用外层 const 会撞在初始化之前（本仓其它测试同一写法）
vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MAX_RULE_TAG_LENGTH, MAX_RULE_TAGS } from '@/utils/constants';
import {
  UNTAGGED,
  collectRuleTags,
  normalizeTags,
  normalizeTagsWithLog,
  ruleMatchesTagFilter,
  sanitizeTags,
  visibleTags,
} from '@/utils/ruleTags';

beforeEach(() => vi.clearAllMocks());

describe('sanitizeTags — 什么算一个标签', () => {
  it('非数组一律当「没有标签」，不抛', () => {
    expect(sanitizeTags(undefined)).toEqual({ dropped: 0 });
    expect(sanitizeTags('uat')).toEqual({ dropped: 0 });
    expect(sanitizeTags({ tag: 'uat' })).toEqual({ dropped: 0 });
    expect(normalizeTags('uat')).toBeUndefined();
  });

  it('trim、内部空白折一格、空白项丢弃', () => {
    expect(sanitizeTags(['  uat  ', '结算 中心', '', '   ']).tags).toEqual(['uat', '结算 中心']);
    expect(sanitizeTags(['  uat  ', '结算 中心', '', '   ']).dropped).toBe(2);
  });

  it('只差大小写的重复算同一个标签，保留第一次写下的那种拼法', () => {
    expect(sanitizeTags(['FAT', 'fat', ' Fat ', 'PAY']).tags).toEqual(['FAT', 'PAY']);
    expect(sanitizeTags(['FAT', 'fat', ' Fat ', 'PAY']).dropped).toBe(2);
  });

  it('非字符串项丢弃并计数，不影响同批其它标签', () => {
    const r = sanitizeTags(['uat', 42, null, { a: 1 }, 'fat']);
    expect(r.tags).toEqual(['uat', 'fat']);
    expect(r.dropped).toBe(3);
  });

  it('长度按码点截断，孤立代理位不会被截出来', () => {
    const cjk = '标'.repeat(MAX_RULE_TAG_LENGTH + 8);
    const long = sanitizeTags([cjk]);
    expect([...long.tags![0]]).toHaveLength(MAX_RULE_TAG_LENGTH);
    expect(long.dropped).toBe(1);
    // 4 个 emoji = 4 个码点 = 8 个 UTF-16 单元；按 `.length` 判会误判超长、按下标硬切会劈开代理对
    const emoji = '🙂🙃🙂🙃';
    expect(emoji.length).toBe(8);
    expect(Array.from(emoji)).toHaveLength(4);
    expect(sanitizeTags([emoji]).tags).toEqual([emoji]);
    // 前缀那个 'a' 是故意的：纯 emoji 串切 24 个 UTF-16 单元正好落在边界上，
    // 那样「按单元切」与「按码点切」看不出差别，这条断言就是空转的
    const emojiRun = 'a' + '🙂'.repeat(MAX_RULE_TAG_LENGTH + 6);
    const cut = sanitizeTags([emojiRun]).tags![0];
    expect([...cut]).toHaveLength(MAX_RULE_TAG_LENGTH);
    // 按单元切会把一对代理劈开（尾巴留下孤立的 \ud83d）；按码点切不会
    expect(cut).toBe(cut.toWellFormed());
    expect(emojiRun.slice(0, MAX_RULE_TAG_LENGTH)).not.toBe(emojiRun.slice(0, MAX_RULE_TAG_LENGTH).toWellFormed());
  });

  it('条数越界时钳到上限，并把丢掉的条数报出来（不是静默截）', () => {
    const many = Array.from({ length: MAX_RULE_TAGS + 5 }, (_, i) => `t${i}`);
    const r = sanitizeTags(many);
    expect(r.tags).toHaveLength(MAX_RULE_TAGS);
    expect(r.tags![0]).toBe('t0');
    expect(r.dropped).toBe(5);
  });

  it('全被丢光时返回 undefined 而不是空数组：无标签规则的形状要与「还没有这个字段」时逐字节相同', () => {
    expect(sanitizeTags(['', '  ']).tags).toBeUndefined();
    expect(normalizeTags(['', '  '])).toBeUndefined();
  });

  it('哨兵字面量不让进（它已经是「（无标签）」那一项的 value，同名标签会被读成那个意思）', () => {
    expect(sanitizeTags([UNTAGGED, 'uat'])).toEqual({ tags: ['uat'], dropped: 1 });
    // 比对发生在 trim 之后：前后加空格救不回来
    expect(sanitizeTags([` ${UNTAGGED} `]).tags).toBeUndefined();
  });
});

describe('normalizeTagsWithLog — 导入侧留痕', () => {
  it('有丢弃就 exactly 一句 warn，且只报数不报标签内容', async () => {
    const { logger } = await import('@/utils/logger');
    expect(normalizeTagsWithLog(['uat', 7, '  '], 'FAT → UAT')).toEqual(['uat']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = String(vi.mocked(logger.warn).mock.calls[0][0]);
    expect(line).toContain('2');
    expect(line).toContain('FAT → UAT');
  });

  it('干干净净的一批不吭声', async () => {
    const { logger } = await import('@/utils/logger');
    expect(normalizeTagsWithLog(['uat', 'fat'], 'r')).toEqual(['uat', 'fat']);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('visibleTags — 从 storage 读出的东西先收口再点', () => {
  it('非数组当空；数组里的非字符串与空串剔掉', () => {
    expect(visibleTags(undefined)).toEqual([]);
    expect(visibleTags('uat')).toEqual([]);
    expect(visibleTags(['a', 1, '', null, 'b'])).toEqual(['a', 'b']);
  });

  it('storage 里躺着的哨兵字面量既不显示，也不让同一条规则同时算「有标签」和「无标签」', () => {
    expect(visibleTags([UNTAGGED, 'uat'])).toEqual(['uat']);
    expect(visibleTags([UNTAGGED])).toEqual([]);
    expect(ruleMatchesTagFilter({ tags: [UNTAGGED] }, [UNTAGGED])).toBe(true);
    expect(collectRuleTags([{ tags: [UNTAGGED, 'uat'] }])).toEqual([{ tag: 'uat', count: 1 }]);
  });
});

describe('collectRuleTags — 筛选下拉的那份清单', () => {
  it('按用量降序、同用量按名排，坏形状的规则不参与', () => {
    const list = collectRuleTags([
      { tags: ['结算', 'uat'] },
      { tags: ['uat'] },
      { tags: ['结算'] },
      { tags: '坏数据' },
      {},
    ] as never[]);
    expect(list).toEqual([
      { tag: 'uat', count: 2 },
      { tag: '结算', count: 2 },
    ]);
  });

  it('大小写不同的标签合并计数（下拉里不出现两条只差大小写的选项）', () => {
    expect(collectRuleTags([{ tags: ['FAT'] }, { tags: ['fat'] }] as never[])).toEqual([{ tag: 'FAT', count: 2 }]);
  });
});

describe('ruleMatchesTagFilter — 多选是任一命中', () => {
  const rule = (tags?: unknown) => ({ tags }) as never;

  it('空选择 = 不筛（与关键字/状态/匹配方式同一口径）', () => {
    expect(ruleMatchesTagFilter(rule(['uat']), [])).toBe(true);
    expect(ruleMatchesTagFilter(rule(undefined), [])).toBe(true);
  });

  it('选中的标签里任意一个命中即通过；都不在则不通过', () => {
    expect(ruleMatchesTagFilter(rule(['uat', 'fat']), ['fat', 'pay'])).toBe(true);
    expect(ruleMatchesTagFilter(rule(['uat']), ['fat', 'pay'])).toBe(false);
  });

  it('比对大小写不敏感', () => {
    expect(ruleMatchesTagFilter(rule(['FAT']), ['fat'])).toBe(true);
  });

  it('UNTAGGED 只筛没标签的，且能与真标签同时选（OR，不是交集）', () => {
    expect(ruleMatchesTagFilter(rule(undefined), [UNTAGGED])).toBe(true);
    expect(ruleMatchesTagFilter(rule([]), [UNTAGGED])).toBe(true);
    expect(ruleMatchesTagFilter(rule(['uat']), [UNTAGGED])).toBe(false);
    expect(ruleMatchesTagFilter(rule(['uat']), [UNTAGGED, 'uat'])).toBe(true);
    expect(ruleMatchesTagFilter(rule(['x']), [UNTAGGED, 'uat'])).toBe(false);
  });

  it('坏数据形状不会抛（手改过的 storage 不能让整张表在渲染时炸）', () => {
    expect(ruleMatchesTagFilter(rule('uat'), ['uat'])).toBe(false);
    expect(ruleMatchesTagFilter(rule({ 0: 'uat' }), ['uat'])).toBe(false);
  });
});
