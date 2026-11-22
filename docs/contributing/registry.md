# The site-pack registry

How site packs are published to `https://browserhive.ai/registry/v1/`, how to propose a change, and the key operations the owner runs. The design is in [spec 13 §10](../../specs/13-session-templates.md#10-registry-delivery-d-55-publishing-in-pr-t4a-the-client-in-pr-t4b) and [D-55](../../specs/00-decisions.md#d-55-site-pack-registry-signed-static-files-check-on-apply-after-approval-auto-update-off). What operators see is in the [site packs guide](../guide/site-packs.md).

## What is published

```
registry/v1/
  keys.json, keys.json.sig     the online keys, signed by a root key (offline, held by the owner)
  index.json, index.json.sig   every pack and its listed versions, signed by the online key
  packs/<id>/<sha256>.json     one pack version, content-addressed, never changed
```

A client trusts `keys.json` only through the two root keys pinned in its release (`packages/core/src/infra/site-packs/trust-root.ts`, threshold 1 of 2), `index.json` only through an online key `keys.json` names, and a pack file only through the SHA-256 and size the index lists. `index.json` lives at most 14 days and is re-signed every week; `keys.json` at most 120 days; an online key at most 90.

A `.sig` file is JSON: `{"schema": 1, "signatures": [{"key_id": "<16 hex>", "sig": "<base64>"}]}`, an Ed25519 signature over the exact bytes of the file it names. A key id is the first 16 hex digits of the SHA-256 of the raw 32-byte public key.

## The source: `registry/`

| Path | What it holds |
|---|---|
| `registry/packs/<id>.json` | the current version of each pack. Canonical JSON: keys sorted at every level, two spaces, a final newline (`bun scripts/registry-build.ts --format` rewrites it) |
| `registry/versions/<id>.json` | the versions the index lists: `{"schema": 1, "versions": {"<v>": {"released": "YYYY-MM-DD", "notes": "…", "revoked": true?}}}`. The newest ten are listed. `notes` (≤ 500 characters) is shown to operators as plain text |
| `registry/keys/root-1.pub`, `root-2.pub` | the root public keys (placeholders until the key ceremony) |
| `registry/keys/keys.json`, `keys.json.sig` | the root-signed online keys (written by `registry-keys.ts`, absent until the ceremony) |

Earlier versions are not kept as files: the build takes each listed version's bytes from the newest commit of `registry/packs/<id>.json` that held it, so the registry needs the full git history (CI checks out with `fetch-depth: 0`). Everything under `registry/` is owned by the owner (CODEOWNERS).

## Proposing a pack change

1. Edit `registry/packs/<id>.json` and raise its `version`. A changed pack whose version is not above the one on the base branch is refused. A field the schema does not know needs a `min_client` that names the release that knows it.
2. Add the version to `registry/versions/<id>.json` with today's date and a one-line note of what changed.
3. Check locally: `bun run registry:check -- --base origin/main` (the same as CI; it needs the full history: `git fetch --unshallow` in a shallow clone). It validates every pack and listed version (schema, refinements, the 64 KiB and 256 KiB caps), the version rules, and classifies each change the way BrowserHive will (tightening, restrictive, loosening, neutral; spec 13 §9.7).
4. Open the pull request. The `registry-check` job prints the classification of every changed pack, field by field, in its job summary; the website preview carries the registry signed with a throwaway test key (`/registry/v1/index.json` on the preview URL) that no release trusts.

The review looks at the classification first: loosening and restrictive changes, and added or removed domains, always wait for each operator's approval, but a wrong tightening change applies by itself where operators turned auto-update on. Published versions are immutable: a version's content never changes once listed (CI refuses it); fix a mistake with a new version, and mark the bad one `"revoked": true`. A pull request can list only its pack's current version, or an earlier version its base branch already held, so an intermediate commit of the pull request is never published.

## How a merge is published

`website.yml` on `main`:

1. `registry-build` (dependencies installed, no secrets) writes the unsigned layout: pack files and an `index.json` without version, dates or signature.
2. `registry-sign` runs in the GitHub environment **`registry-signing`** and waits for the owner's approval. It checks out the commit and runs `node scripts/registry-sign.mjs` with **no dependency installed** (only Node's `crypto`, `fs` and `git`). It recomputes every pack file and the index from the commit and refuses on any difference from the artefact, verifies `keys.json` against `registry/keys/root-*.pub`, checks the online key from `REGISTRY_ONLINE_KEY` is listed and valid, reads the published index (verified) and signs the next version, valid 14 days (never past the online key's `not_after`). It attests the files (`actions/attest-build-provenance`).
3. The `deploy` job publishes the signed files with the site. A deploy that does not sign (a docs change) re-publishes the registry that is live, after verifying it, so the registry never disappears with a deploy.

It signs only when `registry/` changed, on the weekly re-sign, or on a manual run of `website` with **sign**, and only once the repository variable `REGISTRY_PUBLISH` is `true`.

**Weekly re-sign.** `registry-resign.yml` runs every Monday and asks for the same approval: it re-signs the same content with a new version and expiry. Approve it within the week (GitHub → Actions → the waiting run → Review deployments → Approve). A missed week is harmless for 14 days; after that installs show stale site packs (`SITE_PACKS_STALE`) and keep working with what they have.

**Rejecting** a signing run (or letting it time out) publishes nothing and skips that deploy; the next run deploys again.

## Key operations (the owner)

All key operations run on the owner's machine with `bun scripts/registry-keys.ts` (also `bun run registry:keys`). It never uses the network. It writes private keys only to the paths you name, outside any git working tree, as new files with mode 0600, and never overwrites one. Public results go to `registry/keys/` and `trust-root.ts`, which you commit in a pull request. `bun scripts/registry-keys.ts status` shows the root keys, what is pinned, and the expiry of `keys.json` and each online key.

**Rehearse first.** `bun scripts/registry-keys.ts dry-run --layout <dir>` runs the whole ceremony with throwaway keys in a scratch folder (nothing in the repository changes): both roots, an online key, a re-sign by the other root, a rotation and a revocation, then verifies the results with BrowserHive's own verifier. Build `<dir>` first with `bun run registry:build` (it writes `dist/registry/v1`).

### The key ceremony (once)

Before: create the environment, on GitHub → Settings → Environments → **New environment** `registry-signing`: **Required reviewers**: you (leave **Prevent self-review** off: you are the only maintainer); **Deployment branches and tags**: selected branches, `main` only. Have two removable drives, ideally offline storage you keep in different places.

1. On a machine you trust, with the repository on a new branch from the integration branch (or `main`):
   ```sh
   bun scripts/registry-keys.ts init-roots --out /media/drive-1/browserhive-roots
   ```
   Choose a passphrase for each root key (at least 12 characters; write each one down and keep it apart from the key files). It writes the encrypted `root-1.key` and `root-2.key`, reads each back to check it, writes `registry/keys/root-1.pub` and `root-2.pub`, and pins both in `trust-root.ts`.
2. Copy `root-2.key` to the second drive and remove it from the first. From now on each drive holds one root key; either one can sign (threshold 1 of 2), so losing one is survivable.
3. Create the first online key, signed by root 1, with its secret written to a file outside the repository:
   ```sh
   bun scripts/registry-keys.ts online-key --root /media/drive-1/browserhive-roots/root-1.key --secret-out ~/registry-online.secret
   gh secret set REGISTRY_ONLINE_KEY --env registry-signing < ~/registry-online.secret && shred -u ~/registry-online.secret
   ```
   It writes `registry/keys/keys.json` (version 1, expires in 120 days, the key valid 90 days) and `keys.json.sig`, and prints the key id and dates.
4. Check: `bun scripts/registry-keys.ts status` reports the two roots, the same keys pinned, and "This build accepts keys.json".
5. Commit `registry/keys/` and `packages/core/src/infra/site-packs/trust-root.ts` (`feat(core): pin the site-pack registry root keys`), open the pull request and merge it. Only public keys are in it; gitleaks scans it.
6. Set the repository variable (Settings → Secrets and variables → Actions → Variables) `REGISTRY_PUBLISH` = `true`.
7. Publish the first index: once that merge is on `main`, run the **website** workflow with **sign** (or wait for the next change to `registry/`), approve `registry-signing`, and check `https://browserhive.ai/registry/v1/index.json` after the deploy. `bunx browserhive sitepacks verify <a folder with the downloaded files>` from a build with the new keys accepts it.

From that release on, the release workflow refuses to publish a package whose pinned roots are placeholders or test keys (`scripts/registry-trust-check.ts`, run by `release:publish`), so the ceremony has to happen before the first release that carries the registry client.

### Every 90 days: rotate the online key

The signing job warns from 14 days before the online key's `not_after`, and refuses one day before it.

1. `bun scripts/registry-keys.ts online-key --root <either root key> --secret-out ~/registry-online.secret` adds the new key next to the old one in `keys.json` (expired keys are dropped) and re-signs it with a new version and a fresh 120-day expiry.
2. Put the new secret in place: `gh secret set REGISTRY_ONLINE_KEY --env registry-signing < ~/registry-online.secret && shred -u ~/registry-online.secret`.
3. Commit `registry/keys/keys.json` and `keys.json.sig` in a pull request and merge it; the merge signs and publishes with the new key (approve it).
4. Once that index is live, drop the old key: `bun scripts/registry-keys.ts revoke --root <either root key> --key-id <old id>`, then commit and merge again.

`keys.json` itself must also be re-signed at least every 120 days; rotating the online key does that. To extend it without a new key: `bun scripts/registry-keys.ts sign-keys --root <either root key>`.

### If the online key leaks

1. `bun scripts/registry-keys.ts revoke --root <root key> --key-id <leaked id>` (if it is the only key, run `online-key` first, so `keys.json` names a new one), put the new secret into the environment, and merge `registry/keys/`. Clients stop trusting the leaked key as soon as they see the new `keys.json`, without a release.
2. If the leaked key signed an index with a huge version (a fast-forward attack), clients refuse every later index. Re-sign `keys.json` once with `sign-keys --index-floor <the last good index version>`: clients reset their index floor to it. The next `sign-keys` (or rotation) drops the field again; leaving it in would weaken rollback protection.

### If a root key is lost or leaks

A root change needs a release, because the roots are built into each release, and installs keep trusting the old roots until they upgrade; a leaked root key can sign a `keys.json` naming its holder's own online key, so act quickly and say so in the release notes. `init-roots --replace` writes new keys, `.pub` files and pins, but the transition itself (a `keys.json` signed by both a remaining old root and a new one, so installs on either release accept it, and the signing job's check of the published layout against the new roots) is not automated yet: plan it before running it.

## Local commands

| Command | What it does |
|---|---|
| `bun run registry:check -- [--base <commit>]` | validate `registry/`; with a base, the version rules and the classification report |
| `bun run registry:build` | the unsigned layout in `dist/registry/v1` |
| `bun scripts/registry-build.ts --format` | rewrite `registry/packs` and `registry/versions` canonically |
| `bun scripts/registry-keys.ts dry-run --layout dist/registry/v1` | rehearse the ceremony with throwaway keys |
| `node scripts/registry-sign.mjs sign --artefact dist/registry/v1 --out <dir> --test-keys <dir>` | sign a build with a throwaway test root (what previews do) |
| `bun scripts/registry-verify.ts <dir> --test-root <dir>/test-root.pub --expect-pinned-refusal` | verify a test-signed layout, and that this build refuses it |
| `bunx browserhive sitepacks verify <dir>` | verify a downloaded layout against the release's own root keys |
