/** @module app/site-packs/client/candidates — what a verified index makes pending (spec 13 §10.3 step 3, §10.6): per pack the highest non-revoked version this binary may use, newer than the approved one (or than the bundled offer of a pack nothing approved), becomes one `available` row with the publisher's notes; a version BrowserHive already holds verified is recorded `downloaded`, classified against the approved version; older registry rows are superseded. A version an operator rejected or approved never comes back. Run inside `SitePackRegistry.mutate`. */

import type { RegistryIndexPack, RegistryIndexV1 } from '@browserhive/contracts/site-packs';
import { newDomains } from '../../../domain/site-packs/diff.ts';
import { bestUsable } from '../../../domain/site-packs/registry-listing.ts';
import type {
  SitePackChangeRecord,
  SitePackSourceId,
} from '../../../ports/persistence/site-packs.ts';
import type { SourcePackVersion } from '../../../ports/site-packs.ts';
import { readSigned } from '../registry-build.ts';
import { classifyForRow, usageOf } from '../registry-classify.ts';
import type { RegistryCore } from '../registry-core.ts';
import type { PackEntry } from '../registry-types.ts';

/** The principal of automatic decisions (spec 13 §11.8). */
export const SYSTEM = 'browserhive';

/** Decisions after which the same bytes are never offered again. */
const FINAL: ReadonlySet<string> = new Set(['approved', 'auto', 'rejected']);

/** The registry-signed sources. */
function signedSource(source: SitePackSourceId): source is 'remote' | 'import' {
  return source === 'remote' || source === 'import';
}

/** The version a candidate must beat: the approved one, else the bundled offer, else none. */
function baseline(entry: PackEntry | undefined): number {
  return entry?.state?.approvedVersion ?? entry?.offer?.pack.version ?? 0;
}

/** Inputs of {@link syncAvailable}. */
export interface SyncInput {
  readonly index: RegistryIndexV1;
  /** The notes and source of new rows: `remote` (a fetch) or `import` for versions an import holds. */
  readonly importedShas?: ReadonlySet<string>;
}

/** What {@link syncAvailable} recorded. */
export interface SyncResult {
  /** Listed versions newer than the approved ones (all packs). */
  readonly available: number;
  /** Rows inserted now (for `site_pack.pending`). */
  readonly fresh: readonly SitePackChangeRecord[];
}

/** Records the index's candidates; see the module. */
export async function syncAvailable(core: RegistryCore, input: SyncInput): Promise<SyncResult> {
  const snapshot = core.snapshot();
  const fresh: SitePackChangeRecord[] = [];
  let available = 0;
  for (const listing of input.index.packs) {
    const entry = snapshot.packs.get(listing.id);
    const best = bestUsable(listing, core.deps.binaryVersion);
    const pending = entry?.pending ?? [];
    const signedRows = pending.filter(
      (row) => signedSource(row.source) && row.classification !== 'revoked',
    );
    if (best === null || best.v <= baseline(entry)) {
      for (const row of signedRows) await supersede(core, row);
      continue;
    }
    available += 1;
    for (const row of signedRows) {
      if (row.toSha256 !== best.sha256) await supersede(core, row);
    }
    if (pending.some((row) => row.toSha256 === best.sha256)) continue;
    if (await decidedBefore(core, listing.id, best.sha256)) continue;
    const source = input.importedShas?.has(best.sha256) === true ? 'import' : 'remote';
    const row = await core.deps.repos.sitePackChanges.insert({
      seq: 0,
      eventId: core.deps.ids.eventId(),
      packId: listing.id,
      fromVersion: entry?.state?.approvedVersion ?? null,
      toVersion: best.v,
      toSha256: best.sha256,
      source,
      classification: 'unclassified',
      newDomains: [],
      notes: best.notes,
      diff: null,
      decision: 'available',
      decidedBy: null,
      createdAt: core.deps.clock.now(),
      decidedAt: null,
    });
    fresh.push(row);
  }
  return { available, fresh };
}

async function supersede(core: RegistryCore, row: SitePackChangeRecord): Promise<void> {
  await core.deps.repos.sitePackChanges.decide(
    row.eventId,
    'superseded',
    SYSTEM,
    core.deps.clock.now(),
  );
}

async function decidedBefore(core: RegistryCore, packId: string, sha256: string): Promise<boolean> {
  for (const source of ['remote', 'import'] as const) {
    const row = await core.deps.repos.sitePackChanges.findCandidate(packId, sha256, source);
    if (row !== null && FINAL.has(row.decision)) return true;
  }
  return false;
}

/** The verified copy of a listed version BrowserHive holds, or `null`. */
export function heldCopy(
  core: RegistryCore,
  packId: string,
  sha256: string,
  first: 'remote' | 'import' = 'remote',
): Promise<SourcePackVersion | null> {
  return readSigned(core.deps.cache, packId, sha256, core.deps.binaryVersion, first);
}

/**
 * Marks `downloaded`, with its classification, field diff and new domains, every `available`
 * registry row whose verified copy BrowserHive holds (after a download, Download all or an import).
 * Returns the rows marked.
 */
export async function promoteHeld(
  core: RegistryCore,
  only?: ReadonlySet<string>,
): Promise<readonly SitePackChangeRecord[]> {
  const marked: SitePackChangeRecord[] = [];
  for (const entry of core.snapshot().packs.values()) {
    for (const row of entry.pending) {
      if (row.decision !== 'available' || !signedSource(row.source)) continue;
      if (only !== undefined && !only.has(row.toSha256)) continue;
      const copy = await heldCopy(core, entry.packId, row.toSha256, row.source);
      if (copy === null) continue;
      marked.push(await markDownloaded(core, entry, row, copy));
    }
  }
  return marked;
}

/** Classifies `copy` against the approved version and stores the row as `downloaded`. */
export async function markDownloaded(
  core: RegistryCore,
  entry: PackEntry,
  row: SitePackChangeRecord,
  copy: SourcePackVersion,
): Promise<SitePackChangeRecord> {
  const from = entry.local?.approved ?? entry.approved;
  const classified = classifyForRow(
    from?.pack ?? null,
    copy.pack,
    await usageOf(core.deps.repos, entry.packId),
  );
  const fields = {
    classification: classified.classification,
    diff: classified.diff,
    newDomains: [...newDomains(from?.pack ?? null, copy.pack)],
  };
  await core.deps.repos.sitePackChanges.markDownloaded(row.eventId, fields);
  return { ...row, ...fields, decision: 'downloaded' };
}

/** The listing of one pack in the index, or `undefined`. */
export function listingOf(index: RegistryIndexV1, packId: string): RegistryIndexPack | undefined {
  return index.packs.find((p) => p.id === packId);
}
