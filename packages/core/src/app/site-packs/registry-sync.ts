/** @module app/site-packs/registry-sync — what a load does besides reading files (spec 13 §9.6, §10.5, §11.8): records a newer bundled version of an approved pack once as a `downloaded` candidate with its field diff (superseding older ones), records `site_pack.local_override` when the local content in force changes, audits an operator's reload, imports unsigned packs, and summarises what waits for an operator for the update notification. */

import type { SitePackPendingEvent } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import { diffPacks, newDomains } from '../../domain/site-packs/diff.ts';
import { loadPackBytes } from '../../domain/site-packs/load.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { SitePackChangeRecord } from '../../ports/persistence/site-packs.ts';
import type { SitePackSource, SourceCatalog } from '../../ports/site-packs.ts';
import type { SitePackUpdatesFact } from '../events/catalog.ts';
import type { ResolvedPack } from './registry-build.ts';
import { auditPack, type RegistryCore } from './registry-core.ts';
import { packInvalid } from './registry-errors.ts';
import { pendingOf } from './registry-reads.ts';
import type { RegistrySnapshot, SourceStats } from './registry-types.ts';

/** The principal of automatic decisions (spec 13 §11.8). */
const SYSTEM = 'browserhive';

/**
 * Records candidates: a bundled version newer than an approved pack's is inserted once as
 * `downloaded` (unclassified until T3b); pending rows it replaces, or that are no longer newer than
 * the approved version, or whose bytes the release no longer ships, become `superseded`. Rejected,
 * reverted and approved candidates are never inserted again. Returns the `site_pack.pending` events.
 */
export async function syncCandidates(
  core: RegistryCore,
  resolved: readonly ResolvedPack[],
  _bundled: SourceCatalog,
): Promise<z.infer<typeof SitePackPendingEvent>[]> {
  const { repos, clock, ids } = core.deps;
  const pending = await repos.sitePackChanges.listPending();
  const events: z.infer<typeof SitePackPendingEvent>[] = [];
  for (const r of resolved) {
    const state = r.state;
    const approved = r.approved;
    if (state === null || approved === null || state.approvedVersion === null) continue;
    const candidate =
      r.bundled !== null &&
      r.bundled.sha256 !== state.approvedSha256 &&
      r.bundled.pack.version > state.approvedVersion
        ? r.bundled
        : null;
    const now = clock.now();
    for (const row of pending) {
      if (row.packId !== r.packId) continue;
      const stale =
        (row.toVersion !== null && row.toVersion <= state.approvedVersion) ||
        (row.source === 'bundled' && row.toSha256 !== candidate?.sha256);
      if (stale) await repos.sitePackChanges.decide(row.seq, 'superseded', SYSTEM, now);
    }
    if (candidate === null) continue;
    if (
      (await repos.sitePackChanges.findCandidate(r.packId, candidate.sha256, 'bundled')) !== null
    ) {
      continue;
    }
    const record: SitePackChangeRecord = {
      seq: 0,
      eventId: ids.eventId(),
      packId: r.packId,
      fromVersion: state.approvedVersion,
      toVersion: candidate.pack.version,
      toSha256: candidate.sha256,
      source: 'bundled',
      classification: 'unclassified',
      newDomains: [...newDomains(approved.pack, candidate.pack)],
      notes: null,
      diff: diffPacks(approved.pack, candidate.pack),
      decision: 'downloaded',
      decidedBy: null,
      createdAt: now,
      decidedAt: null,
    };
    await repos.sitePackChanges.insert(record);
    core.log.info('site pack update pending', {
      packId: r.packId,
      from: state.approvedVersion,
      to: candidate.pack.version,
    });
    events.push({
      type: 'site_pack.pending',
      pack_id: r.packId,
      to_version: candidate.pack.version,
      classification: 'unclassified',
    });
  }
  return events;
}

/** `site_pack.local_override` (on load) for every pack whose local content in force changed. */
export async function recordLocalOverrides(
  core: RegistryCore,
  previous: RegistrySnapshot,
  next: RegistrySnapshot,
): Promise<void> {
  for (const entry of next.packs.values()) {
    const now = entry.effective;
    if (now === null || !now.localOverride) continue;
    const before = previous.packs.get(entry.packId)?.effective ?? null;
    if (before?.localOverride === true && before.sha256 === now.sha256) continue;
    await auditPack(core.deps.repos, core, SYSTEM, 'site_pack.local_override', entry.packId, {
      sha256: now.sha256,
      version: now.version,
      path: entry.local?.path ?? null,
      overrides_version: entry.state?.approvedVersion ?? null,
    });
  }
}

/** `site_pack.reload` for an operator's reload. */
export async function auditReload(
  core: RegistryCore,
  by: string,
  stats: readonly SourceStats[],
): Promise<void> {
  const details: Record<string, number> = {};
  for (const s of stats) {
    details[`${s.source}_loaded`] = s.loaded;
    details[`${s.source}_skipped`] = s.skipped.length;
  }
  await auditPack(core.deps.repos, core, by, 'site_pack.reload', null, details);
}

/**
 * Stores one unsigned pack in `sitePacksDir` as `<id>.json` (`POST /site-packs/import`); it then
 * needs approval like any local file. @throws `SITE_PACK_INVALID`.
 */
export async function importPack(
  core: RegistryCore,
  raw: unknown,
  by: string,
): Promise<{ packId: string; version: number; sha256: string }> {
  const text = raw === undefined ? undefined : JSON.stringify(raw, null, 2);
  if (text === undefined) throw packInvalid('import', [{ path: 'pack', message: 'missing' }]);
  const bytes = new TextEncoder().encode(`${text}\n`);
  const loaded = loadPackBytes(bytes, {
    origin: 'import',
    binaryVersion: core.deps.binaryVersion,
    expectedId: null,
  });
  if (!loaded.ok) throw packInvalid('import', loaded.error.issues);
  const { pack, sha256 } = loaded.value;
  const path = await core.deps.localWriter.write(pack.id, bytes);
  await auditPack(core.deps.repos, core, by, 'site_pack.import', pack.id, {
    version: pack.version,
    sha256,
    path,
  });
  core.log.info('site pack imported', { packId: pack.id, version: pack.version, path });
  return { packId: pack.id, version: pack.version, sha256 };
}

/** What waits for an operator (the `site_pack.update_pending` notification, spec 13 §8.6). */
export function updatesFact(snapshot: RegistrySnapshot, at: number): SitePackUpdatesFact {
  return {
    at,
    items: pendingOf(snapshot).map((p) =>
      p.kind === 'candidate'
        ? {
            pack_id: p.packId,
            title: p.title,
            from_version: p.fromVersion,
            to_version: p.toVersion,
            local: null,
          }
        : {
            pack_id: p.packId,
            title: p.title,
            from_version: null,
            to_version: p.version,
            local: p.state,
          },
    ),
  };
}

/** Loads one source; a failure keeps `previous` (D-22) and is logged. */
export async function loadCatalog(
  source: SitePackSource,
  previous: SourceCatalog,
  signal: AbortSignal,
  log: Logger,
): Promise<SourceCatalog> {
  try {
    const result = await source.load(signal);
    if (result.ok) return result.value;
    log.warn('site pack source failed', { source: source.id, detail: result.error.message });
  } catch (err) {
    log.warn('site pack source failed', { source: source.id, err: serializeError(err) });
  }
  return previous;
}

/** What one load of a source found. */
export function sourceStats(catalog: SourceCatalog): SourceStats {
  return {
    source: catalog.source,
    loaded: catalog.packs.length,
    skipped: catalog.skipped,
    signedLayouts: catalog.signedLayouts,
  };
}
