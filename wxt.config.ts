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
        dts: '.wxt/components.d.ts',
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
