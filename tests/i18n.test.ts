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
