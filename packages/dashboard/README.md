# @browserhive/dashboard

The BrowserHive operator dashboard: a React 19 single-page app served by the daemon at `/`. Its design, page contracts and UX rules are specified in [`specs/04-admin-frontend.md`](../../specs/04-admin-frontend.md); this file is the practical entry point.

## Run

```sh
bun run browserhive --admin                         # daemon from source + Vite dev server on --port + 10000 with hot reload (spec 06 §2.1)
bun run --filter @browserhive/dashboard dev         # Vite dev server alone; proxies /api (ws too), /mcp, /health, /trace-viewer to BHDEV_DAEMON_URL (default http://127.0.0.1:9876)
bun run --filter @browserhive/dashboard build       # → packages/dashboard/dist (no sourcemaps in production)
bun run --filter @browserhive/dashboard gen:routes  # regenerate src/routeTree.gen.ts outside Vite (typecheck, CI)
bun run test:dashboard                              # unit + component tests (happy-dom + Testing Library + axe-core)
bunx biome ci --error-on-warnings packages/dashboard
BROWSERHIVE_E2E_URL=http://127.0.0.1:9876 BROWSERHIVE_E2E_PASSWORD=… bun run test:e2e
```

`src/routeTree.gen.ts` is generated (Vite plugin in dev and build, `gen:routes` for `tsc`) and is never hand-edited. The root `bun run typecheck` includes this project.

## Structure

```
index.html                 theme bootstrap (no flash of the wrong theme), meta theme-color, font preloads, noscript
vite.config.ts             React + TanStack file routes (auto code-split) + Tailwind v4; dev proxy to the daemon
components.json            shadcn config (Base UI primitives, css = src/styles/globals.css)
playwright.config.ts       e2e runner against a running daemon (desktop and phone projects)
src/main.tsx               mount
src/app/App.tsx            provider composition only
src/app/router.tsx         createRouter + `RouteStaticData` (title, nav, crumb, requires, palette)
src/app/providers/         Query, Auth (+ auth-machine), Socket, Notifications, Confirm, Toast, Keyboard
src/app/shell/             AppShell, Sidebar, Topbar, HealthPill, NotificationBell, PrincipalMenu, ThemeMenu, CommandPalette, KeyboardMap, RouteError, NotFoundPage, workspace layout and page actions
src/theme/                 ThemeProvider, theme store, bootstrap helpers
src/routes/                file routes: __root, index (→ /overview), _auth (auth gate + shell), _public (login, change-password), theme (dev only)
src/features/<name>/       page code: api.ts (queries), search.ts (zod search schema), <Name>Page.tsx, components
src/components/ui/         shadcn copies on Base UI, adapted to the design tokens
src/components/shared/     the shared component set (spec 04 §7): PageHeader, DataTable, FilterBar, StatTile, DataPanel, EmptyState, ErrorState, …
src/lib/api/               client.ts (typed calls over the contracts manifest), operations.ts (operationId → schemas), http.ts, errors.ts (AppError), keys.ts (query keys)
src/lib/ws/                store.ts (socket store), bridge.ts (feed event → cache patch table)
src/lib/search/            table.ts (page/ps/sort/dir/q rules), time-range.ts, use-search-state.ts
src/lib/                   status-registry.ts, keyboard.ts, icons.ts, format/, storage.ts, clock.ts, server-now.ts, client-errors.ts
src/styles/                globals.css (base layer, row-link and focus-ring contracts), tokens.css (all colours, px values and durations), shadcn.css
test/                      setup, helpers (page harness, axe, fake socket, select), fixtures, e2e/
```

Rules the tooling enforces: function components only; no inline `style`; no raw colours or px values outside `src/styles/tokens.css`; tones only through `lib/status-registry.ts`; overlays only through Base UI (`components/ui`); state goes in the URL first, then the TanStack Query cache, then component state; no module-level singletons (every store is created by a provider).

## Routes

| Route | Page | Live topics |
|---|---|---|
| `/overview` | KPI tiles, activity chart (buckets link to sessions), recent sessions, websites visited, recent failures, most visited domains | `sessions`, `pages`, `system` |
| `/sessions` | fleet list with view toggle, owner and facet chips, search, time range, bulk bar, row actions, cards on phones | `sessions`, `attention` |
| `/sessions/$id` | session workspace: header actions, attention banner, tabs Activity · Screenshots · Files & trace · Details, live pane with takeover (`?live=1`) | `session:<id>`, `attention`; screencast frames per spec 04 §13 |
| `/attention` | open requests (attention and vault confirms) and settled history | `attention`, `vault.confirm` |
| `/websites` | navigation history with category chips and most visited domains (`/navigation` is an alias) | `pages` |
| `/blocklist` | configuration state, patterns, refused hosts and attempts | `blocklist` |
| `/vault` | bindings, groups, confirms, origin tester, transfer (only when the vault is enabled) | `vault.confirm`, `vault.config` |
| `/vault/log` | vault access audit rows | `vault.access` (or `session:<id>` when filtered to a session), `vault.confirm` |
| `/logs` | live log console (newest first), filters, daemon log level, export | `logs` |
| `/system` | status, agent tokens, configuration | `system` |
| `/notifications` | day-grouped inbox, mark read, dismiss, toast preferences | `notifications` |

Search parameters for each page are listed in spec 04 §12. Page tests render a route inside the real provider tree with `test/helpers/page-harness.tsx` (`renderPage({ path, component, validateSearch, routes, url })`, which returns the router, recorded requests and helpers to connect the fake socket and emit feed events); wire fixtures live in `test/fixtures/`.

## Recipes (spec 04 §15)

### Add a page

1. Create `src/features/<name>/` with `api.ts` (query functions using `useApi()` + `keys.<resource>`), `search.ts` (zod search schema + defaults), `<Name>Page.tsx`.
2. Create `src/routes/_auth/<name>.tsx`:

```tsx
export const Route = createFileRoute('/_auth/<name>')({
  component: NamePage,
  validateSearch: nameSearch,
  search: { middlewares: [stripSearchParams(NAME_DEFAULTS)] },
  staticData: {
    title: 'Name',
    nav: { label: 'Name', icon: 'sessions', group: 'primary', order: 20 },
    palette: { keywords: ['…'] },
    requires: 'vault',                                                   // optional capability gate
  },
});
```

Nothing else changes: the sidebar, breadcrumbs, `document.title` and the palette derive from `staticData`. Object pages set `crumb: (params) => …` to show a breadcrumb instead of the title. Page actions for the palette go through `usePageActions`.

### Add a stat tile

Render a `StatTile` inside the page's tile grid, reading a query through `DataPanel`, and update the grid class for the new count. If the metric is new, add it to the contracts DTO and the backend aggregate first.

### Add a session tab

Add the value to `SESSION_TABS` (and its tab-scoped search keys to `TAB_SCOPED_KEYS`) in `src/features/sessions/detail-search.ts`, and render its panel in `src/features/sessions/SessionPage.tsx`.

### Add a WS-driven update

Add a row to `BRIDGE` in `src/lib/ws/bridge.ts` (`event type → patch(queryClient, payload)`). Use `upsertRow` / `patchRow` / `removeRow` for list envelopes; invalidate when the position under the current sort is unknown. Add a case to `src/lib/ws/bridge.test.ts`.

## Data layer in one paragraph

`useApi()` returns the typed client: `api.listSessions({ query })`, `api.getSession({ params: { session_id } })`, `api.resolveAttention({ params, body })`, `api.bulkSessions({ body, idempotencyKey })`, `api.putVaultBinding({ params, body, ifMatch })`. Inputs are the contracts `z.input` types; responses are parsed with the contracts schema (`.parse` in development, `safeParse` plus a client-error report in production). Non-2xx becomes `AppError` (`code`, `status`, `retryable`, `retryAfterMs`, `details`, `requestId`); a 401 outside login moves the auth machine to `login` and clears the cache, and `403 PASSWORD_CHANGE_REQUIRED` moves it to `change`. Query keys come from `keys` in `lib/api/keys.ts`; the socket bridge patches those keys from feed events, so pages subscribe to topics with `useTopic('sessions')` and read the cache.
