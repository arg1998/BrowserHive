/** @module app/site-packs/registry-actions — the operator decisions of the approval model (spec 13 §9.6, §10.5, §10.6, D-67): approval on first use with its provenance, Apply, Reject, Revert, Pin, Follow, approving a local file by its SHA-256, and enabling. Each writes `site_pack_state`, a `site_pack_changes` decision and an audit row in one transaction, copying approved bytes to BrowserHive's cache first. */

import { diffPacks, newDomains } from '../../domain/site-packs/diff.ts';
import type { RefusedPack } from '../../domain/site-packs/load.ts';
import type { SitePackStateRecord } from '../../ports/persistence/site-packs.ts';
import type { SkippedPackVersion } from '../../ports/site-packs.ts';
import { readCached } from './registry-build.ts';
import {
  approvedContent,
  assertDomainsFree,
  auditPack,
  decidedChange as change,
  type RegistryCore,
  stateOf,
  syncSiteVersions,
} from './registry-core.ts';
import {
  noLocalFile,
  noPrevious,
  notPending,
  packConflict,
  packInvalid,
  packValidation,
} from './registry-errors.ts';
import type { PackEntry } from './registry-types.ts';

export type { RegistryCore } from './registry-core.ts';
export {
  auditReload,
  importPack,
  recordLocalOverrides,
  syncCandidates,
  updatesFact,
} from './registry-sync.ts';

/** `CONFLICT` for a reviewed hash naming a site no pack covers. */
export function noPackToApprove(siteId: string) {
  return packConflict(`No site pack covers ${siteId} any more; review the site again.`);
}

/** Apply a pending version: it becomes the approved one; the old one is kept for Revert. */
export async function applyVersion(
  core: RegistryCore,
  packId: string,
  version: number,
  by: string,
): Promise<void> {
  const entry = core.entry(packId);
  const row = entry.pending.find((p) => p.toVersion === version);
  const content =
    row === undefined
      ? undefined
      : core.snapshot().bundled.packs.find((p) => p.sha256 === row.toSha256);
  if (row === undefined || content === undefined) throw notPending(packId, version);
  assertDomainsFree(core.snapshot(), packId, content.pack.domains);
  const { deps } = core;
  const now = deps.clock.now();
  await deps.cache.put(row.source, packId, content.sha256, content.bytes);
  const state = stateOf(entry, now);
  await deps.uow.transaction(async (repos) => {
    await repos.sitePackState.put({
      ...state,
      previousVersion: state.approvedVersion,
      previousSha256: state.approvedSha256,
      previousSource: state.approvedSource,
      approvedVersion: content.pack.version,
      approvedSha256: content.sha256,
      approvedSource: row.source,
      approvedProvenance: { kind: 'bundled', release: content.origin },
      approvedDomains: [...content.pack.domains],
      approvedBy: by,
      approvedAt: now,
      // Pinning keeps a version; applying another one ends the pin.
      pinnedVersion: null,
      updatedAt: now,
    });
    await repos.sitePackChanges.decide(row.eventId, 'approved', by, now);
    await auditPack(repos, core, by, 'site_pack.apply', packId, {
      from_version: state.approvedVersion,
      version: content.pack.version,
      sha256: content.sha256,
      source: row.source,
    });
  });
  await core.refresh();
  await syncSiteVersions(core, packId);
}

/** Reject a pending version: dismissed; it does not come back. */
export async function rejectVersion(
  core: RegistryCore,
  packId: string,
  version: number,
  by: string,
): Promise<void> {
  const entry = core.entry(packId);
  const row = entry.pending.find((p) => p.toVersion === version);
  if (row === undefined) throw notPending(packId, version);
  const now = core.deps.clock.now();
  await core.deps.uow.transaction(async (repos) => {
    await repos.sitePackChanges.decide(row.eventId, 'rejected', by, now);
    await auditPack(repos, core, by, 'site_pack.reject', packId, {
      version,
      sha256: row.toSha256,
    });
  });
  await core.refresh();
}

/** Restore the previous approved version (from its source or BrowserHive's copy). */
export async function revertVersion(core: RegistryCore, packId: string, by: string): Promise<void> {
  const entry = core.entry(packId);
  const state = entry.state;
  if (
    state === null ||
    state.previousVersion === null ||
    state.previousSha256 === null ||
    state.previousSource === null
  ) {
    throw noPrevious(packId);
  }
  const { previousVersion, previousSha256, previousSource } = state;
  const bundled = core.snapshot().bundled.packs.find((p) => p.sha256 === previousSha256);
  const content =
    previousSource === 'bundled' && bundled !== undefined
      ? bundled
      : await readCached(
          core.deps.cache,
          previousSource,
          packId,
          previousSha256,
          core.deps.binaryVersion,
        );
  if (content === null) throw noPrevious(packId);
  const now = core.deps.clock.now();
  await core.deps.uow.transaction(async (repos) => {
    await repos.sitePackState.put({
      ...state,
      approvedVersion: previousVersion,
      approvedSha256: previousSha256,
      approvedSource: previousSource,
      approvedProvenance:
        previousSource === 'bundled' && bundled !== undefined
          ? { kind: 'bundled', release: bundled.origin }
          : null,
      approvedDomains: [...content.pack.domains],
      approvedBy: by,
      approvedAt: now,
      previousVersion: null,
      previousSha256: null,
      previousSource: null,
      pinnedVersion: null,
      updatedAt: now,
    });
    await repos.sitePackChanges.insert(
      change(core, {
        packId,
        fromVersion: state.approvedVersion,
        toVersion: previousVersion,
        toSha256: previousSha256,
        source: previousSource,
        classification: 'unclassified',
        newDomains: [...newDomains(entry.approved?.pack ?? null, content.pack)],
        notes: null,
        diff: entry.approved === null ? null : diffPacks(entry.approved.pack, content.pack),
        decision: 'reverted',
        decidedBy: by,
      }),
    );
    await auditPack(repos, core, by, 'site_pack.revert', packId, {
      from_version: state.approvedVersion,
      version: previousVersion,
      sha256: previousSha256,
    });
  });
  await core.refresh();
  await syncSiteVersions(core, packId);
}

/** Pin the approved version (`null` unpins). */
export async function pinVersion(
  core: RegistryCore,
  packId: string,
  version: number | null,
  by: string,
): Promise<void> {
  const entry = core.entry(packId);
  const approved = entry.state?.approvedVersion ?? null;
  if (version !== null && version !== approved) {
    throw packValidation(
      'version',
      approved === null
        ? `${packId} has no approved version to pin`
        : `only the approved version (${approved}) can be pinned`,
      'not_approved_version',
    );
  }
  await writeState(core, entry, by, 'site_pack.pin', { version }, { pinnedVersion: version });
}

/** Follow updates on, off, or automatically (`null`). */
export async function setFollow(
  core: RegistryCore,
  packId: string,
  follow: boolean | null,
  by: string,
): Promise<void> {
  await writeState(core, core.entry(packId), by, 'site_pack.follow', { follow }, { follow });
}

/** Enable or disable a pack. */
export async function setEnabled(
  core: RegistryCore,
  packId: string,
  enabled: boolean,
  by: string,
): Promise<void> {
  const action = enabled ? 'site_pack.enable' : 'site_pack.disable';
  await writeState(core, core.entry(packId), by, action, {}, { enabled });
  await syncSiteVersions(core, packId);
}

async function writeState(
  core: RegistryCore,
  entry: PackEntry,
  by: string,
  action: string,
  details: Record<string, number | boolean | null>,
  patch: Partial<SitePackStateRecord>,
): Promise<void> {
  const now = core.deps.clock.now();
  await core.deps.uow.transaction(async (repos) => {
    await repos.sitePackState.put({ ...stateOf(entry, now), ...patch, updatedAt: now });
    await auditPack(repos, core, by, action, entry.packId, details);
  });
  await core.refresh();
}

/** Approve the local file's current content, by the SHA-256 the operator reviewed (spec 13 §10.5). */
export async function approveLocal(
  core: RegistryCore,
  packId: string,
  sha256: string,
  by: string,
): Promise<void> {
  const entry = core.entry(packId);
  const local = entry.local;
  if (local === null) throw noLocalFile(packId);
  const current = local.current;
  if (current === null) {
    throw packInvalid('local', issuesOf(local.problem));
  }
  if (current.sha256 !== sha256) {
    throw packConflict(`The local file of ${packId} changed since it was shown; review it again.`);
  }
  assertDomainsFree(core.snapshot(), packId, current.pack.domains);
  const { deps } = core;
  const now = deps.clock.now();
  await deps.cache.put('local', packId, sha256, current.bytes);
  const before = entry.effective?.pack ?? approvedContent(entry)?.pack ?? null;
  await deps.uow.transaction(async (repos) => {
    await repos.sitePackState.put({
      ...stateOf(entry, now),
      localPath: local.path,
      localApprovedSha256: sha256,
      localApprovedBy: by,
      localApprovedAt: now,
      updatedAt: now,
    });
    await repos.sitePackChanges.insert(
      change(core, {
        packId,
        fromVersion: entry.effective?.version ?? entry.state?.approvedVersion ?? null,
        toVersion: null,
        toSha256: sha256,
        source: 'local',
        classification: 'local_override',
        newDomains: [...newDomains(before, current.pack)],
        notes: null,
        diff: diffPacks(before, current.pack),
        decision: 'approved',
        decidedBy: by,
      }),
    );
    await auditPack(repos, core, by, 'site_pack.approve_local', packId, {
      sha256,
      version: current.pack.version,
      path: local.path,
    });
  });
  await core.refresh();
  await syncSiteVersions(core, packId);
}

function issuesOf(problem: SkippedPackVersion | null): RefusedPack['issues'] {
  if (problem === null) return [{ path: '', message: 'the local file is not valid' }];
  const listed =
    'issues' in problem && Array.isArray(problem.issues) ? problem.issues.filter(isIssue) : [];
  return listed.length > 0 ? listed : [{ path: '', message: problem.detail }];
}

function isIssue(value: unknown): value is RefusedPack['issues'][number] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  );
}
