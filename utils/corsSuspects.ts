import { CORS_SUSPECT_CACHE_SIZE, CORS_SUSPECT_LIMIT, CORS_SUSPECT_MAX_COUNT } from '@/utils/constants';
import { apiOriginOf, type PageApiOrigin } from '@/utils/pageApiOrigins';

/**
 * 「这一页哪些来源的请求像是被 CORS 拦下了」——页面自报读数的收口与界面行装配
 *
 * 为什么需要它：用户看得见的是控制台里那行红字，看不见的是它属于哪个来源。扩展已经替页面
 * 发过跨域请求，却从不告诉用户「这一页正有一笔原生请求被 CORS 挡下来」，而那一笔恰恰最该建规则。
 * 桥接层把拦截器报上来的几笔账存成一份内存快照，popup 一次只读探测把它取回去；本模块负责
 * **判断这份快照能不能信**与**把它和候选来源拼成一列可点的行**，两者都不碰 `chrome.*`。
 *
 * 三条不可让的前提（与 `INTERCEPTOR_STATS` 同一档处理）：
 * 1. 这份数据**由页面自报**，同页脚本伪造它毫无难度，所以它只用于展示，绝不参与任何判定分支，
 *    也不写 `storage`、不转给 SW；
 * 2. 措辞永远是「疑似」——原生 XHR 被 CORS 拦下、断网、DNS 失败、连接被拒在页面上是同一个形状
 *    （`error` 事件 + `status === 0`），扩展分不出这四者；
 * 3. 读不到与读到空**都不说话**：那一列行维持成今天的样子，绝不画一句「这一页没有跨域报错」。
 *
 * 与 `utils/pageApiOrigins.ts` 的分工：那份是「这一页在调谁」（页面自己的计时记录），
 * 这份是「调了但像是没通」。两者共用同一个 origin 判据（`apiOriginOf`），
 * 于是「带标记的那一行」必然也在这份候选里，不会出现两列地址对不上。
 */

/** 一个来源与其疑似被拦的笔数 */
export interface CorsSuspect {
  origin: string;
  count: number;
}

/** 候选面板里的一行：来源、这一页对它的请求条数、其中疑似被拦的笔数 */
export interface ApiPickerRow {
  origin: string;
  /** 请求条数；`0` = 资源计时里读不到（计时记录有浏览器自己的容量上限，也可能这笔只报过错） */
  count: number;
  /** 疑似被 CORS 拦下的笔数；`0` = 这一行没有标记 */
  suspect: number;
}

/**
 * 把任意载荷收成合法的来源清单
 *
 * 逐条判据、逐条丢弃：一行候选彼此无关，丢掉一条非法项不会让其余说错话
 * （拦截器那四个数必须整包丢弃，是因为它们要彼此自洽才讲得通）。
 *
 * 四道收口：`suspects` 必须是数组；`origin` 必须**本身就是一个 http(s) origin**
 * （剥掉路径/查询后与给来的串不相等就不要——那些内容不该画到界面，更不该跟着下一次点击进 Options）；
 * `count` 必须是有限正数并钳制到 `CORS_SUSPECT_MAX_COUNT`；来源数钳制到 `CORS_SUSPECT_CACHE_SIZE`。
 * 同源重复取最大笔数。那道来源数上限发生在**插入时**（先到先得，见上面那句 `counts.size >=`）：
 * 数组里排在前面的 N 个来源入账，排在后面的即使笔数更大也不进——不是「留笔数最多的前 N 个」，
 * 下面那一次排序只改变已入账这 N 行的显示顺序，不改变谁被丢掉。这个口径由
 * `tests/corsSuspects.test.ts` 的「来源数与伪造包都有上界」钉住（那份载荷故意把最大笔数放在第 N+3 位）。
 * 末尾那一次 `slice` 今天恒不截断（插入时已经卡在 N），留着是因为它同时替「读端那一档不超过
 * 面板那一档」这条不变量收了第二道闩：哪天有人放宽插入时那一道，这一句仍然画不出第 N+1 行。
 */
export function parseCorsSuspects(value: unknown): CorsSuspect[] {
  const raw = (value as { suspects?: unknown } | null | undefined)?.suspects;
  if (!Array.isArray(raw)) return [];
  const counts = new Map<string, number>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { origin, count } = item as Partial<CorsSuspect>;
    if (typeof origin !== 'string') continue;
    const normalized = apiOriginOf(origin);
    if (!normalized || normalized !== origin) continue;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) continue;
    const clamped = Math.min(Math.floor(count), CORS_SUSPECT_MAX_COUNT);
    if (!counts.has(normalized) && counts.size >= CORS_SUSPECT_CACHE_SIZE) continue;
    counts.set(normalized, Math.max(counts.get(normalized) ?? 0, clamped));
  }
  return [...counts]
    .map(([origin, count]) => ({ origin, count }))
    .sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin))
    .slice(0, CORS_SUSPECT_CACHE_SIZE);
}

/**
 * 把两份读数拼成面板里的那一列
 *
 * 排序是「先给最该建规则的」：有疑似标记的行排在最前，其次按请求条数降序，同源并列按 origin
 * 升序（`Map` 的插入序随页面加载顺序变化，不稳定排序会把换序画成界面在抖动）。
 * 只出现在疑似那侧的来源照样成行——资源计时有容量上限，「页面报过错」这条证据不必因为它而消失，
 * 那一行的笔数格因此只讲疑似笔数，不假装有请求条数。
 *
 * 行数收在 `CORS_SUSPECT_LIMIT`（popup 内容宽 320px，一屏放得下的候选才有点击价值）：排序保证
 * 被挤掉的**只可能是没有标记的行**。读端那一档（`CORS_SUSPECT_CACHE_SIZE`）与它取同一个数正是为了
 * 这件事——卡片上那句「检测到 N 个来源」于是恒等于面板里带标记的行数，用户点开数得出同一个数。
 */
export function buildPickerRows(choices: readonly PageApiOrigin[], suspects: readonly CorsSuspect[]): ApiPickerRow[] {
  const suspectOf = new Map(suspects.map(suspect => [suspect.origin, suspect.count]));
  const rows: ApiPickerRow[] = choices.map(choice => ({
    origin: choice.origin,
    count: choice.count,
    suspect: suspectOf.get(choice.origin) ?? 0,
  }));
  const listed = new Set(rows.map(row => row.origin));
  for (const suspect of suspects) {
    if (listed.has(suspect.origin)) continue;
    listed.add(suspect.origin);
    rows.push({ origin: suspect.origin, count: 0, suspect: suspect.count });
  }
  return rows
    .sort((a, b) => b.suspect - a.suspect || b.count - a.count || a.origin.localeCompare(b.origin))
    .slice(0, CORS_SUSPECT_LIMIT);
}
