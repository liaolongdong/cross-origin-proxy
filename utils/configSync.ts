/**
 * 「这一页收到最新配置了吗」的回执形状（界面侧唯一的判据入口）
 *
 * 与 `utils/interceptorStats.ts`、`utils/dnrSample.ts` 同一类适配器：把 SW 读端可能给出的
 * 任意载荷收窄成界面能直接用的判断。这里刻意**没有**多态状态机——这条通道只有两种事实：
 * 「广播确实没送到」（弹窗说话）与「没有这笔账」（什么都不说）。
 * 「不知道」与「有问题」绝不能共用一句话，那正是本功能要消灭的误读。
 */

/** `GET_CONFIG_SYNC` 的回执 */
export interface ConfigSyncStatus {
  /** `false` = 后台确实往这个标签页推过配置而它没接住 */
  synced: boolean;
}

/**
 * 结构完整性判定：只认带布尔 `synced` 的对象。
 *
 * SW 异常时回的是 `{ success: false }` 之类，缺字段就返回 false，
 * 于是界面维持上一次的判断，绝不把「读不到」当成「有问题」画出来。
 */
export function isConfigSyncStatus(value: unknown): value is ConfigSyncStatus {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Partial<ConfigSyncStatus>).synced === 'boolean';
}
