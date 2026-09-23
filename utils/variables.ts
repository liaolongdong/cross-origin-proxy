import type { VariableStore } from '@/utils/types';
import { MAX_VARIABLES, MAX_VARIABLE_VALUE_LENGTH } from '@/utils/constants';

/**
 * 凭据变量的引用语法与展开（纯函数，不碰 chrome API）
 *
 * 规则里的凭据位点（请求头值、查询参数值）允许写成 `{{名称}}`，真值单独存在
 * `storage.local` 的 `variables` 里。这样做的直接后果是本模块必须**只在后台服务线程被调用**：
 * 展开发生在出站请求组装前，而下发给页面世界的配置永远只带着 `{{名称}}` 字面量
 * （见 `entrypoints/content.ts` 的 `toInterceptorConfig`）。
 *
 * 两条刻意的取舍：
 * - **未定义的引用原样保留**，不抛错也不清空。少一个 token 头的表现是上游 401，
 *   比「整条规则静默失效」可读，且拼错的情况已在表单保存处拦住。
 * - **不递归展开**：`replace` 的返回值不会被重新扫描，所以真值里含 `{{x}}` 时
 *   不会被二次解释成另一个变量——否则一个变量就能引用整张表。
 */

/** 变量名：字母开头，允许数字 / `_` / `.` / `-`，总长 1..64（与 `MAX_VARIABLE_NAME_LENGTH` 对齐） */
export const VARIABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** 引用语法。全局标志供 `matchAll` 使用（`matchAll` 内部各自建副本，不共享 `lastIndex`） */
const VARIABLE_REF_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]{0,63})\s*\}\}/g;

export interface ResolvedValue {
  value: string;
  /** 被引用但变量表里没有的名字（去重） */
  missing: string[];
}

export interface ResolvedMap {
  resolved: Record<string, string>;
  missing: string[];
}

/** 变量名是否合法（空串、非法字符、超长都在此拒绝） */
export function isVariableName(name: string): boolean {
  return typeof name === 'string' && VARIABLE_NAME_RE.test(name);
}

export interface SanitizedVariables {
  store: VariableStore;
  /** 被丢弃的条目数：名字非法、值非字符串/空白、值超长、超出条数上限 */
  dropped: number;
}

/**
 * 收口一整张变量表（界面与存储两条入口共用的那道闸门）
 *
 * 返回 `null` 表示传入的**根本不是键值对象**——调用方必须把它当非法请求拒绝，而不是当成
 * 空表写入：否则一次格式错误就等价于静默清空用户全部凭据。
 *
 * 值裁两端空白是有意的：粘贴 token 常带换行，而 HTTP 本就会折掉头值两端空白，留着只会
 * 让「看起来配好了」的请求发不出正确凭据。超长不截断——半把 token 比少一把更难查。
 */
export function sanitizeVariables(input: unknown): SanitizedVariables | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const store: VariableStore = {};
  let dropped = 0;
  for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!isVariableName(name) || !value || value.length > MAX_VARIABLE_VALUE_LENGTH) {
      dropped++;
      continue;
    }
    if (Object.keys(store).length >= MAX_VARIABLES) {
      dropped++;
      continue;
    }
    store[name] = value;
  }
  return { store, dropped };
}

/** 取出一段文本引用的所有变量名（去重、保持首次出现顺序） */
export function extractVariableRefs(value: string | undefined): string[] {
  if (!value) return [];
  const names: string[] = [];
  for (const match of value.matchAll(VARIABLE_REF_RE)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 按名字取变量真值：只认变量表**自己**的键
 *
 * `constructor` / `toString` / `hasOwnProperty` 都是合法变量名（`VARIABLE_NAME_RE` 只约束
 * 首字符与字符集），而裸下标会顺着原型链拿到 `Object.prototype` 上的函数。于是「表里没配
 * 这把密钥」被读成「配了，值是那段函数源码」：请求头原样发出一个看不懂的字符串，而保存侧
 * 专门拦拼错的引用（`findUndefinedVariableRefs`）恰好在这一格放行。
 */
function ownVariableValue(store: VariableStore, name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(store, name) ? store[name] : undefined;
}

/**
 * 展开一段文本里的所有引用
 *
 * 未定义的引用保留 `{{名称}}` 字面量并回报，调用方据此决定是否告警。
 */
export function resolveVariableRefs(value: string, store: VariableStore): ResolvedValue {
  if (!value || !value.includes('{{')) return { value, missing: [] };

  const missing: string[] = [];
  const resolved = value.replace(VARIABLE_REF_RE, (whole, name: string) => {
    const hit = ownVariableValue(store, name);
    if (hit === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return hit;
  });
  return { value: resolved, missing };
}

/**
 * 展开一整张键值表（请求头覆盖、查询参数覆盖共用）
 *
 * 只展开**值**：键名里出现 `{{x}}` 不是本功能的语义（头名是固定词法，展开只会制造
 * 一条永远非法的头），因此键名原样保留。空表返回 `undefined`，与「本规则没有这一项」
 * 在下游判据（`isSimpleRule`、头校验）里保持同一形态。
 */
export function resolveVariableMap(
  map: Record<string, string> | undefined,
  store: VariableStore,
): ResolvedMap | undefined {
  if (!map) return undefined;
  const entries = Object.entries(map);
  if (entries.length === 0) return undefined;

  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, raw] of entries) {
    const hit = resolveVariableRefs(String(raw), store);
    resolved[key] = hit.value;
    for (const name of hit.missing) {
      if (!missing.includes(name)) missing.push(name);
    }
  }
  return { resolved, missing };
}

/**
 * 一条规则引用了哪些变量
 *
 * 表单校验（引用了未定义的就别让存，见 `newlyIntroducedRefs`）与变量管理页的「被 N 条规则使用」
 * 共用这一份口径——两处各写一遍正是漂移的开始。
 */
export function collectRuleVariableRefs(rule: {
  headerOverrides?: Record<string, string>;
  queryOverrides?: Record<string, string>;
}): string[] {
  const names: string[] = [];
  for (const map of [rule.headerOverrides, rule.queryOverrides]) {
    if (!map) continue;
    for (const raw of Object.values(map)) {
      for (const name of extractVariableRefs(String(raw))) {
        if (!names.includes(name)) names.push(name);
      }
    }
  }
  return names;
}

/**
 * 草稿规则里引用了、但变量表中不存在的名字
 *
 * 保存侧用它把「拼错的变量名」拦在表单里：存下去它会在请求时原样发出，表现为一次
 * 看不懂的上游 401，而不是「这里少配了一把密钥」。运行时对漏网的引用仍是宽容原样发出
 * （删除变量不该让无关规则报错，见 `resolveVariableRefs` 的取舍说明）。
 */
export function findUndefinedVariableRefs(
  rule: { headerOverrides?: Record<string, string>; queryOverrides?: Record<string, string> },
  store: VariableStore,
): string[] {
  return collectRuleVariableRefs(rule).filter(name => ownVariableValue(store, name) === undefined);
}

/**
 * 从一组引用名里挑出「这次才带进来的」
 *
 * 表单的两道保存闸门各拿一份基线用它过滤。闸门要拦的是**新写进去的**引用（拼错的名字存下去会在
 * 请求时原样发出），而编辑一条存储里早已写着 `{{X}}` 的规则时，`X` 不是这次带进来的：导入侧不跑
 * 这道校验、手改 storage 也能造出这种规则，此后这条规则连优先级都改不动。比较按**名字**，
 * 不看它出现在哪个位点——但两份基线各自取哪个位点是承重的：未定义那道问「这个名字表里有没有值」，
 * 头与查询可以合并；WS 那道问「这个位点读不读得到变量表」，只能按查询参数一侧算。
 */
export function newlyIntroducedRefs(refs: Iterable<string>, alreadyStored: Iterable<string>): string[] {
  const stored = new Set(alreadyStored);
  return [...new Set(refs)].filter(name => !stored.has(name));
}
