# Cross-Origin Proxy Assistant

**English** | [简体中文](./README.zh-CN.md)

A Chrome extension (Manifest V3) that proxies frontend API requests across environments — for example, letting a FAT frontend call UAT backend APIs — without touching your application code or backend CORS config.

Built with [WXT](https://wxt.dev) + Vue 3 + Element Plus + TypeScript.

## Core Features

### Request Proxy & Modification

- **Rule-based URL rewriting** — match requests by wildcard, prefix, or regex, then redirect them to a target environment
- **Request header overrides** — inject or replace request headers per rule (e.g., auth tokens for the target environment)
- **Request body override** — replace the original request body with custom content
- **Response modification** — override response status code, headers, or JSON body fields (dot-notation path replacement like `data.token`)
- **Mock response** — return custom mock data (JSON/text/HTML) without hitting the target server, perfect for frontend development without a backend
- **Request delay injection** — add artificial latency (0–60s) to simulate slow networks and test loading/timeout states
- **Request blocking** — block matched requests entirely (returns network error), for testing error handling and offline fallback behavior

### Dual Proxy Channels

- **DNR channel** — simple rules (no header/body/response overrides) run as `declarativeNetRequest` dynamic rules, redirected at the browser network layer with zero JS overhead
- **SW fetch channel** — complex rules (with any overrides, mock, delay, or blocking) run through a Service Worker `fetch` channel that intercepts page `fetch`/XHR calls

### Rule Management

- **Add / edit / duplicate / delete** rules with a visual form
- **Drag-and-drop reordering** — drag the ⠿ handle to reorder rules by priority
- **Capability badges** — visual indicators on each rule showing what it does:
  - **H** (blue) — header overrides
  - **B** (amber) — request body override
  - **R** (green) — response overrides
  - **M** (purple) — mock response
  - **D** (cyan) — request delay
  - **X** (red) — request blocking
- **Priority ordering** — lower number = matched first
- **Per-rule and batch enable/disable**
- **Search and filter** by name, pattern, status

### Request Logs & Debugging

- **Request log panel** — recent proxied requests with method, status, duration, and DNR hit statistics
- **Log detail viewer** — click any log row to see full request/response headers and body (JSON auto-formatted)
- **Copy as cURL** — one-click export of any log entry as a `curl` command
- **Filter by method, status, rule, URL keyword**

### Import / Export

- **Config import/export** — back up and restore the full rule config as JSON
- **HAR import/export** — export captured SW-channel logs as standard HAR 1.2 format; import HAR files to auto-create proxy rules from traffic

### Environment Profiles

- **Named configuration snapshots** — save your current rule set as a named environment profile
- **Quick switch** between environments (e.g., FAT, UAT, PROD)

### UI / UX

- **Popup quick panel** — global proxy switch, today's stats, recent requests, and one-click deep links into the options page
- **i18n** — English / 简体中文 UI
- **6 color themes** with light / dark / system modes
- **Keyboard shortcuts** — `Cmd+N` add rule, `/` focus search, `Esc` close dialogs
- **Pattern match test panel** — test URL matching and rewriting in real time

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

## Usage Guide

### Basic Proxy Rule

1. Click the extension icon and toggle **Proxy Switch** on.
2. Click **Manage Rules** in the popup — the options page opens with the add-rule form ready.
3. Create a rule:

   | Field | Description |
   |---|---|
   | Match type | `wildcard` (`https://fat-api.example.com/*`), `prefix`, or `regex` |
   | Match pattern | The URL pattern to intercept |
   | Target URL | Where matched requests are redirected |
   | Priority | Lower number = matched first |

4. Requests from any page that match an enabled rule are transparently redirected. Check **Request Logs** for what was proxied.

### Mock Response

Enable **Mock Response** in the rule form to return custom data without hitting the target server:

1. Toggle Mock Response on
2. Set the status code (default 200)
3. Choose Content-Type (JSON, text, HTML, XML)
4. Enter the mock response body

Useful for frontend development when the backend API isn't ready.

### Request Delay

Enable **Request Delay** to add artificial latency:

1. Toggle Request Delay on
2. Set the delay in milliseconds (0–60000)

Useful for testing loading states, skeleton screens, and timeout handling.

### Request Blocking

Enable **Block Request** to completely block matched requests:

1. Toggle Block Request on

The matched requests will receive a network error. Useful for testing error handling and offline fallback behavior.

### Response Modification

Expand **Response Overrides** in the rule form to modify responses:

- **Status code** — override the response status
- **Response headers** — add or override response headers
- **JSON body replacements** — replace specific fields using dot-notation paths (e.g., `data.token` → `"mock-token"`)

### Drag-and-Drop Reordering

Drag the ⠿ handle on any rule row to reorder. The table displays rules in array order, and drag-and-drop updates both the display order and the priority values.

### HAR Import / Export

- **Export**: Open the Import/Export dialog and click **Export HAR** to download captured request/response logs as a `.har` file.
- **Import**: Click **Import HAR**, select a `.har` file, and the extension will auto-create proxy rules from the traffic entries.

### Log Detail Viewer

Click any row in the Request Logs table to expand a detail panel showing:
- Request URL, headers, and body
- Response headers and body (JSON auto-formatted)
- Error details (if any)
- **Copy as cURL** button to export the request as a curl command

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
- `utils/` — storage, DNR rule builder, URL matcher, i18n, HAR utilities

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
