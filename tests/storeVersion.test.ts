/**
 * 「商店在装版本」的对外账守卫
 *
 * 产品站上有九处写着商店当前在装的版本：两页 JSON-LD 的 `softwareVersion`、四页页脚的版本徽标、
 * `llms.txt` 的页脚、`llms-full.txt` 的头部核对行与页脚。它们说的是**商店已经吃到的那一包**，
 * 不是 `package.json` 里正在开发的号，也不是 GitHub 最新 tag——`.github/docs/RELEASING.md` §2.2
 * 为此把「推 tag」与「商店吃到包」拆成两次翻。
 *
 * 2026-10-27 实测：商店在架 v1.6.0，而九处全停在 1.5.1。这类漂移已经发生过两次（1.3.0 那次
 * 记在项目记忆里），失败形状都是「只翻了其中几处」——所以本轮把版本收进 `store-version.json`，
 * 由本文件逐处对账：少翻一处当场点名，且报出文件与位置。
 *
 * 挡不住的边界：九处**一起**忘了翻（常量自己也停在旧号）。那要靠 `RELEASING.md` §2.2 的人工步骤，
 * 本文件不联网、也不读 shields。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

interface StoreVersionRecord {
  version: string;
  verifiedAt: string;
}

const record = JSON.parse(read('store-version.json')) as StoreVersionRecord;
const MARKETING_PAGES = ['docs/index.html', 'docs/en.html', 'docs/alternatives.html', 'docs/en-alternatives.html'];

interface Reading {
  file: string;
  label: string;
  value: string;
}

/** 按页面顺序收集九处读数；每一处的正则都只认写死的那种形状，不扫正文里的版本词。 */
function collectReadings(): Reading[] {
  const readings: Reading[] = [];

  for (const file of ['docs/index.html', 'docs/en.html']) {
    for (const match of read(file).matchAll(/"softwareVersion":\s*"([^"]+)"/g)) {
      readings.push({ file, label: 'JSON-LD softwareVersion', value: match[1] });
    }
  }

  for (const file of MARKETING_PAGES) {
    for (const match of read(file).matchAll(/<span>v(\d+\.\d+\.\d+)<\/span>/g)) {
      readings.push({ file, label: '页脚版本徽标', value: match[1] });
    }
  }

  for (const match of read('docs/llms.txt').matchAll(/store build v(\d+\.\d+\.\d+)/g)) {
    readings.push({ file: 'docs/llms.txt', label: '页脚', value: match[1] });
  }

  // llms-full.txt 的两处一处带括号、一处嵌在长句里，形状不同；这里按「文件里出现的所有版本串」
  // 收，数量一变就说明多出了第十处对外账（或删掉了一处），两种都该回来重判。
  for (const match of read('docs/llms-full.txt').matchAll(/v(\d+\.\d+\.\d+)/g)) {
    readings.push({ file: 'docs/llms-full.txt', label: '版本引用', value: match[1] });
  }

  return readings;
}

describe('store-version.json：商店在装版本的单一事实源', () => {
  it('形状合法', () => {
    expect(record.version, 'version 必须是三段式数字').toMatch(/^\d+\.\d+\.\d+$/);
    expect(record.verifiedAt, 'verifiedAt 必须是 YYYY-MM-DD').toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('九处读数全部等于单一事实源', () => {
    const readings = collectReadings();
    expect(
      readings.length,
      `应读到九处（两页 JSON-LD、四页页脚、llms.txt 页脚、llms-full.txt 两处），实际 ${readings.length} 处`,
    ).toBe(9);

    const stale = readings
      .filter(reading => reading.value !== record.version)
      .map(reading => `${reading.file} · ${reading.label} = ${reading.value}`);
    expect(stale, `以下位置落后于商店在装版本 v${record.version}：\n${stale.join('\n')}`).toEqual([]);
  });

  it('每一页的版本位不会重复或缺失', () => {
    for (const file of ['docs/index.html', 'docs/en.html']) {
      const count = [...read(file).matchAll(/"softwareVersion":\s*"([^"]+)"/g)].length;
      expect(count, `${file} 应恰好有一处 softwareVersion`).toBe(1);
    }
    for (const file of MARKETING_PAGES) {
      const count = [...read(file).matchAll(/<span>v(\d+\.\d+\.\d+)<\/span>/g)].length;
      expect(count, `${file} 应恰好有一枚页脚版本徽标`).toBe(1);
    }
  });

  it('CHANGELOG 里存在这个版本的小节', () => {
    const escaped = record.version.replace(/\./g, '\\.');
    expect(
      read('CHANGELOG.md'),
      `对外声称 v${record.version}，但 CHANGELOG 没有 \`## [${record.version}]\` 小节`,
    ).toMatch(new RegExp(`^## \\[${escaped}\\]`, 'm'));
  });
});
