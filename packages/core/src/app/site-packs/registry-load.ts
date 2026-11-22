/** @module app/site-packs/registry-load — derives a snapshot from the catalogs and the stored state (spec 13 §9.6). A row that cannot be read affects only its pack (review #83 C-M5): it is left out, the pack is treated as not approved, and `SITE_PACKS_STATE_CORRUPT` is recorded; a clean load recovers it. */

import type { SitePackPendingEvent } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import { bestUsable } from '../../domain/site-packs/registry-listing.ts';
import type { SourceCatalog } from '../../ports/site-packs.ts';
import { assembleSnapshot, readSigned, resolvePacks } from './registry-build.ts';
import { readPackUsage, reclassifyPending, type SignedContent } from './registry-classify.ts';
import { baselineOf, type RegistryCore } from './registry-core.ts';
import { syncCandidates } from './registry-sync.ts';
import type { RegistrySnapshot, SitePackRegistryDeps } from './registry-types.ts';

/** Reads a downloaded row's verified copy for the classifier. */
export function signedContentOf(
  deps: Pick<SitePackRegistryDeps, 'cache' | 'binaryVersion'>,
): SignedContent {
  return async (packId, row) =>
    (await readSigned(deps.cache, packId, row.toSha256, deps.binaryVersion, row.source))?.pack ??
    null;
}

/** The degradation of an unreadable `site_pack_state` or `site_pack_changes` row. */
export const STATE_CORRUPT = 'SITE_PACKS_STATE_CORRUPT';

/** What one derivation produced. */
export interface LoadedSnapshot {
  readonly snapshot: RegistrySnapshot;
  /** `site_pack.pending` events for candidates recorded now. */
  readonly fresh: readonly z.infer<typeof SitePackPendingEvent>[];
}

/** Builds the next snapshot; reports unreadable rows per pack. */
export async function loadSnapshot(
  core: RegistryCore,
  bundled: SourceCatalog,
  local: SourceCatalog,
  generation: number,
): Promise<LoadedSnapshot> {
  const { deps } = core;
  const corrupt = new Map<string, { table: string; reason: string }>();
  const note = (table: string) => (packId: string, error: unknown) => {
    if (corrupt.has(packId)) return;
    corrupt.set(packId, { table, reason: error instanceof Error ? error.message : String(error) });
    core.log.warn('site pack row unreadable', { packId, table });
  };
  const states = await deps.repos.sitePackState.list({ onUnreadable: note('site_pack_state') });
  const onChanges = note('site_pack_changes');
  const before = await deps.repos.sitePackChanges.listPending({ onUnreadable: onChanges });
  const held = core.remote?.held() ?? null;
  const resolved = await resolvePacks({
    bundled,
    local,
    localDir: deps.local.dir,
    cache: deps.cache,
    binaryVersion: deps.binaryVersion,
    states,
    corrupt: new Set(corrupt.keys()),
    listed: held?.index.packs.map((p) => p.id) ?? [],
    pending: before,
  });
  const usage = await readPackUsage(deps.repos);
  const fresh = await syncCandidates(core, resolved, before, usage, onChanges);
  const assembled = assembleSnapshot(resolved, {
    enabled: deps.enabled,
    generation,
    bundled,
    local,
    pending: await deps.repos.sitePackChanges.listPending({ onUnreadable: onChanges }),
    sites: await deps.repos.templateSites.listAll(),
    loadedAt: deps.clock.now(),
    held,
  });
  // Rows from before the classifier, and verdicts a template edit moved (spec 13 §9.7).
  const { snapshot: classified } = await reclassifyPending(
    deps.repos.sitePackChanges,
    assembled,
    usage,
    signedContentOf(deps),
  );
  const snapshot = await withDeclined(core, classified);
  for (const [packId, { table, reason }] of corrupt) {
    deps.degradations?.report({
      code: STATE_CORRUPT,
      severity: 'warn',
      message:
        table === 'site_pack_state'
          ? `The stored approval of site pack '${packId}' cannot be read; the pack does not apply.`
          : `A stored update of site pack '${packId}' cannot be read; its pending updates are hidden.`,
      details: { pack_id: packId, table, reason },
    });
  }
  if (corrupt.size === 0) deps.degradations?.recovered(STATE_CORRUPT);
  return { snapshot, fresh };
}

/** Decisions that set a version aside for good (review #100 M4: shown, and offered again on request). */
const SET_ASIDE: ReadonlySet<string> = new Set(['approved', 'auto', 'rejected']);

/** Marks packs whose usable registry version an operator set aside (`online.declined`). */
async function withDeclined(
  core: RegistryCore,
  snapshot: RegistrySnapshot,
): Promise<RegistrySnapshot> {
  const packs = new Map(snapshot.packs);
  let changed = false;
  for (const [packId, entry] of snapshot.packs) {
    if (entry.listing === null) continue;
    const best = bestUsable(entry.listing, core.deps.binaryVersion);
    const base = baselineOf(entry)?.version ?? 0;
    if (best === null || best.v <= base) continue;
    if (entry.pending.some((p) => p.toSha256 === best.sha256)) continue;
    let declined = false;
    for (const source of ['remote', 'import'] as const) {
      const row = await core.deps.repos.sitePackChanges.findCandidate(packId, best.sha256, source);
      if (row !== null && SET_ASIDE.has(row.decision)) declined = true;
    }
    if (!declined) continue;
    packs.set(packId, { ...entry, declined: true });
    changed = true;
  }
  return changed ? { ...snapshot, packs } : snapshot;
}
