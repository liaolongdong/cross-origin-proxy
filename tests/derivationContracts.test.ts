/**
 * 「派生出可用规则」这一批的源码契约（2026-10-19）
 *
 * 为什么这一批只有源码契约：本环境测不到 Vue 的渲染与交互（node 无 DOM，`jsdom` / `@vue/test-utils`
 * 未装），而这几格坏掉的表现全是**看不见**的——变量芯片把值画出来是凭据泄漏，同源提示挂到所有规则上
 * 是「警告多到没人看」，候选判据分家就是「保存时记了、下拉里没有」。所以按外部可观察面能钉的都在
 * `tests/recentTargets.test.ts`、`tests/urlMatcher.test.ts`、`tests/harImport.test.ts`、
 * `tests/storageLockCache.test.ts` 与 `tests/messageRouter.test.ts` 里，这里只钉那些只能读源码的接线。
 *
 * 每条断言都写成「改动会红」的形状：被钉的表达式若在某文件里有多个调用点，一律**数次数**，
 * 不然 `toContain` 只看得到第一处。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/**
 * 接线契约按「空白归一化后的源码」断言
 *
 * prettier 会把超长的表达式折行，而这里钉的是**接线**（谁调用谁、值从哪来），不是排版。
 * 用 `toContain` 卡原始文本会红在一次无关的换行上——那种红没有牙，只会教人跳过这条用例。
 */
const flat = (source: string) => source.replace(/\s+/g, ' ');

const ruleForm = fs.readFileSync('components/options/RuleFormDialog.vue', 'utf8');
const importExport = fs.readFileSync('components/options/ImportExportDialog.vue', 'utf8');
const optionsApp = fs.readFileSync('components/options/App.vue', 'utf8');
const recentTargets = fs.readFileSync('utils/recentTargets.ts', 'utf8');
const storage = fs.readFileSync('utils/storage.ts', 'utf8');

describe('凭据变量芯片 — 只出现名字，值从不进模板', () => {
  it('芯片的数据源是 `Object.keys(variables.value)`，全文件仅此一处', () => {
    expect(ruleForm.match(/Object\.keys\(variables\.value\)/g)).toHaveLength(1);
  });

  it('模板里不存在任何把变量值插出来的写法', () => {
    // 三种真会画出值的形式：按下标取值、整体 JSON 输出、把 entries 铺开
    expect(ruleForm).not.toMatch(/variables\.value\[[^\]]+\]/);
    expect(ruleForm).not.toContain('v-for="([name, value]) in');
    expect(ruleForm).not.toMatch(/<template[^>]*>\s*\{\{\s*value\s*\}\}/);
  });

  it('芯片渲染的是名字本身', () => {
    expect(ruleForm).toContain('v-for="name in variableNames"');
    expect(ruleForm).toMatch(/class="variable-chip"[\s\S]{0,160}\{\{ name \}\}/);
  });

  it('长连接规则的查询参数那一侧不提供芯片（那种组合保存时必被拒）', () => {
    expect(ruleForm).toContain('v-if="variableNames.length && !isWsRule"');
    expect(ruleForm).toContain('v-if="variableNames.length"');
  });
});

describe('同源提示 — 只挂在派生草稿上，且不作为保存闸门', () => {
  it('判据被 `derivedDraft` 与 `targetTouched` 双重限定，且只出现一处', () => {
    expect(ruleForm.match(/sameOriginNoRewrite\(/g)).toHaveLength(1);
    const guard = ruleForm.slice(ruleForm.indexOf('const showSameOriginHint'), ruleForm.indexOf('const suggestions'));
    expect(guard).toContain('props.derivedDraft === true');
    expect(guard).toContain('!targetTouched.value');
  });

  it('提示是文案，不进校验规则、不拦保存', () => {
    expect(ruleForm).toContain("{{ t('derivedSameTargetHint') }}");
    // targetUrl 的 rules 里只有格式校验（type: 'url'），没有为这句新增的 validator
    const targetRules = ruleForm.slice(
      ruleForm.indexOf('targetUrl: ['),
      ruleForm.indexOf(']', ruleForm.indexOf('targetUrl: [')),
    );
    expect(targetRules).not.toContain('derivedSameTargetHint');
    expect(targetRules).toContain("type: 'url'");
  });

  it('`targetTouched` 不由 watch 置真（预填自己就会写那个字段）', () => {
    expect(ruleForm).toContain('@input="targetTouched = true"');
    expect(ruleForm).not.toMatch(/watch\(\s*\(\)\s*=>\s*form\.targetUrl/);
  });
});

describe('目标环境候选 — 「保存侧记什么」与「界面列什么」同一份判据', () => {
  it('存储层与容器层都经 `distinctTargetOrigins` 取数', () => {
    expect(recentTargets).toContain('export function distinctTargetOrigins');
    expect(recentTargets.match(/distinctTargetOrigins\(/g) ?? []).toHaveLength(2);
    expect(flat(storage)).toContain('distinctTargetOrigins(saved)');
    expect(flat(optionsApp)).toContain('distinctTargetOrigins(rules.value)');
  });

  it('容器层的候选按同一个上限收口', () => {
    expect(flat(optionsApp)).toContain('.slice(0, MAX_RECENT_TARGETS)');
  });

  it('候选读失败只记日志——便利列表坏了不该在配置页冒错', () => {
    const loader = optionsApp.slice(
      optionsApp.indexOf('async function loadRecentTargets'),
      optionsApp.indexOf('\n}', optionsApp.indexOf('async function loadRecentTargets')),
    );
    expect(loader).toContain('logger.debug');
    expect(loader).not.toContain('ElMessage');
  });
});

describe('HAR 目标环境 — 非必填，且复选框不出现时不参与启用', () => {
  it('目标输入框存在，非法只标红这一格', () => {
    expect(importExport).toContain('v-model="harTargetOrigin"');
    expect(importExport).toContain(':error="harTargetInvalid"');
  });

  it('导入按钮的可用条件里没有目标环境——留空照样能按老方式导入', () => {
    const button = importExport.slice(importExport.indexOf('<el-button\n          v-if="harFileContent"'));
    expect(button.slice(0, 260)).not.toContain('disabled');
  });

  it('复选框只在读得出目标时出现，交给后台的意图由那个「在场」旗标兜住', () => {
    expect(flat(importExport)).toContain('v-if="harTargetValid" v-model="harEnableOnImport"');
    // 复选框不在场时恒为 false——「没出现」绝不能读成「用户没勾，但照样启用」
    expect(importExport).toMatch(
      /const harEnableOnImportFlag = computed\(\s*\(\)\s*=>\s*harTargetValid\.value && harEnableOnImport\.value/,
    );
    expect(flat(importExport)).toContain('enableOnImport: harEnableOnImportFlag.value');
  });

  it('目标随消息进后台，界面那份判据不是唯一一道', () => {
    expect(flat(importExport)).toContain('targetOrigin: harTargetParsed.value || undefined');
    expect(storage).not.toContain('targetOrigin');
  });

  it('三条派生出口都带 derived 标记（cURL 与「日志/本页」共用那两个入口），模板卡那条不带', () => {
    // 按字面量数调用点：被钉的表达式在文件里有两处，用 toContain 只看得到第一处
    expect(optionsApp.match(/, 'derived'\);/g)).toHaveLength(2);
    expect(optionsApp).toContain("derivedDraft.value = from === 'derived'");
    // 手动新增与编辑既有规则都不许带上这个标记（否则模板卡的合法自映射也吃警告）
    expect(optionsApp.match(/derivedDraft\.value = false;/g)).toHaveLength(2);
  });
});

/**
 * 批次三：HAR 凭据搬进变量表（默认不勾）
 *
 * 这一格钉的全是「静默就会有害」的形状：默认值从 false 翻成 true 是改变既有导入结果；
 * 严格判据松成 truthy 判断会让一个混进消息体的字符串偷偷改变产出；写失败被吞掉则界面
 * 说「导入成功」而规则里留下一批引用不存在的变量。判据本身在 `tests/harCredentialVars.test.ts`。
 */
describe('HAR 凭据搬家 — 默认不勾、严格判、失败不吞', () => {
  const router = fs.readFileSync('entrypoints/background/messageRouter.ts', 'utf8');

  it('界面那格的默认值是「不勾」，且勾上才多说一句为什么', () => {
    expect(importExport).toContain('const harRelocateCredentials = ref(false)');
    expect(importExport).toContain('v-model="harRelocateCredentials"');
    expect(importExport).toContain('v-if="harRelocateCredentials"');
  });

  it('后台只认严格 true，不勾时的分支一个字都不多写', () => {
    expect(flat(router)).toContain('if (message.data.relocateCredentials !== true) {');
    expect(flat(router)).toContain('relocateHarCredentialHeaders(rules, existing)');
  });

  it('写变量表失败既不能静默、也不能把规则交回界面', () => {
    expect(router).toContain("if (dropped > 0) throw new Error('VARIABLES_DROPPED')");
    // 合并写：整表覆盖的入口是 `saveVariables`，直接交新值就是抹掉用户已有凭据
    expect(flat(router)).toContain('await saveVariables({ ...existing, ...moved.variables })');
  });

  it('两个计数都进成功提示（搬了几个、装不下留了几个）', () => {
    expect(flat(optionsApp)).toContain("t('importHarSuccessRelocated', [relocated])");
    expect(flat(optionsApp)).toContain("t('importHarSuccessKeptRaw', [keptRaw])");
  });
});

/**
 * 批次二：日志转 Mock 的接线
 *
 * 这里只钉三件「看不见」的事：判据只有一个出口、五种拒绝的文案都是字面量 key、草稿走表单
 * 而不是自己写存储。判据本身（哪五档、形状长什么样）由 `tests/mockFromLog.test.ts` 按运行时测。
 */
describe('日志转 Mock — 判据唯一出口与文案分档', () => {
  const logDrawer = fs.readFileSync('components/options/LogDrawer.vue', 'utf8');

  it('组件只调一次判据，自己不造第二份理由', () => {
    expect(flat(logDrawer).match(/buildMockDraftFromLog\(/g)).toHaveLength(1);
    // 采纳的那一句必须是「整份交给判据」，不能在界面侧再补一个三元
    expect(flat(logDrawer)).toContain(
      'const mockDraft = computed(() => (selectedLog.value ? buildMockDraftFromLog(selectedLog.value) : null))',
    );
    // 界面不许自己拼拒绝理由（那等于在判据之外长出第二种「为什么不能」）
    expect(logDrawer).not.toMatch(/reason:\s*'/);
    expect(logDrawer).not.toMatch(/\{\s*ok:\s*false/);
  });

  it('五档拒绝各是一个字面量 key（动态拼 key 会躲过 i18n 那条存在性守卫）', () => {
    for (const key of ['NoBody', 'NoStatus', 'Base64', 'Truncated', 'BadUrl']) {
      expect(logDrawer).toContain(`t('mockFromLog${key}')`);
    }
    // 注意这里扫的是「拼出来的那种写法」，被测文件里的注释已改成不含该形状的说法
    expect(logDrawer).not.toMatch(/t\(\s*`/);
  });

  it('三条边界句只在按钮出现的那一支里', () => {
    const notes = logDrawer.slice(
      logDrawer.indexOf('v-if="mockDraft?.ok"'),
      logDrawer.indexOf('log-detail-mock-refuse'),
    );
    for (const key of ['mockFromLogQueryNote', 'mockFromLogScopeNote', 'mockFromLogBodyNote']) {
      expect(notes).toContain(`t('${key}')`);
    }
    expect(notes).not.toContain('mockFromLogNoBody');
  });

  it('草稿交规则表单确认，组件自己一个字节都不写存储', () => {
    expect(flat(optionsApp)).toContain('handleUseTemplate(draft)');
    expect(logDrawer).not.toContain('BATCH_ADD_RULES');
    expect(logDrawer).not.toContain('ADD_RULE');
    expect(logDrawer).not.toContain('saveProxyConfig');
  });
});

describe('HAR 面板的确认按钮 — 不得复用「导入配置」那枚标签（2026-10-19 真机量出来的）', () => {
  // 这一格是本轮在真 Chrome 里点出来的：HAR 段那颗确认按钮写着 `importButton`（中文「导入配置」），
  // 而它做的是「从抓包创建规则」。同一弹窗里两颗按钮同名、其中一颗还说错自己干什么，
  // 用户按标签找入口就会点错——渲染与文案都不报错，只有读过界面的人才会发现。
  it("`t('importButton')` 在整个弹窗里只出现一次（配置导入那一节）", () => {
    expect(importExport.match(/t\('importButton'\)/g)).toHaveLength(1);
  });

  it('HAR 段用专属标签，且仍由 `harFileContent` 决定出不出', () => {
    expect(importExport).toContain("t('importHarCreateRules')");
    const harButton = importExport.slice(
      importExport.indexOf('v-if="harFileContent"'),
      importExport.indexOf('importHarCreateRules'),
    );
    expect(harButton).toContain('@click="handleImportHar"');
  });

  it('中英两侧的专属标签都不与「导入配置 / Import」同字', () => {
    const zhLabels = JSON.parse(fs.readFileSync('locales/zh_CN/options.json', 'utf8'));
    const enLabels = JSON.parse(fs.readFileSync('locales/en/options.json', 'utf8'));
    expect(zhLabels.importHarCreateRules).not.toBe(zhLabels.importButton);
    expect(enLabels.importHarCreateRules).not.toBe(enLabels.importButton);
    expect(zhLabels.importHarCreateRules).toContain('HAR');
    expect(enLabels.importHarCreateRules).toContain('HAR');
  });
});
