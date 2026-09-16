---
title: "Local development, CI, CD and publishing"
spec: "06"
status: Normative
scope: Running BrowserHive from source as a developer, the root scripts, how each package builds, the GitHub Actions pipelines, and publishing to the npm registry (D-18, D-19).
audience: Contributors setting up a development machine; maintainers operating CI and releases.
related:
  - 00-decisions.md
  - 05-coding-standards.md
  - 07-branching-and-git.md
  - 09-testing.md
---

# 06 — Local Development, CI, CD, and Publishing

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

Branch and PR rules are in `07-branching-and-git.md`; test contents are in `09-testing.md`.

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Bun | ≥ 1.4 (pinned in `.bun-version` and `package.json#packageManager`) | the only runtime (D-01) |
| git | ≥ 2.40 | |
| Chromium for Playwright/Patchright | installed by `bun run init:browsers` | integration tests, `dev` |
| Bitwarden CLI `bw` | optional | vault integration tests (skipped when absent) |
| Node.js | **not required** | Vite, tsdown, Playwright run under Bun |

No native toolchain (no node-gyp, no Python) is needed anywhere.

## 2. First-time setup

```bash
git clone git@github.com:<org>/BrowserHive.git && cd BrowserHive
bun install                      # workspaces, frozen lockfile in CI (--frozen-lockfile)
bun run init:browsers            # bunx playwright install chromium; patchright download (fail-open)
bun run check                    # lint + typecheck + depcruise + unit + grep rules + generated-file checks
bun run browserhive --admin      # daemon from source on :9876; hot-reloading dashboard on :19876
```

### 2.1 Local dev loop

`bun run browserhive [flags]` (`scripts/run-from-source.ts`) runs the CLI from source with the current dashboard:

- **Hot reload (default when serving with `--admin`).** The script starts the daemon as usual and, next to it, a Vite dev server on `127.0.0.1:<--port + 10000>` (19876 by default, `--strictPort`) with `BHDEV_DAEMON_URL` pointing at the daemon. Vite is the front door for the dashboard: it serves the page and modules with HMR and proxies `/api` (WebSocket included), `/mcp`, `/health` and `/trace-viewer` to the daemon with `changeOrigin: false`, so the daemon's Origin check still passes and the session cookie (host-scoped, not port-scoped) works on both ports. Once both answer, the script prints `Dashboard with hot reload → <vite url>`; the dashboard's development URL therefore differs from the daemon's, and the printed line is how the developer finds it. The daemon's own port keeps serving the last built bundle and agents keep using its `/mcp`. The fixed port lets open tabs reload by themselves after a restart. Nothing in the daemon knows about Vite. Alternative considered: putting Vite behind the daemon (a daemon-side proxy) to keep a single URL. It was rejected because it needs a development CSP exception and start ordering inside the daemon, and a stale tab could still load modules from both the bundle and the dev server, mixing two React copies. Differences from the bundle to keep in mind: Vite serves the page without the daemon's CSP and security headers (CSP regressions surface only in a build: run `BHDEV_DASHBOARD=dist` or the e2e suite), and screencast frames take one extra hop. Backend edits need a restart (Ctrl+C stops both). The token dialog's MCP snippets use the daemon's bind address under the dev server (`import.meta.env.DEV`) and the page origin in the bundle.
- **dist (`BHDEV_DASHBOARD=dist`, and every command other than `serve --admin`).** The script runs the dashboard build into `packages/dashboard/dist` when any input (`packages/dashboard/{src,public,index.html,vite.config.ts,package.json}`, `packages/contracts/src`) is newer than `dist/index.html`, then runs the CLI, which serves the bundle. A failed build does not start the CLI.

`bun run dev` (`scripts/dev.ts`) is the same arrangement with `bun --watch` on the server (`serve --logFormat pretty --logLevel debug --admin`, restarts on every backend save, which ends live browser sessions) and Vite on its default port.

Dev-only environment variables (never read by the published package; they are not config keys, and the `BHDEV_` prefix exists because the CLI rejects unknown `BROWSERHIVE_*` variables):

| Variable | Read by | Meaning |
|---|---|---|
| `BHDEV_DASHBOARD` | `run-from-source.ts` | `dist`: no Vite; the daemon serves a bundle built again when stale |
| `BHDEV_DAEMON_URL` | `vite.config.ts` | where Vite proxies API calls; set by the script, default `http://127.0.0.1:9876` |

`bun run doctor` (which calls `browserhive doctor` from source) reports Bun version, Chromium presence and version, Patchright presence, data dir permissions, and any unrecognised data file (such as an `events.db`) that BrowserHive does not read or migrate.

## 3. Root scripts

| Script | Does |
|---|---|
| `browserhive` | `bun scripts/run-from-source.ts`: the CLI from source; with `--admin`, plus a Vite dev server proxying to it (§2.1) |
| `dev` | `bun scripts/dev.ts`: `bun --watch packages/browserhive/src/bin.ts serve --logFormat pretty --logLevel debug --admin` and `bun run --filter @browserhive/dashboard dev` |
| `build` | ordered: contracts → core → dashboard → browserhive (`bun run --filter` respects workspace deps) |
| `typecheck` | `tsc -b --pretty` over the root references (all four packages incl. dashboard and every test) |
| `lint` / `lint:fix` / `format` | `biome ci --error-on-warnings` / `biome check --write` / `biome format --write` |
| `depcruise` | `depcruise --config .dependency-cruiser.cjs packages` |
| `test` | `test:server` (contracts, core unit + persistence + lint, browserhive unit/cli/composition, `test/lint`, `test/docs`) then `test:dashboard` (`bun test packages/dashboard/src`); the root `test/preload.ts` (from `bunfig.toml`) registers happy-dom only for dashboard paths |
| `test:watch` | `bun test --watch` |
| `test:integration` | `bun test --preload ./test/integration/preload.ts packages/*/test/integration` (real Chromium, serial) |
| `test:e2e` | `bunx playwright test` against a built dashboard served by the real server on a random port |
| `test:goldens` | contract goldens (tool JSON Schemas, OpenAPI, WS transcripts, schema fingerprint); `UPDATE_GOLDENS=1` blesses |
| `check` | `lint` + `typecheck` + `depcruise` + `test` + `gen:openapi --check` + `gen:docs --check` + `gen:db-types --check` |
| `ci:local` | `check` + `build` + `test:integration` + `package:check` (what CI does, minus the OS matrix) |
| `gen:openapi` | writes `packages/contracts/generated/openapi.json` from the Hono app |
| `gen:docs` | regenerates `docs/reference/{configuration,errors,tools,api}.md` from contracts; `--check` diffs |
| `gen:routes` | TanStack Router route tree (also run by the Vite plugin in dev) |
| `gen:db-types` | `kysely-codegen --dialect bun-sqlite --verify` against a fresh migrated temp DB |
| `package:check` | `publint` + `attw --pack` + `scripts/smoke-installed.ts` + `scripts/smoke-programmatic.ts` |
| `license:check` | allowed-license scan over production dependencies |
| `init:browsers` | Chromium (+ Patchright) install for local dev |
| `doctor` | runs the CLI doctor from source |
| `release:version` | `changeset version && bun run sync:version && bun install --lockfile-only` |
| `release:publish` | `bun run build && bun run package:check && changeset publish` (CI only) |
| `sync:version` | `bun scripts/sync-version.ts` |

## 4. How each package builds

### `packages/contracts`
tsdown, entry `src/index.ts` plus subpath entries (`config`, `errors`, `enums`, `tools`, `http`, `ws`), ESM, `dts: true`, `platform: 'neutral'`. Output consumed by core, dashboard, browserhive. Never published separately (`private: true`).

### `packages/core`
tsdown, entry `src/index.ts`, ESM, `platform: 'node'` with `bun` conditions, `dts: true`, all deps external. `private: true`. `src/version.ts` is generated (see §5). `src/infra/persistence/generated/db.d.ts` is generated by `gen:db-types`.

### `packages/dashboard`
Vite 8: `vite build` → `dist/` (`index.html`, hashed assets, no sourcemaps in production, fonts latin subset). `base: '/'`. Dev server proxies `/api` (including the WS at `/api/v1/ws`), `/mcp`, `/health` and `/trace-viewer` to `BHDEV_DAEMON_URL` (default `http://127.0.0.1:9876`) with `changeOrigin: false`; `optimizeDeps.entries` scans every source file so lazily loaded routes never trigger a mid-session re-optimisation. `private: true`.

### `packages/browserhive` (published as `browserhive`)
tsdown with two entries: `src/bin.ts` (banner `#!/usr/bin/env bun`, output `dist/bin.js`) and `src/index.ts` (`dist/index.js` + `dist/index.d.ts`). `deps: { alwaysBundle: [/^@browserhive\//] }` — workspace packages are inlined; third-party dependencies stay external and **must** be declared in this package's `dependencies` (a build-time check reads `dist/*.js` imports and fails on an undeclared external). After tsdown, `scripts/bundle-dashboard.ts` copies `../dashboard/dist` into `dist/dashboard/` and **fails the build** if the dashboard build is missing, so a package without a working dashboard can never be published. The Playwright trace-viewer bundle is resolved at runtime from `playwright-core`, not copied.

`package.json` essentials:

```jsonc
{
  "name": "browserhive",
  "type": "module",
  "bin": { "browserhive": "./dist/bin.js" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }, "./package.json": "./package.json" },
  "files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
  "engines": { "bun": ">=1.4.0" },
  "publishConfig": { "access": "public", "provenance": true },
  "sideEffects": false
}
```

Tarball contents are asserted by `package:check`: `dist/bin.js`, `dist/index.js`, `dist/index.d.ts`, `dist/dashboard/index.html`; no `src/`, `test/`, `*.map`, `*.tsbuildinfo`.

## 5. Version single source

`packages/browserhive/package.json#version` is the truth (Changesets fixed group keeps `contracts`, `core`, `dashboard` at the same number). `scripts/sync-version.ts` writes:

```ts
/** @module core/version — generated by scripts/sync-version.ts; do not edit */
export const VERSION = '0.1.0' as const;
```

It runs inside `release:version`. `packages/core/test/version.test.ts` asserts `VERSION === package.json.version` for all four packages, so `--version` and `server_status.version` cannot lie. Biome ignores the generated file.

## 6. `ci.yml`

Triggers: `pull_request`, `push` to `main`. Concurrency group `ci-${{ github.ref }}` with `cancel-in-progress: true` on PRs. Every action pinned to a commit SHA. `oven-sh/setup-bun` reads `.bun-version`. Bun install cache: `~/.bun/install/cache` keyed on `bun.lock`.

| Job | Runs on | Steps | Required |
|---|---|---|---|
| `lint` | ubuntu | `bun install --frozen-lockfile`, `biome ci --error-on-warnings`, grep-rule tests, `gitleaks detect` (secrets scan of the diff) | yes |
| `typecheck` | ubuntu | `tsc -b` (all projects, incl. dashboard and tests) | yes |
| `depcruise` | ubuntu | `depcruise` + `contracts` platform-neutrality rule | yes |
| `unit` | ubuntu | `bun test` (contracts, core, browserhive, dashboard) with coverage (`bun test --coverage`, lcov uploaded); ratcheting threshold in `bunfig.toml` | yes |
| `goldens` | ubuntu | `test:goldens`, `gen:openapi --check`, `gen:docs --check`, `gen:db-types --check`, export snapshots | yes |
| `build` | ubuntu | `build`; uploads `packages/browserhive/dist` and the packed tarball as artifacts | yes |
| `integration` | matrix `ubuntu-latest`, `macos-latest`, `windows-latest` | Playwright cache (`~/.cache/ms-playwright`, `~/Library/Caches/ms-playwright`, `%LOCALAPPDATA%\ms-playwright`) keyed on the **resolved** Playwright version from `bun.lock`; `bunx playwright install chromium --with-deps` on miss; `test:integration` (isolation, stealth, tool surface, auth states, persistence, observability, migration fixtures) | yes (ubuntu); macos/windows required after the first release |
| `e2e` | ubuntu | needs `build`; starts the built server with a temp data dir; `bunx playwright test` (dashboard) with trace-on-failure artifact | yes |
| `package` | ubuntu | needs `build`; `publint`, `attw --pack`, `smoke-installed` (pack → `bun add` into a clean temp project → `browserhive --version`, `--help`, stdio `initialize → tools/list` equals `ALL_TOOL_NAMES`, `serve` on a random port → `/health` ready → SIGTERM exits 0), `smoke-programmatic` (`import { createServer } from 'browserhive'`) | yes |
| `licenses` | ubuntu | `license:check` over `dependencies` of `browserhive` and `dashboard` | yes |
| `audit` | ubuntu | `bun audit --audit-level high` (non-blocking on PRs, blocking on `main`) | no on PRs |
| `commitlint` | ubuntu (PR only) | PR title validated as a Conventional Commit (the squash title) | yes |
| `changeset` | ubuntu (PR only) | `changeset status --since origin/main`; comments when a user-facing package changed without a changeset | yes |

Windows note: integration tests set `BROWSERHIVE_DATA_DIR` to a short temp path (`%RUNNER_TEMP%\bh`) to avoid MAX_PATH issues with Chromium profiles.

## 7. `release.yml`

Trigger: `push` to `main`. Job `release` runs in the `release` GitHub Environment (required reviewer: the maintainer; this is the human gate). Permissions: `contents: write`, `pull-requests: write`, `id-token: write`. **No `NPM_TOKEN` exists anywhere.**

Steps:
1. checkout (full history), setup Bun, `bun install --frozen-lockfile`.
2. `changesets/action` with `version: bun run release:version` and `publish: bun run release:publish`. Behavior: if unreleased changesets exist, it opens/updates the "Version Packages" PR (bumping versions, regenerating `version.ts`, writing `CHANGELOG.md`); if the merged commit *is* that PR, it publishes.
3. Publishing uses `changeset publish`, which calls `npm publish`; npm ≥ 11.5 on the runner (installed via `bun add -g npm@latest`) performs **OIDC trusted publishing** with automatic provenance. `bun publish` is not used (no OIDC support).
4. On publish: `git tag vX.Y.Z` (done by changesets), `softprops/action-gh-release` creates the GitHub Release with the changelog section, attaches the tarball.
5. Prerelease channel: a maintainer runs `bunx changeset pre enter next` on `main` (committed); subsequent releases publish under the `next` dist-tag with versions like `0.2.0-next.0`; `changeset pre exit` returns to stable.

## 8. One-time manual setup

- [ ] Create the GitHub repository; push `main`; enable branch protection (see `07-branching-and-git.md`).
- [ ] Reserve the npm name `browserhive` (first publish is manual from a maintainer machine with 2FA: `bun run build && cd packages/browserhive && npm publish --access public`).
- [ ] On npmjs.com → package → Settings → Trusted Publisher: repository `<org>/BrowserHive`, workflow `release.yml`, environment `release`.
- [ ] Create the `release` Environment in GitHub with a required reviewer.
- [ ] Add repository secrets: none required. Optional: Codecov token if coverage upload is used.
- [ ] Enable Dependabot alerts and Renovate app.

## 9. Renovate / Dependabot

`renovate.json`: weekly schedule (Monday 06:00 UTC), grouped PRs (`tanstack`, `hono`, `opentelemetry`, `biome+typescript`, `playwright+patchright` in one group so Chromium versions stay aligned), `rangeStrategy: pin` for the exact-pin list in `05-coding-standards.md` §8, `automerge: false`, lockfile maintenance monthly. Dependabot is used only for security alerts (`dependabot.yml` with `open-pull-requests-limit: 0` for version updates). GitHub Actions are updated by Renovate with SHA pinning (`helpers:pinGitHubActionDigests`).

## 10. Repository files

- `.github/PULL_REQUEST_TEMPLATE.md`: sections What/Why, Decisions (`D-xx`), Contract changes (goldens diff explained), Test evidence, Screenshots (dashboard, 390 px and ≥1280 px), Changeset, Checklist (the definition of done from `05-coding-standards.md` §14).
- `.github/CODEOWNERS`: `* @<maintainer>`; `packages/contracts/** @<maintainer>` (contract changes always reviewed by the owner).
- `.github/ISSUE_TEMPLATE/{bug,feature,security-report}.yml`.
- `SECURITY.md`, `CONTRIBUTING.md` (points at `specs/`), `CHANGELOG.md` (generated).

## 11. Branch protection (applied to `main`)

Require PR; require status checks `lint, typecheck, depcruise, unit, goldens, build, integration (ubuntu), e2e, package, licenses, commitlint, changeset`; require branches up to date; require linear history; squash merge only; dismiss stale approvals; restrict force-push and deletion. For a solo maintainer, "require approvals" is 0 but all checks are required; the `release` environment reviewer is the human gate before anything reaches npm.

## 12. Reproducing CI locally

`bun run ci:local` runs the same scripts in the same order on the developer machine (single OS). Differences from CI: no OS matrix, no environment gate, `audit` non-blocking. `act` is not supported (Bun setup action and Playwright caches are not worth emulating).

## 13. Troubleshooting

- **Playwright cannot find Chromium**: `bun run init:browsers`; honor `PLAYWRIGHT_BROWSERS_PATH`; the error from the server names the exact `playwright install chromium@<ver>` command.
- **Patchright missing**: stealth sessions fall back to stock Playwright with a `warn`; `doctor` shows it; `bun run init:browsers` installs it.
- **Bun version mismatch**: `.bun-version` is read by `setup-bun` and by `bun`'s own version manager; `bun upgrade --stable` or `bunx bun@<ver>`.
- **Windows**: use short `BROWSERHIVE_DATA_DIR` paths; profile zips are written with POSIX separators inside the archive; `xdg-open` reveal is replaced by `explorer.exe`.
- **Type errors only in CI**: CI typechecks the dashboard and tests too; run `bun run typecheck` (not the editor's per-file check).
- **Golden diffs**: read the diff; if intentional, `UPDATE_GOLDENS=1 bun run test:goldens` and explain in the PR.

## 14. Documentation generation

`scripts/gen-docs.ts` writes, from `@browserhive/contracts`:
- `docs/reference/configuration.md` — every key with env/CLI/JSON names, type, default, description, constraints (from the config schema registry).
- `docs/reference/errors.md` — every error code with status, category, retryable, title, hint (from the error registry).
- `docs/reference/tools.md` — the 43-tool catalog with input/output schemas and annotations.
- `docs/reference/api.md` — REST endpoints summary from the OpenAPI document (`packages/contracts/generated/openapi.json`).
Each file begins with the generated-header comment; `gen:docs --check` fails CI on a diff. Hand-written docs (`docs/guide/*.md`, `README.md`) are not generated but are linted for dead links to reference anchors.

## 15. Release checklist

1. Ensure `main` is green and the "Version Packages" PR reflects the intended bump (`0.x`: breaking changes are `minor`).
2. Review the generated `CHANGELOG.md` entry; fix changeset wording in the PR if needed.
3. Merge the Version Packages PR; approve the `release` environment run.
4. Verify: `npm view browserhive version`, provenance badge on npmjs, GitHub Release created, tag present.
5. Post-release smoke on a clean machine: `bun add -g browserhive@latest && browserhive init && browserhive serve --admin` → dashboard login works; `browserhive --version` matches.
6. If broken: publish a patch (never unpublish beyond the 72-hour window; use `npm deprecate` for a bad version).

## Design notes

- The coverage threshold is a ratchet raised 1 pt per month by a scheduled workflow (`coverage-ratchet.yml`); it is not a release requirement.
- The macOS/Windows integration jobs run on every PR but become required checks only after the first release: before then, a slow or flaky hosted runner on those platforms would block merges without protecting any published version.
