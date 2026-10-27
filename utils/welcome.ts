/**
 * 首装欢迎卡的可见性判据
 *
 * 唯一出口：组件自己不判、`App.vue` 只把三个读数喂进来。`dismissed` 刻意是三态而不是布尔——
 * `null` 表示「这一次打开页面后还没读到关闭标记」：那一刻既不能画（关过卡的老用户会先看到
 * 它再被抹掉，闪一下），也不能当成「没关过」（关闭动作会在下一次打开时失效）。
 *
 * `everRead` 为假时整卡不画：首屏那次 `GET_PROXY_CONFIG` 还在路上、或第一次就读失败，
 * 都不该把「还在读 / 读不到」画成「你需要引导」。用户建出第一条规则后卡自然消失，
 * 不需要额外置位——所以这里只看 `rulesCount === 0`。
 */
export interface WelcomeVisibilityInput {
  /** 这一次打开页面后是否至少成功读到过一次配置 */
  everRead: boolean;
  /** 当前持有的规则条数 */
  rulesCount: number;
  /** `null` = 还没读到关闭标记；`false` = 没关过；`true` = 关过 */
  dismissed: boolean | null;
}

export function shouldShowWelcome(input: WelcomeVisibilityInput): boolean {
  return input.everRead && input.rulesCount === 0 && input.dismissed === false;
}
