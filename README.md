<div align="center">

# Cross-Origin Proxy — CORS debugging & API environment switcher

**English** | [简体中文](./README.zh-CN.md)

**Point a FAT frontend at a UAT backend with one browser rule — no code changes, no backend CORS edits, no rebuild.**

[![Star this repo](https://img.shields.io/github/stars/liaolongdong/cross-origin-proxy?style=for-the-badge&logo=github&label=%E2%AD%90%20Star%20this%20repo&color=yellow)](https://github.com/liaolongdong/cross-origin-proxy/stargazers)

<br/>

![Cross-Origin Proxy rules overview](./docs/assets/img/rules-overview.jpg)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)
&nbsp;
[![CI](https://img.shields.io/github/actions/workflow/status/liaolongdong/cross-origin-proxy/ci.yml?style=for-the-badge&label=CI&logo=github)](https://github.com/liaolongdong/cross-origin-proxy/actions/workflows/ci.yml)
&nbsp;
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-409eff?style=for-the-badge&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
&nbsp;
[![Chrome](https://img.shields.io/badge/Chrome-110%2B-409eff?style=for-the-badge&logo=googlechrome&logoColor=white)](#install)
&nbsp;
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=for-the-badge)](./CONTRIBUTING.md)

> Your frontend runs against FAT, the fix you need only exists on UAT. Instead of editing a devServer proxy per project, hardcoding a token, or asking the backend to open CORS and redeploy, you add one rule in Chrome: match `https://fat-api.example.com/*`, target `https://uat-api.example.com`, done. The same rule set can also rewrite headers and responses, mock data, inject latency, block requests and forward WebSocket.

[Install](#install) · [How it works](#how-it-works) · [Features](#features) · [Use cases](#use-cases) · [FAQ](#faq) · [Contributing](./CONTRIBUTING.md)

</div>

---

## Why this exists

Cross-environment debugging normally costs one of three things: a backend change, a config change in every project, or a fake local build. This extension collapses all three into a browser rule.

| Without it                                                                       | With one rule                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Edit the devServer proxy table, restart the dev server                           | Save a wildcard rule; it applies immediately, to every project in the browser              |
| Ask the backend to allow your origin in `Access-Control-Allow-Origin` + redeploy | Advanced-capability requests are issued by the extension, so page CORS checks do not apply |
| Hardcode another environment's token in source and remember to revert it         | Inject the header per rule, switch the rule off when you are done                          |
| Wait for an API that is still being built                                        | Mock the response in the rule; application code stays untouched                            |

Built with [WXT](https://wxt.dev) + Vue 3 + TypeScript + Element Plus + Vite, on Manifest V3.

## Install

Requires a recent desktop Google Chrome (Manifest V3). The Chrome Web Store listing is in preparation — until then, load the unpacked build.

```bash
git clone https://github.com/liaolongdong/cross-origin-proxy
cd cross-origin-proxy
pnpm install
pnpm build
```

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select `.output/chrome-mv3`.

### First rule in one minute

1. Click the extension icon and turn on **Proxy Switch**.
2. Click **Manage Rules** — the options page opens with the rule form ready.
3. Fill in a rule:

   | Field         | Description                                                        |
   | ------------- | ------------------------------------------------------------------ |
   | Match type    | `wildcard` (`https://fat-api.example.com/*`), `prefix`, or `regex` |
   | Match pattern | The URL pattern to intercept                                       |
   | Target URL    | Where matched requests are redirected                              |
   | Priority      | Lower number = matched first                                       |

4. Reload the page. Requests matching an enabled rule are proxied; check **Request Logs** to confirm.

## How it works

Every enabled rule is classified once, on save. Rules that only rewrite the URL become `declarativeNetRequest` dynamic rules and are resolved by the browser's network stack — zero JavaScript per request. Everything richer runs through the background channel.

```
Page fetch / XHR / WebSocket
   │
   ├── simple rule (URL rewrite only) ──► declarativeNetRequest redirect
   │                                      network layer, zero JS per request
   │
   └── complex rule ───────────────────► page interceptor (MAIN world, postMessage)
                                            └► bridge (ISOLATED world, chrome.runtime)
                                                 └► background request ──► response back to page
```

A rule stops being "simple" as soon as it has any of: request header or body override, response override, mock, delay, block, retry, HTTP method filter, query parameter injection, a `ws://`/`wss://` target, a wildcard that does not end in `*`, or an empty target URL. Those conditions exist because the network layer genuinely cannot express them — see [utils/urlMatcher.ts](./utils/urlMatcher.ts).

**CORS, precisely.** Rules on the background channel are issued by the extension, which holds host permissions, and the page receives a response the extension constructed — page CORS checks do not apply. A pure network-layer redirect still gets `Access-Control-Allow-Origin` validated. If a target environment does not allow your origin, add any capability to the rule (a response header override is the cheapest) and it switches channels.

**Fallback.** If interception fails, the page falls back to native `fetch` / `XMLHttpRequest` / `WebSocket`, so requests still go out normally. Block rules are the deliberate exception: a blocked request is never replayed.

## Features

### Request proxy & modification

- **Rule-based URL rewriting** — match by wildcard, prefix or regex, then redirect to a target environment
- **Request header overrides** — inject or replace headers per rule (e.g. the target environment's auth token)
- **Request body override** — replace the original body with custom content
- **Response modification** — override status code, response headers, or individual JSON fields by dot-notation path (`data.token`)
- **Mock response** — return custom JSON / text / HTML / XML without hitting any server
- **Conditional mock** — attach conditions (URL pattern, HTTP method, query params) and the first match decides the body, status and content type
- **Request delay injection** — 0–60000 ms of artificial latency to exercise loading and timeout states
- **Request blocking** — block matched requests entirely (network error) to test failure and offline fallback paths
- **Retry on failure** — re-issue on a network error or a 5xx response, 0–5 attempts with a configurable interval
- **HTTP method filtering** — restrict a rule to GET/POST/PUT/…; empty means any method
- **Query parameter injection** — append or override query params on the proxied URL (`__env=uat`, gray-release tags) without rewriting the whole URL
- **WebSocket proxying** — redirect `ws://` / `wss://` connections by URL rewrite, handled in the page interceptor

### Rule management

- Add / edit / duplicate / delete via a visual form
- **Quick templates** for the common shapes (wildcard API proxy, prefix path, auth header, header override) and **undo** immediately after a delete
- **Drag-and-drop reordering** of priority (grab the ⠿ handle)
- **Capability badges** on every rule: **H** headers · **B** body · **R** response · **M** mock · **D** delay · **X** block · **WS** WebSocket
- Per-rule and batch enable / disable
- **Batch migrate target URLs** — find/replace part of the target domain across selected rules, with a live change preview
- Search and filter by name, pattern and status
- **Conflict warning** when the rule being edited is shadowed by a higher-priority rule with the same pattern, so a rule that can never fire does not go unnoticed

### Logs & debugging

- Request log panel: method, status, duration, plus hit statistics for both channels — DNR over the last 5 minutes and service-worker hits since the last config change
- Log detail viewer: full request/response headers and body, JSON auto-formatted
- **Copy as cURL** on any log entry, and **create a rule** straight from a captured request
- Filter by method, status, rule or URL keyword
- **URL match tester** in the header bar: type any URL (optionally with a method) to preview the matched rule, rewritten URL, forwarding channel and shadowed rules in real time

### Import, export, environments

- Config import/export as JSON
- **HAR 1.2** export of captured requests, and HAR import that auto-creates rules from recorded traffic
- **cURL import** — paste DevTools' "Copy as cURL" output to prefill a rule
- **Environment profiles** — save the current rule set as a named snapshot and switch between FAT / UAT / PROD
- Auto-off countdown (`chrome.alarms`, survives service-worker restarts) and a badge that shows proxy state

### Interface

- Popup quick panel: global switch, today's stats, recent requests, auto-off countdown, **current-page hit preview**, and "Create rule for this page" prefilled from the active tab
- English / 简体中文 UI, six themes with light / dark / system modes
- Keyboard shortcuts: <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>P</kbd> toggle proxy, <kbd>⌘</kbd>+<kbd>N</kbd> new rule, <kbd>/</kbd> focus search, <kbd>Esc</kbd> close

## Use cases

| Situation                                     | Rule configuration                                 |
| --------------------------------------------- | -------------------------------------------------- |
| Verify a UAT-only fix from a FAT page         | Wildcard rewrite of the API prefix to the UAT host |
| Build UI before the backend exists            | Mock response with a crafted body and status       |
| Prove loading and timeout paths               | Delay of 3000–60000 ms on the endpoint             |
| Check offline / 500 fallback UI               | Block the request, or override the response status |
| Exercise a gray-release or A/B branch         | Query parameter injection                          |
| Debug a real-time feature against another env | WebSocket rewrite                                  |
| Send only writes to the test backend          | Method filter on `POST` / `PUT` / `DELETE`         |
| Hand the same setup to a teammate             | Export JSON, or share HAR-derived rules            |

## FAQ

<details open>
<summary><strong>Does this bypass CORS?</strong></summary>

For rules on the background channel, yes — the extension issues the request and hands the page a constructed response, so page CORS checks never run. A pure URL rewrite becomes a network-layer redirect, and the browser still validates `Access-Control-Allow-Origin` on the redirected response. Add any capability to the rule to move it to the background channel.

</details>

<details>
<summary><strong>Does it work on any site?</strong></summary>

Content scripts run on all `http` / `https` pages and rules match on request URL, so internal tools, `localhost` dev servers and staging domains all work. Chrome blocks extensions on `chrome://` pages, the Web Store and other extension pages.

</details>

<details>
<summary><strong>Is any data sent anywhere?</strong></summary>

No. Rules, logs, profiles and preferences stay in `chrome.storage.local`. There is no analytics, no telemetry and no remote service; the only network traffic is the API traffic you ask it to proxy. See the [privacy policy](https://liaolongdong.github.io/cross-origin-proxy/privacy.html).

</details>

<details>
<summary><strong>Why is my rule using the slow channel?</strong></summary>

Because it has a capability the network layer cannot express, or because it is a wildcard not ending in `*` / has an empty target — both would silently change the redirect result if compiled anyway. The URL match tester shows the channel for any URL.

</details>

<details>
<summary><strong>What are the limits?</strong></summary>

200 rules, the last 500 log entries, 10 MB request body, 0–60000 ms delay, and mocked status codes clamped to 200–599 so the page can always build a valid `Response`.

</details>

<details>
<summary><strong>Firefox or Edge?</strong></summary>

Built and tested for Chrome (MV3). Edge runs Chromium extensions so the same build normally works; Firefox is not a supported target today because of `declarativeNetRequest` differences.

</details>

## Permissions

| Permission                      | Why needed                                                              |
| ------------------------------- | ----------------------------------------------------------------------- |
| `storage`                       | Persist rules, logs, profiles and preferences                           |
| `declarativeNetRequest`         | Network-layer redirects for simple rules (zero JS per request)          |
| `declarativeNetRequestFeedback` | Rule hit statistics shown in the log drawer                             |
| `alarms`                        | Service-worker keepalive and the auto-off countdown                     |
| `<all_urls>` (host permission)  | Proxying must work on any frontend origin; targets are your own domains |

Every permission also has a store-facing justification in [CHROMEWEBSTORE.md](./CHROMEWEBSTORE.md).

## Development

```bash
pnpm dev         # WXT dev server with HMR (port 8899)
pnpm build       # production build → .output/chrome-mv3
pnpm build:zip   # build + zip for store upload
pnpm test        # vitest unit tests
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint (--fix: pnpm lint:fix)
pnpm lint:style  # stylelint (recess-order property sorting)
pnpm format:check# prettier (--write: pnpm format)
pnpm assets      # regenerate store + landing images
```

Requires Node.js 20+ and pnpm 10 (see `packageManager`). CI runs lint, typecheck, stylelint and tests on every push and pull request — see [.github/workflows/ci.yml](./.github/workflows/ci.yml).

### Project layout

```
entrypoints/            WXT entries: background (+ modules), content scripts, options, popup
  background/           autoOff · badgeManager · dnrManager · dnrStats · keepalive · messageRouter · proxyHandler
  main-interceptor.content.ts   MAIN-world fetch/XHR/WebSocket interceptor (self-contained by design)
  content.ts           ISOLATED-world bridge to the background worker
components/options/     Options UI (App.vue assembles; dialogs/drawers load via defineAsyncComponent)
composables/            Reactive state and side effects
utils/                  Framework-free domain logic: urlMatcher · dnrRules · storage · curlParser · har · i18n · theme …
locales/                In-app UI strings (zh_CN / en, split into common/options/popup)
public/_locales/        Manifest name and description only
docs/                   GitHub Pages product site: index.html (en) · zh.html · privacy.html · llms.txt
tests/                  Vitest suites (node environment)
```

### Deeper guides

<details>
<summary>Mock response · delay · block · response modification</summary>

**Mock response** — toggle Mock Response in the rule form, set the status code (default 200), pick a Content-Type (JSON / text / HTML / XML) and paste the body. Useful when the backend API does not exist yet.

**Request delay** — toggle Request Delay and set milliseconds (0–60000). Useful for loading states, skeletons and timeout handling.

**Request blocking** — toggle Block Request. Matched requests receive a network error, which is how you test error handling and offline fallback behaviour.

**Response modification** — expand Response Overrides to set a status code, add or replace response headers, or replace specific JSON fields by dot-notation path (e.g. `data.token` → `"mock-token"`).

</details>

<details>
<summary>Drag-and-drop ordering · HAR · cURL · log detail viewer</summary>

**Reordering** — drag the ⠿ handle on any row. The table shows rules in array order, and dragging updates both display order and priority values.

**HAR** — the Import/Export dialog exports captured background-channel logs as a `.har` file, and imports a `.har` file to auto-create rules from recorded traffic.

**cURL import** — paste a cURL command into the Import cURL section (line continuations and single/double quotes supported) and press Parse & Create Rule. A wildcard rule is generated from the request origin with headers and body prefilled.

**Log detail viewer** — click any log row for request URL, headers and body, response headers and body (JSON auto-formatted), error details, and a Copy as cURL button.

</details>

## Contributing

Small fixes are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the three-step flow, the i18n rule (every visible string needs both `locales/zh_CN/` and `locales/en/`), and which checks must pass before a PR.

## License

[MIT](./LICENSE) · Copyright (c) 2026 Better

---

<div align="center">

**If this saved you a backend deploy, a star helps others find it:**

[![Star this repo](https://img.shields.io/github/stars/liaolongdong/cross-origin-proxy?style=for-the-badge&logo=github&label=Star&color=yellow)](https://github.com/liaolongdong/cross-origin-proxy/stargazers)
&nbsp;
[![Product page](https://img.shields.io/badge/Product_page-GitHub_Pages-409eff?style=for-the-badge&logo=githubpages&logoColor=white)](https://liaolongdong.github.io/cross-origin-proxy/)

</div>
