---
title: "Admin frontend"
spec: "04"
status: Normative
scope: Structure, architecture, data flow, layout, visual system, UI and UX rules of the operator dashboard (`packages/dashboard`), and how it consumes the admin REST and WebSocket contracts.
audience: Contributors building dashboard pages and shared components; reviewers checking UI behaviour and accessibility.
related:
  - 00-decisions.md
  - 03-admin-backend.md
  - 05-coding-standards.md
  - 06-ci-cd-local-dev.md
  - 09-testing.md
---

# 04 — Admin Frontend (`packages/dashboard`)

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Scope: structure, architecture, data flow, layout logic, UI and UX rules of the operator dashboard. Stack per D-11; wire contracts per D-05; realtime per D-10; auth per D-09. Every operator workflow the admin API supports has a surface described here (§1 principle 2); what the dashboard deliberately does not cover is listed in §16.

---

## 1. Principles (falsifiable)

1. **URL is the shareable state.** Every filter, sort, page, tab, time window, expanded activity row and live-pane toggle is in the URL. Pasting a URL reproduces the view. Exceptions, by design: row selection (local, reset when the filters change), split ratios and focus mode, density, sidebar pin, stream quality and the logs tail's live/paused state (per-device `localStorage` or component state, §4.6). Selection stays local because a shared URL MUST NOT carry a selection that a bulk delete or terminate would act on; the tail's paused state stays local because a tail restored paused from a link silently shows stale records; layout choices are per device because screens differ. Test: no page component holds `useState` for a filter, sort, page or tab.
2. **Every operator capability has a surface.** Each operator-facing admin API operation (spec 03) is reachable from a page, dialog, menu or the palette. Test: every `operationId` in `packages/contracts/src/http/endpoints.ts` is called through `useApi()` somewhere under `packages/dashboard/src`, is covered by another channel (per-kind session lists by the timeline, REST input by the WS `input` command, `HEAD` probes, `/docs`, `/openapi.json`, `/ws`), or is listed in §16.
3. **Mobile is first-class.** Every route is usable at 390 px including takeover (touch). Test: at 390/1024/1440/1920 in both themes there is zero horizontal document overflow, no text under 12 px, and every primary action is reachable.
4. **Light and dark are equals, system is default.** Test: the `/theme` page shows every token pair at ≥ 4.5:1 text / ≥ 3:1 non-text in both themes.
5. **WCAG 2.2 AA.** Test: axe in the component and e2e suites reports zero serious/critical violations with no disabled rules; every overlay traps and restores focus; a Tab walk finds no focus stop without a visible 2 px ring.
6. **Everything clickable looks and behaves clickable.** Test: in a sweep of every route, no interactive element lacks `cursor: pointer`, and every entity row is a real link (§11).
7. **Extension over modification.** Adding a page, a stat tile or a panel touches only `src/features/<name>/` and (for a page) a route file. Test: the recipes in §15 each touch ≤ 2 directories.

## 2. Toolchain

| Concern | Choice | Notes |
|---|---|---|
| Build | Vite 8, `@vitejs/plugin-react`, `@tanstack/router-plugin/vite` | `base: '/'`; output `dist`; sourcemaps only for non-production builds, **never in the published package** (D-11). `optimizeDeps.entries` scans every source file so a lazily loaded route never triggers a mid-session re-optimisation |
| Language | TypeScript strict (all D-19 flags), `tsconfig.json` extends `tsconfig.base.json`, `lib: ["ES2022","DOM","DOM.Iterable"]` | `bun run typecheck` at the root includes this project |
| Styling | Tailwind v4 via `@tailwindcss/vite`; shadcn/ui on Base UI primitives | shadcn CLI pinned in `package.json`. `src/styles/globals.css` starts with `@import "tailwindcss";`. Dark variant: `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));` |
| Lint/format | Biome 2.5 with `css.parser.tailwindDirectives: true` | raw colours, px values and durations live only in `src/styles/tokens.css` |
| Tests | `bun test` + `happy-dom` + `@testing-library/react` + `axe-core`; Playwright for e2e | happy-dom is registered by the root `test/preload.ts` before any module links (§14) |
| Charts | Hand-rolled HTML/SVG: the Overview activity chart, `BarList`, `BarMeter`, `Sparkline` | no chart library: every bucket is a real link and the tooltip is plain React state that clears on leave, which a charting library's event layer does not guarantee |
| Tables | TanStack Table (manual mode) behind `useDataTable()`; TanStack Virtual on the Activity stream and the logs console | |
| Panes | react-resizable-panels v4 through `components/ui/resizable.tsx` | sizes are strings (`"40%"`, `"22rem"`): v4 reads bare numbers as pixels |
| Forms | react-hook-form + zod (schemas from `@browserhive/contracts`) | |
| Icons | lucide-react through the typed alias map `src/lib/icons.ts` | 16 px in controls and rows, 20 px in nav |
| Fonts | `@fontsource-variable/geist`, `@fontsource/geist-mono`, latin only | |
| Client | typed client over `@browserhive/contracts` schemas | |

`index.html`: inline theme bootstrap script (reads `localStorage['bh.theme']`, resolves `system` with `matchMedia`, sets `data-theme` before paint), `<meta name="theme-color">` per theme (`#f9fafb` / `#0b0c0e`, asserted equal to the tokens by `theme.test.ts`), favicon (the hive mark), `<noscript>`.

Code splitting: one chunk per route via TanStack Router `autoCodeSplitting`.

Development: `bun run browserhive --admin` runs the daemon from source and a Vite dev server next to it on `--port` + 10000, which serves the dashboard with hot reload and proxies the API paths to the daemon (`BHDEV_DAEMON_URL`); `BHDEV_DASHBOARD=dist` instead serves the built bundle, building it first when any input is newer (06 §2.1). Vite fronts the dashboard in development because that is its standard arrangement: no daemon-side proxy, no development CSP exception, and an open tab never mixes two React bundles.

## 3. Folder structure

```
packages/dashboard/
├── index.html
├── vite.config.ts               dev proxy /api (ws too), /mcp, /health, /trace-viewer → BHDEV_DAEMON_URL (default http://127.0.0.1:9876)
├── components.json              shadcn config
├── playwright.config.ts         e2e runner against a running daemon (BROWSERHIVE_E2E_URL)
├── public/                      favicon.svg
├── scripts/gen-routes.ts        route tree generation outside Vite (typecheck, CI)
├── test/                        setup, helpers (page harness, axe, fake socket, select), fixtures, e2e/
└── src/
    ├── main.tsx
    ├── app/
    │   ├── App.tsx              providers composition only
    │   ├── router.tsx           createRouter(routeTree), defaultErrorComponent, csv search serialisation
    │   ├── search-params.ts     arrays of plain values → `a,b`; other values keep TanStack's JSON default
    │   ├── providers/           Query, Auth (+ auth-machine), Socket, Notifications, Confirm, Toast, Keyboard
    │   └── shell/               AppShell, AuthGate, AuthRetryNotice, Sidebar, SidebarNav, Topbar, HealthPill, NotificationBell,
    │                            PrincipalMenu, ThemeMenu, CommandPalette, KeyboardMap, ToastStack, RouteError, NotFoundPage,
    │                            shell-layout (useWorkspaceLayout), page-actions (usePageActions), sidebar-state
    ├── routes/                  TanStack file-based routes (routeTree.gen.ts generated)
    │   ├── __root.tsx, index.tsx (→ /overview), theme.tsx (dev only)
    │   ├── _auth.tsx            <Outlet/> inside AuthGate + AppShell
    │   ├── _auth/overview, sessions, sessions_.$id, sessions_.$id_.live (redirect), attention, websites, navigation (redirect),
    │   │        blocklist, vault, vault_.log, logs, system, notifications
    │   └── _public/login.tsx, change-password.tsx
    ├── features/
    │   ├── overview/            tiles, activity chart, panels, live-hold.ts (useLiveHold), NewRowsPill, window anchor
    │   ├── sessions/            list/, detail/, activity/, live/, detail-search.ts, route-redirects.ts
    │   ├── attention/  websites/  blocklist/  notifications/
    │   ├── vault/               bindings/, groups/, confirm/, status/, tester/, transfer/, log/
    │   ├── logs/  system/ (status/, tokens/, config/)  auth/  theme/
    ├── components/
    │   ├── ui/                  shadcn copies adapted to the tokens (button, select, tabs, tooltip, dialog, sheet, …)
    │   └── shared/              the §7 component set
    ├── lib/
    │   ├── api/                 client, keys, errors
    │   ├── ws/store.ts          socket store (injectable), topics
    │   ├── ws/bridge.ts         event → cache patch table
    │   ├── status-registry.ts   §8
    │   ├── format/  search/  keyboard.ts  icons.ts  storage.ts  clock.ts  server-now.ts  client-errors.ts
    ├── theme/                   ThemeProvider, theme store, bootstrap (§4.4)
    └── styles/
        ├── globals.css          imports, base layer, reveal/row-link contracts, focus-ring utilities
        └── tokens.css           §9, both themes
```

Decision: **file-based routing** with the TanStack Vite plugin. Adding a page is adding a route file; nav, breadcrumbs, palette and `document.title` derive from route `staticData` (§6.2).

## 4. Providers and state

### 4.1 Auth

State machine (`app/providers/auth-machine.ts`, pure): `loading → login | change | ready`, plus `error`.

- On `/login` with no cached principal the machine starts in `login` without probing (no 401 on the login page).
- Otherwise mount → `GET /api/v1/auth/me` with an 8 s timeout. 401 → `login`; `must_change_password` → `change`; ok → `ready`.
- **Only a 401 signs out.** Every dashboard tab shares the operator principal, so a rate-limited, restarting or briefly unreachable daemon is a transient condition, not a sign-out. Any other probe failure (429, 5xx, network, timeout):
  - with a known principal (last probe, or `localStorage['bh.auth.principal']` from a previous visit): stay `ready`/`change` and show `AuthRetryBanner`, a sticky warn strip under the topbar with a countdown and "Retry now";
  - with no principal: stay on "Checking your session…" (`AuthRetryLine`) for transient failures; `error` ("Couldn't check your session") only for non-transient ones (contract mismatch, client bug).
- Retry delay: 1 s doubling to 30 s, never shorter than `Retry-After`, ±10 % jitter.
- The cached principal is not a credential: the cookie still decides every request.
- Central interceptor: any 401 outside `/login` → `login` (clears the query cache); `403 PASSWORD_CHANGE_REQUIRED` → `change`; `429` on login shows the `retry_after_ms` countdown.
- `ready` mounts Socket + Notifications; leaving `ready` tears them down. WS close 4401 → `login`.

### 4.2 Socket (`lib/ws/store.ts`)

An injectable class (constructed in `SocketProvider`, replaceable in tests) exposing `useSocketState()`, `subscribe(topic, handler)` (refcounted; first subscriber sends `subscribe`, last sends `unsubscribe`), `command(name, params) → Promise<reply>` (correlated by `corr`), and binary screencast frames. Behavior:

- Connects to `/api/v1/ws`; heartbeat `ping` every 20 s; dead if no frame for 45 s.
- Handshake: mismatch on `protocol` → banner "Dashboard is out of date, reload"; `epoch` change or `resync_required` → invalidate all topic-bound queries.
- Reconnect: backoff 500 ms·2ⁿ capped 8 s + jitter; on reconnect re-send every active subscription with its last cursor and invalidate all active queries.
- Bounded dedupe set (last 1 000 seq per topic). The `logs` topic is exempt: its frames carry the feed head as `seq` (many records share one), so they are neither deduped nor used as a resume cursor; the logs page resumes through REST (§12.9).
- Sends while disconnected are dropped with a console warning and a toast, never silently.

### 4.3 Notifications

Server-backed (D-16): `useQuery` for the page and the bell's unread count; the WS `notifications` topic patches both through the bridge (§5). Toast policy (`planToast`, pure and tested):

- Only `notification.created` raises a toast. `notification.updated` (a growing group, or read/dismiss elsewhere) updates a toast this tab raised, in place, or closes it once the row is read or dismissed; it never raises a new one.
- Types that toast come from `/me/preferences` `notifications.types`; with none stored, `DEFAULT_TOAST_TYPES` applies, which excludes `error` (tool errors go to the bell only). `notifications.toasts === false` silences all.
- An `error` for the session the operator is already viewing never toasts. The title is prefixed with `session_slug` unless it already contains it.
- Only `attention` toasts persist; the rest auto-dismiss. "Open session" / "Review in vault" is omitted when the operator is already at the target (`isAlreadyAt`).

### 4.4 Theme

`ThemeProvider`: `'system' | 'light' | 'dark'` in `localStorage['bh.theme']`; resolves with `matchMedia('(prefers-color-scheme: dark)')` and listens for changes; writes `data-theme` on `<html>` and updates `<meta name="theme-color">`. `useTheme()` returns `{ preference, resolved, set }`. The topbar `ThemeMenu` is a dropdown (Light / Dark / System with a check).

### 4.5 QueryClient

One client; `staleTime = FRESHNESS_MS = 15_000`; `refetchOnWindowFocus: true`; reconnect-driven refetch comes from the socket store. Queries retry at most twice (750 ms, then 1.5 s) and never on 4xx, `retryable: 'never'` or client errors. Windowed queries (Overview, Websites, Blocklist, Attention history, Notifications) use `placeholderData: keepPreviousData` and a shared window anchor (§12.1) so a refetch never swaps in a skeleton. Polling exists only for Overview activity (60 s) and a draining session's detail (2 s).

### 4.6 State placement rules

| Kind of state | Lives in | Examples |
|---|---|---|
| View state that should survive reload/share | URL search params (zod-validated) | filters, sort, page, tab, range, expanded activity rows (`open`), `live`, `takeover` |
| Server data | TanStack Query cache | sessions, attention, vault, logs, system |
| Ephemeral interaction | component state | open menus, row selection, logs live/paused, held live rows, unsent message drafts |
| Operator preferences shared across devices | `/api/v1/me/preferences` | `notifications.toasts`, `notifications.types` (the only keys the dashboard reads; the sidebar pin is per device and page size is per URL, so a server default would only fight them) |
| Per-device conveniences | `localStorage` via `lib/storage.ts` (try/catch, degrade silently) | `bh.theme`, `bh.sidebar`, `bh.density`, `bh.session.split.v2`, `bh.session.focusLive`, `bh.liveView.size`, `bh.activity.view`, `bh.auth.principal` |

Never: module-level mutable singletons holding server state.

## 5. Data layer

- **Client**: `lib/api/client.ts`, typed by the contracts schemas. Responses are validated; a mismatch is a typed client error, not a crash.
- **Errors**: non-2xx → `AppError` (`code`, `status`, `retryable`, `retryAfterMs`, `details`, `requestId`, `isClientBug`). A non-problem error body is kept in `details.body` (the 503 health body is rendered from it). `ErrorState` shows the code as a copyable mono token, with no link out (§16); a client `TypeError` is "Something broke in the dashboard" with **Copy details**, never "Network error".
- **Query keys** (`lib/api/keys.ts`): factory per resource; params are the parsed search object.
- **WS → cache bridge** (`lib/ws/bridge.ts`): a table `event type → patch(queryClient, payload)`; unknown events are ignored. When a patch cannot be applied cleanly the bridge invalidates that query instead.

| Event | Patches |
|---|---|
| `session.opened` / `session.updated` / `session.closed` / `session.removed` | session lists (upsert/remove), session detail (including live `counts`), system status |
| `tool.called`, `page.visited`, `vault.access`, `blocklist.hit`, `attention.created` / `attention.resolved` | session timelines: upsert by item `id = "<kind>:<row id>"` (attention uses `request_id`); items cached without `id` are matched by the same formula; multi-kind timelines (`kinds=page,tool`) take prepends for any kind they include; filtered timelines (`q`, `errors_only`, a cursor) are invalidated. `attention.*` never bumps `attention_open` (the server's `session.updated` carries it). Fleet lists (`pages`, blocklist attempts, attention) are prepended or invalidated |
| `screenshot.captured` | session screenshots |
| `vault.confirm.*`, `vault.binding.changed`, `vault.policy.changed` | vault confirms, bindings, groups |
| `blocklist.reloaded`, `system.*`, `retention.completed` | blocklist state, system status |
| `notification.created` / `notification.updated` | `upsertNotification`: for each cached list whose filters it can evaluate (`read`, `type`, `since`/`until` on `updated_at`, page 1, default `updated_at desc`), rows are replaced and moved to their `updated_at` position, rows that left the filter are removed, unknown rows are inserted; other lists are replaced in place when `updated_at` is unchanged, otherwise refetched. The unread count changes only when a row's unread state flips |
| `log.record` (topic `logs`) | not a query: the logs buffer (§12.9) |

- **Mutations**: `useMutation` with `onError → toast.fromError`; optimistic updates only where listed in §11, with rollback and invalidate. Bulk endpoints return per-item results shown as a result table.
- **Error boundaries**: `router.defaultErrorComponent = RouteError` renders page crashes **inside the shell**; Retry is `reset()` + `router.invalidate()`. Sidebar, topbar and palette each have a `WidgetBoundary`; widgets use `DataPanel` / `PanelBoundary`. Boundaries report to `POST /api/v1/client-errors`.

## 6. App shell

### 6.1 Layout

- `AppShell` = skip link (first focusable) · `Sidebar` · column of `Topbar` (`header`) · `AuthRetryBanner` · `main#main`.
- **One page scroller.** In the default `document` layout the document scrolls: the sidebar is `sticky top-0 h-dvh`, the topbar is `sticky top-0`, and `main` is `relative` with `px-gutter pt-6 pb-12`. Pages render straight into `main` and add no page padding, no `mx-auto` and no fixed-height inner scrollers (`h-[70dvh]` is banned). Test: no double scrollbars at any width.
- **Workspace layout.** A page that needs independently scrolling panes calls `useWorkspaceLayout(active)`. While any page claims it, the document stops scrolling (`h-dvh overflow-hidden` on the frame) and `main` becomes `min-h-0 flex-1 overflow-hidden pb-4` with `--table-sticky-top: 0px`; the page root is `flex min-h-0 flex-1 flex-col` and each pane is `min-h-0 overflow-y-auto`. Users: the session page while the live split is shown, and Logs. `main` keeps `pt-6` in both layouts so the page title never moves.
- **Width.** Every page spans the content column; there is no page width cap (`--content-max` and `max-w-content` do not exist). Cap prose, not pages. All pages share the same left and right edge.
- **Sidebar** (`Sidebar.tsx`, `sidebar-state.ts`):
  - Below 768 px: a Sheet drawer opened from the topbar menu button.
  - From 768 px: expanded `--sidebar-width` 15rem (240 px) or a rail `--sidebar-width-icon` 3.5rem (56 px). The operator pins either state at every width ≥ 768 px (`localStorage['bh.sidebar']` = `expanded|collapsed`); with no stored pin it is expanded from 1024 px and a rail at 768–1023. Toggles: ⌘B / Ctrl+B, the `PanelLeft` button in the sidebar header (expanded), the brand button in the rail header, the palette action.
  - Hover-peek over the rail: opens after 200 ms (`PEEK_OPEN_DELAY_MS`) as a `position: fixed` overlay with `shadow-lg` that never reflows `main`; stays open while the pointer is over the rail or the overlay; closes 300 ms (`PEEK_CLOSE_GRACE_MS`) after it leaves both.
  - Rail items: 20 px icon centred in a 40×40 hit area with a right-side tooltip; badges become a dot; lock glyphs are hidden.
  - Nav scroll region: `overflow-y-auto`, thin scrollbar, no `scrollbar-gutter`.
  - Brand: the hive hexagon `BrandMark` + "BrowserHive" wordmark (the rail shows the mark only).
  - Footer: a Shortcuts button (`?`; an icon in the rail; hidden on coarse pointers) and the daemon version.
- **Nav groups**: primary items ordered by `staticData.nav.order` (Overview 10, Sessions 20, Websites 30, Blocklist 40, Attention 50, Vault 60, Vault log 65, Logs 80, System 90). Items whose `staticData.requires` (e.g. `vault`) is off in `/system` render in a "Not enabled" group; vault items render in no group until `/system` has loaded. Badges: Attention shows the open count; Vault shows the confirm count, and the confirm-count query never runs while the vault is disabled. Items carry `aria-current="page"` from the router's active match.
- **Topbar** (`--topbar-height` 3.5rem = 56 px, sticky, translucent with backdrop blur):
  - Left: breadcrumbs on object pages only (`Sessions › slug`); list pages show nothing there because `PageHeader` carries the title. No "BrowserHive" root crumb. Under 768 px: menu button + brand mark instead.
  - Right: a search field-button ("Search sessions, pages…" + `Ctrl K`/`⌘K` by platform) that opens the palette (an icon button under 768 px), `HealthPill`, `NotificationBell`, `ThemeMenu`, `PrincipalMenu` (display name, Change password, Keyboard shortcuts, Log out).
  - `document.title` = `${title} · BrowserHive`.
- `HealthPill` is a ghost `Button` opening a popover with Realtime (WS `connected | connecting | offline` + reason), REST, and daemon version.
- `NotificationBell`: badge anchored top-right, capped at "9+"; rows show the session slug (unless the title has it), `updated_at`, and "first …" for grouped rows; "View all" → `/notifications`.
- 404 (`NotFoundPage`) renders inside `AuthGate` and the shell and sets its title ("Page not found · BrowserHive").

### 6.2 Route table as data

Each route file exports `staticData: { title, nav?: { label, icon, group, order, key? }, crumb?: (params) => string, requires?: 'vault' | 'admin', palette?: { keywords } }`; object pages set `crumb` to show a breadcrumb instead of the title. The shell derives sidebar items, breadcrumbs, `document.title` and palette "Go to" commands from the matched route tree. No other list of routes exists.

### 6.3 Command palette

A 640 px (40rem) dialog (Base UI dialog: portal, focus trap, restore) with a `role=combobox` input and a grouped `role=listbox` using `aria-activedescendant`; 14 px text; the selection scrolls into view; keyboard hints in the footer. Opens on ⌘K / Ctrl+K (also from inside text inputs) and from the topbar search button. Sections, in order:

1. **This page**: actions registered by the mounted page through `usePageActions` (e.g. "Show/Hide live view" on a session, "Show/Hide dashboard traffic" on Logs).
2. **Recent**: last selections (localStorage).
3. **Sessions**: with a query of ≥ 2 characters, `GET /sessions?q=` sorted by last activity; each row shows slug, state dot and label, the id suffix (mono) and relative time in fixed columns, so same-slug sessions are distinguishable. `/search` is the fallback.
4. **Attention**: pending requests filtered by the query.
5. **Pages**: "Go to …" from the route table, plus Notifications.
6. **Actions**: theme (light/dark/system), expand/collapse sidebar, change password, log out.

### 6.4 Toasts

Base UI toast manager (`app/providers/ToastProvider.tsx`): at most 5 (`TOAST_LIMIT`), newest on top, 6.5 s TTL (`TOAST_TTL_MS`), pause on hover and focus; `role="status"` live region for info/success and `role="alert"` for errors. `useToast()` exposes `info | success | warning | error({ title, description?, action?, id?, persist? })`, `fromError(appError)`, `close(id)` and `update(id, patch)` (a no-op once closed). A toast with an action persists unless `persist: false`. Re-issuing an `id` updates instead of stacking. Error toasts carry the copyable `code` and request id. Z-order: toasts (`--z-toast` 45) sit above the drawer and below popovers and dialogs (50): a toast never covers a confirm dialog.

Notification toasts are **grouped and quiet** (§4.3): the server folds tool errors into one row per session, the client updates that toast in place, and tool errors do not toast by default.

### 6.5 Keyboard map

| Key | Action | Scope |
|---|---|---|
| ⌘K / Ctrl+K | command palette | global, including text inputs; not during live capture |
| ⌘B / Ctrl+B | pin the sidebar expanded / collapsed | global except inputs and capture |
| `?` | keyboard map (matched on `event.key === '?'`) | global except inputs and capture |
| Esc | close the topmost overlay (palette → map → drawer → dialog/popover) or clear a focused search | global |
| `/` | focus the page's search field | pages with a `FilterBar` or the Activity search |
| `j` / `k` or ↓ / ↑, Home / End | move between rows | a focused `DataTable` row or Activity row |
| Enter | open the focused row (link, click handler, or expand) | same |
| `x` or Space | select the focused row | selectable tables |
| Shift+F10, ContextMenu, `.` | open the focused row's actions menu | tables with row menus |
| `l` | toggle the live pane | session page |
| `+` `=` `-` `0` | zoom in / in / out / fit | image zoom modal |
| Everything | forwarded to the page | live-view keyboard capture |

Implemented once in `lib/keyboard.ts` + `KeyboardProvider` (`useShortcut({ id, combo, description, scope, group })`). `matchesCombo` handles Shift-punctuation (`?`) and keeps Shift strict for letters. The `?` map lists registered shortcuts grouped (General, Navigation, Lists and tables, then page groups such as Session); table keys (`TABLE_SHORTCUTS`) appear only on pages that show a table; page shortcuts appear only while their page registers them; Esc is listed once. Labels are platform-correct (`⌘K` on Mac, `Ctrl K` elsewhere).

## 7. Shared component set

Components own no outer margins; layouts own spacing with `gap`. Tones are a closed union `'accent' | 'success' | 'warn' | 'danger' | 'vault' | 'info' | 'neutral'`. **Never use native `title=`, native `<select>` or native checkboxes.**

### 7.1 UI primitives (`components/ui`)

| Component | Contract |
|---|---|
| `Button` | sizes `xs 28 · sm 32 · default 36 · lg 40` px and square `icon-xs/icon-sm/icon/icon-lg`; on `pointer: coarse` xs/sm/default grow to 40 and lg to 44. Variants `default`, `outline`, `secondary`, `ghost`, `destructive` (soft red), `destructive-solid` (the confirm button of a dangerous dialog), `destructive-ghost`, `link`; every variant styles `aria-pressed` and `aria-expanded` |
| `Input`, `Textarea` | 36 px (`size="sm"` 32); focus = border + 3 px `ring/20`; `fieldClasses` shared with `SelectTrigger` |
| `Select`, **`SimpleSelect`** | Base UI select; trigger 36 (32 sm), items 32 with a check. `SimpleSelect { value, onValueChange, options: {value, label, disabled?}[], placeholder?, id?, aria-label?, size?, disabled? }` is the drop-in for a native `<select>`; tests drive it with `pickOption(trigger, name)` from `test/helpers/select.ts` |
| `Checkbox` | 16 px box, 32 px invisible hit area (40 on coarse pointers), `indeterminate` (`aria-checked="mixed"`) |
| `Switch` | 36×20 (`sm` 28×16, 40 px tall hit area); a `role=switch` carries its own `aria-label` |
| `Tabs` | `TabsList variant="line"` (default): underline tabs with a sliding indicator that scroll horizontally without a scrollbar and never overflow vertically; `variant="segmented"`: pill switcher. `ToggleGroup spacing={0}` renders a segmented control (time ranges, view toggles) |
| `DropdownMenu` | items 32 px with 16 px muted icons; `variant="destructive"`; radio and checkbox items with checks; `DropdownMenuLabel` is a plain div |
| `Popover`, `Dialog` (+ `DialogBody`), `AlertDialog`, `Sheet` | popover elevation / dialog elevation; dialogs 16 px radius, `max-h: 100dvh - 2rem`; long content goes in `DialogBody`, the only scroller |
| **`Hint`** | one-line tooltip: `<Hint label shortcut? side? disabled?>{child}</Hint>`; the child must take a ref (Button, Link, or a `span tabIndex=0` wrapping a disabled button that needs a reason). `label={null}` renders the child alone. Delay 500 ms, instant between tooltips (`TooltipProvider` in `App.tsx`) |
| `Table` | no wrapper div; cells wrap (`overflow-wrap: anywhere`); headers 40 px, nowrap |
| `Kbd`, `Toast`, `Skeleton`, `Spinner`, `Progress`, `Resizable` | restyled to tokens |

### 7.2 Shared components (`components/shared`)

| Component | Contract |
|---|---|
| `PageHeader` | `{ title, leading?, badge?, description?, learnMore?, actions?, actionsInline?, meta?, tabs? }`; `<h1>` at `text-xl font-semibold`; one muted description line with an info popover for `learnMore`; actions right-aligned (wrap under the title on narrow screens unless `actionsInline`, which truncates the title instead); `meta` is a secondary facts line; `tabs` sit under the header. Pages MUST NOT pass `breadcrumb` (marked `@deprecated`; the topbar owns crumbs, and a given trail only supplies the title) |
| `Section` | `{ title, description?, count?, actions?, children }` → `<section>` with an `<h2>` row, no surface |
| `Panel` | `{ title?, description?, actions?, padding?: 'default' | 'none', bodyClassName? }`: **the** card surface (`rounded-xl`, hairline, `shadow-xs` in light). Never nest panels |
| `FilterBar` | `{ search?: { param, placeholder, value }, selects?, chips?: FacetChip[] (counts?: boolean), tokens?, range?, end?, matching, onChange, onClear }`; search 36 px with a `/` hint, clear ✕, Esc clears, debounced by `useDebouncedSearch` (the timer depends only on the draft and the committed value); chips are 28 px pills (40 on coarse pointers), selected = accent tint + check + bold; "N matching" + Clear all |
| **`SelectionToolbar`** + `BulkBar` | `<SelectionToolbar bulk={selection.size ? <BulkBar count actions onClear/> : null}>{filters}</SelectionToolbar>`: the 44 px accent-tinted bulk bar overlays the filter row in the same slot, the filters stay mounted and inert, the table never shifts. `BulkAction.hint` puts a tooltip on a focusable wrapper (disabled reasons, skip notes); one "× Clear" at the end |
| `DataTable<Row>` | see §7.3 |
| `Pagination` | `{ page, pageSize, total, sizes, alwaysShow? }`; rows-per-page is the ui `Select`; hidden when everything fits (`pagerNeeded`); out-of-range pages keep the pager |
| `ColumnMenu` | the table **View** menu: density radio + column checkboxes; placed in `FilterBar.end` |
| `EmptyState` | `{ kind: 'zero-data' | 'zero-results' | 'not-enabled', icon?, title, description?, action?, onClear?, docsHref?, variant?: 'inline' | 'panel', size? }`; compact, no dashed box; `inline` has no surface |
| `ErrorState` | `{ tier: 'field' | 'region' | 'page', error, onRetry?, escape?, title?, variant? }`; client bugs get a bug icon and Copy details; server errors show the copyable code and request id; `ErrorCode`, `errorDetails()` exported |
| `DataPanel` | `{ query, skeleton, empty, children(data), errorVariant? }`: skeleton after 400 ms; a "retrying (attempt n)" pill while retries run; `ErrorState` after them; a warn strip with Retry above stale data when a refetch fails. `panelPhase()`, `PanelBoundary` exported |
| Skeletons | `SkeletonTable { rowCount?, columns?, density? }` renders `min(pageSize, rowCount, 50)` rows at the real row height; `SkeletonTiles` has exactly the `StatTile` geometry and takes the real grid classes; `SkeletonCard`, `SkeletonKv`, `ROW_HEIGHT` |
| `StatTile` | `{ label, value, sub?, tone?, spark?, info?, to?, search? }`; **linked** (`to`): the whole tile is a `Link`, lifts 2 px with `shadow-md` and a nudging ↗ arrow; **static** tiles never hover; values truncate. Tiles are for metrics only; static config goes in `KeyValue` |
| `Callout` | `{ tone, title?, children?, action?, dismissible? }`; soft tint + icon |
| `KeyValue` | `{ items: {key, value, mono?}[], columns?: 1 | 2, dividers? }`; 13 px muted keys in a 38 % column, 14 px values; string values break at `/ . - _ ? & = : @ , ; +` via `Breakable` |
| `JsonView` | `{ value, collapseAt?, copy? }`; React nodes only (no `dangerouslySetInnerHTML`); rotating chevrons; copy button in its own gutter |
| `SessionRef` | `{ id, slug?, mode?: 'link' | 'text', showId?, truncate?, stacked? }`; slug primary and truncates last; id 13 px mono (8/6) with the full id in a tooltip; copy on hover |
| `UrlCell` | `{ url, category?, head?, tail?, copy?, external? }`; host foreground, path muted, scheme dropped, `public` category never shown. Open and copy sit in an in-flow `.reveal-slot` that takes no width until the row or value is hovered or focused, so the URL re-truncates beside it; the full-URL tooltip appears only when the text is cut. Inside a linked row the URL text is plain (§11) |
| `StatusBadge` / `StatusDot` / `TonePill` | `{ domain, value, variant?: 'dot' | 'pill', pulse? }`; default is **dot + text** (live states ping); hints are tooltips |
| `Chip`, `CountChip`, `VaultChip` | `Chip` 22 px, borderless; `CountChip { count, label, singular?, tone?, showZero? }` renders nothing at 0 and pluralises; `countLabel()` |
| `RelativeTime` | `{ at, now?, mode?: 'relative' | 'absolute' | 'both' }`; tabular digits, 7ch min width, absolute time in a tooltip and `data-absolute` (cursor `help`) |
| `CopyButton`, `CopyValue` | `{ value, label, size?, visibility?: 'hover' | 'always' }`; check + "Copied" tooltip + live region; clipboard API with a textarea fallback on insecure origins |
| `TimeRangeControl`, `DateRangePicker` | 36 px segmented control over `24h | 3d | 7d | 14d | 30d | all`; the picker has ISO `YYYY-MM-DD` fields, optional 24 h `HH:MM`, a Monday-first month grid (click start/end, arrows, PageUp/PageDown, Home/End), validation on Apply; "To" without a time includes the whole day |
| `ConfirmDialog` / `useConfirm()` | `confirm({ title, description, confirmLabel, danger?, requireText? }) → Promise<boolean>`; `destructive-solid` confirm |
| `ImageZoomModal` | fit on open, 0.25×–8×, wheel-to-cursor, drag pan, double-click fit ↔ 2.4×, `+ - 0 Esc`, header with dims/bytes/zoom %, "Open raw", "no longer on disk" |
| `InfoDot` | tooltip/popover trigger with an accessible name; 24 px box with a 40 px pseudo hit area |
| `LeaseBar`, `Sparkline`, `BarMeter`, `ChartFrame`, `BrandMark`/`BrandLockup`, `Toolbar`, `layout` (`Stack`, `Inline`, `Grid` with `minmax(min(100%, 12.5rem), 1fr)`) | as named |
| `row-context` | `useRowScope()` → `{ linked, roving }`; `useRowControlTabIndex()` returns `-1` inside a roving row so Tab moves row → row actions → next row |

### 7.3 `DataTable<Row>`

Props: `{ label, columns, rows, rowCount?, hasNext?, state, sortKeys?, getRowId, onStateChange, onHiddenChange?, renderCard?, emptyState, loading?, rowHref?, rowLabel?, onRowClick?, onRowOpen?, expandable?, expanded?, onToggleExpanded?, density?, stickyHeader?, className? }`.

- **`rowHref(row)`**: whole-row real link, a stretched `<a href data-row-link>`; plain click is SPA navigation, middle/ctrl/meta-click and "open in new tab" are native. `rowLabel` names the link and checkbox.
- **`onRowClick(row)`**: click anywhere on a non-link row; ignores inline controls, clicks from portals (menus) and text selections (`isRowClick`).
- `onRowOpen`: Enter on the focused row; defaults to `rowHref`, then `onRowClick`, then toggling expansion.
- `expandable` + `expanded` + `onToggleExpanded`: the row expands on click anywhere, with a rotating chevron column. The table gets `role="treegrid"` when rows expand and `role="grid"` + `aria-multiselectable` when selectable, so `aria-expanded`/`aria-selected` on `<tr>` are valid.
- `density`: `comfortable` 44 px / `compact` 36 px rows (header 40), default from `useDensity()` (`bh.density`).
- `stickyHeader` (default true): sticks at `top: var(--table-sticky-top, var(--topbar-height))`; inside a workspace pane the shell sets it to 0.
- Column contract (`DataTableColumn`): `{ id, header, cell, sortable?, sortAliases?, priority?: 1|2|3, align?, mono?, nowrap?, truncate?, revealOnHover?, grow?, hideHeader?, className? }`. `grow` (at most one) absorbs spare width and truncates first. `priority` 2 hides under 768 px, 3 shows only from 1280 px. `sortAliases` names other sort keys a column displays (`Activity · errors ↓` with `aria-sort`).
- Surface: one `Panel`-like card, `overflow: clip` so the header sticks to the page; a ResizeObserver switches to `overflow-x: auto` (sticky header off) only when the table really overflows.
- Rows: hover fill, pointer, 2 px inset focus ring (`focus-ring-inset`) on the roving row; keys per §6.5.
- `renderCard` under 768 px: whole-card link (`rowHref`) or whole-card click.
- Loading: skeleton rows at real heights in the same card. Empty: `emptyState` inside the card.

### 7.4 Page-level hooks

| Hook | Contract |
|---|---|
| **`useWorkspaceLayout(active = true)`** (`app/shell/shell-layout.tsx`) | opts the page into the fixed-height workspace (§6.1) while `active`; claims are counted, so nested users are safe |
| **`usePageActions(actions)`** (`app/shell/page-actions.tsx`) | registers `PageAction { id, label, icon, hint?, keywords?, run }[]` (memoised) for the palette's "This page" section while mounted |
| **`useLiveHold(rows, ref, { getId, getVersion?, listKey, enabled? })`** (`features/overview/live-hold.ts`) + **`NewRowsPill`** | while the reader is engaged with the list (page scrolled, pointer over it, or focus inside it; document-level delegation), new rows are held, rows whose `getVersion` grows keep their slot and count as updates, removed rows leave; a `listKey` change drops the freeze. Returns the rows to render, the held counts and `release`. `NewRowsPill { count, added, noun, onShow }` is sticky and zero-height (never shifts rows), reads "3 new navigations" / "1 update" / "2 new, 1 update", and on click releases and scrolls the list top into view. Enable only where live inserts land (page 1, newest first) |
| `useWindowAnchor()` (`features/overview/api.ts`) | one `now` per page mount, shared by pages mounted within 5 min (`WINDOW_ANCHOR_TTL_MS`); trailing windows send only `since`; an anchor ahead of the server clock is stale |
| `useDensity()`, `useSidebarPreference()`, `useShellBand()` | per-device density; effective sidebar pin + setter; band `sm | md | lg | wide` |

## 8. Status registry (`lib/status-registry.ts`)

One file, one type per domain, each `value → { label, tone, icon, pulse? }`:

- **Session state**: `live` (success, pulse), `attention` (warn, pulse), `paused` (warn), `streaming` (success, pulse), `closed` (neutral), `lease_expired` (neutral "expired"), `crashed` (danger), `interrupted` (danger), `shutdown` (neutral), `archived` (neutral), `launching` (info), `draining` (info, label "closing", pulse).
- **Attention outcome**: `resolved` success, `rejected` danger, `timeout` warn, `cancelled` neutral, `pending` warn.
- **Vault result**: `success` success, `origin_mismatch` danger, `auth_failed` danger, `blocked` warn, `denied` danger; **origin check**: `pass` success, `fail` danger, `skipped` neutral.
- **URL category**: `public` neutral/globe, `ip` warn/hash, `local` warn/home, `ftp` info/folder, `other` neutral/help, each with a one-line hint shown as a tooltip (e.g. `local`: "file://, localhost, loopback").
- **Blocked source**: `tool` ("tool call"), `request` ("in-page navigation").
- **Notification type**: `attention` warn, `error` danger, `vault` vault, `lifecycle` info.
- **Log level**: `error` danger, `warn` warn, `info` neutral, `debug` muted; unknown levels resolve through `levelEntry` (never throw).
- **Thresholds**: `LEASE_WARN_MS = 10 min`, `LEASE_DANGER_MS = 2 min`; `DISK_WARN = 0.8`, `DISK_DANGER = 0.9`.
- **Closed reasons** come from the server's `closed_reason` enum; the client never infers a crash from free text, and "session crashed" notifications come from the server producer (D-16).

## 9. Design tokens (`styles/tokens.css`, `styles/globals.css`)

Tailwind v4 `@theme inline` over CSS variables; light is `:root`, dark is `:root[data-theme="dark"]`. `tokens.css` is the only file with raw colours, px values and durations. The `/theme` page (dev only) verifies contrast live.

- **Root size**: the browser's 16 px. **Never set a font-size on `html`**; `body` is `text-base`.
- **Type scale** (size / line-height / tracking):

  | Utility | Size | Line-height | Use |
  |---|---|---|---|
  | `text-xs` | 0.75rem (12 px) | 1rem | captions, meta; **the minimum anywhere** |
  | `text-sm` | 0.8125rem (13 px) | 1.25rem | secondary text, table meta, mono ids and URLs |
  | `text-base` | 0.875rem (14 px) | 1.375rem | body, table cells, controls (default) |
  | `text-md` | 1rem | 1.5rem | section and dialog titles |
  | `text-lg` | 1.125rem | 1.75rem, −0.005em | |
  | `text-xl` | 1.25rem (20 px) | 1.75rem, −0.01em | page titles |
  | `text-2xl` | 1.5rem | 2rem, −0.02em | KPI values |
  | `text-3xl` | 1.875rem | 2.25rem, −0.02em | |

  Arbitrary `text-[…]` below 12 px is banned. Weights 400/500/600. Tabular numbers by default on `table`, `time` and `[data-numeric]`. Labels use `.section-label` (13 px, 500, muted, sentence case); `.eyebrow` (12 px uppercase tracked) only for a real category marker; there is no `.overline`. Mono (Geist Mono) only for ids, URLs, code, JSON and log lines, never titles, enum values or versions.
- **Spacing**: `--spacing: 0.25rem` (4 px base, 8 px rhythm). `--gutter` 1rem, 1.5rem from 640 px (`px-gutter`). Section gap 20–32 px; card padding 16–20 px.
- **Sizing**: controls 36 (default) / 32 (sm) / 28 (xs, dense rows only); ≥ 40 px on coarse pointers. Table rows 44 / 36, header 40. Icons 16 px in controls and rows, 20 px in nav, `shrink-0`.
- **Palettes** (OKLCH, neutrals at hue ~250):
  - Light: background `oklch(0.985 0.002 250)`, card and popover white, sidebar `0.975`, border `0.92`, muted `0.965`, primary `oklch(0.55 0.17 258)`.
  - Dark: background `oklch(0.155 0.004 250)` < sidebar `0.17` < card `0.195` < popover `0.23`; border `white/8%`, muted `white/5%`, accent (hover/selected fill) `white/7%`, primary `oklch(0.53 0.16 258)`.
  - Spine: `background, foreground, card, popover, primary, primary-hover, primary-foreground, secondary, muted, muted-foreground, subtle-foreground, accent, accent-foreground, destructive, border, border-strong, input, ring, link, tooltip, tooltip-foreground, scrollbar, sidebar*, chart-1..6, chart-grid, chart-axis`, plus `--brand-from/--brand-to` for the mark.
  - Semantic hues `success | warn | danger | vault | info | neutral | accent`, each `bg, bg-hover, border, solid, text, on-solid`; in dark they are alpha tints so they sit on any surface. `text` and `subtle-foreground` are ≥ 4.5:1 on background, sidebar, card and popover in both themes; white labels on `primary` and `danger-solid` are ≥ 4.5:1.
  - Accent blue only for primary actions, links, selection and focus. Structure comes from surface contrast and spacing: one hairline around a card at most, no boxes inside boxes, tables with row dividers only.
- **Elevation**: `shadow-xs` (cards in light; `dark:shadow-none`), `shadow-sm` / `shadow-md` (hover lift), `shadow-lg` (peek overlay), `shadow-popover` (menus, popovers, selects, toasts; includes the hairline ring), `shadow-dialog` (dialogs, sheets). Dark elevation = lighter surface + `white/8–9%` ring + black 45–60 % shadows.
- **Radii**: `rounded-xs` 4, `sm` 6, `md` 8 (controls), `lg` 10 (popover lists, callouts), `xl` 12 (cards, tables), `2xl` 16 (dialogs); pills full.
- **Motion**: `--duration-fast 120ms`, `--duration-base 180ms`, `--duration-slow 260ms`; `--ease-out cubic-bezier(.2,.8,.2,1)`, `--ease-in-out cubic-bezier(.4,0,.2,1)`. Overlays animate opacity + small translate/scale in 150–200 ms; in-flow width is never animated; one global `prefers-reduced-motion` override.
- **Z-index**: `--z-sticky 10`, `--z-topbar 20`, `--z-rail 30`, `--z-drawer 40`, `--z-toast 45`, `--z-popover 50`, `--z-dialog 50`, `--z-tooltip 70`.
- **Layout variables**: `--sidebar-width 15rem`, `--sidebar-width-icon 3.5rem`, `--topbar-height 3.5rem`, `--workspace-height calc(100dvh - var(--topbar-height))`, `--breakpoint-wide 112.5rem` (1800 px). There is no `--content-max`.
- **Focus**: `--ring-width 2px`, `--ring-offset 2px`, `--ring-width-capture 3px` (live capture). Base rule: `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }`. Components that reset the UA outline use the **`focus-ring`** utility (or **`focus-ring-inset`**, negative offset, for rows, list items and scrolling tab lists) instead of `outline-none focus-visible:outline-2`, because in Tailwind 4 `outline-none`/`outline-hidden` store `none` in `--tw-outline-style`, which `outline-2` reads back. An unlayered `:focus-visible { --tw-outline-style: solid }` is the safety net. Test: `styles/affordances.test.tsx` compiles `globals.css` and asserts the utilities, the net, that every primitive renders `focus-ring`, and that no file in `components/` or `app/` pairs a reset outline with `focus-visible:outline-<n>`.
- **Cursor rules** (base layer): `cursor: pointer` on `button:not(:disabled)`, `[role=button]`, `a[href]`, `label[for]`, `select`, `summary`, roles `tab`, `menuitem*`, `option`, `checkbox`, `switch`, `radio` (unless disabled), and labels wrapping a checkbox, switch, radio or input. `time[data-absolute]` gets `cursor: help`, inherited from a clickable parent.
- **Scrollbars**: thin, `--scrollbar` colour, both themes; no `scrollbar-gutter` anywhere.
- **Fonts**: `--font-sans: "Geist Variable", system-ui, sans-serif`; `--font-mono: "Geist Mono", ui-monospace, monospace`.

## 10. Responsive rules

Shell bands (`useShellBand`): `sm` < 768 · `md` 768–1279 · `lg` 1280–1799 · `wide` ≥ 1800. Tailwind breakpoints are the defaults (640/768/1024/1280/1536) plus `wide` 1800.

| Band | Shell | Tables | Session page | Toolbars |
|---|---|---|---|---|
| `sm` | drawer; topbar = menu + mark + icon actions | `renderCard` whole-card links | tabs scroll horizontally; live pane stacked above the tabs as a stage at the page's aspect ratio | chips wrap; Logs collapses levels, modules and dashboard traffic into one Filters menu under 640 px |
| `md` | pinned rail or sidebar (default rail below 1024) | `priority 2` columns visible; horizontal scroll only when a table really overflows | stacked live pane | one row + overflow |
| `lg`, `wide` | pinned sidebar or rail (default expanded) | `priority 3` columns from 1280 | with Live open: resizable split in the workspace layout | full |

- Widgets size by **container queries**, not viewport queries, so they behave inside panes: the sessions table shows Created from 64rem, Activity from 56rem and State from 38rem of its own width (below those, Activity folds into the Session line and State becomes a dot); the Activity stream forces the list view under 640 px of container width; KeyValue goes two-column at `@2xl`.
- Touch targets on `pointer: coarse` are ≥ 40 px: buttons (xs/sm/default), toggles, segmented and line tabs, FilterBar chips, clear-search, token remove buttons, small inputs and selects, select and menu items, Activity kind chips, the password eye; checkbox, Switch `sm`, `InfoDot`, the Activity chevron, the header copy-id button and the live status pill get 40 px pseudo-element hit areas. The rail keyboard button and shortcut hints are hidden on coarse pointers. Overview chart bars stay narrow: on touch the first tap selects a bar and the second opens it.
- Every scroll region is focusable; there is never horizontal document overflow.

## 11. UX rules

- **Affordances.** Everything clickable looks and behaves clickable (§9 cursor rules). Secondary actions are real buttons (ghost/outline with icon), never label-looking text. Disabled actions that need a reason wrap in a focusable `Hint`.
- **Whole-row links.** A row or card that represents an entity opens it on click anywhere, as a real `<a>` (`DataTable.rowHref`, `LinkList`/`LinkRow` outside tables). Stacking contract (`globals.css`): `[data-row-link]` is z-index 1 above all text; only real controls are lifted to z-index 2 (`a`, `button`, `input`, `select`, `textarea`, `[role=button|checkbox|switch|combobox]`, `[data-interactive]`). Text is never lifted, so a tooltip on display text inside a linked row is unreachable by design: put the full value on a control. A lifted control inside a transformed wrapper is trapped below the link. Entity titles in linked rows render as text (`SessionRef mode="text"`) and underline on row hover; links to other entities stay real `Link`s.
- **Expandable rows** expand on click anywhere with a rotating chevron (`onToggleExpanded`); detail is inline, never a side drawer.
- **Reveal pattern.** Row actions, copy and open buttons sit in `.reveal` (overlay) or `.reveal-slot` (in-flow, zero width until shown) inside a `data-reveal-scope`; they show on hover or focus-within, stay while their menu is open, and are always visible on `hover: none`.
- **Linked KPI tiles** lift, show ↗ and use a pointer; static tiles never hover.
- **Live inserts never move what the operator is reading** (`useLiveHold` + `NewRowsPill` on Notifications, Websites and Blocklist attempts; the Activity stream and logs tail hold rows behind their own "N new" pills).
- **Stable geometry.** Skeletons match final heights; windowed queries keep previous data; tiles and chart render placeholders at their final size; the Overview layout shift over 70 s is ≤ 0.001.
- **Empty states**: exactly three kinds (§7). Zero-data states carry a CTA where one exists. Chips and counts render only when > 0 (no "0 errors", no "Public" chip, no identical chips on every row).
- **Loading**: skeleton for region loads (400 ms delay), spinner only on buttons, progress for determinate work. The shell renders immediately; page errors render inside the shell.
- **Errors**: field (inline), region (`ErrorState tier=region` with Retry), page (`RouteError` with Retry and an escape link). Codes are always shown and copyable.
- **Confirm every destructive action**: terminate, delete (typed slug for one session, typed count for bulk), bulk archive, delete binding, group policy → `reject_all`, attention reject, vault confirm deny, bulk resolve/reject, notifications "Dismiss all". Enter in an attention message box never resolves.
- **Optimistic updates** only for: attention resolve/reject (the session banner row is removed optimistically), vault confirm approve/deny, notification read/dismiss. Rollback restores the cache entry and shows an error toast with the code.
- **Copy**: sentence case, verbs first, no exclamation marks. Empty states and callouts that tell the operator how to enable something quote the exact flag or environment variable (`--blocklist <file>`, `BROWSERHIVE_BLOCKLIST`, `--vault bitwarden`) and explain it inline; where published documentation exists they also link to it. Every outbound URL comes from `lib/links.ts` (browserhive.ai docs, the repository, issues, releases): the sidebar and Help menu, the command palette, `InfoDot` popovers ("Read the docs"), not-enabled empty states, the sessions zero-data CTA (the MCP clients guide) and config keys on the System page. English only; `Intl.NumberFormat('en-US')`; `Intl.DateTimeFormat` in the browser timezone, 24 h clock.
- **Timestamps**: `RelativeTime` (relative text, absolute tooltip); tables show the absolute short form; log lines show absolute mono times with ms.
- **Identifiers**: `SessionRef` renders session ids; filtering by an entity is an explicit filter button or chip, not an id click.
- **Time-range vocabulary**: `24h | 3d | 7d | 14d | 30d | all` plus custom `since/until`. `all` means all time.
- **Colour** carries meaning only (registry). **Motion** is decoration: attention is signalled by an amber border that also exists without animation.

## 12. Pages

Shared search schema (`lib/search/table.ts`): `page` (int ≥ 1, default 1), `ps` (25|50|100), `sort` (per-page enum), `dir` (`asc|desc`), `q`. Any filter/sort change resets `page`; defaults are stripped from the URL (`stripSearchParams`); lists are written as comma lists (`?level=warn,error`) and TanStack's JSON-array spelling also parses; flags are `1`; writes use `replace: true`. `/` redirects to `/overview`.

### 12.1 `/overview`

Search: `range` (default `7d`), `since`, `until`. The activity chart is always shown, so there is no chart toggle param (an unknown `chart` param is stripped).

- **KPI tiles**: Live sessions (→ `/sessions?view=live`, sub "N watched live"), Open attention (→ `/attention`), Sessions, Tool calls, Errors (sparklines only with ≥ 3 non-empty buckets, drawn beside the value), Blocked URLs (→ `/blocklist`; shown only when a blocklist is configured or `blocked_total > 0`); with the vault on, Vault fills and Active live views. `tileGridClass(n)` places 4/5/6/7/8 tiles without an orphan row (first tile spans two columns for 5 and 7).
- **Activity chart** (hand-rolled, `ActivityChart.tsx`): stacked calls/errors bars, `niceScale` integer y-axis, day labels centred over their day (a day less than half inside the window is unlabelled), session starts as amber dots under the baseline. Every non-empty bucket is a real `<a href="/sessions?since&until">` with a column-wide hover fill and focus ring. The tooltip is React state beside the column and clears on leave/blur. The description names the bucket size; when all activity is in the last day of a wider window it says so and offers "Zoom to 24h". Buckets: 24h → 1 h, 3d → 3 h, 7d → 6 h, 14d → 12 h, 30d/all → 1 d.
- **Panels** (12-column from `xl`: left 7 = Recent sessions, Websites visited; right 5 = Recent failures, Most visited domains; stacked below): flush `LinkList` rows that are whole-row links, each with a `PanelLink` header action.
  - Recent sessions: slug + state dot, calls · errors (> 0 only) · last URL, time.
  - Websites visited: 10 live rows (URL, slug, time) → session.
  - Recent failures: latest failed calls from `GET /tool-calls?ok=false&has_session=true` (tool, code, session, message) → `/sessions/$id?kinds=tool&errors_only=1`; header → `/sessions?sort=errors`.
  - Most visited domains: top 8 `BarList` → `/websites?domain=…` keeping the range.
- **Data**: `useWindowAnchor` + `keepPreviousData`; a minute rollover never refetches with a new key or flashes a skeleton (tested with a mutable server clock).

### 12.2 `/sessions`

Search: table schema + `view` (`live|closed|archived`, absent = all non-archived), `owner`, `channel` (csv), `persistence` (csv), `since`, `until`, `archived` (`include`). Sort keys: `created|slug|channel|activity|errors|lease|owner|persistence|closed|blocked`. Selection is local state keyed to the filter signature and never in the URL (§1 principle 1).

- **Header**: "N sessions · N live" only when unfiltered; the explainer is in `learnMore`. "N matching" shows only when filtered.
- **Filters** inside `SelectionToolbar`: view toggle, Owner select and facet chips rendered only when they have more than one option, search, time range, View menu.
- **Columns**: Session (slug `font-medium`, underlines on row hover; second line = unique id suffix in mono with the full id in the tooltip and copy, `· chrome/headed/incognito` only when not default, owner only when facets show more than one) · State (dot + text; second line = lease bar while live, "lease paused" during attention, or relative closed time) · Last URL (`grow`, host emphasised) · Activity (`12 calls`, `2 errors · 1 blocked` in red only when > 0; `sortAliases` errors/blocked) · Created (relative, absolute tooltip) · actions (`revealOnHover`). Rows ≈ 53 px, two lines. Columns follow container queries (§10).
- **Rows** are whole-row links to `/sessions/$id`. Row actions: an "Open live view" icon (live rows) + kebab (Open, Open live view, Copy session id | Archive/Unarchive — disabled with "Available once the session closes" while live, Terminate… (live only), Delete…).
- **Bulk bar**: Archive/Unarchive, Terminate only when a selected session is live ("Terminate N live" when mixed, sends only live ids), Delete (typed count), Clear.
- **Cards** under 768: whole-card links with slug, id, host+path, state/lease and activity.
- Data: `sessions.list(params)` with server facets; topics `sessions`, `attention`. Empty: zero-data ("No sessions yet" + docs CTA), zero-results, "No archived sessions".

### 12.3 `/sessions/$id` — session workspace

Search (`features/sessions/detail-search.ts`): `tab` (`activity|screenshots|files|details`, default `activity`), `live` (flag), `takeover` (flag), `kinds` (csv of `tool|page|attention|vault|blocked`), `errors_only` (flag), `q`, `view` (`list|table`), `open` (csv of expanded timeline item ids), `shots` (csv of screenshot kinds), `page`, `ps`. Switching tabs clears the tab-scoped keys and keeps `live`.

**Aliases** (`route-redirects.ts`, `detail-search.ts`): the session page accepts alternative link spellings and redirects them in `beforeLoad` (`replace: true`) to the canonical search, so hand-written links, bookmarks and links pasted elsewhere that name a single-kind tab or the live view land on the equivalent workspace view. `/sessions/$id/live` → `/sessions/$id?live=1` keeping `takeover`. Search aliases:

| Alias | Canonical |
|---|---|
| `tab=timeline` | Activity |
| `tab=tools` / `tab=pages` / `tab=vault` | Activity with `kinds=tool` / `page` / `vault` |
| `ok=0` | `errors_only=1` |
| `tab=overview`, `tab=identity` | `tab=details` |
| `tab=live` | `live=1` |
| `kind` | `shots` |
| `expanded`, `follow`, `sort`, `dir`, `tool`, `pane`, `size` | dropped |

**Header** (`SessionHeader`): title = slug (20 px semibold) + state dot badge; meta = full mono id (copies on click) · owner · non-default browser · Started (relative) · Running for / Ran for (coarse, so the line never reflows each second); separators are CSS markers clipped at line starts. Actions: a **Live** toggle (`aria-pressed`, `L` hint) while the session is live or the pane is open, or **Open trace viewer** when closed (hidden on the Files & trace tab); `⋯` menu: Open trace viewer, Download trace.zip, Export activity NDJSON/CSV, Copy session id | Archive, Terminate… (live), Delete….

**Attention banner** (`AttentionBanner`): driven by `GET /sessions/:id/attention?status=pending`, never by `counts`. Shows the full reason (wraps), asked / times-out times, page host+path, "N more waiting". Reject… and Resolve… open a popover with an optional message (≤ 500) and use the shared `useResolveAttention` hook (optimistic banner removal, toast "Message sent: …"). **Take over** appears only for `mode === 'takeover'` and sets `?live=1&takeover=1`. `session.warning` events render as dismissible callouts under it.

**Tabs** (line tabs owned by the left pane, so the live pane sits beside them, not under them):

- **Activity** (`activity/*`): one stream of tool calls, page visits, attention requests, vault fills and blocked navigations, so the operator reads a session in one place instead of cross-referencing per-kind lists:
  - Server-paged `GET …/timeline` (100 per page), older pages loaded automatically at the end ("Load older activity" / "Start of the session").
  - Filters: kind chips with a real pressed state (a chip shows only when that kind exists or is selected; counts from live `counts`, none for Attention), an Errors chip (red when pressed, hidden at 0), server search `q` (debounced, `/`), List/Table toggle (`bh.activity.view` fallback).
  - Folding: a page visit whose tool call is loaded (same `event_id`) folds into the call, so `navigate` shows `host/path · title`; selecting Tools alone fetches `kinds=page,tool` to keep folding. The `request_attention` call folds into its attention row (by `event_id`, else the nearest call within 3 s), which shows the outcome and reply.
  - List row (fixed 57 px): `HH:MM:SS` (+ date when not today) · kind icon (per-tool icons; red on failure) · primary (tool in mono / page title / "Takeover requested") · secondary (URL, `CODE · message` clamped to 2 lines, reason) · thumbnail (`@xl`) · duration (`@lg`) · chevron. Table row (40 px): Time · Event · Details · Status (icon only for problems/outcomes, label in tooltip) · Duration · Size.
  - Row detail (inline expand, click anywhere on the row head or the chevron `button[aria-expanded]`): tool calls fetch `…/tool-calls/:event_id` and show facts, error box, "Landed on", Parameters and Result `JsonView` (Result hidden when it only echoes the error), screenshot with zoom; other kinds show their full record; **Copy as JSON** everywhere.
  - Keyboard: roving focus with j/k or ↑/↓, Home/End, Enter/Space to expand; virtualised rows scroll into view.
  - Live: a Follow switch while live; new rows are held while the reader is scrolled away or Follow is off, behind a sticky "N new events" pill that releases them and scrolls to top.
  - Virtualised (TanStack Virtual) on the page scroller in the document layout (`useWindowVirtualizer`) or on its pane in the workspace.
- **Screenshots**: All / Agent captures / Trace frames segmented control (`shots`); a thumbnail grid using each capture's aspect ratio; each card shows the page title at capture time (from `GET /pages?session_id&until=<newest shot>&limit=500`, latest visit at or before the capture), then host · dims · size, then time; falls back to host, then "Screenshot" / "Trace frame · <tool>"; zoom modal; pager only when needed.
- **Files & trace**: Playwright trace panel (size, Download, Open trace viewer with the disabled reason in a tooltip, `npx playwright show-trace` with copy), data directory (path wrapping at `/`, copy, Show files with result notes), Export activity.
- **Details**: counts strip (tool calls, errors, pages always; blocked and open attention when > 0; vault fills when the vault is on or > 0) whose cells link to Activity with `kinds` / `errors_only`; Session panel (state + worded closed reason, owner, client, browser, persistence, started/closed/lifetime or lease, last URL, proxy); Identity & coherence (full-width UA with copy, provenance); Browser viewport (`ViewportForm`, `POST /sessions/:id/viewport`) while live; the form says plainly that it changes the agent's real viewport and that pages may re-layout under the agent, because `set_viewport` is not attention-gated (D-10).

**Live pane** (`live/LivePane.tsx`), toggled by the Live button, `L`, or the palette; state `?live=1`:

- **≥ 1280 px** (and the session loaded): `useWorkspaceLayout(true)` + a resizable split, Activity left and Live right. Live gets 60 % by default; the ratio is saved in `bh.session.split.v2`; Activity's minimum is 22rem. "Focus the live view" (or dragging Activity under its minimum) collapses Activity to a 4rem rail, remembered in `bh.session.focusLive`. The pane stays mounted through every layout change, so the stream is never restarted by one. Each pane scrolls itself.
- **< 1280 px**: the pane stacks above the tabs and the page scrolls normally.
- **Stage**: a dark card whose aspect ratio is the page's (frame size from the stream, else the launch viewport), never taller than the pane, so the frame fills it without black bars. The canvas backing store is its CSS box × DPR and the bitmap is drawn into `letterboxRect(box, bitmap)` (contain, centred), repainted on resize; input maps through the same rect (`toPageCoords`). The canvas cursor is default when view-only.
- **Toolbar** (44 px): status pill button (Live / Idle / Connecting / Reconnecting / Paused / Ended / Failed / Stopped) whose popover explains the state and lists page size, stream size, fps, dropped frames and last-frame age; "Idle" = no frame for 2.5 s (`IDLE_AFTER_MS`) and is described as normal. The current page URL. "Takeover open" chip or "View only". A vault raw-pixels popover only when `/system` reports the vault enabled. Pause/resume, quality menu (Auto/720p/1080p/Native, `bh.liveView.size`), resize-viewport popover (compact `ViewportForm`), fullscreen, focus, hide (`L`).
- **Overlays**: connecting (spinner), failed/stopped (code + Retry, which sends a fresh start), paused (Resume), reconnecting (chip).
- **Ended**: when the session is `draining` or not live the pane shows Closing/Ended immediately over the kept last frame, stops the stream, and the page polls detail every 2 s while draining. Opening `?live=1` on a closed session strips the param and shows a one-line info callout ("Closed by the agent" …, Open trace viewer, Dismiss).
- **Takeover**: gated by `takeoverRequest(session, pending)` = a pending attention request with `mode === 'takeover'` (`attention_open > 0` alone is not enough). The footer has a **Capture keyboard** switch with a `label[for]` and `aria-label`, a hint line, and an on-screen keyboard button on coarse pointers. `?takeover=1` arms capture once frames arrive, then removes the param. Border: warn while takeover is open, primary while capturing (3 px ring). `INPUT_NOT_PERMITTED` shows a toast with the code. Input set: click, double/right/middle click, hover at rAF, drag, non-passive wheel, keyboard (keyDown/keyUp with text, modifiers, VK codes), touch (forwarded as raw `touchStart`/`touchMove`/`touchEnd` events, so the page itself interprets taps, scrolls and long presses; no gesture translation), mobile text input.

Data: `keys.sessions.detail(id)`, `.timeline(id, facet, params)`, `.screenshots(id, params)`, `.pageContext(id, params)`, `.attention(id)`, `.trace(id)`; topics `session:<id>`, `screencast:<id>`. Error: 404 → page-level "Session not found" with "Back to sessions". Skeleton shaped like header + tabs + rows.

### 12.4 `/attention`

Search: `mode` (csv), `status` (csv), `session`, `range` (default `7d`), `since`, `until`, table params; sort `created|resolved|waited` (keyset cursors walked by `useCursorPager`).

- **Header**: "Attention" + a warn "N open" pill (the only count); one-line description with the mode explainer behind Learn more; a labelled "Sound alerts" switch (per device).
- **Open requests**: Reject all / Resolve all when > 1 open (confirm). Empty queue = one compact panel. Cards (`AttentionCard`, memoised): 3 px left stripe (warn takeover / info notify); meta line = mode pill (Take over / Notify, `ICONS.takeover`), "Waiting 4m 12s", deadline pill; the reason as a 16 px headline clamped to 4 lines with Show all/less; Session / Page / Options facts (`{choices:[…]}` as chips, else collapsed JSON); the session's latest stored screenshot captioned with its age relative to the request (from md, zoomable); footer = message input, **Take over** (a real link to `/sessions/$id?live=1&takeover=1`) as primary for takeover or Resolve for notify, Resolve/Open session secondary, Reject (`destructive-ghost`, confirm). Phone order: primary (full width), secondary, Reject; from 640 px Reject · secondary · primary. The 1 Hz clock lives only in `Tickers.tsx`, so ticking and typing never re-render other cards.
- **History** (`HistoryTable`): facet chips Outcome then Mode from the API's disjunctive `facets` (zero-filled); columns Outcome (dot), Reason (grow, 2-line clamp + message), Mode, Session (real link), Waited, Requested; click a row to expand (full reason, message, resolution, page, tool, requested/settled with by, options, Open session). Phone cards share the expansion state.
- The success toast echoes the message ("Message sent: “…”"). `useResolveAttention` (`features/attention/api.ts`) serves this page and the session banner.
- Vault confirms are fetched only when `/system` says the vault is enabled (`=== true`).

### 12.5 `/websites`

`/navigation` is an alias route that redirects to `/websites` keeping the search (`replace: true`), so links using the other natural name for navigation history land on this page. The REST resource and WS topic are `pages` (§17).

Search: `range` (default `7d`), `since`, `until`, `category` (csv), `session_id`, `domain`, `top` (5|10|25|100, default 10), table params; sort `time|session|category|domain` (domain has no header; URL only).

- Header without a count meta; "N matching" in the FilterBar.
- Category chips from `facets.category` (zero options hidden unless selected; without facets every category shows without counts).
- Table: Time (absolute), Session (`SessionTitle`), URL (grow; category only when not public), Tab (from 2xl), and a hover-revealed filter icon button ("Show only example.com", pressed while active). Rows are whole-row links to the session; cards under 768.
- **Most visited domains**: from 1280 px a sticky side panel (320 px, 352 px from 1800) with a Top select; below, a collapsible panel (collapsed by default) above the table. Rows toggle the `domain` filter; the active row gets an inset ring, check and semibold label; the value is a thin meter under the label.
- Live `page.visited` prepends hold while reading (`useLiveHold`, "N new navigations").

### 12.6 `/blocklist`

Search: `range` (default `7d`; `all` = all time), `since`, `until`, `source` (csv), `pattern`, `domain`, `session_id`, table params; sort `time|session|source|domain|pattern`.

- Header: short description, explanation in Learn more; **Reload blocklist** always shown, disabled with "No blocklist file is configured, so there is nothing to reload" when unconfigured.
- **Not configured, never used**: one compact `EmptyState` panel (`not-enabled`, capped at `max-w-2xl`) with the configuration hint (start with `--blocklist <file>` or set `BROWSERHIVE_BLOCKLIST`, one URL pattern per line); no tiles, table, filters, pager or range.
- **Not configured but with history**: an info callout plus the normal page.
- **Configured**: skipped-lines callout; 4 tiles; Patterns and Top refused hosts as warn `BarList`s (side by side from xl). Patterns ranked by hits (ties in file order), capped at 10 with "Show all N patterns" (an active filter stays visible past the cap); never-fired rows show "—" with a tooltip naming the file line and suggesting a check of the pattern shape; rows toggle filters.
- **Attempts table**: Time, Session, URL (grow), Pattern (mono, truncates), Source (icon + text, xl), and a hover-revealed filter menu (Host / Pattern). Rows link to the session; cards on mobile; live hold pill.

### 12.7 `/vault`

Search: `tab` (`bindings|groups|confirms|tester|transfer`, default `bindings`), bindings table params + `group`, `folder`, tester inputs `tester`, `slug`, `entry`.

- `useVaultEnabled()` is `undefined` until `/system` loads; nothing under `/vault/*` is requested while the vault is disabled (a full sweep records zero `/vault/*` requests).
- **Disabled**: one `VaultDisabled` panel (icon, explanation, 3 steps: start the server with `--vault bitwarden`; "Unlock it on this page" by pasting a session token from `bw unlock --raw` or starting with `BW_SESSION` exported, never the master password; decide what agents may fill).
- **Enabled**: state badge + capability meta + Sync/Lock in the page header; sync result callout; unlock card; line tabs.
  - Unlock card: one password-type field whose label, hint and input handling follow the backend's `unlock.mode` (from `GET /vault`); the value is held only in form state until submit, and secrets are never displayed. For Bitwarden (`mode: 'token'`) the field is "Session token": the operator pastes a `BW_SESSION` token (surrounding whitespace is trimmed, autocomplete and spellcheck are off), the copy states that BrowserHive never asks for the master password and keeps the token in memory only, and a `VAULT_UNLOCK_FAILED` explains that the token may have expired and a new one must be pasted.
  - Bindings: chip lists wrap, edit/delete icon buttons always visible, row click edits, mobile cards, "New binding" disabled with a tooltip while locked; `BindingEditor` form (item picker, title with derived handle hint, origins, flags as ui `Checkbox` through `Controller`, contracts validation).
  - Groups: wrapping header buttons; access-mode select with confirm before `reject_all`; allow-all policy form; locked state is a compact panel.
  - Confirms (approve / deny with reason, bulk), Tester (origin tester, logic from contracts helpers), Transfer (export/import with merge/replace card radios).

### 12.8 `/vault/log`

Search: `result` (csv), `origin_check` (csv), `evaluate` (`on|off`), `session_id`, `entry`, range/`since`/`until`, table params; sort `time|entry|result|session`. `DataTable` with shared expansion (`onToggleExpanded`, no Details column), width-aware columns, mobile cards. Facet chips hide counts until the server reports facets. Not-enabled explainer (`VaultDisabled page="log"` with "Go to Vault") when the vault is off.

### 12.9 `/logs`

Search: `level` (csv), `module` (csv root prefixes), `session_id`, `trace_id`, `request_id`, `q`, `since`, `until`, `dashboard` (`show`). Live/paused is view state, never in the URL.

- **Layout**: `useWorkspaceLayout()`; the log console is the only scroller. Status strip (paused / reconnecting / offline, counts, gap warning, "N dashboard records hidden · Show", Resume), column header, virtualised rows (13 px mono: time with ms, level, module, message; HTTP access records read `POST login 200 198 ms`). A whole-row toggle expands to actions (Copy JSON, Filter to trace/request, Open session, Open trace in APM when `otelTraceUrlTemplate` is set), correlation ids with copy, error block, fields `JsonView`.
- **Order: newest at the top.** The head page is `GET /logs?dir=desc&limit=200` (never cached across filter changes); "Load older" follows `next_cursor`; the buffer holds at most 5 000 records (the oldest drop and "Load older" is disabled).
- **Tail**: WS `log.record` events are filtered client-side and batched every 100 ms per filter key (`LiveBatch {key, records}`), so a record queued under old filters never lands after a filter change. Scrolling away with real input (wheel, touch, key, pointer; never a measurement) pauses with "N new records"; scrolling back to the top resumes a scroll pause; the "● Live" / "▷ Resume" button's manual pause is sticky.
- **Reconnect**: a gap fill `GET /logs?dir=desc&after_seq=<max seen seq>` walks `next_cursor` (≤ 5 pages) and merges by `seq`; the buffer is never wiped. A daemon epoch change starts a new buffer.
- **Filters**: search, level chips without counts, a Module menu of roots (checkbox items; client matching mirrors the server's root-prefix rule), session/trace/request tokens. Under 640 px levels, modules and dashboard traffic collapse into one Filters menu with a count badge; Daemon log level and Export become icon buttons.
- **Dashboard traffic** (off by default; `?dashboard=show` shows it; Clear resets): hides successful `GET`/`HEAD`/`OPTIONS` REST reads (status < 400, not `/mcp`, including the `/api/v1/ws` upgrade) and info/debug `ws.hub` connect/disconnect lines (`isDashboardTraffic`). Never hidden: writes, 4xx/5xx, MCP traffic, hub warnings and errors. Client-side over the buffer (toggling never refetches); while it hides records and fewer than 40 are visible, older pages load automatically (≤ 4 per buffer). A `request_id` or `trace_id` filter bypasses it. Discoverable through a labelled switch with an info popover, the status-strip count, a palette page action and the empty state. Export (`GET /logs/export`, NDJSON) is server-side and includes dashboard traffic.
- **Daemon log level**: a header popover (default level select + per-module override rows; "Sets `info,sessions=debug`" only when the draft differs; Apply → `PATCH /system/log-level`), explained as distinct from the page's Level filter.
- **Errors**: `ErrorState` after retries (never an endless skeleton), `PanelBoundary` around the console.

### 12.10 `/system`

Search: `tab` (`status|tokens|config`, default `status`), `key` (config filter). One `Tabs` root; a 403 renders one page-level `ErrorState` with no tabs. Mapping is pure in `system/model.ts`.

- **Status**: notices shown once (evaluate with vault risk, degraded health, disk pressure). KPI tiles: Uptime, Live sessions (→ `/sessions`), Open attention (→ `/attention`), MCP clients, Database (phones: Uptime spans the first row then 2×2; md: Database spans two columns; xl: 5 columns). Health and Runtime share one card: Health reads the 503 body when degraded instead of vanishing; Runtime lists versions in sans tabular figures, and Chromium shows `runtime.chromium` as the version, "Available, version not reported" (muted, info hint) when it is `null` but sessions are live or `health.checks.browser === 'ok'`, and "Not installed — run browserhive init…" only when nothing launches. Storage & retention beside a stack of Degradations (compact when empty) and Dashboard connections; Migrations.
- **Agent tokens**: auth-off notice (from `auth_mode`), aligned create form, compact empty state, table with width-dependent columns, once-shown token dialog with MCP snippets in `DialogBody`; "Agent tokens" + count pill only when > 0.
- **Configuration**: settings in effect as grouped key/value panels in two independent stacks (Server + Integrations beside Sessions + Stealth, `items-start`); mono only for Bind address and Data directory; paths wrap at `/`. "All configuration keys" table: key, wrapping value, source chip, "overrides env 9000" lines, filter + "only changed from defaults".

### 12.11 `/notifications`

Search: `read` (`all|unread|read`, default `all`), `type` (csv), `range` (`24h|7d|30d|all`, default `7d`), `page`, `ps`. Reachable from the bell's "View all" and the palette.

- Header: accent "N unread" pill, description, Dismiss all (ghost, confirm), Mark all read.
- `FilterBar`: labelled "Show" segmented control + "Period" range in the first row, type chips (no counts) in the second, "N matching" + Clear all.
- List: day groups ("Today", "Yesterday", `Mon D`) of `Panel`s with `LinkRow`s ordered and grouped by `updated_at`. **The whole row is a real link to its target and opening it (including middle/ctrl-click) marks it read.** Row: tinted type icon (type also in sr-only text), title (semibold + accent dot while unread), 2-line body, meta (session slug with a session icon unless the title leads with it; "first <time>" for grouped rows), time at the right edge. Mark read / Dismiss (32 px, labels include the title) fade in over the time on hover-capable devices and stay visible on touch.
- Live inserts and group updates hold while reading (`useLiveHold` with `getVersion = updated_at`).
- **Toast preferences** panel (mounted after the list loads): pop-up toasts switch, "Toast for" type checkboxes (default `DEFAULT_TOAST_TYPES`, disabled while toasts are off), Save enabled only with changes; other stored preference keys are preserved.

### 12.12 `/login`, `/change-password` (public layout)

`AuthLayout`: theme menu top-right, brand mark above a centred card, title + subtitle; sets `document.title` ("Sign in · BrowserHive" or the change-password title).

- **Login**: native `<form>`, 40 px `PasswordInput` with show/hide (`autoComplete="current-password"`, autofocus); Sign in always enabled — an empty submit shows "Enter the password." inline, focuses the field and clears on typing; invalid → inline error with icon; 429 → countdown on the button from `retry_after_ms`; seed-password help collapsed under "Where do I find the password?". The page load makes no failing request.
- **Change password**: current/new/confirm with the contracts schema (min 12), a live requirement checklist, a 4-step strength meter, confirm-field validation; reachable voluntarily from the principal menu (`?voluntary=1`, with Cancel).
- `AuthGate` renders offline/error as a page-tier `ErrorState` inside the auth card.

### 12.13 `/theme` (dev), NotFound

`/theme` 404s outside `import.meta.env.DEV`; it renders every token in both themes with computed WCAG ratios. NotFound: inside the shell, "Page not found" with links to Overview and back.

## 13. Live-view protocol usage

Wire format per `03-admin-backend.md` §6.5–6.7.

- **Start** after the stage has been measured (or 300 ms have passed): `command('screencast.start', { session_id, max_width, max_height, quality })`. `max_*` for `fit` = stage box × `min(2, max(1, devicePixelRatio))`, clamped to 64…`SCREENCAST_MAX_DIMENSION`; presets 720p = 1280×720, 1080p = 1920×1080, native = 3840×2160. No `quality` is sent: the stream is shared by every viewer, so the server's `--screencastQuality` decides it, and a value that changed with fullscreen would only restart the stream.
- **Order on the wire** (server-guaranteed): reply `screencast.started {ordinal}` → `started` → `meta` → first binary frame, also on an unchanging page. The client maps ordinal → topic on `started`/`meta`.
- **Resize**: `command('screencast.set_size', { session_id, max_width, max_height })` debounced 250 ms (`SET_SIZE_DEBOUNCE_MS`) on stage resize, split drags and focus/fullscreen changes; skipped when unchanged. The pane stays mounted, so layout changes never stop and restart the stream.
- **Frames**: binary messages with the 16-byte `BHSC` header (ordinal, seq, width, height = the page's device CSS size, not the JPEG size), decoded with `createImageBitmap` off the React render path and drawn fitted onto a `<canvas>` (§12.3). Latest-wins: a lower `seq` after a higher one is dropped.
- **Status pill** derives from socket state, stream controls and last-frame age: Connecting → Live; Idle after 2.5 s without a frame; Reconnecting; Paused (client pause, `screencast.stop`); Ended (session not live); Failed (`SCREENCAST_FAILED` reply or a `stream failed {code}` control, after one automatic retry); Stopped (`stream stopped`). The popover shows page size, stream size, fps, dropped frames and last-frame age.
- **Tab switch** by the agent: no new message; `meta` and frames continue on the same ordinal.
- **Stop**: `command('screencast.stop', { session_id })` on unmount or pause. The client MUST NOT add delayed stops or retries around start/stop: the server serialises start/stop/set_size per connection and per session, so commands are sent as they happen.
- **Input**: `command('input', { session_id, input })` fire-and-forget (mouse moves coalesced at rAF); refusals surface as an `INPUT_NOT_PERMITTED` toast. Viewport resize is REST `POST /sessions/:id/viewport`.

## 14. Testing

- Unit (`bun test`): status registry exhaustiveness, search schemas (defaults stripped, page reset, csv parsing, session search aliases), `search-params` csv serialisation, `JsonView` escaping, formatters, WS bridge (timeline id dedupe, notification upsert across bell/inbox/unread/read/page-2 keys), keyboard registry (`?`), auth machine (429/5xx keep the shell), toast policy (`planToast`), live-hold freezing, logs buffer and `enqueueLive`, `isDashboardTraffic`, frame fit and input mapping, takeover gate, date-range helpers.
- Component (`bun test` + happy-dom + RTL + axe with no disabled rules): `DataTable` (sort gating and aliases, selection, treegrid/grid roles, keyboard, clamped pagination, linked-row text not lifted), `FilterBar`, `ConfirmDialog`, `ErrorState`, pages (Overview minute rollover, Session page tabs/banner/redirects, LivePane, Logs filter race, Notifications hold).
- CSS contract: `styles/affordances.test.tsx` compiles the real `globals.css` (focus-ring utilities, safety net, row-link z-index contract).
- Harness: the root `test/preload.ts` registers happy-dom (only when the run includes `packages/dashboard`) before any CommonJS module links, adds global RTL cleanup, and sets `asyncUtilTimeout` to 3 s. Dashboard runs pass under randomized file order.
- Contract: the dashboard compiles against the contracts schemas; fixtures in `test/fixtures` parse with them.
- E2E (Playwright, `test/e2e`): `smoke.e2e.ts` (operator journey with forced password change) and `affordances.e2e.ts` (Tab walk with computed outlines, `elementFromPoint` over URL text in linked rows, real Ctrl+K).

## 15. Extension recipes

- **Add a page**: create `src/features/<name>/` (`api.ts`, `search.ts`, `<Name>Page.tsx`) and `src/routes/_auth/<name>.tsx` exporting `Route` (with `validateSearch`, `stripSearchParams` defaults, `staticData` for nav/title/palette). Nav, breadcrumb, palette and title derive from `staticData`. Page actions for the palette go through `usePageActions`.
- **Add a stat tile**: add a `StatTile` to the page's tile grid reading a query (update the grid class for the new count); if the metric is new, add it to the contracts DTO and the backend aggregate first.
- **Add a session tab**: add the value to `SESSION_TABS` (and its scoped keys to `TAB_SCOPED_KEYS`) in `features/sessions/detail-search.ts` and render its panel in `features/sessions/SessionPage.tsx`.
- **Add a WS-driven update**: add a row to `lib/ws/bridge.ts`.

## 16. Known limitations

Not built; each is a deliberate scope boundary of the current dashboard, not a defect.

- **Operator sign-in sessions and tool metrics have no page.** `GET /auth/sessions`, `DELETE /auth/sessions/{id_prefix}`, `POST /auth/sessions/revoke-all` and `GET /metrics/tools` are reachable through REST only.
- **Held vault fills are not shown on the session page.** A fill waiting for dashboard confirmation is approved or denied from `/attention` (open requests board) or the Confirms tab of `/vault`.
- **Bulk deny carries no reason.** "Deny all" on a confirm queue sends no `reason`, although `POST /vault/confirm/bulk` accepts one; a reason is given per row with the inline deny control.
- **No saved views or server-side page defaults.** A view is shared as a URL; `/me/preferences` holds notification toast preferences only (§4.6).
- **Dashboard-traffic filtering is client-side.** `GET /logs` and `GET /logs/export` have no server-side equivalent of the Logs page's dashboard-traffic filter, so older pages are loaded to fill a filtered view and exports include dashboard traffic (§12.9).
- **Error states do not link to the error reference.** `ErrorState` shows the code as a copyable token only; `AppError.docsUrl` already builds the `browserhive.ai` link for when it should.
- **The operator cannot open a browser.** There is no `POST /sessions`; sessions come only from an agent's `launch_session`, so a dashboard with no agent connected has nothing to watch or drive.
- **Takeover starts only when an agent asks.** Input is gated per message on an open `takeover` attention request, which only `request_attention` creates; there is no operator-initiated takeover.
- **Live-view input gaps.** No clipboard: Ctrl/Cmd combinations are left to the local browser (`shouldPreventKey`), so paste never reaches the remote page. No IME composition. A popup or `window.open` tab never becomes the watched tab (only the agent switching tabs retargets the stream) and there is no operator tab switcher, so OAuth popups are invisible. Native dialogs, file choosers and browser UI are not part of a CDP screencast. WebAuthn/passkeys cannot work: the authenticator is on the operator's machine, not in the remote browser.
- **No `noindex` signal.** Neither `index.html` nor the daemon's responses carry `robots` meta or `X-Robots-Tag`; a dashboard exposed beyond loopback relies on authentication to keep its pages out of search indexes.

## 17. Design constraints

- **Page names follow the operator's vocabulary; wire names follow the resources.** The page is "Websites" (`/websites`), while the REST resource and the WS topic are `pages`, because WS topics map 1:1 to REST resources (D-10).
- **Wire formats are consumed, not defined, here.** The screencast frame header is defined once in `contracts/ws/screencast.ts` and `03-admin-backend.md` §6.5; its `width`/`height` are the page's viewport in CSS pixels, not the JPEG size (the JPEG may be downscaled).
- **The client relies on server ordering guarantees instead of compensating for them**: screencast start/stop/set_size serialisation and message order (§13), the logs gap fill by `after_seq` (§12.9), and full DTOs in feed events for cache patches (§5).
- **Transient failures never sign the operator out** (§4.1), and a page crash never replaces the shell (§5 error boundaries).
- **Layout choices are per device, shareable view state is per URL, and only preferences that should follow the operator across devices are stored server-side** (§1 principle 1, §4.6).
