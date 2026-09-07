# Contributing

Thanks for taking the look. This is a small, focused Chrome extension for cross-environment API debugging, and the bar for a change is: **it must not break an existing rule's behaviour, an existing interaction, or a user's requests.**

中文要点见文末「贡献要点（中文）」。

## The three-step flow

1. **Fork and branch** off `main`. One concern per branch — `fix/dnr-regex-boundary`, not `misc-improvements`.
2. **Make the change and run the checks** that match what you touched:

   | What you changed                         | Must pass                                                     |
   | ---------------------------------------- | ------------------------------------------------------------- |
   | TypeScript / Vue                         | `pnpm typecheck` `pnpm lint` `pnpm test`                      |
   | CSS or `<style>` blocks                  | `pnpm lint:style` (recess-order property sorting is enforced) |
   | Storage, messaging, matching or rewrites | `pnpm test` (full suite)                                      |
   | Entrypoints, manifest, deps, bundling    | `pnpm build`                                                  |
   | Docs, JSON, Markdown                     | `pnpm exec prettier --check <the files you touched>`          |

   There is no git hook in this repository, so these run manually (and in CI).

3. **Open a pull request** describing the behaviour before and after, the commands you ran with their results, and any limitation you could not verify.

## Setting up

```bash
pnpm install          # pnpm 10, per the packageManager field; Node.js 20+
pnpm dev              # WXT dev server with HMR on port 8899
pnpm build            # → .output/chrome-mv3
```

Load `.output/chrome-mv3` unpacked at `chrome://extensions` to try it. Run `pnpm assets` only when you want to regenerate the store and landing-page images from `screenshots/`.

## Conventions worth knowing before you write code

- **Two forwarding channels.** `isSimpleRule()` in [utils/urlMatcher.ts](./utils/urlMatcher.ts) decides whether a rule becomes a `declarativeNetRequest` redirect or runs in the background. If you change what counts as "simple", both channels must stay semantically identical for URL rewriting, and the URL match tester must keep reporting the truth.
- **`chrome.storage.local` is the only source of truth.** The service worker is killed at any time; anything cached in memory must be rebuildable and invalidated on `storage.onChanged`. Read-modify-write sequences go through `withStorageLock()`.
- **Validate before touching DNR.** Regular expressions must pass `isRegexSupported` (RE2) and substitution references must be in range, or `updateDynamicRules` rejects the entire batch.
- **The MAIN-world interceptor stays self-contained.** [entrypoints/main-interceptor.content.ts](./entrypoints/main-interceptor.content.ts) cannot import the logger or use `chrome.*`, and posts messages with `window.location.origin` as the target origin, never `*`.
- **Treat input as untrusted.** Imported HAR/cURL/JSON files, page messages and storage contents are all validated at the boundary; messages that change state are checked with `isTrustedSender`.
- **Logging goes through `utils/logger.ts`** — no bare `console` in runtime code (the interceptor, the logger itself and `scripts/` are the documented exceptions).
- **Never weaken a rule to make code pass.** No broad `eslint-disable`, no `@ts-ignore`, no loosening `tsconfig`, Stylelint or test assertions.
- **Element Plus is imported on demand** through the existing resolver; keep the popup and options first paint small, and heavy dialogs/drawers behind `defineAsyncComponent`.

## Internationalisation

Every visible string needs both languages, and the two key sets must stay identical:

- In-app UI: `locales/zh_CN/{common,options,popup}.json` and `locales/en/{common,options,popup}.json`, consumed through `useI18n()`'s `t()`.
- Manifest name/description: `public/_locales/{zh_CN,en}/messages.json`. Chrome enforces `name` ≤ 75 characters and `description` ≤ 132 characters, and [tests/build-verification.test.ts](./tests/build-verification.test.ts) guards both.
- User-facing docs: `README.md` and `README.zh-CN.md` state the same facts.

## Tests

- Suites live in `tests/*.test.ts` and run in Vitest's node environment. Pure modules (`urlMatcher`, `dnrRules`, `curlParser`, `har`, `formatters`) are unit-testable directly.
- For a bug fix, add a regression test that **fails before the fix and passes after** — that is the strongest thing you can contribute.
- For a feature, cover success, failure and the interesting boundary.
- Do not delete, skip or soften an existing assertion to get green.

## Scope

Refactors are welcome when they are adjacent to the change you are making. What is not welcome: repository-wide restyling, renaming for taste, or a "while I was in there" behaviour change bundled into a fix. If a change would alter matching semantics, storage shape, defaults, permissions, or any visible behaviour, open an issue first and describe the trade-off.

## Versioning and releasing

You normally do not need any of this to send a patch — the maintainers cut releases. It is written down so a PR does not accidentally break the pipeline:

- **The version lives in `package.json` only.** `wxt.config.ts` deliberately does not declare `manifest.version`; WXT derives it (and strips pre-release suffixes). Re-adding it creates a second source of truth that will drift, and [tests/build-verification.test.ts](./tests/build-verification.test.ts) fails on drift on purpose.
- **User-visible changes need a `CHANGELOG.md` entry.** Add a bullet under `Unreleased` or, when cutting a version, a `## [x.y.z] - YYYY-MM-DD` section — the release workflow cuts that exact section into the GitHub Release notes, so a missing section silently downgrades to auto-generated notes.
- **Pushing a `v*` tag is the release.** It runs [`.github/workflows/release.yml`](./.github/workflows/release.yml): full verify, build + zip, GitHub Release, then Chrome Web Store upload and review submission when the store secrets are configured. Never tag a commit you have not run the checks on.
- **Docs under `docs/` are the product site.** Pushing to `main` deploys it via `.github/workflows/deploy-pages.yml`, and that is where the privacy-policy URL the store requires is served — so a broken link in `docs/` is a store-review blocker, not a cosmetic issue.
- Repository display settings (About, topics, Pages source) are operator-only and listed in [GITHUB.md](./GITHUB.md).

The full release runbook, including the one-time store credentials, is [RELEASING.md](./RELEASING.md).

## 贡献要点（中文）

1. 从 `main` 分支拉分支，一个分支只解决一件事。
2. 按改动范围跑对应检查：TS/Vue 跑 `pnpm typecheck` + `pnpm lint` + `pnpm test`；样式跑 `pnpm lint:style`；入口/清单/依赖/打包跑 `pnpm build`；文档与 JSON 跑 `pnpm exec prettier --check <改动文件>`。仓库没有 git hook，靠手动与 CI 保证。
3. PR 描述要写清「改动前行为 / 改动后行为 / 跑了哪些命令及结果 / 未能验证的部分」。

关键约束：`isSimpleRule()` 决定规则走 DNR 还是后台通道，改它必须保证两条通道的重写语义一致；`chrome.storage.local` 是唯一事实来源，内存缓存必须可重建并在 `storage.onChanged` 失效；DNR 同步前必须过 RE2 与替换引用校验，否则整批规则被拒；MAIN world 拦截器必须自包含（不能 import logger、不能用 `chrome.*`）；页面 DOM、导入文件、runtime message 与 storage 数据都按不可信输入处理；日志统一走 `utils/logger.ts`；禁止用 `eslint-disable`、`@ts-ignore` 或降低断言来绕过问题；新增可见文案必须同时补齐中英文，且 `name` ≤ 75、`description` ≤ 132 字符由测试守卫。

## License

By contributing you agree that your contributions are released under the [MIT License](./LICENSE).
