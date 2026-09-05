import type { ProxyRule } from '@/utils/types';

/** 单条规则的迁移结果：命中查找串并会产生变更的目标地址补丁 */
export interface TargetMigration {
  id: string;
  oldUrl: string;
  newUrl: string;
}

/**
 * 计算「批量迁移目标域名」的变更集（纯函数，便于单测与 UI 预览复用）。
 *
 * 对指定 `ids` 的规则，在其 `targetUrl` 上把 `find` 替换为 `replace`：
 * - 使用 `replaceAll` 语义（一次性替换全部出现），避免多处相同前缀只改首处；
 * - 仅收集 `targetUrl` 含 `find` 且替换后确实发生变化的规则；
 * - `find` 为空时不产生任何变更（防止误伤全部规则）；
 * - 不修改入参 `rules`，返回全新的补丁数组供提交与预览。
 *
 * @param rules 全部规则（用于按 id 定位）
 * @param ids 需要参与迁移的规则 id 列表（通常为用户选中项）
 * @param find 查找串（域名 / 协议+域名 / 任意子串）
 * @param replace 替换串
 */
export function computeMigratedTargets(
  rules: readonly ProxyRule[],
  ids: readonly string[],
  find: string,
  replace: string,
): TargetMigration[] {
  if (!find) return [];
  const idSet = new Set(ids);
  const result: TargetMigration[] = [];
  for (const rule of rules) {
    if (!idSet.has(rule.id)) continue;
    if (!rule.targetUrl.includes(find)) continue;
    const newUrl = rule.targetUrl.replaceAll(find, replace);
    if (newUrl !== rule.targetUrl) {
      result.push({ id: rule.id, oldUrl: rule.targetUrl, newUrl });
    }
  }
  return result;
}
