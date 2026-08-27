# Cross-Origin Proxy Assistant

**English** | [简体中文](./README.zh-CN.md)

A Chrome extension (Manifest V3) that proxies frontend API requests across environments — for example, letting a FAT frontend call UAT backend APIs — without touching your application code or backend CORS config.

Built with [WXT](https://wxt.dev) + Vue 3 + Element Plus + TypeScript.

## Features

- **Rule-based URL rewriting** — match requests by wildcard, prefix, or regex, then redirect them to a target environment
- **Dual proxy channels**
  - Simple rules (no header overrides) run as `declarativeNetRequest` (DNR) dynamic rules — redirected at the browser network layer with zero JS overhead
  - Complex rules (with header overrides) run through a Service Worker `fetch` channel that intercepts page `fetch`/XHR calls
- **Header overrides** — inject or replace request headers per rule (e.g., auth tokens for the target environment)
- **Rule management** — add / edit / duplicate / delete, priority ordering, per-rule and batch enable/disable, search and filter
- **Request logs** — recent proxied requests with method, status, duration, and DNR hit statistics
- **Import / Export** — back up and restore the full rule config as JSON
- **Popup quick panel** — global proxy switch, today's stats, recent requests, and one-click deep links into the options page (add rule / logs / import-export)
- **i18n & themes** — English / 简体中文 UI, six color themes

## Installation

### From source

```bash
pnpm install
pnpm build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `.output/chrome-mv3`.

### Development

```bash
pnpm dev   # starts WXT dev server with HMR on port 8899
```

## Usage

1. Click the extension icon and toggle **Proxy Switch** on.
2. Click **Manage Rules** in the popup — the options page opens with the add-rule form ready (an already-open options tab is reused instead of opening a duplicate).
3. Create a rule:

   | Field | Description |
   |---|---|
   | Match type | `wildcard` (`https://fat-api.example.com/*`), `prefix`, or `regex` |
   | Match pattern | The URL pattern to intercept |
   | Target URL | Where matched requests are redirected |
   | Priority | Lower number = matched first |
   | Header overrides | Optional headers to inject (rule switches to the SW fetch channel) |

4. Requests from any page that match an enabled rule are transparently redirected. Check **Request Logs** for what was proxied.

> Regex rules used by the DNR channel must be RE2-compatible; incompatible patterns are skipped for DNR (with a warning) but still work in the SW channel when they carry header overrides.

## Architecture

```
Page fetch / XHR
   │
   ├── matches simple rule ──► DNR dynamic rule ──► redirected at network layer
   │
   └── matches complex rule ─► MAIN-world interceptor (postMessage)
                                  └► ISOLATED-world bridge (chrome.runtime)
                                       └► Background SW fetch ──► response back to page
```

- `entrypoints/background/` — DNR sync, message routing, SW proxy execution, keepalive
- `entrypoints/main-interceptor.content.ts` — MAIN-world `fetch`/XHR interceptor (falls back to native on any failure)
- `entrypoints/content.ts` — ISOLATED-world bridge between the page and the Service Worker
- `components/options/` — options UI (rule table, form dialog, logs drawer, import/export)
- `utils/` — storage, DNR rule builder, URL matcher, i18n

## Permissions

| Permission | Why |
|---|---|
| `storage` | Persist rules, logs, and preferences |
| `declarativeNetRequest` | Network-layer URL redirection for simple rules |
| `declarativeNetRequestFeedback` | DNR hit statistics shown in the logs drawer |
| `alarms` | Periodic Service Worker keepalive ping |
| `<all_urls>` | Intercept and proxy requests on any site you use it on |

## Limits

- Up to **200 rules** (enforced on add)
- Request log keeps the most recent **500 entries**

## Scripts

```bash
pnpm dev         # dev server with HMR
pnpm build       # production build to .output/chrome-mv3
pnpm build:zip   # build + zip for store upload
pnpm test        # vitest unit tests
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
pnpm format      # prettier
```
