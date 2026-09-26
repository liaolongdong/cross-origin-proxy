/**
 * 「一次操作只淡一次」——换肤与换语言的过渡不许被自己的存储回声顶掉
 *
 * 界面侧改配色/改语言是两步：先就地应用（包一次 View Transition），再写
 * `chrome.storage.local`；而写下去的那一笔会沿 `storage.onChanged` **绕回发起页自己**。
 * VT 的回调是被浏览器推迟到下一帧才跑的，回声赶在它前面时，根元素上还挂着旧值——
 * 于是「这一笔和当前不一样」成立，第二次过渡被启动，把第一次当场中止。
 *
 * 中止不是渲染问题（画面照样淡过去），而是两件实打实的代价：每次换肤多拍一张整页快照，
 * 以及前一次的 `ready` 以 `AbortError: Transition was skipped` 拒绝——2026-09-26 在真实
 * Chrome 里量到过，一次点击一条未处理拒绝（`Runtime.exceptionThrown`）。
 *
 * 所以判据不能只看「根元素现在是什么」，还要看「已经有一次在途的过渡正把它画成什么」。
 * 这一支就是这个 pending 目标本身，外加 `withViewTransition` 对中止信号的接手。
 *
 * 本环境测不到的那半：真实的快照合成与交叉淡入长什么样（node 无 DOM），以及 CSS 侧
 * `::view-transition-*` 的时长——那些只能在真浏览器里目测，2026-09-26 已量过一轮。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** 假根元素：只存 `data-theme` / `data-mode` 两个属性 */
let root: { dataset: Record<string, string> };
/** localStorage 镜像替身 */
let mirror: Map<string, string>;
/** storage.local 里躺着的数据 */
let store: Record<string, unknown>;
let changeHandlers: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void>;
/** 被假 `startViewTransition` 收下、还没执行的回调（真实浏览器也是这个时序） */
let pendingCallbacks: Array<() => void | Promise<void>>;
let vtCalls: number;
/** 假过渡返回的 `ready` / `finished`，用来模拟「被后一次顶掉」那一路 */
let readyFactory: () => Promise<void>;
let finishedFactory: () => Promise<void>;

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  root = { dataset: {} };
  mirror = new Map();
  store = {};
  changeHandlers = [];
  pendingCallbacks = [];
  vtCalls = 0;
  readyFactory = () => Promise.resolve();
  finishedFactory = () => Promise.resolve();
  // `currentLocale` 是模块级共享 ref，上一格的 `setLocale` 会一直留着——不重置的话，
  // 「真的换另一种语言时照常淡」那一格会因为已经是 'en' 而一次都不淡，绿得毫无意义
  i18n.currentLocale.value = 'zh_CN';
  vi.stubGlobal('document', {
    documentElement: root,
    startViewTransition: (callback?: () => void | Promise<void>) => {
      vtCalls += 1;
      if (callback) pendingCallbacks.push(callback);
      return { ready: readyFactory(), finished: finishedFactory() };
    },
  });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => mirror.get(key) ?? null,
    setItem: (key: string, value: string) => void mirror.set(key, value),
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        }),
      },
      onChanged: { addListener: vi.fn(handler => changeHandlers.push(handler)) },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 放行浏览器那一帧：把攒着的 VT 回调执行掉 */
async function runTransitions(): Promise<void> {
  const queue = pendingCallbacks.splice(0, pendingCallbacks.length);
  for (const cb of queue) await cb();
  await flush();
}

/** 模拟存储落盘之后绕回本页的那一笔 */
function echo(changes: Record<string, { newValue?: unknown }>): void {
  changeHandlers.forEach(h => h(changes, 'local'));
}

const theme = await import('@/utils/theme');
const i18n = await import('@/utils/i18n');

/**
 * 装上真的存储监听，并等首帧那两次异步读取落定。
 *
 * 少了这一句，`echo()` 就没有接手人——回声那几格会绿得像是修好了，其实什么都没测。
 * 读完之后根元素挂的是默认配色 `sky`（存储里什么都没有时 `readStoredTheme()` 回落默认值），
 * 于是「旧值还挂在根元素上」这个前提也和真实页面一致。
 */
async function mountThemeSync(): Promise<void> {
  theme.initThemeSync();
  await flush();
}

describe('换肤：回声不再开第二次过渡', () => {
  it('点色块 → 回声赶在回调之前，也只淡这一次', async () => {
    await mountThemeSync();

    theme.applyThemeVisually('green');
    expect(vtCalls).toBe(1);
    // 回调还没跑，所以根元素仍是旧值——这正是回声误判成「变了」的那个窗口
    expect(root.dataset.theme).toBe('sky');

    echo({ theme: { newValue: 'green' } });
    expect(vtCalls).toBe(1);

    await runTransitions();
    expect(root.dataset.theme).toBe('green');
    // 回声那一笔照旧刷镜像（不变量：落盘之后才写），只是不再多拍一张快照
    expect(mirror.get('cop_theme')).toBe('green');
  });

  it('连着换两个不同配色，仍然各淡一次（上一格不是把过渡整个关掉了）', async () => {
    theme.applyThemeVisually('green');
    await runTransitions();
    theme.applyThemeVisually('pink');
    await runTransitions();
    expect(vtCalls).toBe(2);
    expect(root.dataset.theme).toBe('pink');
  });

  it('在途目标是 green 时，中途改口 pink 要淡第二次，不能把 pink 当回声吞掉', async () => {
    await mountThemeSync();

    theme.applyThemeVisually('green');
    echo({ theme: { newValue: 'pink' } });
    expect(vtCalls).toBe(2);
    await runTransitions();
    expect(root.dataset.theme).toBe('pink');
  });

  it('显示模式那条同样只认「在途目标」，回声不开第二次', async () => {
    await mountThemeSync();

    theme.applyThemeModeVisually('dark');
    expect(vtCalls).toBe(1);
    echo({ theme_mode: { newValue: 'dark' } });
    expect(vtCalls).toBe(1);
    await runTransitions();
    expect(root.dataset.mode).toBe('dark');
    expect(mirror.get('cop_mode')).toBe('dark');
  });

  it('两项里只有一项还没落：另一项已是目标值也要淡，且该改的那项照样改', async () => {
    await mountThemeSync();
    // 先把配色落到 green，再请求「green + dark」：theme 这项已经满足，mode 这项没有。
    // 判据若写成「任一项相同就不淡」（而不是「两项都相同才不淡」），这一格就是
    // 「设置里选了暗色、页面还停在亮色」那条真实路径。
    theme.applyThemeVisually('green');
    await runTransitions();
    expect(root.dataset.theme).toBe('green');

    theme.applyThemeVisually('green', 'dark');
    expect(vtCalls).toBe(2);
    await runTransitions();
    expect(root.dataset.mode).toBe('dark');
    expect(root.dataset.theme).toBe('green');
  });

  it('根元素已经是那个配色、也没有在途过渡时，不进过渡', () => {
    root.dataset.theme = 'green';
    theme.applyThemeVisually('green');
    // 这条契约的全部内容就是「连快照都不该拍」：这一格里的 `write()` 按构造是个空操作
    //（走进这个分支的前提就是每一项都已经等于目标值），所以此处不重复断言 `data-theme`——
    // 那句断言在前提成立时永远为真，钉不住任何写法。
    expect(vtCalls).toBe(0);
  });

  it('存储里两个键同批变更时淡一次，且两个属性都落', async () => {
    await mountThemeSync();

    theme.applyThemeVisually('green', 'dark');
    // 两个键装进同一批 changes 绕回来：在途目标把两项都覆盖了，一次都不许多
    echo({ theme: { newValue: 'green' }, theme_mode: { newValue: 'dark' } });
    expect(vtCalls).toBe(1);
    await runTransitions();
    expect(root.dataset.theme).toBe('green');
    expect(root.dataset.mode).toBe('dark');
  });

  it('两次过渡排在一起时，先跑的那次回调不许把后一笔的账抹掉', async () => {
    await mountThemeSync();

    theme.applyThemeVisually('green');
    echo({ theme: { newValue: 'pink' } });
    expect(vtCalls).toBe(2);

    // 只放行排在前面那一笔（真实浏览器里它确实先跑完），此时 pink 那一次还在队列里
    const first = pendingCallbacks.shift();
    if (!first) throw new Error('夹具没收下第一笔过渡的回调');
    await first();
    await flush();
    expect(root.dataset.theme).toBe('green');

    // 同一份 pink 又送来一遍：账还在，所以它仍是回声，不多淡一次
    echo({ theme: { newValue: 'pink' } });
    expect(vtCalls).toBe(2);

    await runTransitions();
    expect(root.dataset.theme).toBe('pink');
  });
});

describe('另一页改的配色，本页只靠这个监听器画上', () => {
  /**
   * 这几格刻意不让本页先发起请求。
   *
   * 「回声」那几格里本页已经排了一次过渡，回调最终会把值画上，所以就算监听器把 `mode` 丢了
   * 也照样绿（2026-09-26 变异实测：摘掉监听器里的 `mode` 全仓不红）。只有让监听器独自负责，
   * 「跨页同步」这条真实路径才有人看着。
   */
  it('存储里来了新配色 → 淡一次并画上', async () => {
    await mountThemeSync();

    echo({ theme: { newValue: 'pink' } });
    expect(vtCalls).toBe(1);
    await runTransitions();
    expect(root.dataset.theme).toBe('pink');
    expect(mirror.get('cop_theme')).toBe('pink');
  });

  it('存储里来了新的显示模式 → 淡一次并画上（theme 原样不动）', async () => {
    await mountThemeSync();

    echo({ theme_mode: { newValue: 'dark' } });
    expect(vtCalls).toBe(1);
    await runTransitions();
    expect(root.dataset.mode).toBe('dark');
    expect(root.dataset.theme).toBe('sky');
    expect(mirror.get('cop_mode')).toBe('dark');
  });

  it('两个键同批到达 → 只淡一次，两个属性都落', async () => {
    await mountThemeSync();

    echo({ theme: { newValue: 'pink' }, theme_mode: { newValue: 'dark' } });
    expect(vtCalls).toBe(1);
    await runTransitions();
    expect(root.dataset.theme).toBe('pink');
    expect(root.dataset.mode).toBe('dark');
  });

  it('落不到合法配色上的一律重置成默认，并且照样淡（不是静默忽略）', async () => {
    await mountThemeSync();
    theme.applyThemeVisually('green');
    await runTransitions();
    expect(root.dataset.theme).toBe('green');

    echo({ theme: { newValue: 'neon' } });
    expect(vtCalls).toBe(2);
    await runTransitions();
    expect(root.dataset.theme).toBe('sky');
  });
});

describe('换语言：回声不再开第二次过渡', () => {
  it('setLocale 之后 storage.onChanged 绕回来，也只淡这一次', async () => {
    i18n.initLocaleSync();
    i18n.setLocale('en');
    expect(vtCalls).toBe(1);

    echo({ locale: { newValue: 'en' } });
    expect(vtCalls).toBe(1);

    await runTransitions();
    expect(i18n.currentLocale.value).toBe('en');
    expect(mirror.get('cop_locale')).toBe('en');
  });

  it('真的换另一种语言时照常淡（上一格不是把过渡关掉了）', async () => {
    i18n.setLocale('en');
    await runTransitions();
    i18n.setLocale('zh_CN');
    await runTransitions();
    expect(vtCalls).toBe(2);
    expect(i18n.currentLocale.value).toBe('zh_CN');
  });

  it('另一页改语言传过来时，监听器独自负责也要淡并画上', async () => {
    i18n.initLocaleSync();
    await flush();

    echo({ locale: { newValue: 'en' } });
    expect(vtCalls).toBe(1);
    await runTransitions();
    expect(i18n.currentLocale.value).toBe('en');
    expect(mirror.get('cop_locale')).toBe('en');
  });
});

describe('被顶掉的那次过渡不许留下未处理拒绝', () => {
  it('`ready` 与 `finished` 都以 AbortError 拒绝时，既不抛也没有未接手人', async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onRejection);
    // 真实浏览器里被后一次过渡顶掉时这两个 promise 是一起拒绝的，所以夹具两份都给拒绝——
    // 只拒绝一份，另一份的接手就成了没人能检出的冗余
    const aborted = () => Promise.reject(Object.assign(new Error('Transition was skipped'), { name: 'AbortError' }));
    readyFactory = aborted;
    finishedFactory = aborted;
    try {
      theme.applyThemeVisually('green');
      await flush();
      await flush();
      expect(vtCalls).toBe(1);
      expect(seen).toEqual([]);
      // 阳性对照：`aborted()` 交回来的确实是「已被拒绝」的那一枚，所以上一句不是「压根没建 promise」
      let rejected = 0;
      await aborted().catch(() => {
        rejected += 1;
      });
      expect(rejected).toBe(1);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    await runTransitions();
  });
});
