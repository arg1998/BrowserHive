---
title: "Branching, git and the pull request process"
spec: "07"
status: Normative
scope: Branching strategy, commit conventions, changesets, the GitHub pull request and review process, releases and tags, and repository hygiene.
audience: Contributors and maintainers; AI agents working in the repository.
related:
  - 00-decisions.md
  - 05-coding-standards.md
  - 06-ci-cd-local-dev.md
---

# 07 — Branching, Git, and the Pull Request Process

> **Conventions.** The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
> RFC 2119 when they appear in uppercase. `D-NN` identifiers refer to entries in the
> [decision log](00-decisions.md). Terminology follows the [specification index](README.md#conventions).

CI job details are in `06-ci-cd-local-dev.md`; the definition of done is in `05-coding-standards.md` §14.

---

## 1. Model: trunk-based on `main`

- `main` is the only long-lived branch and is always releasable. Every change lands through a pull request; there are no direct pushes.
- Protection: PR required; required status checks (`06-ci-cd-local-dev.md` §11); linear history; **squash merge only** (one commit per PR whose message is the PR title); force-push and deletion disabled; stale approvals dismissed. Solo-maintainer rule: 0 required approvals, all checks required, the `release` environment reviewer is the human gate. When a second maintainer joins, required approvals becomes 1 and CODEOWNERS review is enforced.
- Signed commits (SSH or GPG) are recommended and become required at 1.0.

## 2. Branches

Short-lived (days, not weeks), created from `main`, deleted on merge:

| Prefix | Use |
|---|---|
| `feat/<area>-<slug>` | new capability (`feat/sessions-state-machine`) |
| `fix/<area>-<slug>` | bug fix |
| `chore/<slug>` | tooling, deps, CI |
| `docs/<slug>` | documentation only |
| `spec/<slug>` | changes to `specs/` |
| `release/next-*` | not used; prerelease mode is a changeset state on `main` |

`<area>` is a scope from §3.2. Rebase on `main` before opening the PR; do not merge `main` into the branch.

## 3. Commits

### 3.1 Conventional Commits

The squash-merge title (which becomes the commit on `main`) must match `<type>(<scope>)!?: <subject>`; a `commitlint` job validates the PR title. Commits inside a branch are free-form and disappear on squash.

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.

### 3.2 Scopes

One of: `contracts`, `core`, `dashboard`, `cli`, `sessions`, `browsers`, `stealth`, `tools`, `http`, `ws`, `auth`, `vault`, `attention`, `persistence`, `observability`, `config`, `blocklist`, `notifications`, `docs`, `ci`, `deps`, `release`. Multiple scopes are comma-separated; omit the scope only for repo-wide changes.

### 3.3 Breaking changes

`!` after the scope and a `BREAKING CHANGE:` footer describing the migration. During `0.x`, breaking changes bump `minor` (Changesets is configured accordingly); after `1.0` they bump `major`. Contract changes (MCP tool schemas, REST, WS, config keys, DB schema) are breaking by definition unless purely additive.

## 4. Changesets

- Every PR that changes user-facing behavior of the published package adds a changeset (`bunx changeset`), choosing `patch` (fixes, docs in the package), `minor` (features; breaking during `0.x`), or `major` (breaking after `1.0`). Internal-only PRs (tests, CI, specs) add none and get the `no-changeset` label.
- The `changeset` CI job comments on PRs missing one when `packages/{contracts,core,dashboard,browserhive}/src` changed.
- The fixed group keeps all four packages at one version; the changeset names `browserhive`.
- Changeset text is user-facing prose (it becomes `CHANGELOG.md`): what changed, what to do about it. Reference decisions (`D-xx`) and error codes by name.

## 5. Pull requests

### 5.1 Template sections

1. **What / why** — one paragraph; link the issue.
2. **Decisions** — `D-xx` references implemented or affected; if a decision changes, the same PR edits `specs/00-decisions.md`.
3. **Contract changes** — list every changed tool/route/WS message/config key/DB migration; paste the golden diff summary; state whether additive or breaking.
4. **Test evidence** — which suites cover it; for integration/e2e, the CI run link.
5. **Screenshots** — dashboard changes: 390 px and ≥1280 px, light and dark.
6. **Changeset** — present or `no-changeset` with reason.
7. **Checklist** — the definition of done.

### 5.2 Review guidelines

Reviewers (or the maintainer self-reviewing) check, in order:
1. Does the PR do what the title says and nothing else? Scope creep is split out.
2. Contract diffs: every golden change is explained; additive vs breaking is correct; docs regenerated.
3. Layer rules and anti-patterns (`05-coding-standards.md` §12): no new `any`, casts on payloads, silent catches, globals, `process.env`.
4. Tests assert at the outermost surface; new behavior has a failing-then-passing test.
5. Security: anything touching auth, vault, redaction, blocklist, launch args, or static serving gets a line-by-line read and a negative test.
6. Operator experience: error messages name the flag/command to fix the situation; log messages follow §7 of the standards.

Approve with "LGTM" only when every item is satisfied; otherwise request changes with specific lines.

### 5.3 Merge rules

- Squash merge; the PR title is the commit subject; the PR body's first paragraph is the commit body.
- The author merges after checks are green (solo) or after approval (team).
- Reverts use `revert:` PRs, never force-pushes to `main`.

## 6. Releases and tags

- No release branches. Releases are cut from `main` by the Changesets flow (`06-ci-cd-local-dev.md` §7). Tags are `vX.Y.Z`, created by the release job, immutable.
- Hotfix: branch from `main`, fix, PR, patch changeset, merge, release. If `main` already contains unreleased minor work, the hotfix is still released as a minor during `0.x` (acceptable; there is no LTS line before 1.0).
- Prerelease: `bunx changeset pre enter next` committed via PR; releases go to the `next` dist-tag; `pre exit` via PR returns to stable.
- `CHANGELOG.md` is generated by Changesets; never hand-edited except to fix wording in the Version Packages PR.

## 7. Repository hygiene

### 7.1 `.gitignore` (complete)

```
# dependencies
node_modules/

# build output
dist/
*.tsbuildinfo
coverage/
playwright-report/
test-results/

# local state
.env
.env.*
!.env.example
scratchpad/
.browserhive/
.bh-data/
*.log

# editor / os
.idea/
.vscode/*
!.vscode/settings.json
!.vscode/extensions.json
.DS_Store
Thumbs.db

# temporary artifacts
*.tgz
tmp/
```

Generated files that are committed (`routeTree.gen.ts`, `version.ts`, `openapi.json`, `docs/reference/*.md`, `generated/db.d.ts`) are **not** ignored.

### 7.2 `.gitattributes`

```
* text=auto eol=lf
*.png binary
*.jpg binary
*.zip binary
*.db binary
packages/dashboard/src/routeTree.gen.ts linguist-generated=true
packages/core/src/version.ts linguist-generated=true
packages/contracts/generated/** linguist-generated=true
packages/core/src/infra/persistence/generated/** linguist-generated=true
docs/reference/** linguist-generated=true
bun.lock linguist-generated=true
CHANGELOG.md linguist-generated=true
```

### 7.3 Commit hygiene

- No generated noise in unrelated PRs: if a generated file changes, the PR touches the source that caused it.
- No vendored research, cloned third-party repos, screenshots of experiments, or agent working notes in the repository: they bloat clones, carry foreign licenses, and go stale without any test noticing. Long-form research lives in issues/discussions or a separate repo.
- Fixture databases for migration tests live under `packages/core/test/fixtures/db/` and are small (< 200 KB), created by a script, and committed as binary with a `README` naming the app version that produced each.
- Secrets never enter the repo (`gitleaks` runs in the `lint` job).

## 8. Issues

Labels: `bug`, `feature`, `security`, `docs`, `good-first-issue`, `needs-decision`, `no-changeset`, `breaking`, area labels mirroring §3.2 scopes. Templates:
- **Bug**: version (`browserhive --version`), OS, Bun version, config (`browserhive config --json` with secrets redacted), steps, expected/actual, logs (`--logLevel debug`), whether a session/tool/dashboard page is involved.
- **Feature**: problem, proposed behavior, which tier (zero-config / opt-in / plugin), affected contracts.
- **Security report**: redirects to `SECURITY.md` (private reporting via GitHub Security Advisories).

## 9. Security disclosure (`SECURITY.md`)

Report privately through GitHub Security Advisories; acknowledgement within 72 hours; fix and coordinated disclosure targeted within 30 days; supported versions: latest minor. Do not open public issues for vulnerabilities. Advisories result in a `fix(security)` PR and a patch release with a GHSA link in the changeset.

## 10. CODEOWNERS

```
*                              @<maintainer>
packages/contracts/**          @<maintainer>
packages/core/src/app/auth/**  @<maintainer>
packages/core/src/domain/vault/** @<maintainer>
specs/**                       @<maintainer>
```

## 11. Third-party code and attribution

- Code derived from another project (an algorithm, its constants, or a shape of API) is allowed only under a license from the allow-list in `05-coding-standards.md` §8, and is credited in a `NOTICE.md` next to the code that names the project, its license and copyright line, and exactly what was derived (see `packages/core/src/infra/browsers/humanize/NOTICE.md`).
- Rationale is written into the code comment itself, never only linked: external pages move, and the reason for a constant must survive them.
- A PR that introduces derived code says so in its description and names the `NOTICE.md` it adds or updates.

## 12. AI-assisted development

- `specs/` is the reference for humans and agents alike; an agent implementing a task reads `00-decisions.md` and the relevant spec first and cites `D-xx` in its PR.
- Working notes go in the gitignored `scratchpad/` directory or the PR description, never into the tree.
- Commits and PRs authored with AI assistance carry the attribution trailer configured for the repository (`Co-Authored-By:`) exactly as the tooling emits it; the human maintainer remains the author of record and reviews every diff before merge.
- Agents never bless goldens, change decisions, or add dependencies without a human-visible explanation in the PR body.

## Design notes

- With a solo maintainer, "0 required approvals + all checks required + release environment gate" is the practical protection; the switch to 1 required approval is documented in `CONTRIBUTING.md` when a second maintainer is onboarded.
- `gitleaks` runs as a step of the `lint` job (`06-ci-cd-local-dev.md` §6), so a secret in a diff fails the earliest and cheapest required check.
