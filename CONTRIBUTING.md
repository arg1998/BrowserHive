# Contributing

BrowserHive is specified before it is coded: `specs/00-decisions.md` is the decision log and the other
files in `specs/` describe each subsystem. Read the decision log first and cite decisions (`D-xx`) in
pull requests.

## Setup

```bash
bun install
bun run init:browsers
bun run check
bun run browserhive --admin   # daemon from source + hot-reloading dashboard (URL printed on start)
```

`bun run browserhive [flags]` runs the CLI from source. With `--admin` it also starts a Vite dev server on the
daemon's port + 10000 (`http://127.0.0.1:19876/` by default) that proxies the API to the daemon: open that URL for
hot reload. The daemon's own URL keeps serving the last built bundle, and agents keep using its `/mcp`. Backend
edits need a restart. `BHDEV_DASHBOARD=dist` skips Vite and serves the bundle, building it first when its sources are newer.
`bun run dev` is the same with the server in watch mode. Dev-only variables use the `BHDEV_` prefix because the
CLI rejects unknown `BROWSERHIVE_*` variables; the full list is in `specs/06-ci-cd-local-dev.md` §2.1.

Bun ≥ 1.4 is the only runtime. No Node.js, no native toolchain.

## Workflow

- Trunk-based: short-lived branches from `main`, squash merge, PR title is a Conventional Commit
  (`feat(sessions): …`). Scopes are listed in `specs/07-branching-and-git.md` §3.2.
- Every user-facing change adds a changeset (`bunx changeset`).
- `bun run check` must pass: lint, typecheck, dependency-cruiser, unit tests (server and dashboard, including grep
  rules and docs gates), and the `gen:openapi`, `gen:docs` and `gen:db-types` freshness checks.
- Contract changes (tool schemas, REST, WS, config keys, DB schema) re-bless goldens with an explanation.
- The definition of done is `specs/05-coding-standards.md` §14.

## Website and docs site

`website/` is browserhive.ai: the landing page and the docs, built with Astro and Starlight and served by
Cloudflare Workers static assets. It is a separate Bun project with its own lockfile and lint config, outside the
workspace.

```bash
bun run website:install
bun run website:dev      # http://localhost:4321, re-syncs when docs/ changes
bun run website:check    # astro check, biome, unit tests
bun run website:build    # static output in website/dist
bun run website:preview  # build, then serve it with wrangler as Cloudflare would
```

`docs/` stays the only source of the docs: `website/scripts/sync-docs.ts` copies it into the site at build time,
takes page titles from the H1, turns relative `.md` links into site routes and builds the sidebar from
`docs/README.md`. Write docs as plain Markdown that reads well on GitHub. The current major is served at `/docs/`
from the working tree; each older major is served at `/docs/vN/` from its newest `browserhive@N.x.y` release tag.

CI keeps the two apart. `website.yml` builds on changes to `website/`, `docs/` or the package version, deploys
previews for PRs and production from `main`. In `ci.yml`, a PR that only touches `website/` skips the library jobs,
and one that only touches `docs/` or root Markdown runs just the docs gates.

## Reporting security issues

See `SECURITY.md`.
