import type { ProxyRule, StoredProfile } from '@/utils/types';
import { MAX_RULES } from '@/utils/constants';
import { isValidRuleShape } from '@/utils/ruleValidation';

/**
 * 环境快照的两道读侧判据：`profiles` 是 storage 原文，读取侧不能假设形状
 *
 * 两个消费者共用这一份，判据必须同源：
 * - `utils/storage.ts` 的 `getProfiles` / `loadProfile`——三条写入路径（保存、删除、加载）都要在
 *   这份数组上走 `findIndex` / `filter`，数组里混进 `null` 或字符串会让它们当场抛；加载则是
 *   **整套替换 + 顺手打开总开关**，坏规则会直接成为生效配置。
 * - `composables/useProfiles.ts`——Options 弹窗与 popup 切换卡都要渲染 `profile.rules.length`，
 *   而 `rules` 被手改成字符串时那句渲染会在 `loadProfile` 之前就抛，界面连「这份坏了」都说不出口。
 *
 * 只**拒绝**不修补：把坏 `rules` 当成空数组传下去，等于替用户点了一次「清空规则并打开代理」。
 */

/** 快照拒绝加载的原因码（只进日志，不是界面文案） */
export type ProfileRulesError = 'invalid-rules' | 'too-many-rules';

export interface ProfileRulesInspection {
  /** 这份规则集不能整套写进生效配置时的原因码 */
  code?: ProfileRulesError;
  /** `rules` 是数组时的条数；不是数组时为 `null`（「读不出条数」不能画成 0） */
  ruleCount: number | null;
  /** 第一条不合形状的规则下标；不是数组或全部合法时为 -1 */
  firstInvalidIndex: number;
  /** 只有 `code` 为空时才有值：一份已逐条过闸、能安全整套替换的规则数组 */
  rules?: ProxyRule[];
}

export function inspectProfileRules(profile: Pick<StoredProfile, 'rules'>): ProfileRulesInspection {
  const rules = profile.rules;
  if (!Array.isArray(rules)) {
    return { code: 'invalid-rules', ruleCount: null, firstInvalidIndex: -1 };
  }
  const firstInvalidIndex = rules.findIndex(rule => !isValidRuleShape(rule));
  if (firstInvalidIndex >= 0) {
    return { code: 'invalid-rules', ruleCount: rules.length, firstInvalidIndex };
  }
  if (rules.length > MAX_RULES) {
    return { code: 'too-many-rules', ruleCount: rules.length, firstInvalidIndex: -1 };
  }
  // 逐条过闸之后才能收窄：`isValidRuleShape` 是类型守卫，`every` 不改变数组元素类型
  return { ruleCount: rules.length, firstInvalidIndex: -1, rules: rules as ProxyRule[] };
}

/**
 * 一条快照能不能被寻址（id / name / createdAt 形状对得上）
 *
 * `rules` 刻意不在这道判据里：坏规则的快照仍要出现在列表里，用户才删得掉它；
 * 加载那一步由 {@link inspectProfileRules} 单独拒绝。但 `id` 不是字符串（或整条是 `null`）的
 * 条目既渲染不了、也删不掉，只能从读取结果里剔掉——它们留在 storage 里，下一次写入列表时消失。
 */
export function isStoredProfileEntry(value: unknown): value is StoredProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.id === 'string' &&
    profile.id !== '' &&
    typeof profile.name === 'string' &&
    typeof profile.createdAt === 'number' &&
    Number.isFinite(profile.createdAt)
  );
}
