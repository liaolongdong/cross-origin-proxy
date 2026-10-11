import { describe, it, expect, afterAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { STORE_SECRET_NAMES } from '@/scripts/release-gate.mjs';
import {
  RETIRED_V1_1_KEYS,
  SEMANTIC_SWITCHES,
  UNMODELED_KEYS,
  evaluate,
  mergeEnvFile,
  privateKeyProblem,
  render,
  shapeProblem,
} from '@/scripts/store-preflight.mjs';

/**
 * Chrome Web Store 离线预检的判据（`scripts/store-preflight.mjs`）
 *
 * 这支脚本存在的理由与 `release-gate.mjs` 同一类：它是这条链路上少数「错了会贵到不可撤回」
 * 的判据之一，而它跑在 `.github/**` 里——本机没有 `act`/`docker`，YAML 那层永远实跑不了。
 * 判据本身是纯函数（收一份 env 对象、吐结构化结论），所以这里测的是**真实现**，不是复刻。
 *
 * 覆盖面按「外部可观察面」组织：
 * - 结论：`{ok, items, notes}` 三个字段，红/绿与「红在哪一条」
 * - 措辞：预检报告那一屏（处理的人只看得到它）
 * - 卫生：报告里绝不含任何一份传入值的片段（这条最容易在改动时被打穿，所以给了阳性对照）
 * - 文件：`.env.submit` 的多行引号 PEM 能不能原样读回来（与 `publish-browser-extension` 同一套解析器）
 *
 * 至于「GitHub 的 `env:` 到底注入了哪几个键」仍然只有 YAML 那一份口径，由
 * `tests/docs-consistency.test.ts` 按源码钉住。
 */

/** 两份真密钥：PKCS#8 是 Google JSON 里现在的那种，PKCS#1 是老格式——两种都必须读得出来。 */
const { privateKey: PEM_PKCS8 } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const { privateKey: PEM_PKCS1 } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const PUBLISHER_ID = '12345678901234567890';
const CLIENT_EMAIL = 'cws-ci@proj-42.iam.gserviceaccount.com';

/** 一份全部合法的 env；下面的反例都从它出发**只改一处**，好让「红了几条」本身成为断言。 */
const GOOD: Record<string, string> = {
  CHROME_API_VERSION: 'v2',
  CHROME_EXTENSION_ID: EXTENSION_ID,
  CHROME_PUBLISHER_ID: PUBLISHER_ID,
  CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL: CLIENT_EMAIL,
  CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: PEM_PKCS8,
};

const with_ = (patch: Record<string, string | undefined>): Record<string, string> => {
  const next = { ...GOOD };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
};

/** 取某一条判据的结论；`null` 表示那一条是绿的。 */
function problemOf(env: Record<string, string>, name: string): string | null {
  const item = evaluate(env).items.find(entry => entry.name === name);
  if (!item) throw new Error(`判据里没有 ${name} 这一条——名字清单或判据结构变了`);
  return item.ok ? null : item.detail;
}

const failingNames = (env: Record<string, string>) =>
  evaluate(env)
    .items.filter(item => !item.ok)
    .map(item => item.name);

describe('evaluate：一份合法配置应当全绿', () => {
  it('五项全过，且没有多余的 ✗', () => {
    const result = evaluate(GOOD);
    expect(result.ok).toBe(true);
    expect(result.items.every(item => item.ok)).toBe(true);
    // 「非空」这条自检是承重的：整体失配时（比如判据数组切出空的）`every` 会静默为真。
    expect(result.items.length).toBeGreaterThanOrEqual(STORE_SECRET_NAMES.length + 1);
  });

  it('两份 PKCS#1 与 PKCS#8 都算合法——老格式的服务账号 JSON 不该被要求重新下载', () => {
    expect(evaluate(with_({ CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: PEM_PKCS1 })).ok).toBe(true);
    expect(privateKeyProblem(PEM_PKCS1)).toBe('');
  });

  it('四项凭据的名字清单与闸门脚本同一份（不是这里另抄一遍）', () => {
    // 这条不是形式主义：`release-gate.mjs` 那份清单是给审批页看「凭据齐不齐」的，这一份是
    // 真正决定发不发的。两份一旦分叉，会出现「闸门说四个都在、预检说缺一个」这种谁也说不清的 red。
    expect(STORE_SECRET_NAMES).toEqual([
      'CHROME_EXTENSION_ID',
      'CHROME_PUBLISHER_ID',
      'CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL',
      'CHROME_SERVICE_ACCOUNT_PRIVATE_KEY',
    ]);
    for (const name of STORE_SECRET_NAMES) {
      expect(
        evaluate(GOOD).items.some(item => item.name === name),
        name,
      ).toBe(true);
    }
  });
});

describe('CHROME_API_VERSION：这一条是整条链路的 API 版本事实源', () => {
  it('缺省即红，且说的是「v1.1 已退役」而不是「格式不对」', () => {
    const detail = problemOf(with_({ CHROME_API_VERSION: undefined }), 'CHROME_API_VERSION');
    expect(detail).toContain('v1.1');
    expect(detail).toContain('2026-10-15');
  });

  it('写成 v1.1 红；大小写与空格都不给过（这一条是精确相等，不做宽容）', () => {
    for (const value of ['v1.1', 'V2', 'v2 ', '', '2']) {
      expect(problemOf(with_({ CHROME_API_VERSION: value }), 'CHROME_API_VERSION'), value).not.toBeNull();
    }
    expect(problemOf(GOOD, 'CHROME_API_VERSION')).toBeNull();
  });
});

describe('四项凭据：缺哪一条就说哪一条', () => {
  it('逐个删掉，恰好红那一条，别的不动', () => {
    for (const name of STORE_SECRET_NAMES) {
      expect(failingNames(with_({ [name]: undefined })), name).toEqual([name]);
    }
  });

  it('空串与纯空格都算「没配」——配了个空壳与没配在处置上是同一件事', () => {
    for (const value of ['', '   ', '\n']) {
      expect(failingNames(with_({ CHROME_PUBLISHER_ID: value })), JSON.stringify(value)).toEqual([
        'CHROME_PUBLISHER_ID',
      ]);
    }
  });

  it('「没配」与「形状不对」是两句话，不许合成一句', () => {
    // 处置完全不同：前者去改名或新增，后者去重新拿值。两条措辞各自点名自己的动作。
    expect(problemOf(with_({ CHROME_EXTENSION_ID: undefined }), 'CHROME_EXTENSION_ID')).toContain('没配');
    expect(problemOf(with_({ CHROME_EXTENSION_ID: 'abcdef' }), 'CHROME_EXTENSION_ID')).toContain('形状不对');
  });
});

describe('形状判据逐条有牙', () => {
  it('扩展 ID：只认 32 个 a–p 的小写字母', () => {
    for (const bad of [
      'abcdefghijklmno15pabcdefghijklmnop', // 数字（Chrome 的 ID 字母表没有它）
      'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP', // 大写
      'abcdefghijklmnopabcdefghijklmnopq', // 33 位
      'abcdefghijklmnopabcdefghijklmnop '.slice(0, 31), // 31 位
      'qrstuvwxyzabcdefghijklmnopabcdefg', // q–z 之间的字母
      `${'abcdefghijklmnop'.slice(0, 16)}../..${'abcdefghijklmnop'.slice(0, 12)}`, // 想往 URL 路径里塞东西
    ]) {
      expect(shapeProblem('CHROME_EXTENSION_ID', bad), bad).not.toBe('');
    }
    expect(shapeProblem('CHROME_EXTENSION_ID', EXTENSION_ID)).toBe('');
  });

  it('publisher ID：路径单段的字符集，`/` `?` `#` `%` 与空白一律不收', () => {
    for (const bad of ['../x', 'a b', 'a/b', 'a?b', 'a#b', 'a%2fb', ' ', '12345\n678']) {
      expect(shapeProblem('CHROME_PUBLISHER_ID', bad), bad).not.toBe('');
    }
    for (const good of [PUBLISHER_ID, 'abc-DEF.123_456']) {
      expect(shapeProblem('CHROME_PUBLISHER_ID', good), good).toBe('');
    }
  });

  it('服务账号邮箱只认 .iam.gserviceaccount.com 那一种', () => {
    for (const bad of [
      'me@gmail.com',
      'cws-ci@proj-42.serviceaccount.com', // 少了 .iam.
      'cws-ci@proj-42.iam.gserviceaccount.com.evil.test', // 后缀再挂一段
      'cws-ci@proj-42.iam.gserviceaccount.com ',
      'proj-42-service-account@proj-42.iam.gserviceaccount.com,extra',
      'cws ci@proj-42.iam.gserviceaccount.com',
    ]) {
      expect(shapeProblem('CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL', bad), bad).not.toBe('');
    }
    expect(shapeProblem('CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL', CLIENT_EMAIL)).toBe('');
  });

  it('私钥里那串字面 \\n 单独点名——它是手动粘贴最常见的错法，且报错形状与普通 PEM 错不同', () => {
    const doubleEscaped = PEM_PKCS8.replaceAll('\n', '\\n');
    const detail = privateKeyProblem(doubleEscaped);
    expect(detail).toContain('反斜杠');
    expect(detail).toContain('真换行');
    expect(detail).toContain('wxt submit init');
    // 阳性对照：同一份 PEM 原样交出必须是空串，否则上面那三句断言只是在读一段永远为真的文案。
    expect(privateKeyProblem(PEM_PKCS8)).toBe('');
  });

  it('私钥被截断、被换成非 PEM 文本，都红且不复读内容', () => {
    const truncated = PEM_PKCS8.slice(0, PEM_PKCS8.length - 40);
    expect(privateKeyProblem(truncated)).not.toBe('');
    expect(privateKeyProblem('not a key at all')).toContain('PEM');
    // 只用 code/reason/name 组那句话，`err.message` 在某些分支里会带上被解析的片段。
    expect(privateKeyProblem(truncated)).not.toContain(PEM_PKCS8.split('\n')[2]);
  });

  it('未知键名一律不判形状（判据不认识它就不该有意见）', () => {
    expect(shapeProblem('CHROME_SOMETHING_ELSE', '###')).toBe('');
  });
});

describe('v1.1 残留：只要带着值就红，且不看值对不对', () => {
  it('五个退役键逐个红，措辞点名「v2 的 schema 里没有它、会被 mask 掉」', () => {
    expect(RETIRED_V1_1_KEYS).toEqual([
      'CHROME_CLIENT_ID',
      'CHROME_CLIENT_SECRET',
      'CHROME_REFRESH_TOKEN',
      'CHROME_PUBLISH_TARGET',
      'CHROME_REVIEW_EXEMPTION',
    ]);
    for (const name of RETIRED_V1_1_KEYS) {
      const detail = problemOf(with_({ [name]: 'whatever' }), name);
      expect(detail, name).toContain('v1.1');
      expect(detail, name).toContain('mask');
    }
  });

  it('`trustedTesters` 这个取值不特殊对待：键在就红（v2 没有发布分组这一概念）', () => {
    // 这一条是用户明确要的那道护栏。它必须是「红」而不是「忽略」，因为忽略会让操作者以为
    // 自己在往测试通道发，而 Google 那头的包进了正式发布队列。
    expect(failingNames(with_({ CHROME_PUBLISH_TARGET: 'trustedTesters' }))).toContain('CHROME_PUBLISH_TARGET');
    expect(problemOf(with_({ CHROME_PUBLISH_TARGET: 'trustedTesters' }), 'CHROME_PUBLISH_TARGET')).toContain(
      '测试通道',
    );
  });

  it('空壳的退役键不红——本进程环境里「设成空串」与「没设」根本分不开，判据不许假装分得出', () => {
    expect(failingNames(with_({ CHROME_CLIENT_ID: '' }))).toEqual([]);
  });

  it('短时访问令牌红，理由是「它会过期，流水线拿不到新的」', () => {
    const detail = problemOf(
      with_({ CHROME_SERVICE_ACCOUNT_ACCESS_TOKEN: 'ya29.' }),
      'CHROME_SERVICE_ACCOUNT_ACCESS_TOKEN',
    );
    expect(detail).toContain('过期');
  });
});

describe('会改变发布形态的开关', () => {
  it('每一个列出来的开关在真值下都红，且理由各自点名它会做什么', () => {
    expect(SEMANTIC_SWITCHES.map(entry => entry.name)).toEqual(['CHROME_CANCEL_PENDING', 'CHROME_SKIP_REVIEW']);
    for (const { name, reason } of SEMANTIC_SWITCHES) {
      const detail = problemOf(with_({ [name]: 'true' }), name);
      expect(detail, name).toContain(reason.slice(0, 8));
    }
    // 这两个动作各自还在等不同的人：撤排队是「别人可能正在等」，跳审核是「本扩展不符合条件」。
    expect(problemOf(with_({ CHROME_CANCEL_PENDING: 'true' }), 'CHROME_CANCEL_PENDING')).toContain('排队');
    expect(problemOf(with_({ CHROME_SKIP_REVIEW: 'true' }), 'CHROME_SKIP_REVIEW')).toContain('跳过');
  });

  it('真值的口径 = true / 1（大小写无关），其余字符串不抢判据的位置', () => {
    for (const truthy of ['true', 'TRUE', '1']) {
      expect(failingNames(with_({ CHROME_CANCEL_PENDING: truthy })), truthy).toContain('CHROME_CANCEL_PENDING');
    }
    // `yes` 之类的值不归这里判红：`publish-browser-extension` 自己按 true/false 严格校验，
    // 它会在任何出网请求之前把那次运行判成 Invalid config。
    for (const falsy of ['false', '0', '', 'yes', 'on']) {
      expect(failingNames(with_({ CHROME_CANCEL_PENDING: falsy })), JSON.stringify(falsy)).toEqual([]);
    }
  });

  it('只是「被设置了」的键进 notes，不翻红', () => {
    const result = evaluate(with_({ CHROME_PUBLISH_TYPE: 'STAGED_PUBLISH' }));
    expect(result.ok).toBe(true);
    expect(result.notes.join('\n')).toContain('CHROME_PUBLISH_TYPE');
    // 清单本身也要对账：notes 只覆盖清单里的键，别哪天多一个开关却没人给它分类。
    expect(UNMODELED_KEYS).toEqual(['CHROME_PUBLISH_TYPE', 'CHROME_DEPLOY_PERCENTAGE', 'CHROME_SKIP_SUBMIT_REVIEW']);
    for (const name of UNMODELED_KEYS) {
      expect(evaluate(with_({ [name]: 'x' })).notes.join('\n'), name).toContain(name);
    }
  });
});

describe('报告卫生：一条值都不许进日志', () => {
  it('全红的那一份配置里，每个独特片段都不出现在渲染结果中', () => {
    // 探针挑的是「只有值本身才有」的片段：密钥体、ID 前缀、邮箱那两段。
    // 注意不能用 `-----BEGIN PRIVATE KEY-----` 那种公共样板——判据文案里就该写它，命中它不是泄漏。
    const probes = [
      PEM_PKCS8.split('\n')[2],
      PEM_PKCS8.split('\n').at(-3) ?? '',
      EXTENSION_ID.slice(0, 12),
      PUBLISHER_ID,
      'cws-ci',
      'proj-42',
      'trustedTesters',
    ];
    const broken = with_({
      CHROME_EXTENSION_ID: 'nope',
      CHROME_PUBLISHER_ID: '../x',
      CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL: 'me@gmail.com',
      CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: PEM_PKCS8.replaceAll('\n', '\\n'),
      CHROME_PUBLISH_TARGET: 'trustedTesters',
    });
    const text = render(evaluate(broken));
    for (const probe of probes) expect(text, probe).not.toContain(probe);
    // 阳性对照：判据确实红过，否则「不含值」只是因为什么都没写。
    expect(text).toContain('✗');
    expect(brokenNamesIn(text)).toEqual(expect.arrayContaining(['CHROME_EXTENSION_ID', 'CHROME_PUBLISH_TARGET']));
  });
});

/** 从报告里数出被点名的键名，用来给上面那条做阳性对照。 */
function brokenNamesIn(text: string): string[] {
  return [...text.matchAll(/`([A-Z_]+)`/g)].map(match => match[1]);
}

describe('mergeEnvFile：与本仓库文档教的那份 .env.submit 同一种形状', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cws-preflight-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('文件不存在时只交本进程环境，且不编造一个文件名', () => {
    const merged = mergeEnvFile(join(dir, 'nope.env'), { CHROME_PUBLISHER_ID: 'from-env' });
    expect(merged.env).toEqual({ CHROME_PUBLISHER_ID: 'from-env' });
    expect(merged.fileName).toBeUndefined();
  });

  it('`wxt submit init` 写出的那份（多行引号包住真换行 PEM）能原样读回来', () => {
    // 这份夹具按 `setDotenvValue` 的实际写法手写：值里有换行就用双引号包住，换行是**真的**换行。
    // 测它是为了回答一个具体的问题——离线预检与 `wxt submit` 会不会读到两份不一样的私钥。
    const file = join(dir, 'good.env');
    writeFileSync(
      file,
      [
        'CHROME_API_VERSION=v2',
        `CHROME_EXTENSION_ID=${EXTENSION_ID}`,
        `CHROME_PUBLISHER_ID=${PUBLISHER_ID}`,
        `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL=${CLIENT_EMAIL}`,
        `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY="${PEM_PKCS8}"`,
        '',
      ].join('\n'),
      'utf-8',
    );
    const merged = mergeEnvFile(file, {});
    expect(merged.env.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY).toBe(PEM_PKCS8);
    const result = evaluate(merged.env, { fileName: merged.fileName });
    expect(result.ok).toBe(true);
    expect(result.notes.join('\n')).toContain('good.env');
  });

  it('同名时本进程环境覆盖文件（与 publish-browser-extension 的 `??=` 同一个方向）', () => {
    const file = join(dir, 'override.env');
    writeFileSync(file, 'CHROME_PUBLISHER_ID=from-file\n', 'utf-8');
    expect(mergeEnvFile(file, { CHROME_PUBLISHER_ID: 'from-env' }).env.CHROME_PUBLISHER_ID).toBe('from-env');
    expect(mergeEnvFile(file, {}).env.CHROME_PUBLISHER_ID).toBe('from-file');
  });

  it('读不动的文件不抛：预检照样按「没配」红在该红的地方', () => {
    const merged = mergeEnvFile(join(dir, 'a-broken', 'nested.env'), GOOD);
    expect(merged.fileName).toBeUndefined();
    expect(evaluate(merged.env).ok).toBe(true);
  });
});
