/**
 * `respondAsync`（`entrypoints/background/messageRouter.ts`）把 handler 的 reject 转成
 * **resolved** 的 `{ success: false, error }`，因此界面侧的 `catch` 拦不到后台失败——
 * 每个消费点必须自己判这一步，否则导出与删除在写失败时照样弹成功提示。
 *
 * 成功侧有两种形状：数据本体（导出与读取类，不带 `success`）或 `{ success: true }`（写入类），
 * 而写入类里 `saveProfile` / `deleteProfile` 成功时回的是 `undefined`。
 * 所以判据只认 `success === false`，**不能**写成 `!result?.success`——那会把成功当成失败。
 */
export function isFailureEnvelope(value: unknown): value is { success: false; error?: string } {
  return typeof value === 'object' && value !== null && (value as { success?: unknown }).success === false;
}
