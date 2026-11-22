/** @module app/site-packs/registry-core — what the registry's decisions share: access to the snapshot, the audit row (`operator_actions`, `resource_kind: 'site_pack'`, spec 13 §11.8), and keeping `template_sites.pack_version` equal to the version in force. */

import type { Logger } from '../../ports/logger.ts';
import type { JsonObject } from '../../ports/persistence/json.ts';
import {
  emptySitePackState,
  type SitePackChangeRecord,
  type SitePackSourceId,
  type SitePackStateRecord,
} from '../../ports/persistence/site-packs.ts';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import type { SourcePackVersion } from '../../ports/site-packs.ts';
import { domainTaken } from './registry-errors.ts';
import type {
  PackEntry,
  RegistrySnapshot,
  RemoteFacts,
  SitePackRegistryDeps,
} from './registry-types.ts';

/** The registry as its decision functions see it. */
export interface RegistryCore {
  readonly deps: SitePackRegistryDeps;
  readonly log: Logger;
  snapshot(): RegistrySnapshot;
  /** @throws `SITE_PACK_NOT_FOUND`. */
  entry(packId: string): PackEntry;
  /** Re-derives the snapshot from the current catalogs and the stored state. */
  refresh(): Promise<void>;
  /** The registry client's facts (T4b), when attached. */
  readonly remote?: RemoteFacts | undefined;
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

/** The pack's state row, or a fresh one. */
export function stateOf(entry: PackEntry, now: number): SitePackStateRecord {
  return entry.state ?? emptySitePackState(entry.packId, now);
}

/** A decided change row (`seq` and `event_id` filled in). */
export function decidedChange(
  core: RegistryCore,
  fields: Omit<SitePackChangeRecord, 'seq' | 'eventId' | 'createdAt' | 'decidedAt'>,
): SitePackChangeRecord {
  const now = core.deps.clock.now();
  return { seq: 0, eventId: core.deps.ids.eventId(), createdAt: now, decidedAt: now, ...fields };
}

/** The content in force, else the approved one (a disabled pack keeps its approval). */
export function approvedContent(entry: PackEntry): SourcePackVersion | null {
  return entry.local?.approved ?? entry.approved;
}

/**
 * Refuses content of `packId` that claims a domain an approved other pack covers (spec 13 §9.10,
 * review #83 C-M1): `SITE_PACK_DOMAIN_TAKEN` naming that pack. Offers never own a domain here.
 */
export function assertDomainsFree(
  snapshot: RegistrySnapshot,
  packId: string,
  domains: readonly string[],
): void {
  for (const domain of domains) {
    const owner = snapshot.byDomain.get(domain);
    if (owner === undefined || owner === packId) continue;
    const entry = snapshot.packs.get(owner);
    if (entry !== undefined && approvedContent(entry) !== null) {
      throw domainTaken(packId, domain, owner);
    }
  }
}

/**
 * What a candidate is classified against (spec 13 §9.7): the content in force (a local override,
 * else the approved version), else for a pack nothing approved yet the bundled version first use
 * would approve (review #100 M2); `null` for a pack only the registry lists.
 */
export function baselineOf(
  entry: PackEntry,
): {
  readonly content: SourcePackVersion;
  readonly version: number;
  readonly source: SitePackSourceId;
} | null {
  const local = entry.local?.approved ?? null;
  if (local !== null) return { content: local, version: local.pack.version, source: 'local' };
  const approved = entry.approved;
  const source = entry.state?.approvedSource ?? null;
  if (approved !== null && source !== null) {
    return { content: approved, version: approved.pack.version, source };
  }
  if (entry.offer !== null) {
    return { content: entry.offer, version: entry.offer.pack.version, source: 'bundled' };
  }
  return null;
}
