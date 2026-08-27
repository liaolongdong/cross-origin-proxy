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
    esbuild: process.env.NODE_ENV === 'production' ? { drop: ['console', 'debugger'] } : {},
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
    version: '1.0.0',
    permissions: [
      'storage',
      'declarativeNetRequest',
      'declarativeNetRequestFeedback',
      'alarms',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: '__MSG_extensionName__',
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
