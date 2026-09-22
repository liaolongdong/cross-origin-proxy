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
 * 源码里 `t('key')` 用到的键必须真实存在于中英两侧字典。
 *
 * `t()` 未命中时**返回键名本身**，所以少一个键不会报错、不会红任何静态检查，
 * 只会把 `restorePointsTitle` 这样的英文标识直接画到界面上。这里只认字面量参数，
 * 动态拼出来的键（`t(prefix + name)`）扫不到，那一类仍只能靠界面自查。
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

  const dictionaries = (['zh_CN', 'en'] as const).map(locale => ({
    locale,
    keys: new Set(
      ['common', 'options', 'popup'].flatMap(ns => {
        const raw = JSON.parse(fs.readFileSync(`locales/${locale}/${ns}.json`, 'utf-8')) as Record<string, string>;
        return Object.keys(raw);
      }),
    ),
  }));

  const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/?\*|<!--)/.test(line);

  const usedKeys = new Set<string>();
  const unresolved: string[] = [];
  for (const file of SOURCE_DIRS.flatMap(listSourceFiles)) {
    fs.readFileSync(file, 'utf-8')
      .split('\n')
      .forEach((line, index) => {
        if (isCommentLine(line)) return;
        for (const [, key] of line.matchAll(/\bt\(\s*['"]([A-Za-z][\w.]*)['"]/g)) {
          usedKeys.add(key);
          for (const { locale, keys } of dictionaries) {
            if (!keys.has(key)) unresolved.push(`${file}:${index + 1} 的 '${key}' 在 ${locale} 侧不存在`);
          }
        }
      });
  }

  it('扫描本身不是空转（正则一旦失配，下面的断言会假绿）', () => {
    expect(usedKeys.size).toBeGreaterThan(300);
  });

  it('每个字面量 key 都能在中英字典里找到（缺一个就会画出裸键名）', () => {
    expect(unresolved).toEqual([]);
  });
});
