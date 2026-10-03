/**
 * Element Plus 组件注册表的在岗状态（`el-*` 的 prop 值与 emit 签名怎么被 `typecheck:vue` 看见的）
 *
 * 需要这支测试的原因：`pnpm typecheck:vue` 只认它在 tsconfig 里读得到的类型。那份由
 * `unplugin-vue-components` 生成的 `GlobalComponents` 注册表以前落在 `.wxt/`——`wxt prepare`
 * 不产出它（只有 dev/build 生成）、又被 gitignore，而 CI 的校验清单里 Build 排在 Typecheck Vue
 * **之后**，于是干净检出时那一格根本不存在：`el-tag` 的 `type` 传了类型联合外的值、`el-switch`
 * 的 `change` 实参宽窄、`el-table` 插槽的 `row` 到底是不是 `ProxyRule`，全都不报错（写错也静默）。
 * 现在注册表写到入库的 `types/components.d.ts`，它被 tsconfig 的 include 通配收进来，门禁够得着了。
 *
 * 顺带量到一件支撑这个设计的事：tsconfig 的 include 通配（那条「两级 `**` 加 `.ts`」）**进不去点目录**
 * （2026-10-03 探针实测——
 * 往 `.wxt/` 里放一个 `.ts` 文件，`--listFiles` 里查不到它；`.wxt/wxt.d.ts` 与
 * `.wxt/auto-imports.d.ts` 之所以在程序里，是因为它们被 `include` **按名字**点名，
 * `.wxt/types/*.d.ts` 那几份则由 `wxt.d.ts` 引用带进来）。所以「把注册表放回 `.wxt/`
 * 再靠通配命中」这条路根本不存在，只能显式点名——而显式点名就是 CI 会红的那种写法。
 * 反过来看，这一条也保证了本地残留的旧 `.wxt/components.d.ts` 不会和第二份注册表合并成
 * 两个 `GlobalComponents`，我机器上的结果与干净检出的是同一份。
 *
 * 这里钉五件事：
 *
 * 1. **注册表在库里、被 git 跟踪、`wxt.config.ts` 把它写到那儿**，且 `.prettierignore` 收了它
 *    （生成物不是 prettier 口径的，漏掉那一行就是「每次 `pnpm build` 之后 `format:check` 红」）。
 * 2. **模板里用到的每个 `<el-*>` 都在注册表里**——有人加了新组件却忘了跑 `pnpm build` 时，
 *    红字直接点名缺的那几个，而不是让 `typecheck:vue` 安静地什么也没查。
 * 3. 反方向也钉：注册表里不许留「模板已经不用了」的条目（同一件事的另一半，同样由 build 修）。
 * 4. `tsconfig.json` 不许把 `.wxt/components.d.ts` 加回 `include`——门禁不能挂在一个 CI
 *    走到的那一步还不存在的文件上（那正是本轮要换掉的写法）。
 * 5. 前四件事的自检：注册表解析出的条目数非 0、无重名、模板扫描非空、每条都指向
 *    `'element-plus/es'`。少这一条，前面四支里任何一支的解析口径坏掉都会变成「空对空，全绿」。
 *
 * 牙口实测（各删注册表一行、只改这一处）：删 `ElCarousel` → 1 红，红字点名 `ElCarousel`；
 * 删 `ElTable` → 1 红，红字点名 `ElTable`。两轮其余用例照旧全绿，说明它不是「一红全红」。
 *
 * **已知拦不住的那一面**：把 prop 的**名字**写错（`disable-transitions` 少写一个 `s`）照样绿。
 * Vue 允许属性透传，这个检查要 `vueCompilerOptions.strictTemplates` 才有，而 2026-10-03 实测开它
 * 全仓涌出 45 条，其中 8 条是 `aria-label` / `spellcheck` / `tabindex` / `@keydown` 这类**刻意透传**
 * 的写法（日志抽屉的整张表格就是靠 `tabindex` + `@keydown` 变成键盘焦点位的），只能靠放宽类型或
 * 改行为去「修」；剩下的 `el-input-number` 的 `number | undefined` 之类同样是改语义的活。
 * 所以那一档刻意不开，见 AGENTS.md「项目特有约定」。值的类型、emit 的签名、插槽实参的形状，
 * 这一档是真有牙的：本轮就是靠它照出 popup 两处 `el-tag :type` 交的是空串。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'node:fs';

const REGISTRY = 'types/components.d.ts';
const registrySrc = readFileSync(REGISTRY, 'utf-8');
const wxtConfigSrc = readFileSync('wxt.config.ts', 'utf-8');
const tsconfigSrc = readFileSync('tsconfig.json', 'utf-8');
const prettierIgnoreSrc = readFileSync('.prettierignore', 'utf-8');

/** 只扫这两个目录，和 `accessibleNames.test.ts` 同一口径：`.test-tmp/` 里的历史副本不算模板 */
const vueFiles = ['components', 'entrypoints']
  .flatMap(dir => (readdirSync(dir, { recursive: true }) as unknown as string[]).map(f => `${dir}/${f}`))
  .filter(f => f.endsWith('.vue'));

/**
 * 注册表里声明的组件名（`ElAlert: typeof import('element-plus/es')['ElAlert']`）。
 *
 * 按「行首缩进 + `El` 打头 + 冒号」取，避开文件头那些注释；`GlobalDirectives` 里的
 * `vLoading` 不以 `El` 开头，天然不落进这个集合。
 */
const registeredNames = [...registrySrc.matchAll(/^\s*(El[A-Za-z0-9]+):\s*typeof import\(/gm)].map(m => m[1]);

/** 取 SFC 的 `<template>` 正文并剥掉 HTML 注释：注释里的 `<el-xxx>` 不是用法 */
function templateBody(src: string): string {
  const open = src.indexOf('<template');
  if (open === -1) return '';
  const close = src.lastIndexOf('</template>');
  return src.slice(src.indexOf('>', open) + 1, close === -1 ? undefined : close).replace(/<!--[\s\S]*?-->/g, '');
}

/** kebab 标签名 → 注册表里的 PascalCase 名（`el-input-number` → `ElInputNumber`） */
const toPascal = (tag: string): string =>
  tag
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

/**
 * 模板里真正用到的 `el-*` 组件名。
 *
 * 两种书写都收：`<el-tag` 与 `<ElTag`（resolver 对这两种都认）。边界用 `[^\w-]` 而不是 `\b`——
 * `-` 不是单词字符，`\bel-tag\b` 会在 `<el-tag-column` 那种前缀上误命中。
 */
const usedNames = new Set<string>();
for (const file of vueFiles) {
  const body = templateBody(readFileSync(file, 'utf-8'));
  for (const m of body.matchAll(/<el-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w-])/g)) {
    usedNames.add(toPascal(m[0].slice(1)));
  }
  for (const m of body.matchAll(/<El[A-Za-z0-9]+(?![\w-])/g)) {
    usedNames.add(m[0].slice(1));
  }
}

describe('Element Plus 组件注册表（typecheck:vue 的那一格类型盲区）', () => {
  it('注册表落在入库的 types/，而不是只有 dev/build 才存在的 .wxt/', () => {
    expect(wxtConfigSrc, 'Components() 的 dts 必须指向 types/components.d.ts').toContain(`dts: '${REGISTRY}'`);
    expect(wxtConfigSrc, '回到 .wxt/ 就是重新关掉这一格门禁').not.toContain('.wxt/components.d.ts');

    const tracked = execFileSync('git', ['ls-files', '-z', REGISTRY], { encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(tracked, `${REGISTRY} 必须提交进 git：CI 干净检出时它得已经在那儿`).toEqual([REGISTRY]);

    // 生成物不是 prettier 口径（行尾无分号、`/* prettier-ignore */` 只护住那一段），
    // 不收进 .prettierignore 的话，每次 pnpm build 都把 format:check 弄红。
    expect(
      prettierIgnoreSrc
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#')),
      `${REGISTRY} 要在 .prettierignore 里`,
    ).toContain(REGISTRY);
  });

  it('tsconfig 不把 .wxt/components.d.ts 加回 include', () => {
    expect(tsconfigSrc, '注册表由 types/ 那份入库的命中 **/*.ts；再引 .wxt/ 就是挂到 CI 走不到的文件上').not.toContain(
      '.wxt/components.d.ts',
    );
  });

  it('模板用到的每个 <el-*> 都在注册表里', () => {
    const registered = new Set(registeredNames);
    const missing = [...usedNames].filter(name => !registered.has(name)).sort();
    expect(
      missing,
      `这些 el-* 组件在模板里用了、注册表却没有：${missing.join(', ')}。跑一次 pnpm build 重新生成 ${REGISTRY} 并提交`,
    ).toEqual([]);
  });

  it('注册表里没有模板已经不用了的条目', () => {
    const stale = registeredNames.filter(name => !usedNames.has(name)).sort();
    expect(
      stale,
      `这些 el-* 组件模板里已经不用了、注册表还留着：${stale.join(', ')}。跑一次 pnpm build 重新生成 ${REGISTRY} 并提交`,
    ).toEqual([]);
  });

  it('注册表非空，且每条都指向 element-plus/es（守卫不是在空转）', () => {
    expect(registeredNames.length, '注册表解析出 0 条，这两支对账等于空转').toBeGreaterThan(0);
    expect(new Set(registeredNames).size, '注册表出现重名条目：解析口径和生成器对不上了').toBe(registeredNames.length);
    expect(usedNames.size, '模板里一个 el-* 都没扫到：扫描口径（目录、<template> 边界、注释剥离）坏了').toBeGreaterThan(
      0,
    );
    const wrongSource = [...registrySrc.matchAll(/^\s*(El[A-Za-z0-9]+):\s*typeof import\(([^)]*)\)/gm)].filter(
      m => !m[2].includes("'element-plus/es'"),
    );
    expect(
      wrongSource.map(m => m[1]),
      '注册表应当全部来自 element-plus/es',
    ).toEqual([]);
  });
});
