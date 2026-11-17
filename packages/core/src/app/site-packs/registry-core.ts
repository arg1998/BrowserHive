/** @module app/site-packs/registry-core — what the registry's decisions share: access to the snapshot, the audit row (`operator_actions`, `resource_kind: 'site_pack'`, spec 13 §11.8), and keeping `template_sites.pack_version` equal to the version in force. */

import type { Logger } from '../../ports/logger.ts';
import type { JsonObject } from '../../ports/persistence/json.ts';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import type { PackEntry, RegistrySnapshot, SitePackRegistryDeps } from './registry-types.ts';

/** The registry as its decision functions see it. */
export interface RegistryCore {
  readonly deps: SitePackRegistryDeps;
  readonly log: Logger;
  snapshot(): RegistrySnapshot;
  /** @throws `SITE_PACK_NOT_FOUND`. */
  entry(packId: string): PackEntry;
  /** Re-derives the snapshot from the current catalogs and the stored state. */
  refresh(): Promise<void>;
}

/** Appends one `site_pack.*` audit row. */
export async function auditPack(
  repos: Pick<Repositories, 'operatorActions'>,
  core: RegistryCore,
  by: string,
  action: string,
  packId: string | null,
  details: JsonObject,
): Promise<void> {
  await repos.operatorActions.append({
    eventId: core.deps.ids.eventId(),
    principalId: by,
    action,
    resourceKind: 'site_pack',
    resourceId: packId,
    details,
    occurredAt: core.deps.clock.now(),
  });
}

/**
 * Sets `pack_version` of every template site using the pack to the version now in force (after a
 * refresh). Returns the templates touched.
 */
export async function syncSiteVersions(core: RegistryCore, packId: string): Promise<string[]> {
  const version = core.snapshot().packs.get(packId)?.effective?.version ?? null;
  if (version === null) return [];
  const touched = new Set<string>();
  const repos = core.deps.repos;
  for (const site of await repos.templateSites.listAll()) {
    if (site.packId !== packId || site.packVersion === version) continue;
    await repos.templateSites.upsert({ ...site, packVersion: version });
    touched.add(site.templateId);
  }
  return [...touched];
}
