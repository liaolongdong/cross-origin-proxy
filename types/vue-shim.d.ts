/**
 * Vue 单文件组件模块声明（tsc --noEmit 类型检查用）
 *
 * 说明：项目未引入 vue-tsc，tsc 无法解析 .vue 模块，
 * 此 shim 让 .ts 入口对 .vue 的 import 可通过类型检查；
 * 组件内部类型由 IDE 的 Vue 语言服务保障。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
