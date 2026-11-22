# The site-pack registry

This guide covers how site packs are published to `https://browserhive.ai/registry/v1/`, how to propose a change, and the key operations the owner runs. The design is in [spec 13 §10](../../specs/13-session-templates.md#10-registry-delivery-d-55-publishing-in-pr-t4a-the-client-in-pr-t4b) and [D-55](../../specs/00-decisions.md#d-55-site-pack-registry-signed-static-files-check-on-apply-after-approval-auto-update-off). What operators see is in the [site packs guide](../guide/site-packs.md).

## What is published

```
registry/v1/
  keys.json, keys.json.sig     the online keys, signed by a root key (offline, held by the owner)
  index.json, index.json.sig   every pack and its listed versions, signed by the online key
  packs/<id>/<sha256>.json     one pack version, content-addressed, never changed
```

A client trusts each layer only through the one above it:

- `keys.json` only through the two root keys pinned in its release (`packages/core/src/infra/site-packs/trust-root.ts`; either one is enough).
- `index.json` only through an online key that `keys.json` names.
- A pack file only through the SHA-256 and size that the index lists.

Lifetimes: `index.json` lives at most 14 days and is re-signed every week, `keys.json` at most 120 days, an online key at most 90 days.

A `.sig` file is JSON: `{"schema": 1, "signatures": [{"key_id": "<16 hex>", "sig": "<base64>"}]}`. Each entry is an Ed25519 signature over the exact bytes of the file it names. A key id is the first 16 hex digits of the SHA-256 of the raw 32-byte public key.

## The source: `registry/`

| Path | What it holds |
|---|---|
| `registry/packs/<id>.json` | The current version of each pack, the file you edit. Canonical JSON: keys sorted at every level, two spaces, a final newline. |
| `registry/archive/<id>/<sha256>.json` | Every published version, byte for byte, named by its SHA-256. The current version's copy equals `registry/packs/<id>.json`. |
| `registry/versions/<id>.json` | The published versions: `{"schema": 1, "versions": {"<v>": {"sha256": "…", "released": "YYYY-MM-DD", "notes": "…", "revoked": true?}}}`. The index lists the newest ten. `notes` (1 to 500 characters) is shown to operators as plain text. |
| `registry/state.json` | `index_version`: the last index version you recorded as published. Signing never goes below it. |
| `registry/keys/root-1.pub`, `root-2.pub` | The root public keys. They are placeholders until the key ceremony. |
| `registry/keys/keys.json`, `keys.json.sig` | The root-signed online keys, written by `registry-keys.mjs`. They are absent until the ceremony. |

Everything the registry publishes comes from these files, never from git history, so a squash merge changes nothing. Everything under `registry/` is owned by the owner (CODEOWNERS).

## Proposing a pack change

1. Edit `registry/packs/<id>.json` and raise its `version`. A changed pack whose version is not above the one on the base branch is refused. A field the schema does not know needs a `min_client` that names the release that knows it.
2. Run `bun scripts/registry-build.ts --sync`. It writes the file canonically, archives it as `registry/archive/<id>/<sha256>.json`, and adds the version to `registry/versions/<id>.json` with today's date. Write its `notes`: one line on what changed.
3. Check locally with `bun run registry:check -- --base origin/main`, the same check CI runs. It validates:
   - every pack and archived version: schema, refinements, and the 64 KiB and 256 KiB caps;
   - the version rules: a published version is never changed or removed, and a new version is above every published one;
   - each change's classification, the way BrowserHive will classify it: tightening, restrictive, loosening or neutral (spec 13 §9.7).
4. Open the pull request.
   - The `registry-check` job prints, in its job summary, the classification of every changed pack field by field.
   - The website preview serves the registry signed with a throwaway test key that no release trusts (`/registry/v1/index.json` on the preview URL).

**What review looks for.**
- **Read the classification first.** Loosening and restrictive changes, and added or removed domains, always wait for each operator's approval. A wrong *tightening* change, however, applies by itself wherever operators turned auto-update on.
- **Published versions are immutable.** A version's content never changes once listed. Both CI and the signing job refuse such a change.
- **Fixing a mistake.** Publish a new version, and mark the bad one `"revoked": true`.

## How a merge is published

`website.yml` on `main` runs three jobs:

1. **`registry-build`** writes the unsigned layout: pack files, and an `index.json` without version, dates or signature. It installs dependencies and holds no secrets.
2. **`registry-sign`** runs in the GitHub environment **`registry-signing`** and waits for the owner's approval. It checks out the commit and runs `node scripts/registry-sign.mjs` with **no dependency installed** (only Node's built-ins). In order, it:
   1. recomputes every pack file and the index from the commit's `registry/`, and refuses any difference from the artefact;
   2. verifies `keys.json` against `registry/keys/root-*.pub`, and checks that the online key in `REGISTRY_ONLINE_KEY` is listed and still valid;
   3. reads the published layout and refuses to go on unless:
      - it verifies under the pinned roots, signed by an online key the commit's `keys.json` lists;
      - its version is not below `registry/state.json`;
      - its version is within the fast-forward bound;
      - every version it already published is unchanged;
   4. signs the next version, valid 14 days (never past the online key's `not_after`);
   5. attests the files (`actions/attest-build-provenance`).
3. **`deploy`** publishes the signed files with the site.

**Deploys that don't sign.** A deploy that does not sign (a docs change) re-publishes the live registry, but only if it is exactly this commit's: the commit's `keys.json` byte for byte, signed by a still-valid online key of it. Otherwise the docs deploy without the registry, the job fails, and the summary asks for a re-sign. A website deploy can never silently remove a published registry: `website/scripts/deploy-guard.ts` refuses that, in CI and for `bun run website:deploy`.

**When signing runs.** Only when `registry/` changed, on the weekly re-sign, or on a manual run of the **website** workflow with **sign**. In every case, only once the repository variable `REGISTRY_PUBLISH` is `true`. When nothing is published yet, the signing job refuses unless the manual run also sets **first_publish**.

**Recording the version.** The signing job's summary shows the version it signed. Now and then, copy it into `registry/state.json` (`index_version`) in a pull request. That makes it the floor future signatures never go below, even if the site is wiped or serves an old copy.

**Weekly re-sign.** `registry-resign.yml` runs every Monday and asks for the same approval. It re-signs the same content with a new version and expiry. Approve it within the week: GitHub → Actions → the waiting run → **Review deployments** → **Approve**. A missed week is harmless for 14 days. After that, installs show stale site packs (`SITE_PACKS_STALE`) and keep working with what they have.

**Rejecting** a signing run (or letting it time out) publishes nothing and skips that deploy. The next run deploys again.

### If the published registry cannot be verified

A signing run refuses when what browserhive.ai serves does not verify, was signed by a key the commit no longer lists, is older than `registry/state.json`, or jumps too far ahead. The same happens when nothing is served although `registry/state.json` records a version. Each of these means the site was changed outside the workflow, or a key leaked. Do this:

1. Rotate the Cloudflare token.
2. Redeploy the last good build: re-run the last successful **website** run on `main`.
3. If no good copy exists, run the **website** workflow with **sign** and **first_publish**. It signs the version after the one `registry/state.json` records, so installs that saw a higher version refuse it as a rollback until later signatures pass their floor. Set `index_version` in `registry/state.json` to the highest version you know was published before doing this.

### Deploying the website by hand

`bun run website:deploy` refuses to deploy over a published registry unless the build carries it. To deploy by hand, carry it first:

```sh
node scripts/registry-sign.mjs fetch --url https://browserhive.ai/registry/v1/ --out /tmp/live --packs
node scripts/registry-sign.mjs carry --from /tmp/live --out /tmp/registry
REGISTRY_DIR=/tmp/registry bun run website:deploy
```

## Repository settings (the owner)

- **Required status checks.** In the `main` ruleset, add **`registry-check`**, **`workflow-lint`** and **`registry-preview-verify`** to the required checks. Skipped jobs report success, so this costs nothing on pull requests that do not touch the registry. Without it, a red `registry-check` does not block a merge; the signing job still refuses changed published versions.
- **Environment.** Create `registry-signing` with these settings:
  - **Required reviewers**: you. Leave **Prevent self-review** off: you are the only maintainer.
  - **Deployment branches and tags**: selected branches, `main` only.
  - **Secret**: `REGISTRY_ONLINE_KEY`. Store it in this environment only, never as a repository secret.
- **Cloudflare token.** Keep the production `CLOUDFLARE_API_TOKEN` in the `website` environment (which is limited to `main`), and give previews a separate token or none. A token that pull-request code can read can replace what browserhive.ai serves. It cannot forge the registry, but it can withhold it.

## Key operations (the owner)

All key operations run with `node scripts/registry-keys.mjs` (also `bun run registry:keys`). The tool is a standalone file that imports only Node's built-ins, so it needs no `bun install`, and no third-party code is loaded in the process that decrypts a root key. A test keeps it that way.

**Where to run it.** Ideally on an offline machine, from a fresh `git clone` of the repository, with only Node installed.

**What it writes.**
- Private keys go only to the paths you name. Those paths must be outside any git working tree; each key is written as a new file with mode 0600, and an existing file is never overwritten.
- Public results go to `registry/keys/` and `trust-root.ts`, which you commit in a pull request.
- The tool never uses the network.

`node scripts/registry-keys.mjs status` shows the root keys, what is pinned, and the expiry of `keys.json` and of each online key.

**Rehearse first.** `node scripts/registry-keys.mjs dry-run --layout <dir>` runs the whole ceremony with throwaway keys in a scratch folder; nothing in the repository changes. It runs both roots, an online key, a re-sign by the other root, a rotation and a revocation. It then prints the command that checks its signed layout with BrowserHive's own verifier, run in a separate process. Build `<dir>` first with `bun run registry:build`, which writes `dist/registry/v1`.

### The key ceremony (once)

**Before you start:**
- Do the repository settings above.
- Have two removable drives, ideally offline storage that you keep in different places.

**Steps:**

1. On the offline machine, in a fresh clone, on a new branch:
   ```sh
   node scripts/registry-keys.mjs init-roots --out /media/drive-1/browserhive-roots
   ```
   - Choose a passphrase for each root key: at least 12 characters, each written down and kept apart from the key files.
   - The tool writes the encrypted `root-1.key` and `root-2.key` and reads each one back to check it.
   - It writes `registry/keys/root-1.pub` and `root-2.pub`, and pins both keys in `trust-root.ts`.
2. Copy `root-2.key` to the second drive and remove it from the first. From now on each drive holds one root key. Either one can sign, so losing one is survivable.
3. Create the first online key, signed by root 1, with its secret written to a file outside the repository:
   ```sh
   node scripts/registry-keys.mjs online-key --root /media/drive-1/browserhive-roots/root-1.key --secret-out /media/drive-1/registry-online.secret
   ```
   - It writes `registry/keys/keys.json` (version 1, expires in 120 days, the key valid 90 days) and `keys.json.sig`, and prints the key id and dates.
   - Carry the secret file to a machine with `gh`, then run:
     ```sh
     gh secret set REGISTRY_ONLINE_KEY --env registry-signing < registry-online.secret && shred -u registry-online.secret
     ```
4. Check: `node scripts/registry-keys.mjs status` reports the two roots, "trust-root.ts pins exactly registry/keys", and "keys.json verifies under the root keys".
5. Commit `registry/keys/` and `packages/core/src/infra/site-packs/trust-root.ts` (`feat(core): pin the site-pack registry root keys`), open the pull request and merge it. It holds only public keys, and gitleaks scans it.
6. Once that merge is on `main`, set the repository variable `REGISTRY_PUBLISH` = `true` (Settings → Secrets and variables → Actions → Variables).
7. Publish the first index:
   - Run the **website** workflow with **sign** and **first_publish**, and approve `registry-signing`.
   - After the deploy, check `https://browserhive.ai/registry/v1/index.json`. `bunx browserhive sitepacks verify <a folder with the downloaded files>` from a build with the new keys accepts it.
   - Set `registry/state.json` `index_version` to the signed version in a later pull request.

From that release on, the release workflow refuses to publish a package whose pinned roots are placeholders or test keys (`scripts/registry-trust-check.ts`, run by `release:publish`). The ceremony therefore has to happen before the first release that carries the registry client.

### Every 90 days: rotate the online key

The signing job warns from 14 days before the online key's `not_after`, and refuses one day before it.

1. Add the new key:
   ```sh
   node scripts/registry-keys.mjs online-key --root <either root key> --secret-out <file>
   ```
   This adds the new key next to the old one in `keys.json` (expired keys are dropped) and re-signs it with a new version and a fresh 120-day expiry.
2. Put the new secret in place: `gh secret set REGISTRY_ONLINE_KEY --env registry-signing < <file> && shred -u <file>`.
3. Commit `registry/keys/keys.json` and `keys.json.sig` in a pull request and merge it. The merge signs and publishes with the new key; approve it.
4. Once that index is live, drop the old key with `node scripts/registry-keys.mjs revoke --root <either root key> --key-id <old id>`, then commit and merge again.

`keys.json` itself must also be re-signed at least every 120 days; rotating the online key does that. To extend it without a new key, run `node scripts/registry-keys.mjs sign-keys --root <either root key>`.

### If the online key leaks

1. **Revoke the key.**
   - Run `node scripts/registry-keys.mjs revoke --root <root key> --key-id <leaked id>`. If it is the only key, run `online-key` first, so `keys.json` names a new one.
   - Put the new secret into the environment and merge `registry/keys/`.
   - Clients stop trusting the leaked key as soon as they see the new `keys.json`, without a release.
2. **If the leaked key signed an index with a huge version** (a fast-forward attack), clients refuse every later index.
   - Re-sign `keys.json` once with `sign-keys --index-floor <the last good index version>`.
   - Each client resets its index floor to that value, once: the first time it sees that `keys.json` version.
   - The next `sign-keys` (or rotation) drops the field again.

### If a root key is lost or leaks

A root change needs a release, because the roots are built into each release. Installs keep trusting the old roots until they upgrade. A leaked root key can sign a `keys.json` naming its holder's own online key, so act quickly and say so in the release notes.

`init-roots --replace` writes new keys, `.pub` files and pins. The transition itself is not automated yet, so plan it before running it. It needs:
- a `keys.json` signed by both a remaining old root and a new one, so installs on either release accept it;
- the signing job to verify the published layout against the new roots.

## Local commands

| Command | What it does |
|---|---|
| `bun run registry:check -- [--base <commit>]` | Validate `registry/`; with a base, also the version rules and the classification report. |
| `bun run registry:build` | Write the unsigned layout to `dist/registry/v1`. |
| `bun scripts/registry-build.ts --sync` | Rewrite `registry/packs` and `registry/versions` canonically, and archive each pack's current version. |
| `node scripts/registry-keys.mjs dry-run --layout dist/registry/v1` | Rehearse the ceremony with throwaway keys. |
| `node scripts/registry-sign.mjs sign --artefact dist/registry/v1 --out <dir> --test-keys <dir>` | Sign a build with a throwaway test root, as previews do. |
| `bun scripts/registry-verify.ts <dir> --test-root <dir>/test-root.pub --expect-pinned-refusal` | Verify a test-signed layout, and check that this build refuses it. |
| `bunx browserhive sitepacks verify <dir>` | Verify a downloaded layout against the release's own root keys. |
