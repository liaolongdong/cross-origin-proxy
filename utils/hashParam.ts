/**
 * 地址栏 hash 参数的解码收口
 *
 * 唯一出口：`#logs?url=` 与 `#add-rule-from-tab=` 都从这里取解码结果。住在地址栏里的那一串
 * 属外部输入（用户可手改、别的扩展可导航），而 `decodeURIComponent` 对畸形百分号序列
 * （`%ZZ`、`%E0%A4%A`）**抛 `URIError` 而不是返回空串**——一次抛错会让配置页的
 * `handleHashNavigation` 中途退出，把 `history.replaceState` 那一步（抹掉 hash）留在身后。
 *
 * 判据是「解不出来就当没带」：交回空串，由调用方决定这句话怎么说，绝不向上抛。
 */
export function decodeHashValue(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}
