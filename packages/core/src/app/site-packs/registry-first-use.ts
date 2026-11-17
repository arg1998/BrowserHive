/** @module app/site-packs/registry-first-use — approval on first use (spec 13 §9.6, D-67): adding a site keeps the version already approved, else approves exactly the offered version the operator reviewed (`pack_sha256`; without it `SITE_PACK_APPROVAL_REQUIRED` with the offer, review #83 S-M4). Prepared outside, written inside the caller's transaction (C-L9). */

import { diffPacks } from '../../domain/site-packs/diff.ts';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import {
  approvedContent,
  assertDomainsFree,
  auditPack,
  decidedChange,
  type RegistryCore,
  stateOf,
} from './registry-core.ts';
import { approvalRequired, domainTaken, packConflict } from './registry-errors.ts';
import type { PreparedApproval } from './registry-types.ts';

const short = (sha: string) => `${sha.slice(0, 12)}…`;

/**
 * Prepares the approval a new site `siteId` of pack `packId` needs.
 *
 * @returns `null` when the pack has nothing to approve and no hash was reviewed (a generic site).
 * @throws `SITE_PACK_APPROVAL_REQUIRED` (no hash for a pack that needs approval), `CONFLICT` (a
 *   hash that is not the version approved or on offer), `SITE_PACK_DOMAIN_TAKEN`.
 */
export async function prepareFirstUse(
  core: RegistryCore,
  siteId: string,
  packId: string,
  sha256: string | undefined,
  by: string,
): Promise<PreparedApproval | null> {
  const entry = core.entry(packId);
  const inForce = approvedContent(entry);
  if (inForce !== null) {
    const known = [inForce.sha256, entry.state?.approvedSha256, entry.state?.localApprovedSha256];
    if (sha256 !== undefined && !known.includes(sha256)) {
      throw packConflict(
        `The approved version of ${packId} is not the one reviewed (SHA-256 ${short(inForce.sha256)}); review it again.`,
      );
    }
    const version = entry.effective?.version ?? inForce.pack.version;
    const sha = entry.effective?.sha256 ?? inForce.sha256;
    return { packId, version, sha256: sha, approves: false, write: () => Promise.resolve() };
  }
  const offer = entry.offer;
  if (offer === null) {
    if (entry.overlap !== null)
      throw domainTaken(packId, entry.overlap.domain, entry.overlap.owner);
    if (sha256 !== undefined) throw packConflict(`${packId} has no version to approve.`);
    return null;
  }
  if (sha256 === undefined) {
    throw approvalRequired(siteId, packId, {
      version: offer.pack.version,
      sha256: offer.sha256,
      release: offer.origin,
    });
  }
  if (sha256 !== offer.sha256) {
    throw packConflict(
      `The offered version of ${packId} changed since it was shown (SHA-256 ${short(offer.sha256)}); review it again.`,
    );
  }
  assertDomainsFree(core.snapshot(), packId, offer.pack.domains);
  await core.deps.cache.put('bundled', packId, offer.sha256, offer.bytes);
  const provenance = { kind: 'bundled' as const, release: offer.origin };
  const write = async (repos: Repositories): Promise<void> => {
    const now = core.deps.clock.now();
    const current = await repos.sitePackState.get(packId);
    if (current?.approvedSha256 === offer.sha256) return; // approved meanwhile: nothing to add
    if (current?.approvedSha256 != null) {
      throw packConflict(`Another version of ${packId} was approved meanwhile; review it again.`);
    }
    await repos.sitePackState.put({
      ...(current ?? stateOf(entry, now)),
      approvedVersion: offer.pack.version,
      approvedSha256: offer.sha256,
      approvedSource: 'bundled',
      approvedProvenance: provenance,
      approvedDomains: [...offer.pack.domains],
      approvedBy: by,
      approvedAt: now,
      updatedAt: now,
    });
    await repos.sitePackChanges.insert(
      decidedChange(core, {
        packId,
        fromVersion: null,
        toVersion: offer.pack.version,
        toSha256: offer.sha256,
        source: 'bundled',
        classification: 'new_pack',
        newDomains: [...offer.pack.domains],
        notes: null,
        diff: diffPacks(null, offer.pack),
        decision: 'approved',
        decidedBy: by,
      }),
    );
    await auditPack(repos, core, by, 'site_pack.approve', packId, {
      version: offer.pack.version,
      sha256: offer.sha256,
      source: 'bundled',
      provenance,
      domains: [...offer.pack.domains],
      site_id: siteId,
    });
  };
  return { packId, version: offer.pack.version, sha256: offer.sha256, approves: true, write };
}
