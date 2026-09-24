import { toRaw } from 'vue';

/**
 * 从规则数组里取出的那一条，是 Vue 的响应式 Proxy，不是普通对象。
 * 而 `structuredClone` 见到 Proxy 直接抛 `DataCloneError`——嵌套字段一旦被摸过，
 * 读出来的 `rule.methods` / `rule.headerOverrides` 同样是 Proxy。
 *
 * `toRaw()` 只剥最外层，但嵌套 Proxy 从来不会写回原始对象（Vue 把它们缓存在代理表里），
 * 所以拿到原始对象之后再深拷贝，就既不会再抛、也不会和原规则共享引用。
 *
 * 不用 `JSON.parse(JSON.stringify())`：规则里的可选字段以 `undefined` 显式存在，
 * JSON 会把它们整键抹掉，恢复点与副本的字段集就跟存储里的对不上。
 */
export function cloneRule<T extends object>(rule: T): T {
  return structuredClone(toRaw(rule) as T);
}
