/** @module app/site-packs/client/client-ops — what the registry client does with a verified index (spec 13 §9.7, §10.3 step 3, §10.5, §10.6): records its candidates, applies revocations (D52), auto-updates followed packs, **Download & review** of exactly one file, **Download all**, signed imports (a request or the local folder) and the export of the held layout. Every pack file is trusted only through the index's `sha256` and `size`. */

import type {
  SitePackCheckOff,
  SitePackDownloadAllResponse,
  SitePackDownloadResponse,
  SitePackExportResponse,
  SitePackImportResponse,
} from '@browserhive/contracts/http';
import type { RegistryIndexV1, RegistryPackVersion } from '@browserhive/contracts/site-packs';
import type { z } from 'zod';
import { autoApplyHold } from '../../../domain/site-packs/auto-update.ts';
import { bestUsable } from '../../../domain/site-packs/registry-listing.ts';
import { serializeError } from '../../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../../ports/logger.ts';
import type { SitePackChangeRecord } from '../../../ports/persistence/site-packs.ts';
import type { SkippedPackVersion, SourcePackVersion } from '../../../ports/site-packs.ts';
import type { RegistryCore } from '../registry-core.ts';
import {
  downloadFailed,
  notListed,
  packInvalid,
  packNotFound,
  type RegistryUnavailableReason,
  registryUnavailable,
} from '../registry-errors.ts';
import type { HeldIndex } from '../registry-types.ts';
import { followEffective } from '../views.ts';
import type { Acceptance, LayoutFiles } from './accept.ts';
import { acceptLayout } from './accept.ts';
import { listingOf, markDownloaded, promoteHeld, SYSTEM, syncAvailable } from './candidates.ts';
import type { ClientRecord, RegistryFloorsRecord } from './client-state.ts';
import type { HeldState, RegistryClientDeps } from './client-types.ts';
import { PACK_READ_MAX } from './held.ts';

/** What the operations need from the client. */
export interface ClientContext {
  readonly deps: RegistryClientDeps;
  readonly log: Logger;
  held(): HeldIndex | null;
  heldState(): HeldState | null;
  floors(): RegistryFloorsRecord;
  checkOff(): z.infer<typeof SitePackCheckOff> | null;
  record(): ClientRecord;
  setRecord(record: ClientRecord): Promise<void>;
  adopt(
    acceptance: Extract<Acceptance, { kind: 'updated' | 'not_modified' }>,
    files: LayoutFiles,
    from: { readonly origin: HeldState['origin']; readonly name: string | null },
  ): Promise<void>;
}

// --- after an accepted index ------------------------------------------------------------------

/** Records the index's candidates and marks those already held verified as downloaded. */
export async function recordCandidates(
  core: RegistryCore,
  index: RegistryIndexV1,
  importedShas?: ReadonlySet<string>,
): Promise<{ available: number; fresh: readonly SitePackChangeRecord[] }> {
  const synced = await syncAvailable(core, {
    index,
    ...(importedShas !== undefined && { importedShas }),
  });
  await core.refresh();
  await promoteHeld(core);
  return synced;
}

/** Candidates, `site_pack.pending` for followed packs, revocations, then auto-update. */
export async function afterAccept(
  ctx: ClientContext,
  options: { readonly autoUpdate: boolean; readonly importedShas?: ReadonlySet<string> },
): Promise<{ available: number }> {
  const held = ctx.held();
  if (held === null) return { available: 0 };
  const { registry, bus } = ctx.deps;
  const synced = await registry.mutate((core) =>
    recordCandidates(core, held.index, options.importedShas),
  );
  const snapshot = registry.snapshotNow();
  for (const row of synced.fresh) {
    const entry = snapshot.packs.get(row.packId);
    if (entry === undefined || !followEffective(entry) || row.toVersion === null) continue;
    bus?.publish('site_pack.pending', {
      type: 'site_pack.pending',
      pack_id: row.packId,
      to_version: row.toVersion,
      classification: row.classification,
    });
  }
  await applyRevocations(ctx);
  if (options.autoUpdate && !held.stale) await autoUpdate(ctx);
  return { available: synced.available };
}

/**
 * A version the held index marks `revoked: true` that is approved (same bytes) or pending goes to
 * `SitePackRegistry.revoke()` once (spec 13 §9.7, D52): a tightening or neutral fallback applies at
 * once, a looser one waits as a `revoked` decision, no fallback keeps it in force and reports it.
 */
export async function applyRevocations(ctx: ClientContext): Promise<void> {
  const held = ctx.held();
  if (held === null) return;
  const { registry } = ctx.deps;
  const record = ctx.record();
  const handled = new Set(record.revocations);
  const listed = new Set<string>();
  for (const pack of held.index.packs) {
    for (const entry of pack.versions) {
      if (entry.revoked !== true) continue;
      const key = `${pack.id}@${entry.v}:${entry.sha256}`;
      listed.add(key);
      if (handled.has(key)) continue;
      const state = registry.snapshotNow().packs.get(pack.id);
      if (state === undefined) continue;
      const approved =
        state.state?.approvedVersion === entry.v &&
        state.state.approvedSha256 === entry.sha256 &&
        state.state.approvedSource !== 'local';
      const pending = state.pending.some(
        (p) => p.toVersion === entry.v && p.toSha256 === entry.sha256,
      );
      if (!approved && !pending) continue;
      const result = await registry.revoke(pack.id, entry.v, SYSTEM);
      ctx.log.info('pack version revoked', {
        packId: pack.id,
        version: entry.v,
        outcome: result.outcome,
      });
      if (result.outcome !== 'not_in_force') handled.add(key);
    }
  }
  const revocations = [...handled].filter((k) => listed.has(k));
  if (revocations.join() !== record.revocations.join()) {
    await ctx.setRecord({ ...ctx.record(), revocations });
  }
}

/**
 * Auto-update (`sitePacksAutoUpdate`, spec 13 §9.7): registry candidates of followed, unpinned,
 * approved packs are downloaded and applied by `browserhive` when they only tighten rules (or
 * change nothing), add no domain and stay under the D74 cap; the others wait.
 */
async function autoUpdate(ctx: ClientContext): Promise<void> {
  const { registry } = ctx.deps;
  for (const entry of [...registry.snapshotNow().packs.values()]) {
    const approved = entry.approved;
    if (approved === null || !followEffective(entry) || entry.state?.pinnedVersion != null)
      continue;
    if (entry.effective?.localOverride === true) continue;
    const row = entry.pending.find(
      (p) => p.source === 'remote' && p.classification !== 'revoked' && p.toVersion !== null,
    );
    if (row === undefined || row.toVersion === null) continue;
    const version = row.toVersion;
    try {
      const copy = await ensureDownloaded(ctx, entry.packId, row);
      if (copy === null) continue;
      const fresh = registry.snapshotNow().packs.get(entry.packId);
      const decided = fresh?.pending.find((p) => p.eventId === row.eventId);
      if (decided === undefined || decided.decision !== 'downloaded') continue;
      const hold = autoApplyHold(
        approved.pack,
        copy.pack,
        decided.classification,
        decided.newDomains,
      );
      if (hold !== null) {
        ctx.log.info('auto-update waits', { packId: entry.packId, version, hold });
        continue;
      }
      await registry.apply(entry.packId, version, SYSTEM, { auto: true });
      ctx.log.info('pack auto-updated', { packId: entry.packId, version });
    } catch (err) {
      ctx.log.warn('auto-update skipped', {
        packId: entry.packId,
        version,
        err: serializeError(err),
      });
    }
  }
}

/** The verified copy of a pending registry row, fetching it when BrowserHive does not hold it. */
async function ensureDownloaded(
  ctx: ClientContext,
  packId: string,
  row: SitePackChangeRecord,
): Promise<SourcePackVersion | null> {
  const held = ctx.held();
  const entry = held === null ? null : findListed(held.index, packId, row.toVersion ?? 0);
  if (entry === null || entry.sha256 !== row.toSha256) return null;
  const copy = await fetchVerified(ctx, packId, entry);
  await ctx.deps.registry.mutate(async (core) => {
    const current = core.snapshot().packs.get(packId);
    const pending = current?.pending.find((p) => p.eventId === row.eventId);
    if (current !== undefined && pending?.decision === 'available') {
      await markDownloaded(core, current, pending, copy);
    }
  });
  return copy;
}

// --- downloads -------------------------------------------------------------------------------

/** Refuses a download that would need the registry when it cannot be used. */
function assertRegistryUsable(ctx: ClientContext): HeldIndex {
  const off = ctx.checkOff();
  if (off !== null) throw registryUnavailable(off as RegistryUnavailableReason);
  const held = ctx.held();
  if (held === null) throw registryUnavailable('no_index');
  if (held.stale) throw registryUnavailable('stale');
  return held;
}

function findListed(
  index: RegistryIndexV1,
  packId: string,
  version: number,
): RegistryPackVersion | null {
  return listingOf(index, packId)?.versions.find((v) => v.v === version) ?? null;
}

/** Fetches exactly `entry.path`, verifies it against the entry and caches it (`cache/remote`). */
async function fetchVerified(
  ctx: ClientContext,
  packId: string,
  entry: RegistryPackVersion,
): Promise<SourcePackVersion> {
  const { deps } = ctx;
  const held = await deps.registry.signedCopy(packId, entry.sha256);
  if (held !== null) return held;
  const result = await deps.fetcher.fetch({ path: entry.path, maxBytes: PACK_READ_MAX });
  if (result.kind !== 'ok') {
    const reason = result.kind === 'failed' ? result.reason : 'not_modified';
    const detail = result.kind === 'failed' ? result.detail : 'unexpected 304';
    throw downloadFailed(packId, entry.v, reason, detail);
  }
  const checked = deps.verifier.verifyListedPack(result.bytes, packId, entry, deps.binaryVersion);
  if (!checked.ok)
    throw downloadFailed(packId, entry.v, checked.error.reason, checked.error.detail);
  if ('outOfRange' in checked.value) throw notListed(packId, entry.v);
  const copy = checked.value;
  await deps.registry.cachePut('remote', packId, copy.sha256, copy.bytes);
  return copy;
}

async function audit(
  ctx: ClientContext,
  by: string,
  action: string,
  packId: string | null,
  details: Record<string, string | number | boolean | null>,
): Promise<void> {
  const { deps } = ctx;
  await deps.repos.operatorActions.append({
    eventId: deps.ids.eventId(),
    principalId: by,
    action,
    resourceKind: 'site_pack',
    resourceId: packId,
    details,
    occurredAt: deps.clock.now(),
  });
}

/** **Download & review**: exactly the version the verified index lists as available. */
export async function download(
  ctx: ClientContext,
  packId: string,
  version: number,
  by: string,
): Promise<SitePackDownloadResponse> {
  const held = assertRegistryUsable(ctx);
  const { registry, binaryVersion } = ctx.deps;
  const listing = listingOf(held.index, packId);
  if (listing === undefined && registry.get(packId) === null) throw packNotFound(packId);
  const best = listing === undefined ? null : bestUsable(listing, binaryVersion);
  if (best === null || best.v !== version) throw notListed(packId, version);
  const pending = registry
    .snapshotNow()
    .packs.get(packId)
    ?.pending.find((p) => p.toSha256 === best.sha256);
  if (pending === undefined) throw notListed(packId, version);
  let copy: SourcePackVersion;
  try {
    copy = await fetchVerified(ctx, packId, best);
  } catch (err) {
    await audit(ctx, by, 'site_pack.download', packId, {
      version,
      sha256: best.sha256,
      outcome: 'refused',
      reason: err instanceof Error ? err.message.slice(0, 300) : 'failed',
    });
    throw err;
  }
  await registry.mutate(async (core) => {
    const entry = core.snapshot().packs.get(packId);
    const row = entry?.pending.find((p) => p.eventId === pending.eventId);
    if (entry !== undefined && row?.decision === 'available')
      await markDownloaded(core, entry, row, copy);
  });
  await audit(ctx, by, 'site_pack.download', packId, {
    version,
    sha256: copy.sha256,
    outcome: 'ok',
  });
  const view = registry.get(packId);
  if (view === null) throw packNotFound(packId);
  return { view, diff: await registry.diff(packId, { to: version }) };
}

/** **Download all**: every listed, non-revoked version BrowserHive lacks, of every pack. */
export async function downloadAll(
  ctx: ClientContext,
  by: string,
): Promise<SitePackDownloadAllResponse> {
  const held = assertRegistryUsable(ctx);
  const { registry } = ctx.deps;
  const downloaded: SitePackDownloadAllResponse['downloaded'] = [];
  const refused: SitePackDownloadAllResponse['refused'] = [];
  let heldCount = 0;
  for (const pack of held.index.packs) {
    for (const entry of pack.versions) {
      if (entry.revoked === true) continue;
      const have = await registry.signedCopy(pack.id, entry.sha256);
      if (have !== null) {
        heldCount += 1;
        continue;
      }
      try {
        const copy = await fetchVerified(ctx, pack.id, entry);
        downloaded.push({ pack_id: pack.id, version: entry.v, sha256: copy.sha256 });
      } catch (err) {
        const details = errorDetails(err);
        // A version for another BrowserHive is fetched (so the request set reveals nothing) but not kept.
        if (details.reason !== 'other_client')
          refused.push({ pack_id: pack.id, version: entry.v, ...details });
      }
    }
  }
  await registry.mutate(async (core) => {
    await promoteHeld(core);
  });
  await audit(ctx, by, 'site_pack.download', null, {
    all: true,
    downloaded: downloaded.length,
    refused: refused.length,
  });
  return {
    downloaded,
    held: heldCount,
    refused,
    pending_count: registry.list().pending_count,
  };
}

function errorDetails(err: unknown): { reason: string; detail: string } {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'SITE_PACK_NOT_LISTED'
  ) {
    return { reason: 'other_client', detail: 'needs another BrowserHive' };
  }
  const details =
    typeof err === 'object' && err !== null && 'details' in err && typeof err.details === 'object'
      ? (err.details as Record<string, unknown>)
      : {};
  return {
    reason: typeof details['reason'] === 'string' ? details['reason'] : 'failed',
    detail: typeof details['detail'] === 'string' ? details['detail'] : serializeError(err).message,
  };
}

// --- imports and export ------------------------------------------------------------------------

const LAYOUT_NAMES = ['keys.json', 'keys.json.sig', 'index.json', 'index.json.sig'] as const;

/**
 * Verifies a signed layout with the pinned keys exactly as a fetch is (floors included; the held
 * index again is `not_modified`), adopts its index, caches its verified pack files (`cache/import`)
 * and queues the candidates (spec 13 §10.5). @throws `SITE_PACK_INVALID`, `SITE_PACKS_REGISTRY_UNAVAILABLE`.
 */
export async function importFiles(
  ctx: ClientContext,
  files: ReadonlyMap<string, Uint8Array>,
  how: { readonly origin: 'import' | 'local'; readonly name: string; readonly by?: string },
): Promise<SitePackImportResponse> {
  const { deps } = ctx;
  const off = ctx.checkOff();
  if (off === 'packs_off' || off === 'no_trust_root') throw registryUnavailable(off);
  const missing = LAYOUT_NAMES.filter((n) => !files.has(n));
  if (missing.length > 0) {
    throw packInvalid(
      how.origin,
      missing.map((n) => ({ path: n, message: 'missing from the layout' })),
    );
  }
  const layout: LayoutFiles = {
    keys: files.get('keys.json') ?? new Uint8Array(),
    keysSig: files.get('keys.json.sig') ?? new Uint8Array(),
    index: files.get('index.json') ?? new Uint8Array(),
    indexSig: files.get('index.json.sig') ?? new Uint8Array(),
  };
  const heldState = ctx.heldState();
  const acceptance = acceptLayout({
    verifier: deps.verifier,
    files: layout,
    heldIndexSha256: heldState === null ? null : deps.sha256(heldState.files.index),
    sha256: deps.sha256,
    floors: ctx.floors(),
    now: deps.clock.now(),
  });
  if (acceptance.kind === 'refused' || acceptance.kind === 'stale') {
    const { file, reason, detail } =
      acceptance.kind === 'refused'
        ? acceptance.refusal
        : { file: 'index.json', reason: 'expired', detail: 'the index has expired' };
    throw packInvalid(how.origin, [{ path: file, message: `${reason}: ${detail}` }]);
  }
  if (acceptance.kind === 'updated') {
    await ctx.adopt(acceptance, layout, { origin: how.origin, name: how.name });
  }
  const index = acceptance.index.value;
  const imported: SitePackImportResponse['imported'] = [];
  const shas = new Set<string>();
  for (const pack of index.packs) {
    const best = bestUsable(pack, deps.binaryVersion);
    for (const entry of pack.versions) {
      const bytes = files.get(entry.path);
      if (bytes === undefined) {
        if (best?.sha256 === entry.sha256) {
          imported.push({
            pack_id: pack.id,
            version: entry.v,
            state: 'available',
            sha256: entry.sha256,
          });
        }
        continue;
      }
      const checked = deps.verifier.verifyListedPack(bytes, pack.id, entry, deps.binaryVersion);
      if (!checked.ok) {
        imported.push({
          pack_id: pack.id,
          version: entry.v,
          state: 'refused',
          sha256: entry.sha256,
        });
        continue;
      }
      if ('outOfRange' in checked.value) {
        imported.push({
          pack_id: pack.id,
          version: entry.v,
          state: 'other_client',
          sha256: entry.sha256,
        });
        continue;
      }
      await deps.registry.cachePut('import', pack.id, entry.sha256, checked.value.bytes);
      shas.add(entry.sha256);
      imported.push({ pack_id: pack.id, version: entry.v, state: 'current', sha256: entry.sha256 });
    }
  }
  await afterAccept(ctx, { autoUpdate: false, importedShas: shas });
  // A listed version is `downloaded` when it is now a pending candidate.
  const snapshot = deps.registry.snapshotNow();
  const pendingShas = new Set(
    [...snapshot.packs.values()].flatMap((e) =>
      e.pending.filter((p) => p.decision === 'downloaded').map((p) => p.toSha256),
    ),
  );
  for (const item of imported) {
    if (item.state === 'current' && pendingShas.has(item.sha256)) item.state = 'downloaded';
  }
  if (how.by !== undefined) {
    await audit(ctx, how.by, 'site_pack.import', null, {
      layout: true,
      name: how.name,
      outcome: acceptance.kind,
      index_version: index.version,
      files: files.size,
    });
  }
  await deps.registry.mutate(async () => undefined);
  return {
    imported,
    layout: {
      outcome: acceptance.kind,
      index_version: index.version,
      keys_version: acceptance.keys.value.version,
      signed_by: acceptance.index.signedBy,
    },
  };
}

/** Signed layouts of the local folder (spec 13 §10.5 (a)): verified like an import; refusals are reported, never thrown. */
export async function importLocalLayouts(
  ctx: ClientContext,
  paths: readonly string[],
): Promise<SkippedPackVersion[]> {
  const read = ctx.deps.readFolder;
  const skips: SkippedPackVersion[] = [];
  if (read === undefined) return skips;
  for (const dir of paths) {
    try {
      const files = await readLayoutFolder(read, dir);
      if (files === null) {
        skips.push(layoutSkip(dir, 'not a signed layout: keys.json is missing'));
        continue;
      }
      await importFiles(ctx, files, { origin: 'local', name: dir });
    } catch (err) {
      skips.push(layoutSkip(dir, serializeError(err).message));
    }
  }
  return skips;
}

function layoutSkip(dir: string, detail: string): SkippedPackVersion {
  return { packId: dir, version: null, reason: 'layout_refused', detail };
}

async function readLayoutFolder(
  read: NonNullable<RegistryClientDeps['readFolder']>,
  dir: string,
): Promise<Map<string, Uint8Array> | null> {
  const files = new Map<string, Uint8Array>();
  for (const name of LAYOUT_NAMES) {
    const bytes = await read(dir, name, 512 * 1024);
    if (bytes === null) {
      if (name === 'keys.json') return null;
      continue;
    }
    files.set(name, bytes);
  }
  const indexBytes = files.get('index.json');
  if (indexBytes === undefined) return files;
  let index: { packs?: { versions?: { path?: unknown }[] }[] };
  try {
    index = JSON.parse(new TextDecoder().decode(indexBytes));
  } catch {
    return files;
  }
  for (const pack of index.packs ?? []) {
    for (const version of pack.versions ?? []) {
      const path = version.path;
      if (typeof path !== 'string' || !/^packs\/[a-z0-9.-]+\/[0-9a-f]{64}\.json$/.test(path))
        continue;
      const bytes = await read(dir, path, PACK_READ_MAX + 1);
      if (bytes !== null) files.set(path, bytes);
    }
  }
  return files;
}

/** The held layout and every listed version BrowserHive holds verified, base64 by path. */
export async function exportLayout(ctx: ClientContext): Promise<SitePackExportResponse> {
  const held = ctx.heldState();
  if (held === null) throw registryUnavailable('no_index');
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
  const files: Record<string, string> = {
    'keys.json': b64(held.files.keys),
    'keys.json.sig': b64(held.files.keysSig),
    'index.json': b64(held.files.index),
    'index.json.sig': b64(held.files.indexSig),
  };
  let packs = 0;
  for (const pack of held.index.packs) {
    for (const entry of pack.versions) {
      const copy = await ctx.deps.registry.signedCopy(pack.id, entry.sha256);
      if (copy === null) continue;
      files[entry.path] = b64(copy.bytes);
      packs += 1;
    }
  }
  return { files, index_version: held.index.version, keys_version: held.keys.version, packs };
}
