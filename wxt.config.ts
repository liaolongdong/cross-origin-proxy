import { defineConfig } from 'wxt';
import path from 'path';
import { fileURLToPath } from 'url';
import Components from 'unplugin-vue-components/vite';
import AutoImport from 'unplugin-auto-import/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  dev: {
    server: {
      port: 8899,
    },
  },
  vite: () => ({
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      minify: 'esbuild',
    },
    // 只 drop debugger，不要 drop console：实测 `drop: ['console']` 会让
    // .output/chrome-mv3 里的 console.* 归零（dev 包 39 处），连带把
    // logger.warn/error 一起编译掉——而 DNR 同步被整批拒绝、非 RE2 正则被跳过、
    // ReDoS 规则被跳过这几类故障**只有**这些告警这一个信号源。
    // 一个以“帮用户看清请求为什么没走代理”为卖点的工具不该在生产包里静默。
    // logger.debug/info 已由 `import.meta.env.DEV` 门控，生产会被摇掉，无需靠 drop。
    esbuild: process.env.NODE_ENV === 'production' ? { drop: ['debugger' as const] } : {},
    plugins: [
      AutoImport({
        imports: ['vue', { 'element-plus': ['ElMessage', 'ElMessageBox'] }],
        resolvers: [ElementPlusResolver({ importStyle: 'css' })],
        dts: '.wxt/auto-imports.d.ts',
      }),
      Components({
        resolvers: [ElementPlusResolver({ importStyle: 'css' })],
        // 这份 GlobalComponents 注册表刻意写到入库的 `types/`，而不是 `.wxt/`：
        // 它只由 dev/build 生成（`wxt prepare` 不产出），而 `pnpm typecheck:vue` 在 CI 里
        // 排在 Build 之前——放在 `.wxt/` 就等于「干净检出时那份注册表不存在」，于是 `el-*`
        // 的 prop 取值与 emit 签名对门禁是隐形的（它只看得见自己声明过的类型）。
        // 放回 `.wxt/` 再靠 tsconfig 的通配命中也不行：那是点目录，实测通配进不去，
        // 只能按名字点名——也就是把门禁挂在一个 CI 此刻还没有的文件上。
        // 生成物，不要手改：改完模板里的 `<el-*>` 跑一次 `pnpm build` 让它同步；
        // 漏跑由 `tests/elementComponents.test.ts` 当场点名（它按模板里用到的 `el-*` 对账）。
        dts: 'types/components.d.ts',
      }),
    ],
  }),
  manifest: {
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    default_locale: 'zh_CN',
    // 版本号不要在这里声明：唯一事实源是 `package.json` 的 `version`，WXT 会取它并
    // 削去预发布后缀（见 wxt/dist/core/utils/manifest.mjs）。双写必然漂移，而漂移的
    // 代价是带错版本号的包进商店；`tests/build-verification.test.ts` 守卫两者一致。
    permissions: ['storage', 'declarativeNetRequest', 'declarativeNetRequestFeedback', 'alarms'],
    host_permissions: ['<all_urls>'],
    // 注意：不要在此声明 `action.default_title`。WXT 会用 popup 入口 HTML 的 `<title>`
    // 覆盖它（见 wxt/dist/core/utils/manifest.mjs），写在这里属于无效配置。
    // 工具栏悬停提示的短名因此统一由 `entrypoints/popup/index.html` 的
    // `<title>__MSG_extensionShortName__</title>` 决定，并由构建产物测试守卫。
    commands: {
      'toggle-proxy': {
        suggested_key: {
          default: 'Ctrl+Shift+P',
          mac: 'Command+Shift+P',
        },
        description: '__MSG_commandToggleProxy__',
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
