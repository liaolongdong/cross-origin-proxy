/**
 * 按钮层级与动作区形状：把「该点哪一颗」收成一份可核对的账
 *
 * 这一面在 node 环境没有渲染对应物（无 jsdom / `@vue/test-utils`），所以全部按源码契约钉。
 * 钉的不是审美，是三类会静默复发的事：
 * ① 有人把 `el-button` 的 `type` 当「动作类别色带」用（success=生成、warning=选文件），
 *    于是同一屏出现四种档位、数不出主行动——`ImportExportDialog` 与 `LogDrawer` 都曾是这样；
 * ② popup 加一颗新按钮、选了一个 options 没有的 hash——点了什么也不会发生，且没有任何报错；
 * ③ 动作区的形状（几张卡、哪张在第一、次级动作有没有又长回一行）——本轮把它按「离用户的手多近」
 *    重排过，并与同期进 main 的两列宫格合流成「七张卡一档」；没有守卫的话，下一次加功能默认会
 *    继续往上堆卡片或另起一行，而不是想清楚它排第几。
 *
 * 例外两处，形状写死在断言里而不是靠注释：`link` 档的按钮可以带 `type`，因为它承担的只是色相
 * （全仓现存两枚：规则表单「收起测试面板」、设置页「回退这一份恢复点」）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const popup = readFileSync('entrypoints/popup/App.vue', 'utf8');
const optionsApp = readFileSync('components/options/App.vue', 'utf8');
const importExport = readFileSync('components/options/ImportExportDialog.vue', 'utf8');

/** 摸出目录树里所有 `.vue`（跳过软链与本地工作树残留） */
function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) return [];
    return statSync(path).isDirectory() ? vueFiles(path) : path.endsWith('.vue') ? [path] : [];
  });
}

const allVue = [...vueFiles('components'), ...vueFiles('entrypoints')];

/** 抽出一个文件里所有 `<el-button ...>` 起始标签（含跨行属性） */
function buttonTags(src: string): string[] {
  return [...src.matchAll(/<el-button\b[\s\S]*?>/g)].map(m => m[0]);
}

/** 去掉注释再比形状，免得一条解释性注释把断言顶红 */
function templateOf(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from);
  if (from === -1 || to === -1) throw new Error(`区块锚点没找到：${start} / ${end}`);
  return src.slice(from, to);
}

describe('档位：type 只表达层级，不表达动作类别', () => {
  it('全仓 el-button 的 success / warning / info 只准待在 link 档上（实心按钮的类别色就是第四档主行动）', () => {
    const offenders = allVue.flatMap(file =>
      buttonTags(readFileSync(file, 'utf8'))
        .filter(tag => /type="(success|warning|info)"/.test(tag) && !/\blink\b/.test(tag))
        .map(tag => `${file}: ${tag.replace(/\s+/g, ' ')}`),
    );
    expect(offenders).toEqual([]);
  });

  it('link 档的色相全仓恰好两枚（多一枚就是有人在重新发明色带）', () => {
    const hues = allVue.flatMap(file =>
      buttonTags(readFileSync(file, 'utf8'))
        .filter(tag => /type="(success|warning|info)"/.test(tag))
        .map(tag => `${file}|${tag.replace(/\s+/g, ' ').slice(0, 40)}`),
    );
    expect(hues).toHaveLength(2);
  });

  it('导入导出弹窗：六节各留一颗实心主行动，选文件那三颗退回无型，预览那颗只留色相', () => {
    const tags = buttonTags(importExport);
    expect(tags).toHaveLength(10);
    expect(tags.filter(t => /type="primary"/.test(t) && !/\blink\b/.test(t))).toHaveLength(6);
    expect(tags.filter(t => /type="primary"/.test(t) && /\blink\b/.test(t))).toHaveLength(1);
    expect(tags.filter(t => !/type="/.test(t) && !/:type=/.test(t))).toHaveLength(3);
  });

  it('日志详情那四颗是平行动作：同容器同档位、一律带图标', () => {
    const drawer = readFileSync('components/options/LogDrawer.vue', 'utf8');
    const block = templateOf(drawer, '<div class="log-detail-actions"', '</div>');
    const tags = buttonTags(block);
    // 数的是「四颗平行动作」这一件事本身，所以钉死到 4：写 >=3 时摘掉关闭那颗照样绿
    expect(tags.length, '创建规则 / 存为 Mock / 复制为 cURL / 关闭').toBe(4);
    expect(
      tags.every(t => /:icon="/.test(t)),
      '这一格的图标要么全带要么全不带',
    ).toBe(true);
    expect(
      tags.every(t => !/type="(primary|success|warning)"/.test(t)),
      '平行动作没有主行动',
    ).toBe(true);
    expect(block, '手摆间距的内联 style 已被 :icon 取代').not.toContain('margin-right: 4px');
  });
});

describe('弹窗 footer：主行动永远在最右', () => {
  for (const file of ['components/options/RuleFormDialog.vue', 'components/options/MigrateTargetsDialog.vue']) {
    it(`${file} 的第一个是取消、最后一个是 primary`, () => {
      const footer = templateOf(readFileSync(file, 'utf8'), '<template #footer>', '</template>');
      const tags = buttonTags(footer);
      expect(tags.length, 'footer 至少一取消一主行动').toBeGreaterThanOrEqual(2);
      expect(/type="primary"/.test(tags.at(-1) ?? ''), '主行动排到了倒数第二位之后').toBe(true);
      expect(/type="primary"/.test(tags[0]), '取消那颗不该带档位').toBe(false);
    });
  }

  it('popup 的环境快照确认块同一条次序：取消在左、切换在右', () => {
    const block = templateOf(popup, '<div class="profile-confirm-actions">', '</div>');
    expect(block.indexOf("t('cancel')"), '取消排在主行动之前').toBeLessThan(block.indexOf('profilePickerApply'));
  });
});

describe('popup → options 的出口', () => {
  const router = (() => {
    const start = optionsApp.indexOf('function handleHashNavigation');
    return optionsApp.slice(start, optionsApp.indexOf('\n}\n', start));
  })();

  it('弹窗里用到的每一个 hash，options 的分派必须有对应分支（否则点了没反应、且无声）', () => {
    // 实参既可能是普通字符串 '#logs'，也可能是模板串 `#add-rule-from-tab=${…}`：
    // 只认引号那一种，模板串那条出口就整个从这条守卫眼前溜走（本轮实测漏过一次）
    const hashes = [...popup.matchAll(/openOptionsPage\(\s*['`]#([a-z-]+)/g)].map(m => m[1]);
    expect(hashes.length, '一个 hash 都没抓到＝正则或写法变了，本用例失去意义').toBeGreaterThan(0);
    // 按「引号 + #hash」这个前缀对账，不带收尾引号：分派里 `startsWith('#add-rule-from-tab=')`
    // 那种分支也要算对上
    for (const hash of new Set(hashes)) {
      expect(router.includes(`'#${hash}`), `options 不认 #${hash}`).toBe(true);
    }
  });

  it('#settings 这一格是本轮补的：弹窗此前没有通往设置的路', () => {
    expect(router, 'options 分派里没有 #settings').toContain("hash === '#settings'");
    expect(popup).toContain("openOptionsPage('#settings')");
  });
});

describe('popup 动作区的形状', () => {
  const actionList = templateOf(popup, '<div class="action-list">', '\n    <!-- 最近请求');

  it('两列宫格七张卡，第一张是环境配置（切环境是这个扩展最勤的动作）', () => {
    const cards = [...actionList.matchAll(/class="action-card"/g)];
    expect(cards, '动作区的卡数变了：新增入口要回来把这一格与 AGENTS 的档位表一起改').toHaveLength(7);
    expect(actionList).toContain('@click="handleProfilesCard"');
    const order = ['handleProfilesCard', 'handleCreateRuleFromTab', 'openOptionsPage()'];
    const at = order.map(name => actionList.indexOf(name));
    at.forEach((index, i) => expect(index, `第 ${i + 1} 颗找不到 "${order[i]}"`).toBeGreaterThan(-1));
    expect(at[0] < at[1] && at[1] < at[2], '顺序不再是「离手多近」：环境配置 → 为当前页 → 规则管理').toBe(true);
    expect(actionList, '规则管理那张不许再指向添加弹窗').toContain('openOptionsPage()');
    expect(actionList).not.toContain("openOptionsPage('#add-rule')");
  });

  it('七个入口都在卡里，且每一颗都有能落地的 hash', () => {
    for (const [key, handler] of [
      ['actionProfiles', 'handleProfilesCard'],
      ['actionCreateRuleFromTab', 'handleCreateRuleFromTab'],
      ['actionOpenConfig', 'openOptionsPage()'],
      ['actionViewLogs', "openOptionsPage('#logs')"],
      ['actionImportExport', "openOptionsPage('#import-export')"],
      ['actionSettings', "openOptionsPage('#settings')"],
      ['actionSelfCheck', 'openOptionsPage(selfCheckHash)'],
    ] as const) {
      expect(actionList, `动作区少了 ${key}`).toContain(`t('${key}')`);
      expect(actionList, `${key} 的动作变了`).toContain(handler);
    }
    // 图标按容器走：七颗卡全带，少一颗就是「同一容器两种形状」
    expect(actionList.match(/<el-icon>/g), '动作卡的图标不是全带就是全不带').toHaveLength(7);
  });

  it('次级那一行已经收进宫格： markup 与 CSS 都不许留尸', () => {
    expect(popup, '.action-bar 的 markup 还在，说明有两套动作区形状并存').not.toContain('class="action-bar"');
    expect(popup, '.action-bar 的样式还在（死代码）').not.toContain('.action-bar {');
  });

  it('宫格是两列、卡里的描述改作 title 悬停（宫格宽度放不下第二行）', () => {
    const css = templateOf(popup, '.action-list {', '\n.action-card {');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(popup).toMatch(/\.action-card__content \{[\s\S]*?\}/);
    expect(actionList, '卡片里又长出第二行文字：那会把「最近请求」重新挤出首屏').not.toContain('action-card__desc');
    // 五张「有话说得清」的卡各带一条 `title`（第六、七颗只有标签本身，没有第二句可给）；
    // 数的是 `:title="t('action`，两块内联面板里那些 `:title` 说的是别的事，不能一起算
    expect(actionList.match(/:title="t\(\x27action/g), '描述行改作悬停提示这件事被回退了').toHaveLength(4);
  });

  it('自动关闭那五格有折行兜底（文案不可收缩，没有 wrap 就是挤压）', () => {
    expect(popup).toMatch(/\.auto-off-chips \{[\s\S]*?flex-wrap: wrap;/);
    expect(popup).toMatch(/\.auto-off-chip \{[\s\S]*?min-width: 52px;/);
  });
});

describe('层级表住在文档里', () => {
  it('AGENTS.md 有一份按钮层级表（规则不能只活在测试里）', () => {
    expect(readFileSync('AGENTS.md', 'utf8')).toContain('按钮层级表');
  });
});
