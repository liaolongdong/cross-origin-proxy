import { MAX_VARIABLES, MAX_VARIABLE_VALUE_LENGTH } from '@/utils/constants';
import { isVariableName } from '@/utils/variables';
import type { ProxyRule, VariableStore } from '@/utils/types';

/**
 * 把 HAR 抓包里录到的凭据头改成 `{{名称}}` 引用，真值搬到凭据变量表
 *
 * 为什么需要：`harEntriesToRules` 会把 `Authorization` / `Cookie` / `x-api-key` 的**原值**抄进
 * `rule.headerOverrides`（那是别人机器上抓的包）。全仓其余地方的口径是「规则里只放引用，真值只住在
 * `STORAGE_KEYS.VARIABLES`」——导出脱敏、日志、下发给页面 world 的配置都按这条成立，而 HAR 导入这条
 * 路是唯一把真值写进规则的入口。这一步把它对齐。
 *
 * 四条不静默的降级，都是「宁可保留今天的形状，也不造一条引用不存在的规则」：
 * - 变量表**装不下**（`MAX_VARIABLES`）时，装不下的那几个头保持原值；
 * - 值**超过 `MAX_VARIABLE_VALUE_LENGTH`** 时保持原值——`sanitizeVariables` 会把超长的条目丢掉，
 *   而那时规则里已经写上引用了，等于留下一条指向不存在变量的规则并把整笔导入撞成失败；
 * - 生成的名字不合 `VARIABLE_NAME_RE` 时保持原值（本函数产出的名字理论上总是合法，这一档是给
 *   未来改命名方案留的保险，不是给今天用的）；
 * - 值本身已经是 `{{...}}` 引用时原样不动（重复导入同一份文件不该再造一份变量）。
 *
 * 纯函数：不碰 `chrome`、不改入参、同名同值的既有变量**复用而不新增**。
 */

/** HAR 侧会带凭据的三枚头名（与 `utils/har.ts` 的白名单同一份含义，判读处在那一侧） */
const CREDENTIAL_HEADER_NAMES = new Set(['authorization', 'cookie', 'x-api-key']);

/** 引用前缀与最长名字（`VARIABLE_NAME_RE` 上限 64） */
const NAME_PREFIX = 'HAR_';
const MAX_NAME_LENGTH = 64;

/** 已经写成引用的值，原样保留 */
const REFERENCE_RE = /\{\{[^{}]+\}\}/;

function hostSegment(source: ProxyRule): string {
  // `matchPattern` 是 `https://host[:port]/*` 形状；端口参与域名清洗，两个端口是两个环境
  const host = source.matchPattern.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const cleaned = host.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'origin';
}

function clampName(name: string): string {
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH).replace(/_+$/g, '') : name;
}

/**
 * 生成一个不与现有变量冲突的名字
 * @param base 期望的名字（含前缀）
 * @param taken 已被占用的名字（含本次调用刚分配的）
 */
function uniqueName(base: string, taken: Set<string>): string {
  let candidate = clampName(base);
  if (!taken.has(candidate)) return candidate;
  for (let index = 2; index < 100; index += 1) {
    candidate = clampName(`${base}_${index}`);
    if (!taken.has(candidate)) return candidate;
  }
  return '';
}

/** 一次导入的结果：改过的规则、要新增的变量、以及两个计数（界面要把降级说清楚） */
export interface RelocatedHar {
  rules: ProxyRule[];
  /** 需要合并进变量表的那部分（不含既有变量） */
  variables: VariableStore;
  /** 改成引用的**头**的数量（同值复用同一变量时不新建，所以它可以大于本次真正新增的变量条数） */
  relocated: number;
  /** 因为装不下、名字不合用、或值超过单条长度上限而保留原值的头的数量（「本来就是引用」不计——它没被改动） */
  keptRaw: number;
}

/**
 * @param rules `harEntriesToRules` 刚产出的规则（不修改）
 * @param existing 当前变量表
 * @param capacityLeft 还能装几条；缺省按 `MAX_VARIABLES` 与现有条数算
 */
export function relocateHarCredentialHeaders(
  rules: ProxyRule[],
  existing: VariableStore,
  capacityLeft?: number,
): RelocatedHar {
  const existingNames = Object.keys(existing);
  const taken = new Set(existingNames);
  const available = capacityLeft ?? Math.max(0, MAX_VARIABLES - existingNames.length);
  const pending: VariableStore = {};
  const next: ProxyRule[] = [];
  let relocated = 0;
  let keptRaw = 0;

  for (const rule of rules) {
    const overrides = rule.headerOverrides;
    if (!overrides) {
      next.push(rule);
      continue;
    }
    const rewritten: Record<string, string> = {};
    let changed = false;

    for (const [name, value] of Object.entries(overrides)) {
      const isCredential = CREDENTIAL_HEADER_NAMES.has(name.toLowerCase());
      // 已经有引用就不动：重复导入同一份文件不该再多一份变量
      if (!isCredential || typeof value !== 'string' || !value.trim() || REFERENCE_RE.test(value)) {
        rewritten[name] = value;
        continue;
      }

      // 值超长的不搬：`sanitizeVariables` 会把它当成非法条目丢掉，而我们已经在规则里写上了
      // 引用——那会留下一条指向不存在的变量的规则，并把整笔导入撞成失败。
      // 与收口侧共用同一个上限，两边对「多长算太长」不会给出不同答案。
      if (value.length > MAX_VARIABLE_VALUE_LENGTH) {
        rewritten[name] = value;
        keptRaw += 1;
        continue;
      }

      // 同一个真值在变量表里、或本次调用里已经分配过就复用：一份 HAR 里同一个 token 常出现在
      // 几十个头上，每个头配一条同值变量会让那张表被重复条目塞满
      const reusedName =
        existingNames.find(key => existing[key] === value) ?? Object.keys(pending).find(key => pending[key] === value);
      if (reusedName) {
        rewritten[name] = `{{${reusedName}}}`;
        changed = true;
        relocated += 1;
        continue;
      }

      const base = `${NAME_PREFIX}${hostSegment(rule)}_${name.toLowerCase()}`;
      const fits = Object.keys(pending).length < available;
      const candidate = fits ? uniqueName(base, taken) : '';
      if (!candidate || !isVariableName(candidate)) {
        // 装不下或名字不合用：保留原值，也就是今天的行为，而不是留一条引用不存在的规则
        rewritten[name] = value;
        keptRaw += 1;
        continue;
      }

      taken.add(candidate);
      pending[candidate] = value;
      rewritten[name] = `{{${candidate}}}`;
      changed = true;
      relocated += 1;
    }

    next.push(changed ? { ...rule, headerOverrides: rewritten } : rule);
  }

  return { rules: next, variables: pending, relocated, keptRaw };
}
