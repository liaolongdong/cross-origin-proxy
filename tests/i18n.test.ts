import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { t, currentLocale } from '@/utils/i18n';

afterEach(() => {
  currentLocale.value = 'zh_CN';
});

describe('i18n t()', () => {
  it('返回当前语言文案', () => {
    currentLocale.value = 'zh_CN';
    expect(t('confirm')).toBe('确定');
    currentLocale.value = 'en';
    expect(t('confirm')).toBe('OK');
  });

  it('未注册 key 回退返回 key 本身', () => {
    expect(t('__not_exist_key__')).toBe('__not_exist_key__');
  });

  it('支持 $1 占位符插值（单值）', () => {
    currentLocale.value = 'zh_CN';
    expect(t('minutesAgo', 5)).toBe('5分钟前');
  });

  it('支持多占位符插值（数组）', () => {
    currentLocale.value = 'zh_CN';
    expect(t('rulesCountInfo', [8, 3])).toBe('共 8 条规则，已启用 3 条');
    currentLocale.value = 'en';
    expect(t('rulesCountInfo', [8, 3])).toBe('8 rules in total, 3 enabled');
  });

  it('语言切换后同一 key 文案随之变化', () => {
    currentLocale.value = 'zh_CN';
    const zh = t('addRule');
    currentLocale.value = 'en';
    const en = t('addRule');
    expect(zh).toBe('添加规则');
    expect(en).toBe('Add Rule');
  });

  it('插入值里的 $ 序列按字面量呈现，不被特殊模式或后续占位符吃掉', () => {
    currentLocale.value = 'zh_CN';
    expect(t('importPreviewConflictItem', ['a$&b', 'https://$1.old', 'x$2y'])).toBe(
      '「a$&b」已存在：保留 https://$1.old，文件里的 x$2y 不会生效',
    );
  });

  it('传参少于占位符时，未提供的占位符原样保留', () => {
    currentLocale.value = 'zh_CN';
    expect(t('importPreviewConflictItem', '只有名字')).toBe('「只有名字」已存在：保留 $2，文件里的 $3 不会生效');
  });
});

/**
 * 源码里用到的键必须真实存在、且在中英两侧都有非空文案。
 *
 * `t()` 未命中时**返回键名本身**，所以少一个键不会报错、不会红任何静态检查，
 * 只会把 `restorePointsTitle` 这样的英文标识直接画到界面上；值写成空串同样画出一片空白。
 *
 * 认两类位点：① `t('字面量')`；② 以键表形式声明的动态键（属性名以 `Key` / `Keys` 结尾的
 * 字面量值，以及 `const *_KEYS = { ... }` 的整表值）——`EmptyGuide.vue` 的模板卡与
 * `SettingsDialog.vue` 的恢复点成因走的都是后者，只扫 ① 时它们从来不在守卫范围内。
 * 真正运行时拼出来的键（`t(prefix + name)`）仍然扫不到，那一类只能靠界面自查。
 */
describe('i18n 用到的 key 必须存在', () => {
  const SOURCE_DIRS = ['components', 'composables', 'entrypoints', 'utils'];

  function listSourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listSourceFiles(full);
      return /\.(vue|ts)$/.test(entry.name) ? [full] : [];
    });
  }

  /** 键 → 文案值：除了「存不存在」，还要能问「是不是空的」（用 Map 而不是对象，避开原型链） */
  const dictionaries = (['zh_CN', 'en'] as const).map(locale => ({
    locale,
    values: new Map<string, unknown>(
      ['common', 'options', 'popup'].flatMap(ns => {
        const raw = JSON.parse(fs.readFileSync(`locales/${locale}/${ns}.json`, 'utf-8')) as Record<string, unknown>;
        return Object.entries(raw);
      }),
    ),
  }));

  const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/?\*|<!--)/.test(line);

  /** 一处键位点的出处与实际毛病 */
  const unresolved: string[] = [];
  const usedKeys = new Set<string>();
  const dynamicKeys = new Set<string>();

  const checkKey = (where: string, key: string, bucket?: Set<string>): void => {
    bucket?.add(key);
    usedKeys.add(key);
    for (const { locale, values } of dictionaries) {
      const value = values.get(key);
      if (value === undefined) unresolved.push(`${where} 的 '${key}' 在 ${locale} 侧不存在`);
      else if (typeof value !== 'string') unresolved.push(`${where} 的 '${key}' 在 ${locale} 侧不是字符串`);
      else if (value.trim() === '') unresolved.push(`${where} 的 '${key}' 在 ${locale} 侧是空文案`);
    }
  };

  /**
   * 标签键表：`const FOO_KEYS: Record<某个域联合, string> = {` 到配对的 `}` 之间，
   * 所有 `: '值'` 都是消息键。要求那行 `Record<...>` 标注是为了把它和别的名叫 KEYS 的
   * 表区分开——`utils/constants.ts` 的 `STORAGE_KEYS` 值是存储键，不是文案键。
   */
  const KEY_TABLE_RE = /const\s+([A-Z][A-Z0-9_]*KEYS)\s*:\s*Record<[^=>]+>\s*=\s*\{/;
  const TABLE_VALUE_RE = /:\s*['"]([A-Za-z][\w.]*)['"]/g;
  /** 属性名以 Key / Keys 结尾的字面量值（`titleKey: 'wildcardApiProxy'`） */
  const KEY_PROPERTY_RE = /[\w$]*(?:Key|Keys)\s*:\s*['"]([A-Za-z][\w.]*)['"]/g;
  const LITERAL_CALL_RE = /\bt\(\s*['"]([A-Za-z][\w.]*)['"]/g;
  /** 跨行收表只认「行首就是右花括号」：值里或注释里的 `}` 不该提前把这张表关掉 */
  const TABLE_CLOSE_RE = /^\s*\}/;
  /** 一行写完的键表另有一判：`{` 之后的内容以 `}` 收尾（可带尾随逗号或分号） */
  const TABLE_CLOSE_INLINE_RE = /\}\s*[,;]?\s*$/;

  /**
   * 扫一份源码：把两类键位点登记进 `usedKeys` / `dynamicKeys`，查不出的记进 `unresolved`
   *
   * 单独收成一个函数，是为了让「键表状态机」本身可测——真实源码里今天没有一行式键表，
   * 收束判据写错也不会红，只有喂它一份合成源码才钉得住（见下面那条用例）。
   */
  const scanSource = (text: string, wherePrefix: string): void => {
    const lines = text.split('\n');
    let table: string | undefined;
    lines.forEach((line, index) => {
      const where = `${wherePrefix}:${index + 1}`;
      if (isCommentLine(line)) return;
      // 每个非注释行都先扫字面量：键表那套状态机不得顺手把这一格跳掉
      for (const [, key] of line.matchAll(LITERAL_CALL_RE)) checkKey(where, key);
      for (const [, key] of line.matchAll(KEY_PROPERTY_RE)) checkKey(where, key, dynamicKeys);
      if (table) {
        if (TABLE_CLOSE_RE.test(line)) table = undefined;
        else {
          for (const [, key] of line.matchAll(TABLE_VALUE_RE)) checkKey(`${where}（键表 ${table}）`, key, dynamicKeys);
          return;
        }
      }
      const opened = line.match(KEY_TABLE_RE);
      if (!opened) return;
      table = opened[1];
      // 同一行就写完的键表当场取值、当场收束：漏这一步，这张表会一路开着吞掉后面的
      // `x: 'y'` 行——扫进来的不是文案键，报出来的就是假红
      for (const [, key] of line.matchAll(TABLE_VALUE_RE)) checkKey(`${where}（键表 ${table}）`, key, dynamicKeys);
      if (TABLE_CLOSE_INLINE_RE.test(line.slice(line.indexOf('{') + 1))) table = undefined;
    });
  };

  for (const file of SOURCE_DIRS.flatMap(listSourceFiles)) {
    scanSource(fs.readFileSync(file, 'utf-8'), file);
  }

  it('扫描本身不是空转（正则一旦失配，下面的断言会假绿）', () => {
    expect(usedKeys.size).toBeGreaterThan(300);
    // 动态位点的精确数：模板卡 8 个 + 恢复点成因 5 个。钉死而不是给下界——两处写法一变
    // （改名、折行、去掉 `Record<>` 标注）就是整块漏扫，集合只会变小，而 `> 5` 这种阈值
    // 在只剩 8 个时照样绿，等于悄悄宣布自己还在守。正常新增一个位点也会红在这里：那时请
    // 连同本行一起改数，而不是把这条删掉。
    expect(dynamicKeys.size).toBe(13);
  });

  it('每个 key 都能在中英字典里找到，且文案非空（缺一个就会画出裸键名或空白）', () => {
    expect(unresolved).toEqual([]);
  });

  it("一行式键表当场收束，不吞紧随其后的 `x: 'y'` 行", () => {
    const before = unresolved.length;
    scanSource(
      [
        "const PROBE_KEYS: Record<'a', string> = { a: 'probeKeyShouldBeScanned' };",
        "const opts = { type: 'warning', placement: 'top' };",
        'const tail = 1;',
      ].join('\n'),
      'probe',
    );
    // 中英各报一条：既证明这张表当场就被扫到（否则「没吞后面两行」只是因为压根没扫），
    // 也证明第二行的 `type` / `placement` 没被当成文案键扫进来
    expect(unresolved.slice(before).sort()).toEqual([
      "probe:1（键表 PROBE_KEYS） 的 'probeKeyShouldBeScanned' 在 en 侧不存在",
      "probe:1（键表 PROBE_KEYS） 的 'probeKeyShouldBeScanned' 在 zh_CN 侧不存在",
    ]);
  });
});
