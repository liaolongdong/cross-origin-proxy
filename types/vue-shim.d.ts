/**
 * Vue 单文件组件模块声明（`tsc --noEmit` 类型检查用）
 *
 * 为什么还需要它：`tsc` 认不了 `.vue`，`.ts` 里 `import App from './App.vue'`
 * 要有一个落点，所以这份 shim 把每个 `.vue` 声明成一个宽松的 `DefineComponent`。
 * 代价是 `pnpm typecheck` 只看得到「这个模块存在、它是个组件」，
 * `<script setup>` 块与模板表达式全都不进。
 *
 * 那半由 `pnpm typecheck:vue`（`vue-tsc`）负责，它会真正解析 `.vue`；
 * 两道都要跑，不要把 `typecheck` 单独通过写成 Vue 改动的证据。
 * 组件内部类型另有 IDE 的 Vue 语言服务保障。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
