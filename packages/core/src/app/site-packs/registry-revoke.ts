/** @module app/site-packs/registry-revoke — a publisher's revocation of a pack version (spec 13 §9.7, last paragraph), as the registry applies it: the fallback (the previous approved version) applies at once when it is tightening or neutral; a loosening or restrictive one waits as a pending decision marked `revoked` (with `site_pack.update_pending`) while the revoked version stays in force; with no fallback the revoked version stays and is reported. Bundled and local sources carry no revocation today: the T4b registry client calls this when the signed index marks a version `revoked: true`. */

import type { SitePackView } from '@browserhive/contracts/http';
import { newDomains } from '../../domain/site-packs/diff.ts';
import { revocationDecision } from '../../domain/site-packs/revocation.ts';
import type {
  SitePackProvenanceRecord,
  SitePackSourceId,
} from '../../ports/persistence/site-packs.ts';
import type { SourcePackVersion } from '../../ports/site-packs.ts';
import { readCached } from './registry-build.ts';
import { usageOf } from './registry-classify.ts';
import {
  auditPack,
  decidedChange,
  type RegistryCore,
  stateOf,
  syncSiteVersions,
} from './registry-core.ts';
import type { PackEntry } from './registry-types.ts';

/** What a revocation did. */
export type RevocationOutcome =
  /** The fallback is now the approved version. */
  | { readonly outcome: 'fallback_applied'; readonly classification: 'tightening' | 'neutral' }
  /** The revoked version stays in force; the fallback waits for an operator. */
  | { readonly outcome: 'decision_opened'; readonly classification: 'loosening' | 'restrictive' }
  /** The revoked version stays in force and is reported. */
  | { readonly outcome: 'kept'; readonly reason: 'no_fallback' | 'operator_content' }
  /** A pending candidate was revoked: withdrawn from the pending list. */
  | { readonly outcome: 'candidate_withdrawn' }
  /** The version is neither approved nor pending: nothing to do. */
  | { readonly outcome: 'not_in_force' };

/** The principal of automatic decisions. */
const SYSTEM = 'browserhive';

/** What `SitePackRegistry.revoke` answers. */
export type RevokeResult = RevocationOutcome & { readonly view: SitePackView };

/** Applies the revocation of `version` of `packId` (publishing `site_pack.pending` for a decision). */
export async function revokeVersion(
  core: RegistryCore,
  packId: string,
  version: number,
  by: string,
  /** The revoked bytes (the index entry's SHA-256): only that version is touched (review #100 I1). */
  sha256?: string,
): Promise<RevocationOutcome> {
  const entry = core.entry(packId);
  const state = entry.state;
  const now = core.deps.clock.now();
  if (
    state === null ||
    entry.approved === null ||
    state.approvedVersion !== version ||
    (sha256 !== undefined && state.approvedSha256 !== sha256) ||
    state.approvedSource === null
  ) {
    const row = entry.pending.find(
      (p) => p.toVersion === version && (sha256 === undefined || p.toSha256 === sha256),
    );
    if (row === undefined) return { outcome: 'not_in_force' };
    await core.deps.uow.transaction(async (repos) => {
      await repos.sitePackChanges.decide(row.eventId, 'superseded', by, now);
      await auditPack(repos, core, by, 'site_pack.revoke', packId, {
        version,
        outcome: 'candidate_withdrawn',
      });
    });
    await core.refresh();
    return { outcome: 'candidate_withdrawn' };
  }
  const revoked = entry.approved;
  const fallback = await fallbackOf(core, entry);
  const decision = revocationDecision({
    revoked: revoked.pack,
    source: state.approvedSource,
    fallback: fallback?.content.pack ?? null,
    ctx: await usageOf(core.deps.repos, packId),
  });
  if (decision.kind === 'keep_and_report' || fallback === null) {
    const reason = decision.kind === 'keep_and_report' ? decision.reason : 'no_fallback';
    core.log.warn('revoked pack kept', { packId, version, reason });
    await auditPack(core.deps.repos, core, by, 'site_pack.revoke', packId, {
      version,
      outcome: 'kept',
      reason,
    });
    return { outcome: 'kept', reason };
  }
  const { content, source, provenance } = fallback;
  const base = {
    packId,
    fromVersion: version,
    toVersion: content.pack.version,
    toSha256: content.sha256,
    source,
    newDomains: [...newDomains(revoked.pack, content.pack)],
    notes: null,
    diff: decision.changes.map((c) => ({ ...c })),
  };
  if (decision.kind === 'open_decision') {
    // Kept for Apply, which reads BrowserHive's copy when the release no longer ships it.
    await core.deps.cache.put(source, packId, content.sha256, content.bytes);
    await core.deps.uow.transaction(async (repos) => {
      await repos.sitePackChanges.insert({
        ...base,
        seq: 0,
        eventId: core.deps.ids.eventId(),
        classification: 'revoked',
        decision: 'downloaded',
        decidedBy: null,
        createdAt: now,
        decidedAt: null,
      });
      await auditPack(repos, core, by, 'site_pack.revoke', packId, {
        version,
        outcome: 'decision_opened',
        fallback_version: content.pack.version,
        classification: decision.classification,
      });
    });
    await core.refresh();
    core.deps.bus?.publish('site_pack.pending', {
      type: 'site_pack.pending',
      pack_id: packId,
      to_version: content.pack.version,
      classification: 'revoked',
    });
    return { outcome: 'decision_opened', classification: decision.classification };
  }
  await core.deps.uow.transaction(async (repos) => {
    await repos.sitePackState.put({
      ...stateOf(entry, now),
      approvedVersion: content.pack.version,
      approvedSha256: content.sha256,
      approvedSource: source,
      approvedProvenance: provenance,
      approvedDomains: [...content.pack.domains],
      approvedBy: SYSTEM,
      approvedAt: now,
      previousVersion: null,
      previousSha256: null,
      previousSource: null,
      // A pin on the revoked version follows the revocation (spec 13 §9.7).
      pinnedVersion: null,
      updatedAt: now,
    });
    await repos.sitePackChanges.insert(
      decidedChange(core, {
        ...base,
        classification: decision.classification,
        decision: 'auto',
        decidedBy: SYSTEM,
      }),
    );
    await auditPack(repos, core, by, 'site_pack.revoke', packId, {
      version,
      outcome: 'fallback_applied',
      fallback_version: content.pack.version,
      classification: decision.classification,
    });
  });
  await core.refresh();
  await syncSiteVersions(core, packId);
  return { outcome: 'fallback_applied', classification: decision.classification };
}

/** The previous approved version's content (the release's bytes, else BrowserHive's copy). */
async function fallbackOf(core: RegistryCore, entry: PackEntry): Promise<Fallback | null> {
  const state = entry.state;
  if (state === null || state.previousSha256 === null || state.previousSource === null) return null;
  const sha = state.previousSha256;
  const source = state.previousSource;
  const bundled = core.snapshot().bundled.packs.find((p) => p.sha256 === sha);
  if (source === 'bundled' && bundled !== undefined) {
    return { content: bundled, source, provenance: { kind: 'bundled', release: bundled.origin } };
  }
  const { cache, binaryVersion } = core.deps;
  const content = await readCached(cache, source, entry.packId, sha, binaryVersion);
  return content === null ? null : { content, source, provenance: null };
}

/** The version a revocation falls back to. */
interface Fallback {
  readonly content: SourcePackVersion;
  readonly source: SitePackSourceId;
  readonly provenance: SitePackProvenanceRecord | null;
}
