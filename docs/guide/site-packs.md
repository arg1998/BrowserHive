# Site packs

> **In this release:** BrowserHive ships site packs for a set of popular sites, reads your own pack files from a local folder, and checks BrowserHive's signed online registry for new versions ([Updates from the registry](#updates-from-the-registry)); signed folders can be exported and imported by hand for hosts without internet access. No pack applies until you approve it. Packs select [strategies](#strategies) (pacing, launch spacing, warm-up, keep-alive and the others) that BrowserHive runs for them. Every pending version is [classified](#classification): you see at a glance whether it tightens rules, relaxes them or can stop a site.

A site pack tells BrowserHive how one site works, so a [session template](templates.md) behaves there the way the site expects a person to, and stays signed in. It says how to tell whether the template is signed in, which requests and buttons sign the account out or create new credentials, which pages are security checks that need a person, and what the site's terms say about automation.

A pack is **data only**. It never carries code, scripts, launch arguments, proxy settings or vault rules, and nothing in it is ever sent anywhere. Packs apply to template sessions only; other sessions are not affected. The update check sends nothing about your install either: see [What the update check sends](security.md#what-the-update-check-sends).

## What a pack contains

A pack is one JSON file (at most 64 KiB) for one site, named by the site's registrable domain: `linkedin.com`. Every section is checked against a strict schema; an unknown key makes the whole version invalid.

| Section | What it says |
|---|---|
| `id`, `version`, `title`, `domains` | The pack's identity (`linkedin.com`), its version number (higher is newer), its name, and the registrable domains it covers (up to 8, the first is the id). A domain belongs to at most one pack. |
| `min_client`, `max_client` | The BrowserHive versions that can use this version. |
| `identity_provider`, `shares_login_with` | The site whose sign-in this one uses (`youtube.com` signs in through `google.com`), and sites that share its sign-in. |
| `sign_in` | The sign-in page (an `https` address inside the pack's domains, path only), `human_only` (when `true`, BrowserHive never fills a vault login there) and, optionally, `post`: up to 4 addresses (guard globs inside the pack's domains, never a whole host) the sign-in form posts to, every step included. Only the [classification](#classification) reads `post`: it tells which guards can stop the sign-in. |
| `signed_in` | How to tell that the template is signed in without reading a cookie value: a page to load (`probe`), the redirects that mean "signed out", a selector that is only there when signed in (`landmark`) or only when signed out (`signed_out_marker`), and cookie **names** whose absence means signed out. |
| `guards` | Requests that sign the account out, change account or security settings, create credentials (tokens, keys, app passwords, OAuth consent), destroy data, or write; each with what to do: `block`, `confirm`, `warn` or follow the write policy. |
| `element_guards` | Buttons and links an agent must not use (by CSS selector, or by role and name), with the same actions. |
| `write_policy` | The site's terms on automation (`stance`), the clause quoted from them with its address and the date it was checked, and the default for writes (`allow`, `warn` or `confirm`). |
| `challenges` | Pages that are security checks, CAPTCHAs, locked accounts or rejected sign-ins, and whether they need a person (`attention`) or must stop all use of the site (`stop`). |
| `concurrency`, `pacing` | How many sessions at once and how many writes per period the site tolerates, each with its source (official or vendor guidance). |
| `browser`, `device_binding`, `consistency` | The browser and headedness the site expects, how it binds a sign-in to a device, and whether the location, time zone and language must stay fixed. |
| `strategies` | Behaviour selected from a fixed list built into BrowserHive: pacing, launch spacing, active hours, warm-up, keep-alive, a stealth floor and others ([Strategies](#strategies)). |
| `verified`, `sources` | The date each section was last checked against the live site, and where the facts come from (shown, never fetched). |

## Where packs come from

| Source | What it is | Trust |
|---|---|---|
| **Bundled** | Packs shipped inside BrowserHive. A new release can ship new versions of them. | Publisher: they come with the release. |
| **Local** | Single pack files (`<pack id>.json`) in the local folder, `sitePacksDir` (default `<data-dir>/site-packs/local`). Written by you. | Operator: you approve each file's content. |
| **Registry** | Signed packs from `https://browserhive.ai/registry/v1/` (or a mirror): the index lists every version, and you download the ones you want to review. | Publisher: every file is checked against keys built into BrowserHive. |
| **Signed import** | A signed folder (the registry's layout) you copy to a machine without internet access, imported with `browserhive sitepacks import <dir>` or placed in the local folder. | Publisher: checked exactly like a download. |

BrowserHive reads the bundled packs and the local folder at startup and again on **Reload** (`browserhive sitepacks reload`). A file that fails validation is skipped, with its reason on the Site packs page, in `browserhive sitepacks list` and in `browserhive doctor`. A signed layout placed in the local folder (`keys.json`, `index.json`, their `.sig` files and `packs/`, at the top level or one per subfolder) is verified like an import, and its versions wait as downloaded updates; one that does not verify is listed as skipped (`layout_refused`).

With [`sitePacks`](../reference/configuration.md#sitePacks) set to `false`, BrowserHive uses no pack data at all: every template site is a generic site (sign-in checks by learned cookie names, no guards, no challenges).

## Approval and provenance

**No pack version applies until you have approved it**, whatever its source. Until then the site is a generic site.

**First use.** When you add a site to a template (the dashboard's new-template wizard, adding a site on the template page, `browserhive templates create --sites`, or the REST API), BrowserHive shows the pack that would apply: its version, its SHA-256 and where it comes from ("bundled with BrowserHive 0.3.1", or a local file's path). Adding the site **approves that version**, in your name, with that provenance. Every way of adding a site sends the SHA-256 of the version you were shown, and BrowserHive approves exactly that one:

- **The dashboard** waits until the catalog of packs has loaded before it lets you create the template, and sends the hash of each pack it showed you.
- **`browserhive templates create --sites`** prints each site's pack (version, provenance, SHA-256, the site's terms, whether writes need confirmation) before it creates anything, asks you to type `yes` on a terminal, and refuses without one unless `--yes`. A pack that is already approved is listed and needs no answer.
- **The REST API** takes the hash as `pack_sha256` on each site (`POST /templates`, `PUT /templates/{id}/sites/{site}`). A site whose pack still needs approval is refused without it ([`SITE_PACK_APPROVAL_REQUIRED`](../reference/errors.md#SITE_PACK_APPROVAL_REQUIRED), 409, with the offer's version, SHA-256 and provenance in its details), so nothing is approved that you were not shown.

If another version is on offer by the time you confirm, adding the site fails with `409 CONFLICT`, and you review the pack again.

**Packs are global.** One approval covers every template. A pack another template already uses keeps its approved version when you add its site to a second template. An approved, enabled pack applies to every template browser's pages on its domains, whether or not the template lists the site. What is per template is the site's [write policy](#write-policies-and-the-stance-rule).

**Later versions wait for you.** When a newer BrowserHive release ships a newer bundled version, it appears as a **pending update** with the exact field-by-field difference from the version you approved, each field [classified](#classification). Templates keep the approved version until you act. No release, and no automatic update, ever applies one.

| Action | Dashboard | Command line | What it does |
|---|---|---|---|
| Review | the pack page | `sitepacks diff <pack> [--to <version>]` | Shows the version's classification, each changed field with its class, its old and new value, and any new domain. |
| **Apply** | **Apply** | `sitepacks apply <pack> [version]` | The version becomes the approved one. Every template that uses the pack follows it at once. The version it replaces is kept for Revert. |
| **Reject** | **Reject** | `sitepacks reject <pack> [version]` | Dismisses the version: it is **set aside**. It is offered again only when a newer version arrives, or when you download it again ([Set aside](#set-aside-versions)). |
| **Revert** | **Revert** | `sitepacks revert <pack>` | Goes back to the previous approved version in one step, and sets aside the version you reverted from. The dashboard and the command line show its classification first, like Apply. |
| **Pin** | **Pin** | `sitepacks pin <pack> <version>`, `sitepacks unpin <pack>` | Keeps the approved version. Newer versions are listed as "pinned at v7, v9 available". |
| **Follow updates** | **Follow updates** | `sitepacks follow <pack> on\|off\|auto` | Whether the pack lists pending updates, counts in the badge and sends [`site_pack.update_pending`](notifications.md#site-packs). `auto` (the default) follows a pack while a template uses it. |
| Turn off | the **Enabled** switch | `sitepacks disable <pack>`, `sitepacks enable <pack>` | A disabled pack applies nowhere: its guards (sign-out, account and credential ones included) stop applying for every template, and its sites are generic sites until you enable it again. Turning a pack off asks for confirmation (the command line asks you to type the pack id, or takes `--yes`). |

Every decision is recorded with who made it and when (`GET /api/v1/site-packs/changes`, and the audit log).

**BrowserHive keeps a copy of what you approved.** At every approval it copies the version's exact bytes to `<data-dir>/site-packs/cache/<source>/<pack id>/<sha256>.json`. When a later release drops or changes a bundled version, or a local file is edited or deleted, the approved copy keeps applying. If that copy is missing or unreadable, the pack is not applied (its sites are generic) and the pack is listed as skipped (`not_found`).

**Precedence.** For one pack id, approved local content wins over every other source; otherwise the approved version applies. A pack whose content comes from a local file says "Local file overrides v9" wherever it is shown.

**A domain belongs to one pack.** Content that claims a domain another pack already covers is refused: approving or importing a local file that lists `github.com` while the GitHub pack covers it answers 409 [`SITE_PACK_DOMAIN_TAKEN`](../reference/errors.md#SITE_PACK_DOMAIN_TAKEN) naming that pack, and nothing of the other pack changes. A version skipped for this reason names the pack that owns the domain.

**One broken pack stays alone.** If BrowserHive cannot read one pack's stored approval, only that pack is left out (its sites are generic), and the Site packs page and `browserhive doctor` say so; every other pack keeps applying.

### When a version raises the stealth floor

A pack's [`stealth-profile`](stealth.md#site-pack-stealth-strategies) sets a floor: a minimum stealth level, and fingerprint noise on or off. A template's stealth level and fingerprint noise are fixed for its life, so a template cannot be changed to meet a higher floor. A version whose floor is above a template that uses the pack (with the site turned on there) therefore cannot apply: **Apply**, **Revert** to such a version and **Approve** of such a local file are refused with [`SITE_PACK_BELOW_FLOOR`](../reference/errors.md#SITE_PACK_BELOW_FLOOR), which names each template and what it lacks, and nothing changes. The dashboard explains it in a dialog. To go ahead, for each named template:

- turn the site off on that template (its **Sites** tab), so the template no longer uses the pack; or
- create a new template with the stealth settings the pack needs, sign in to the site there, and remove the site from the old template.

Or reject the version: the current one keeps applying.

**When the version in force changes without you.** Deleting an approved local file cannot be refused: the approved published version applies again at once. If its floor is above a template that uses the pack (the same holds when a revoked version falls back to an earlier one), BrowserHive turns the site off on that template, records it in the audit log and tells you: the template's page says the site was turned off and why, System lists [`TEMPLATE_SITE_BELOW_FLOOR`](../reference/errors.md#TEMPLATE_SITE_BELOW_FLOOR), and you get a notification. A template never runs a site below its pack's floor. Turning the site on again is refused while the template is below the floor; the record clears once no site BrowserHive turned off is still off below its pack's floor (the site or the template removed, or a version with a lower floor applied). Sites you turned off yourself never keep it open.

## Classification

BrowserHive compares every pending version (and every local file waiting for approval) with the version you approved, field by field, and gives each changed field one of four classes. The version's class is the strongest of its fields: **Relaxes rules** beats **Can stop the site**, which beats **Tightens rules**, which beats **No rule change**.

| Class | Dashboard | What it means | Examples |
|---|---|---|---|
| `loosening` | **Relaxes rules** (red) | Removes or weakens a protection, widens what the pack covers, or changes an address BrowserHive loads by itself. | A guard or challenge removed; a guard action made laxer (`block` → `warn`), or its match, target or `request_guard` changed; any move to or from `write_policy`; a domain added or removed; the sign-in page, the addresses the sign-in form posts to (`sign_in.post`: added, removed or changed), the signed-in check, the keep-alive path or any strategy path changed; `identity_provider` or `shares_login_with` changed; a cap raised; a strategy removed; a strategy parameter moved against its safe direction; `browser.channel` changed. |
| `restrictive` | **Can stop the site** (amber) | Adds a limit that can stop agents from using the site. | A guard (that blocks or asks) added or made stricter over the pack's signed-in check page, its sign-in page or a whole host, or that can stop the sign-in form's post (it covers `POST`, or every method, at an address the pack lists in `sign_in.post`; a pack that lists none counts any such guard on the sign-in page's host); a challenge that stops the site (added with `stop`, or `attention` → `stop`); a challenge matched without an address (only by its title, a selector, text or a CAPTCHA frame: "LinkedIn" is in every LinkedIn title); a challenge over the signed-in check page, the sign-in page or a whole host, or that would match every page (landmark `body`, `html` or `:root`, a text shorter than 4 characters); one session at a time or a write budget of 1; `headed: 'required'` added (headless templates stop); `active-hours` added, or its window cut below 4 hours; a `stealth-profile` floor above a template that uses the pack. |
| `tightening` | **Tightens rules** (green) | Adds or strengthens protections and limits; nothing is relaxed. | A guard added elsewhere (away from the sign-in form's post addresses when the pack lists them in `sign_in.post`, else on another host than the sign-in page's, or for methods other than `POST`), or made stricter there (`warn` → `confirm` → `block`); a `warn` guard anywhere; a challenge that asks for attention added at an address elsewhere; a stricter default write policy (`allow` < `warn` < `confirm`); a cap lowered, a pacing rule added, a longer launch gap or keep-alive interval; a visible browser preferred, a proxy recommended, location, time zone or language pinned; a device binding added; `human_only` turned on; a strategy added, or a parameter moved in its safe direction (the strategy table says which way is stricter). |
| `neutral` | **No rule change** (grey) | Only what is shown changes. | `title`, `description`, `verified` dates, `sources`, `min_client`, `max_client`, the terms' `stance`, `clause` and `exception`, the source of a cap or pacing rule; a strategy parameter written out with its default value. |

Chips always carry words and an icon, never colour alone. Other labels you can meet in the history: **New pack** (the first approval of a pack), **Local override** (an approved local file), **Revoked** (see below), and **Not classified** (decisions recorded before this release).

**Default deny.** A field, or a strategy parameter, that has no rule above is **loosening**. A new pack format field, a pacing rule's period or its `guard`, a challenge's `kind` and every strategy parameter without a safe direction (a path, `entry-warmup`'s `referrer`) count as relaxing rules until someone writes a rule for them. Numbers are compared as BrowserHive reads them: defaults applied and clamped to the bounds built into it, so writing out a default changes nothing.

**It follows your templates.** Whether a `stealth-profile` change can stop the site depends on the templates that use the pack (their enabled sites). When you create or delete a template, or add, remove, or turn a site on or off on one, the pending versions are classified again.

**The sign-in form's post.** A guard that blocks or asks can stop agents from signing in when it covers the address the sign-in form posts to, which is rarely the sign-in page itself (LinkedIn's form on `/login` posts to `/checkpoint/lg/login-submit`). A pack can list those addresses in `sign_in.post` (every step: password, two-factor, device checks); then only a guard over one of them, the sign-in page or the signed-in check page classifies **Can stop the site**, and a routine guard elsewhere on the same host (a sign-out, a settings page, a write) **Tightens rules**. A pack that lists none is read conservatively: every guard that blocks or asks a `POST` on the sign-in page's host can stop the site, so on a site whose sign-in page is on its main host most such guards wait for you even once automatic updates arrive. Because a wrong list would let a guard on the real address pass as tightening, adding, removing or changing `sign_in.post` always **Relaxes rules**. Two addresses count as overlapping when any address matches both globs (with the guard grammar's sub-path and query variants; a host wildcard never reaches into the path).

**What the classification decides.** With automatic updates off (the default), nothing by itself: every version waits for your Apply, and the class tells you how carefully to read it. With [automatic updates](#automatic-updates) on, only **Tightens rules** and **No rule change** versions of followed registry packs are applied automatically; versions that relax rules or can stop a site, any change of domains, bundled versions and local files always wait for you.

**Revocation.** The online registry can mark a version it published as revoked. BrowserHive then compares the version you approved before it (the fallback) with the revoked one, like any candidate: a fallback that only tightens rules or changes nothing applies at once (recorded as "Applied automatically"); a fallback that relaxes rules or can stop the site does **not** apply by itself, the revoked version stays in force, and the fallback waits under **Updates available** marked **Revoked**, with a notification, whether or not you follow the pack or pinned it; with no fallback the revoked version stays in force and the revocation is recorded in the audit log. A revoked version is never removed silently. Bundled packs and local files cannot be revoked, and content you approved from a local file is never replaced by a revocation.

## Updates from the registry

BrowserHive's registry is a folder of signed, static files on browserhive.ai: a list of signing keys (`keys.json`), an index of every pack and version (`index.json`), their signatures, and one file per pack version. No server of ours runs and nothing is uploaded; see [the registry's contributor guide](../contributing/registry.md) for how it is published.

> **Before the signing keys are built in.** A release can check the registry only once the project's root keys are built into it. Until then [`browserhive doctor`](cli.md#doctor), the Site packs page and `browserhive sitepacks check` say "this build pins no registry keys yet: no update check runs", and BrowserHive makes no request.

### The check

With [`sitePacksUpdateCheck`](../reference/configuration.md#sitePacksUpdateCheck) on (the default), BrowserHive fetches the signed index 5 minutes after it starts and then every 24 hours (± 2 hours, later after failures), whether or not you have templates. It fetches only `keys.json`, `index.json` and their two signatures: never a pack file, and nothing about your install ([What the update check sends](security.md#what-the-update-check-sends)). **Check now** on the Site packs page, or `browserhive sitepacks check`, checks at once.

Every file is verified before anything changes: the keys list against the root keys built into BrowserHive, the index against a signing key from that list, both against their expiry dates and against the versions BrowserHive saw before (an older or a much newer index is refused). A file that does not verify changes nothing. BrowserHive keeps the last index that verified in `<data-dir>/site-packs/remote/`.

### Available, downloaded, applied

The index lists each version with its size, release date and the publisher's notes (plain text, signed with the index). For each pack, the newest version you have not approved, that is not revoked and that your BrowserHive can use, appears under **Updates available** as **Available**:

1. **Download & review** (`browserhive sitepacks download <pack> [version]`) fetches exactly that version's file, checks its size and SHA-256 against the signed index and the pack schema, and shows the [classified](#classification) field-by-field difference from the version you approved. The version is now **Downloaded**.
2. **Apply**, **Reject** or **Pin** it as for any pending version ([Approval and provenance](#approval-and-provenance)). Apply records the registry as its provenance ("registry, key …, index …, signature verified"); **Revert** goes back to the previous version in one step.

A newer version supersedes an older one that is still pending. A version that needs another BrowserHive release is shown with the range it needs and is never offered. A pack you have never approved can be downloaded and applied the same way; applying it is its first approval. When the pack has a bundled version that first use would approve, the difference is shown against that version ("compared with bundled v2"); a pack only the registry has shows every field as new.

### Set aside versions

**Reject**, and **Revert** (for the version you go back from), set a registry version aside: it leaves **Updates available** and is not offered again by later checks. It comes back by itself only when the registry lists a newer version. To look at it again, download it again (`browserhive sitepacks download <pack> <version>`, or `POST /site-packs/{pack}/download`): it is pending again, with its difference. `sitepacks list` and `sitepacks show` print "v3 set aside · `browserhive sitepacks download <pack> 3` reviews it again".

### Follow updates

The check always fetches the whole index, for every pack. **Follow updates** (automatic by default: followed while a template uses the pack; or `browserhive sitepacks follow <pack> on|off|auto`) decides only which packs list pending updates, count in the badge and send [`site_pack.update_pending`](notifications.md#site-packs), and which packs automatic updates may touch. `sitepacks check` and `sitepacks list --pending` exit 2 when a followed pack has a pending update.

### Download all

**Download & review** fetches one pack file, so the registry's host can tell which pack version your IP address downloaded. **Download all** (`browserhive sitepacks download --all`) instead fetches every listed version BrowserHive does not hold yet, for every pack, so nothing in the requests says which pack you care about. Each file is verified like a single download; versions newer than the approved ones appear as **Downloaded**, and still wait for you.

### Automatic updates

[`sitePacksAutoUpdate`](../reference/configuration.md#sitePacksAutoUpdate) is off by default. When you turn it on, BrowserHive downloads and applies a registry version by itself only when the change cannot stop or block your agents' work. All of these must hold:

- the pack is followed, approved, not pinned, and has no local file in force;
- the version is classified **Tightens rules** or **No rule change**: nothing relaxes a rule and nothing can stop the site;
- it adds or removes no domain;
- it adds, removes or changes no challenge and no element guard (a button or link agents must not use);
- it adds no blocking guard over a whole host, and makes at most three network guards newly block or ask;
- it does not turn on **sign-in by a person only** (`sign_in.human_only`);
- it does not lower how many sessions the site allows at once (`concurrency.max_sessions`);
- it slows agents by at most a factor of 2: no new pace rule and no change to a rule's period or guard, a pace limit at least half the old one, and a launch gap (`pacing.min_launch_gap_s`) at most twice the old one (or 30 seconds, if that is more);
- it adds or removes no strategy, moves no numeric strategy parameter by more than a factor of 2 either way, and changes no other strategy parameter.

Such a decision is recorded as made by `browserhive` ("Applied automatically"). Anything else is downloaded and waits for you, with the badge and the notification. Versions that relax rules or can stop a site, domain changes, bundled versions, imports and local files are never applied automatically, and the stealth floor is checked as on any Apply. A stolen signing key can therefore at most make small tightening changes to followed packs, and only with automatic updates on.

### Revoked versions

When the index marks the version you approved as revoked, BrowserHive follows the rules under [Revocation](#classification) above: a fallback that only tightens applies at once; otherwise the revoked version stays in force, the pack says **Revoked** (`sitepacks show` and `list` say so too), and the fallback waits for you.

### When the index is stale or the check fails

An index expires 14 days after it was signed (the publisher re-signs it every week). When the held index expires and no fresh one verifies, BrowserHive keeps everything you approved, offers nothing new, refuses downloads, and System lists [`SITE_PACKS_STALE`](../reference/errors.md#SITE_PACKS_STALE); if the registry's clock and yours differ by more than an hour, the message says to check the system clock (`doctor` warns beyond 5 minutes). Three failed checks in a row list [`SITE_PACKS_FETCH_FAILED`](../reference/errors.md#SITE_PACKS_FETCH_FAILED) with the last reason (a network error, or a file that did not verify). Approved packs keep applying in both cases; the records clear after the next good check.

### Hosts without internet access

With `sitePacksUpdateCheck` set to `false`, BrowserHive makes no request at all; bundled and local packs keep working. To bring registry versions to such a host:

1. On a connected host, check and download what you want (`browserhive sitepacks check`, then `browserhive sitepacks download --all` to include every pack file), then write the signed folder: `browserhive sitepacks export ./registry-export`. It holds the verified `keys.json`, `index.json`, their signatures and every pack file BrowserHive holds, exactly as published. `export` names the listed versions it does not hold, which are therefore not in the folder; run `sitepacks download --all` first to include them.
2. Copy the folder to the offline host and import it: `browserhive sitepacks import ./registry-export` (at most 1 MiB), or copy it into the local folder (`sitePacksDir`) and run `browserhive sitepacks reload`.

The offline host verifies the folder with its own built-in keys exactly as a download (expiry and the versions it saw before included), so a copied folder cannot be older than what it already has, and a stale export is refused like a stale index. Versions whose file is in the folder arrive as **Downloaded** (provenance "imported file <folder name>", with the signing key and index version that verified it); listed versions without a file are **Available** and cannot be downloaded there; revoked versions are reported as revoked by the publisher. Like any pending version, a downloaded version is listed for review only while you follow its pack: `sitepacks import` says "downloaded; `browserhive sitepacks follow <pack> on` to review it" for the others. Export, then import on an offline host, offers the same versions as the connected host. Folders downloaded from `https://browserhive.ai/registry/v1/` by hand work the same way; `browserhive sitepacks verify <dir>` checks one without a server.

### Mirrors

[`sitePacksUrl`](../reference/configuration.md#sitePacksUrl) points the check and downloads at another folder (`https` only). A mirror must serve the same signed files: everything is verified against the keys built into BrowserHive, whatever the address, so a mirror can withhold updates or serve stale files (which become [stale](#when-the-index-is-stale-or-the-check-fails)) but cannot change a pack.

## Local packs

Put one file per pack in the local folder, named after the pack: `<sitePacksDir>/example.com.json`. Then run `browserhive sitepacks reload` (or restart BrowserHive). Or send a file to a running server, which stores it in the folder for you:

```bash
browserhive sitepacks import ./example.com.json
```

The command sends the file's text byte for byte, so the SHA-256 you approve is the file's own: the one `browserhive sitepacks verify` prints. It prints that SHA-256 after the import.

A local file needs no signature, but it applies only once you have approved its content, **once per SHA-256**:

| State | Meaning | What applies |
|---|---|---|
| **Approved** | You approved this exact content. | The file's content. |
| **Changed since approval — review** | The file's SHA-256 differs from the one you approved. The pack page shows the difference. | The content you approved, from BrowserHive's copy in `site-packs/cache/local/`. |
| **Not yet approved** | You never approved any content of this file. | Nothing of it. |

Approve on the pack page, or:

```bash
browserhive sitepacks approve-local example.com
```

The command prints the difference between what applies now and the file, then the SHA-256 it approves (the one of the content whose difference it printed), and asks you to type the pack id (`--yes` skips the question; without a terminal it refuses unless `--yes`). BrowserHive then copies that content to `site-packs/cache/local/example.com/<sha256>.json`, so later edits to the file change nothing until you approve them again. If the file changed between the review and the approval, the approval is refused (`409 CONFLICT`, or the command stops before sending anything): run it again to review the new content. The dashboard's **Approve** likewise approves the hash of the difference it shows, and waits while that difference reloads.

## Write policies and the stance rule

A pack records the site's terms on automation as a **stance**, quotes the clause with its address and the date it was checked, and sets a **default write policy** for its `write` guards. The default follows the stance rule:

| Stance | Shown as | Default write policy |
|---|---|---|
| `prohibited` | The site's terms prohibit automated access | `confirm`: each write waits for your approval |
| `writes_restricted` | The site's terms restrict automated posting or submitting | `confirm` |
| `restricted` | The site's terms restrict automated access | `warn`: writes go through and are recorded with a warning |
| `allowed` | The site's terms allow automated access | `allow` |

A pack that departs from the rule says why (`exception`), and the reason is shown to you. The clause is shown as text, with its address as plain text; it has no other effect. **You choose** a template's write policy per site: in the wizard, on the template's Sites tab, or with `PUT /api/v1/templates/{id}/sites/{site}` and `{"write_policy": "allow" | "warn" | "confirm" | null}` (`null` uses the pack's default). **A pack with no `write` guards has nothing for the write policy to act on**: whatever you choose, no write waits for confirmation on that site. The wizard, the template's Sites tab, the pack page and `browserhive templates create` say so for such a pack.

## Guards

Guards are checked in two places, both pure matching over the pack's data:

- **In the browser, on every request** of a template's browser: by method, address and type. This is the enforcement point. Sign-out, account, credential and destructive guards match **every** type of request (page loads, `fetch`, XHR, beacons, images, scripts, stylesheets, prefetches, event streams and the rest; WebSockets are never routed, see below), so an `<img src="/logout">` is stopped too, unless the guard names the types it covers (`resource_types`). Write guards match page loads, `fetch`, XHR and beacons unless they name others.
- **In the tools, before the browser is touched**: `navigate` and `new_tab` check page-load guards, and `click`, `hover`, `select_option`, `drag_and_drop`, `fill`, `type_text` and `press_key` check element guards. An action is refused when its target **is** the guarded element **or is inside it** (a `<span>` in a guarded button). This is an earlier, friendlier refusal, not the boundary.

A request belongs to the pack of its own address's registrable domain, not of the page that sent it. The first matching guard of that pack decides. A guard address without a trailing `*` also matches the same path with any query string and the paths beneath it: `www.example.com/logout` matches `/logout`, `/logout/x` and `/logout?next=/`, but not `/logout-help`. Before matching, the address is read the way a server reads it: percent-encoded letters and digits are decoded (`/log%6Fut` is `/logout`), encoded slashes and dots are decoded, repeated slashes collapse (`//logout` is `/logout`), `;parameters` in a path segment are dropped (`/logout;x=1` is `/logout`), and host names are compared without case or a trailing dot. Pattern matching takes time proportional to the address, whatever the pattern, and a pattern may hold only a few `*`.

BrowserHive also applies built-in guards on every template page, with or without a pack: they block the OAuth consent approval of `accounts.google.com`, `github.com`, `login.microsoftonline.com` and `login.live.com`, so an agent cannot grant a third-party app access to the account.

| Action | In the browser | In the tools |
|---|---|---|
| `block` | The request is aborted. | `navigate` and `new_tab` answer [`URL_BLOCKED`](../reference/errors.md#URL_BLOCKED) with `pattern: '<pack id>#<guard id>'`; element actions answer [`SITE_ACTION_BLOCKED`](../reference/errors.md#SITE_ACTION_BLOCKED). Agents are told not to retry. |
| `confirm` | The request is **held** while a write confirmation waits on `/attention`. Approve: it goes on. Deny, the deadline, the session closing or the page going away: it is aborted. | The tool answers [`SITE_OPERATOR_PENDING`](../reference/errors.md#SITE_OPERATOR_PENDING) with the request id. After an approval, the agent retries the action: the same guard and address pass once for that session, within 10 minutes. |
| `warn` | The request goes on, with a [`SITE_GUARD_WARNED`](../reference/errors.md#SITE_GUARD_WARNED) warning on the session. | The action goes on. |
| `write_policy` | The site's write policy decides: `allow`, `warn` or `confirm` as above. | The same. |

**Write confirmations.** A held write shows on `/attention` with the method, the address (sanitized), the guard and its kind, the site and the tool call that triggered it. Its deadline is `attentionTimeout`, at least `minAttentionWait`. While it waits, the session gets a [`SITE_WRITE_HELD`](../reference/errors.md#SITE_WRITE_HELD) warning and its next tool call answers `SITE_OPERATOR_PENDING`; the agent can wait with `get_attention_result`. Bounds: one open write confirmation per session (a further matching write of that session is aborted), and at most 10 open site checks and write confirmations per template (beyond that, matching writes are aborted); the limits are checked before anything is opened, so requests arriving together cannot pass them, and one session cannot fill the template's limit alone. **Resolve all** on `/attention` never decides site checks or write confirmations: decide each one. Writes of kind `write` can also be approved from a [notification](notifications.md#site-packs); sign-out, account, credential and destructive guards only on `/attention`.

**Requests with no session.** A request of the template's browser that belongs to no agent session (a service worker, a page you opened by hand, a page BrowserHive opened for a health check) under a `confirm` guard is aborted, as under `block`.

**Without the dashboard** (`transport=stdio`), nobody can answer: `confirm` acts as `block`, and challenges only mark the site's health.

Every guard decision is recorded (`GET /api/v1/site-packs/guard-hits`, and as `guard` rows in the session's timeline) with the guard, the action, the session, the method, the sanitized address and, for confirmations, who decided.

## Challenges

A **challenge** is a page that needs a person: a security check, a CAPTCHA, a re-authentication prompt, a locked account. BrowserHive watches a template's pages for:

- a page load whose address matches a pack challenge;
- after the page loads, its title containing a pack's text, a pack's selector on the page, or a pack's text on the page;
- a CAPTCHA provider's challenge (Cloudflare, reCAPTCHA, hCaptcha, Arkose, DataDome), but **only a visible one**: a provider's challenge frame, or a provider frame at least 100 × 60 pixels inside the viewport. Invisible checks and badges (reCAPTCHA v3, Turnstile in invisible mode) are ignored.

Site checks are raised only on a template's own sites and on the domains of approved packs; a challenge on any other site changes nothing. Built-in challenges apply on those pages: the Cloudflare interstitial ("Just a moment", "Verify you are human") needs a person; any other visible provider challenge only marks the site's health.

What happens:

- **In an agent's session**, BrowserHive opens a **Site check** on `/attention` ("LinkedIn security check") in takeover mode, with a deadline of `attentionTimeout` (at least `minAttentionWait`). The site's health becomes `challenged` ("! check needed") and you get a [`template.challenged`](notifications.md#template-sign-ins) notification. Until the check is resolved, the session's tools answer `SITE_OPERATOR_PENDING`, except `close_session`, `list_sessions`, `server_status`, `session_info`, `list_tabs`, `screenshot`, `list_templates`, `get_attention_result`, `list_saved_auths` and `vault_list_available`. Take over in the live view (your input is allowed while the check is open), or solve it in the template's window, then **Resolve** or **Reject** it on `/attention`. Resolving checks the site again. At the deadline the session's tools are released and the site stays `challenged`.
- **`stop`** is for pages where retrying makes things worse ("Couldn't sign you in", a suspended account). It does the same, and also stops the site: every agent navigation to it and every tool on its pages answers `SITE_OPERATOR_PENDING` (`reason: stopped`) until you press **Clear stop** on the template's Sites tab (`POST /api/v1/templates/{id}/sites/{site}/clear-stop`).
- **An agent's own navigation never triggers one.** When the address an agent passed to `navigate` or `new_tab` matches a challenge, the page loads and nothing else happens: no Site check, no health change, no stop. A redirect into a challenge page does count.
- **In a health check**, a challenge only sets the result to `challenged`.

Bounds: one open Site check per session (further matches join it), at most one new one per session every 5 minutes, and the template's limit of 10 open site checks and write confirmations. Neither `challenged` nor "couldn't tell" ever starts a re-login: signing in again into a security check is how accounts get locked.

## Strategies

A pack selects **strategies** from a fixed list built into BrowserHive; it never carries their code. Each strategy's parameters are checked and kept within bounds built into BrowserHive, so a pack can tune a strategy but not push it to a harmful extreme. `GET /api/v1/site-packs/strategies` lists every strategy with its parameters, defaults and bounds, and each pack page in the dashboard shows the strategies it selects.

Strategies change how a template's sessions behave on the site, never what an agent can ask for. An agent sees a wait as an ordinary slower call, and a refusal only as `TEMPLATE_BUSY` with a retry time, the same answer as a full template. Strategies that concern the whole template (session cap, launch spacing, active hours, ramp-up, keep-alive, the stealth floor and WebRTC) come from the template's **enabled** sites; when several sites select one, the strictest wins. Strategies that concern a page (pacing, dwell, one action at a time, warm-up, humanized input, one focused tab, device binding) apply on the pages of the pack's domains. Restarting BrowserHive does not reset them: the write budgets used, the next launch's turn and the last action on each site are kept in BrowserHive's database, written when a budget is used or a launch takes its turn (the last action at most every 2 seconds, and everything when BrowserHive stops), and read back before any session starts. So a restart neither refills a budget nor lets a launch or an action skip its spacing; a crash loses at most the last 2 seconds of last-action times. What ended while BrowserHive was stopped stays ended: a budget refills over the time that passed, and a turn that came is taken by the next launch. Ramp-up counts from the template's creation, so it is unaffected. Only live coordination is not kept, as no session survives a restart: the queue of one action at a time and which tab holds focus. A template's saved state is deleted with the template. With [`sitePacks`](../reference/configuration.md#sitePacks) set to `false` no strategy runs.

### Sessions and launches

- **Session cap (`concurrency.max_sessions`).** Not a strategy: whenever an enabled site's approved pack sets `concurrency.max_sessions`, the template runs at most that many agent sessions at once (the smallest of its sites wins, and never more than the template's own **Max sessions**). The Templates list shows the lowered cap. An agent launching beyond it gets `TEMPLATE_BUSY` ("Template 'name' is at capacity. Retry in 5 s."), the same answer as the template's own cap.
- **Ramp up a new template (`ramp-up`).** For a template younger than `days` (14), its session cap and every write budget of `pace-writes` are scaled by `start_fraction + (1 − start_fraction) × age_days / days` (`start_fraction` 0.3), rounded up and never below one; the smallest factor of the template's sites wins. The Templates list shows the current cap.
- **Active hours (`active-hours`).** New sessions start only inside the window (`start_hour`–`end_hour`, end exclusive, may wrap past midnight; `weekdays_only` counts the day the window opened) in the template's pinned time zone. With several sites a launch must be inside every window. Outside, `launch_session` answers `TEMPLATE_BUSY` with a retry time up to the window's start; sessions already running continue. If the sites' windows never overlap, launches are refused with a one-day retry and BrowserHive logs a warning.
- **Space launches (`launch-spacing`).** Consecutive sessions of the template start at least `min_gap_s` apart (default: the pack's `pacing.min_launch_gap_s`; the largest of its sites), plus a random 0–`jitter_pct` % (20 %). A launch waits for its turn, up to 20 s and never beyond its launch budget, and to the agent this is a slower launch; a turn further away answers `TEMPLATE_BUSY` with the time until it. Launches queue in order; a refused launch takes no turn.

### Actions on the site's pages

- **One action at a time (`serialize-site`).** At most `max_parallel` (1) sessions of the template click, type, scroll, upload, download or navigate on the site at once, like one person with many tabs. The others queue in arrival order for up to 30 s; past that the action answers `TEMPLATE_BUSY` ("Actions on <site> are being paced. Retry in 5 s.") and the log records `site action paced`. Reading tools (snapshot, content, screenshots, waits) are never held, and a session's own concurrent calls share its turn. A session's own calls share its turn only while no other session is waiting; once another session is queued, the session's next call waits behind it, so a session with calls always in flight cannot keep the site to itself. An action that had to wait for its turn or its dwell time is checked again right before it runs: if a security check now holds the session, the site was stopped, or an operator sign-in started while it waited, the action does not reach the site and the agent gets the same answer as a call made at that moment (the same check runs after an entry warm-up, before the page the agent asked for).
- **Human dwell time (`human-dwell`).** Before each action on the site, a session waits until a random time between `min_ms` (600) and `max_ms` (2500) has passed since its previous action there. Its first action does not wait. To the agent, some actions take a little longer.
- **Warm-up entry (`entry-warmup`).** The first time a session goes straight to a deep page of the site, BrowserHive first opens the pack's entry `path` (`/`, on the `www.` host or the sign-in check host) with no referrer (`none`), the site's home page (`same-site`) or a search engine (`search`) as referrer, waits `dwell_ms` (2000) there, then opens the page the agent asked for. The warm-up uses at most half of the tool's timeout; a failed warm-up is logged (`entry warm-up failed`) and never fails the navigation. Script navigations away from the pack's domains during the warm-up are aborted; a server redirect from the entry path is followed like any redirect ([What guards cannot see](#what-guards-cannot-see)).
- **Humanized input (`humanize-input`, and `stealth-profile` with `humanize: true`).** Clicks, hovers, typing and scrolling on the site's pages move and type like a person, even in sessions launched without `humanize`. A template with stealth `off` cannot humanize: the strategy is ignored and BrowserHive logs it once (`humanize not forced`). The template page warns about it on the site's card ("Humanized input is not applied"), and the new-template wizard lists it under **What your sites need** with a one-click **Turn stealth on**. The template is still created with stealth off; its input on the site is then native.

### Writes, responses and keeping the sign-in fresh

- **Pace writes (`pace-writes`).** The pack's `pacing.rules` give some `write` guards a budget (so many per minute, hour, day or week). The budget belongs to the template, the account, and every session of the template shares it; it refills continuously. A write over budget waits for the next token when that is at most a minute away (plus up to 20 %, so writes do not tick like a clock) and is then handled as usual (allowed, warned or held for confirmation by the write policy); a write further over budget is cancelled. Both appear in the guard-hit log (`held`, `paced`), and a cancelled one adds the warning "A write was paced" (`SITE_PACED`) to its session. To the agent a write may take a little longer, or fail like a request the site did not answer. A new template's budgets are scaled down by `ramp-up` (above). A write that waits for its token takes it when it starts waiting; if that write then needs the operator's confirmation and is denied, the token is not given back (the budget errs on the side of fewer writes).
- **Detect device-bound sessions (`device-bound-session`).** When the site answers with a device-bound session header (DBSC: `Sec-Session-Registration` or `Sec-Session-Id`), the template's site is marked **Device-bound** on its Sites tab: the sign-in is tied to this machine's browser and will not survive being moved elsewhere. BrowserHive only reads the response headers; it never changes a request.
- **Keep the sign-in fresh (`keep-alive`).** BrowserHive visits the pack's `keeper.path` (else its sign-in check page) in its own background window every `interval_h` hours (default: the pack's `keeper.interval_hours`, else 24; ± 20 %), so sign-in cookies that refresh on use stay fresh while no agent uses the template. A visit is skipped when an agent session of the template loaded the site within the interval, and for a site that is signed out or held by a security check. Like a scheduled check, a stopped browser is started for the visit when a browser slot is free (it starts with no window, and the visit's window opens minimized in the background) and stops again when idle. A visit counts as a sign-in check when it tells something (it appears in the template's checks as `schedule`). Only `GET` requests are made, and the visit cannot leave the pack's domains by script. Visits respect the template's active hours: one that falls due outside the window happens within 20 minutes after the window opens; if the sites' windows never overlap, it is retried a day later.

### Stealth

`stealth-profile`, `single-focus` and `webrtc-policy` change what the site sees of the whole template: see [Site pack stealth strategies](stealth.md#site-pack-stealth-strategies).

## Navigation checks

For a site with an approved pack, a [health check](templates.md#health-checks) loads the pack's `probe` page in a background window of the template's browser, with `GET` only. During the check, any page load that leaves the pack's domains is aborted. First, when the pack lists sign-in cookie names and none of them is present, the site is signed out without loading anything. Otherwise the page is loaded (at most 20 seconds), and the first of these that holds decides:

| Result | Reason | When |
|---|---|---|
| ! check needed (`challenged`) | `challenge:<kind>` | A challenge matched. Never reported as signed out. |
| ✗ signed out (`signed_out`) | `redirect`, `marker`, `cookies_absent` | The page redirected to a signed-out address, shows the signed-out marker, or no sign-in cookie is left. |
| ✓ signed in (`signed_in`) | `landmark`, `no_redirect`, `no_redirect_settled` | The signed-in landmark is on the page, or the page stayed where it was asked to load or moved to a page below it, like LinkedIn's `/feed/` to `/feed/foryou/` (`no_redirect_settled`: it loaded and stayed put for a few seconds, a weaker sign). Sign-in cookies alone never count: a page that lands somewhere else on the site reads **Couldn't tell**. |
| ? couldn't tell (`inconclusive`) | `timeout`, `network`, `http_<status>`, `no_signal` | The page did not load in time, the network failed, the server answered an error, or nothing matched. |

Some sites send a signed-out browser to their sign-in page from page script after the page loaded, not with a redirect. For packs whose check uses redirects (`redirect`, `either`), BrowserHive waits for the check page to finish loading and then up to 4 seconds for such a move before deciding. An `either` check page that loaded and stayed put counts as signed in, with its own reason `no_redirect_settled`: it is a weaker sign, because a site that signs you out later, or only shows a sign-in box without changing the address, looks the same. The template page says so under the site's sign-in. One that never finished loading is "couldn't tell". Reddit's check works this way; a signed-in landmark for Reddit is still to be verified.

Selectors are only counted and texts only looked for; nothing from a pack is ever run in the page. A site without an approved pack keeps the cookie check of a generic site.

## What guards cannot see

The request guard sees what the browser driver routes. Some traffic is not routed, so no guard can stop it:

| Not seen | What packs do about it |
|---|---|
| **Redirect hops.** Only the first address of a redirect chain is routed. A redirect into a guarded address (`/go?to=/logout` answering `302 /logout`) is not stopped, and because `307` and `308` keep the method, that covers `POST` too. | Packs block the site's known open redirectors. The same limit applies to the pages BrowserHive loads by itself (health checks, keep-alive visits, warm-ups): a page leaving the pack's domains by script is aborted, but a server redirect's next hop is not, so pack paths must not redirect off the pack's domains. |
| **WebSockets.** Neither the connection nor its messages pass through BrowserHive's routing, so no guard sees them. | Element guards on the controls that send them. |
| **`javascript:` URLs.** Requests a page makes from one. Agents cannot open them: every non-web scheme is refused at the tools ([Security](security.md#agents-open-web-urls-only)). | — |
| **SharedWorker requests.** Dedicated workers and service workers are routed; shared workers are not. | Packs express such writes as element guards. |
| **Requests sent while a page closes.** A beacon or `keepalive` fetch sent from `pagehide` or `unload` while `close_tab` or `close_session` closes the page. Whether it reaches the site depends on timing. | Packs express writes a site sends on unload as element guards (the tool path). |
| **Service-worker attribution.** Some requests a service worker forwards are attributed to the page that triggered them instead of to the template's browser. The guard still applies; only the session recorded with the hit differs. | — |

Guards are not an egress firewall. They keep agents from signing the account out, changing its security settings and minting credentials **where a guard exists**. An agent can still act as the account wherever no guard stops it ([Security](security.md#site-packs)).

## Why a bad pack can do little harm

Packs come from a source you trust less than yourself (a release, later a registry), so the schema and BrowserHive bound what a pack can do even if its author is careless or hostile:

| Field | Bound |
|---|---|
| `sign_in.url` | `https` only, a host inside the pack's domains, a path with no query. Shown in full before a sign-in window opens. |
| `sign_in.post` | Guard globs inside the pack's domains, never a whole host, at most 4; never loaded or sent, only read to classify a version; any change relaxes rules, so a decoy address cannot make a guard on the real one pass as tightening. |
| `domains` | A domain another pack covers is refused, also for a local file you approve. A new domain is shown in the difference and needs your approval. |
| Pages BrowserHive loads by itself (the probe page) | A path inside the domains, no query, and never one of the pack's own sign-out, account, credential or destructive guards. During a check, page loads that leave the domains are aborted. |
| `guards` | The glob grammar only (`*` and `?`, at most 4 `*` and no `**` per pattern, matched without backtracking; an address over 16 384 characters is judged by its host alone, so a padded address cannot slip past a sign-out or account guard), hosts inside the pack's domains, at most 64. |
| `challenges` | Per-session and per-template bounds on Site checks; an agent's own navigation never triggers one. |
| `signed_in` | Cookie **names** only, never values. A re-login never starts on `challenged` or "couldn't tell". |
| Numbers (sessions, pacing, intervals) | Floors and ceilings built into BrowserHive; sessions never above the template's own cap. |
| Selectors | Standard CSS only, at most 200 characters and 4 selectors per list, one `:has(`, a short list of allowed pseudo-classes, no Playwright extensions; only ever counted, never run. |
| Any text | Control characters (terminal escape sequences) and Unicode bidi and format characters (which reverse or hide text) are refused in every field, and `verify` reports them. Text is shown as text, never as HTML or a one-click link, isolated from the text around it in the dashboard, with any such character replaced by `�` on the command line, and escaped in notifications; length limits on every field; 64 KiB per pack. |
| `strategies` | Only names built into this BrowserHive; an unknown name skips the version. |

No pack field is ever sent anywhere, and every address a pack can make the browser load is inside its approved domains.

## Verifying a pack

```bash
browserhive sitepacks verify ./example.com.json
```

`verify` works offline, without a server: it checks the file against the schema and every rule above and prints each problem with its field. A server refuses an invalid file the same way ([`SITE_PACK_INVALID`](../reference/errors.md#SITE_PACK_INVALID)).

Given a folder instead, `verify` checks a signed registry layout (`keys.json`, `index.json`, their `.sig` files and `packs/`, as published at `https://browserhive.ai/registry/v1/`) against the keys built into your release: the signatures, the expiry dates, and each pack file against the hash the index lists. How the registry is signed is described in [the registry's contributor guide](../contributing/registry.md).

## Writing a local pack

Write a pack for a site you use, or a stricter version of a bundled pack (a local file with the same id overrides it once approved). This example is for a fictional forum at `example.com`:

```json
{
  "schema": 1,
  "id": "example.com",
  "version": 1,
  "min_client": "0.3.0",
  "title": "Example Forum",
  "domains": ["example.com", "example.net"],
  "sign_in": {
    "url": { "host": "www.example.com", "path": "/login" },
    "human_only": false,
    "post": ["www.example.com/session", "www.example.com/two-factor*"]
  },
  "signed_in": {
    "probe": { "host": "www.example.com", "path": "/account/profile" },
    "kind": "redirect",
    "signed_out_redirects": ["www.example.com/login*"],
    "cookie_names": ["session_id"]
  },
  "guards": [
    { "id": "logout", "kind": "logout", "match": { "url": "www.example.com/logout" }, "action": "block" },
    { "id": "go-redirector", "kind": "logout", "match": { "url": "www.example.com/go*" }, "action": "block" },
    {
      "id": "api-tokens",
      "kind": "credential",
      "match": { "url": "www.example.com/settings/tokens*", "methods": ["POST", "DELETE"] },
      "action": "block"
    },
    {
      "id": "new-post",
      "kind": "write",
      "match": { "url": "www.example.com/api/posts*", "methods": ["POST"] },
      "action": "write_policy"
    }
  ],
  "element_guards": [
    {
      "id": "logout-link",
      "kind": "logout",
      "page": "www.example.com/*",
      "target": { "selector": "a[href^=\"/logout\"]" },
      "action": "block",
      "request_guard": "logout"
    },
    {
      "id": "publish-button",
      "kind": "write",
      "page": "www.example.com/compose*",
      "target": { "role": "button", "name": "Publish" },
      "action": "write_policy",
      "request_guard": "new-post"
    }
  ],
  "write_policy": {
    "default": "confirm",
    "stance": "writes_restricted",
    "clause": {
      "quote": "You may not post content by automated means.",
      "url": "https://www.example.com/terms",
      "checked": "2026-11-01"
    }
  },
  "challenges": [
    { "id": "verify", "kind": "checkpoint", "match": { "url": "www.example.com/verify*" }, "action": "attention" },
    { "id": "suspended", "kind": "locked", "match": { "title_contains": "Account suspended" }, "action": "stop" }
  ],
  "verified": { "guards": "2026-11-01", "signed_in": "2026-11-01" }
}
```

Tips:

- Give every element guard the request guard that enforces it on the network (`request_guard`); `verify` warns when one has none.
- Guard the site's open redirectors (`/go*` above): a redirect into a guarded address is not seen ([above](#what-guards-cannot-see)).
- The probe page must not be one of your own sign-out, account, credential or destructive guards.
- List in `sign_in.post` every address the sign-in posts to (read the form's `action`, or watch DevTools › Network while signing in), later steps such as two-factor included: a guard on an address you left out classifies as tightening. Leave `post` out if you are not sure; then every blocking guard on the sign-in host waits for you. `verify` warns when one of your own `block` or `confirm` guards covers a listed address (agents would be stopped from signing in there).
- Raise `version` with every change you want to show as a new version, and run `verify` before `reload`.
- Record in `verified` only what you checked against the live site.

## Bundled packs

BrowserHive ships packs for popular sites. Every field in them was checked against the live site; a field that can only be checked from a signed-in account and was not, is left out rather than guessed, and each pack's `verified` dates say what was checked and when. `browserhive sitepacks list --source bundled` lists the ones your release has.

The first bundled packs were checked on 2026-11-16 without signing in: sign-in pages and signed-out redirects were observed in a fresh browser, guards and terms come from the sites' official pages. What only a signed-in account can confirm (a signed-in landmark, write endpoints, pacing numbers) is not in them yet; later pack versions add it, and each arrives as a pending update for you to approve.

| Pack | Domains | Probe (signed out → redirect) | Sign in by hand only | Terms → default write policy | Notes |
|---|---|---|---|---|---|
| Google | `google.com` | `myaccount.google.com/` | yes | restricted → warn | account, security, app-password, device and deletion pages blocked; device binding (DBSC on Windows) listed |
| LinkedIn | `linkedin.com`, `licdn.com` | `www.linkedin.com/feed/` | no | prohibited → confirm | headed browser preferred |
| Reddit | `reddit.com`, `redd.it` | `www.reddit.com/settings/account` (`either`) | no | prohibited → confirm | headed browser preferred; the redirect happens after the page loads (see [Navigation checks](#navigation-checks)); no logout guard yet |
| Facebook | `facebook.com`, `fbcdn.net` | `www.facebook.com/settings` | no | prohibited → confirm | |
| Instagram | `instagram.com`, `cdninstagram.com` | `www.instagram.com/accounts/edit/` | no | prohibited → confirm | |
| X | `x.com`, `twitter.com`, `twimg.com` | `x.com/settings/account` | no | prohibited → confirm | headed browser preferred |
| GitHub | `github.com` | `github.com/settings/profile` | no | allowed → allow | token, SSH key and OAuth app pages are `credential` guards; the sign-in form's post addresses are listed (`/session`, `/sessions/*`), so routine guards on `github.com` tighten |
| Indeed | `indeed.com` | `myjobs.indeed.com/` | no | writes restricted → confirm | headed browser preferred |
| Glassdoor | `glassdoor.com` | `www.glassdoor.com/member/profile` | no | prohibited → confirm | signs in through Indeed; headed browser preferred; no logout guard yet |
| Microsoft account | `microsoft.com`, `live.com`, `microsoftonline.com` | `account.microsoft.com/` | no | restricted → warn | headed browser preferred; security pages are guarded (opening them forces a fresh sign-in) |

Only GitHub lists `sign_in.post` so far (its sign-in form's `action`, observed signed out on 2026-11-17); the other packs leave it out until the addresses their sign-in posts to are confirmed while signing in, so every blocking guard on their sign-in host classifies **Can stop the site**. Packs without write guards (all of these for now) leave the write policy with nothing to act on. YouTube is not bundled yet: its signed-in check could not be confirmed without an account. Besides the packs, every template browser blocks the OAuth consent screens and approvals of Google, GitHub (authorize and device approval) and Microsoft (Entra admin consent, Microsoft account consent), so an agent cannot grant a third-party app access to the account.

## Commands and API

| Task | Command line | REST (`/api/v1`) |
|---|---|---|
| List packs, pending updates and local files | `sitepacks list [--source …] [--pending]` | `GET /site-packs` |
| Show one pack | `sitepacks show <pack>` | `GET /site-packs/{pack}` |
| Show a difference, classified | `sitepacks diff <pack> [--to <version\|local>]` | `GET /site-packs/{pack}/diff?to=…` |
| The strategies BrowserHive knows, with each parameter's default, bounds and safe direction | `sitepacks show <pack>` (the pack's strategies) | `GET /site-packs/strategies` |
| Apply, reject, revert | `sitepacks apply\|reject\|revert <pack>` | `POST /site-packs/{pack}/apply`, `/reject`, `/revert` |
| Pin, follow | `sitepacks pin\|unpin\|follow <pack> …` | `PUT /site-packs/{pack}/pin`, `/follow` |
| Approve a local file | `sitepacks approve-local <pack>` | `POST /site-packs/{pack}/approve-local` `{sha256}` |
| Enable, disable | `sitepacks enable\|disable <pack>` (disable asks first, or `--yes`) | `POST /site-packs/{pack}/enable`, `/disable` |
| Read the folder again | `sitepacks reload` | `POST /site-packs/reload` |
| Import one pack file | `sitepacks import <file>` | `POST /site-packs/import` `{text}` (the file's exact text) or `{pack}` (a parsed pack, stored re-serialized) |
| Check the registry now | `sitepacks check` | `POST /site-packs/check` |
| Download & review one version, or every listed version | `sitepacks download <pack> [version]`, `sitepacks download --all` | `POST /site-packs/{pack}/download` `{version}`, `POST /site-packs/download-all` |
| Export the signed folder, import one | `sitepacks export <dir>`, `sitepacks import <dir>` | `GET /site-packs/export`, `POST /site-packs/import` `{files, name}` (base64 by path) |
| Check a file or a signed folder offline | `sitepacks verify <file\|dir>` | — |
| Decisions and guard hits (identical hits within a second are recorded once; confirmations always) | — | `GET /site-packs/changes`, `GET /site-packs/guard-hits` (`since`/`until` inclusive) |

The routes need the scopes `sitepacks:read` or `sitepacks:write` ([REST reference](../reference/api.md#site-packs)). The commands are described in the [CLI guide](cli.md#sitepacks).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| [`sitePacks`](../reference/configuration.md#sitePacks) | `true` | `false` turns packs off: every template site is a generic site. |
| [`sitePacksDir`](../reference/configuration.md#sitePacksDir) | `<data-dir>/site-packs/local` | The local folder for your own pack files and signed folders. |
| [`sitePacksUpdateCheck`](../reference/configuration.md#sitePacksUpdateCheck) | `true` | The daily check of the signed index. `false`: no request to the registry at all. |
| [`sitePacksAutoUpdate`](../reference/configuration.md#sitePacksAutoUpdate) | `false` | `true`: followed packs' registry versions that only tighten rules are applied without you ([Automatic updates](#automatic-updates)). |
| [`sitePacksUrl`](../reference/configuration.md#sitePacksUrl) | `https://browserhive.ai/registry/v1/` | The registry folder, or a [mirror](#mirrors). |
