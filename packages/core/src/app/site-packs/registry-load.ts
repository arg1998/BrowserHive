/** @module app/site-packs/registry-load — derives a snapshot from the catalogs and the stored state (spec 13 §9.6). A row that cannot be read affects only its pack (review #83 C-M5): it is left out, the pack is treated as not approved, and `SITE_PACKS_STATE_CORRUPT` is recorded; a clean load recovers it. */

import type { SitePackPendingEvent } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type { SourceCatalog } from '../../ports/site-packs.ts';
import { assembleSnapshot, resolvePacks } from './registry-build.ts';
import { readPackUsage, reclassifyPending } from './registry-classify.ts';
import type { RegistryCore } from './registry-core.ts';
import { syncCandidates } from './registry-sync.ts';
import type { RegistrySnapshot } from './registry-types.ts';

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
  const resolved = await resolvePacks({
    bundled,
    local,
    localDir: deps.local.dir,
    cache: deps.cache,
    binaryVersion: deps.binaryVersion,
    states,
    corrupt: new Set(corrupt.keys()),
  });
  const onChanges = note('site_pack_changes');
  const before = await deps.repos.sitePackChanges.listPending({ onUnreadable: onChanges });
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
  });
  // Rows from before the classifier, and verdicts a template edit moved (spec 13 §9.7).
  const { snapshot } = await reclassifyPending(deps.repos.sitePackChanges, assembled, usage);
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
