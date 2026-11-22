/** @module app/site-packs/registry-build — builds the registry's snapshot (spec 13 §9.6, §10.5, D-67): resolves each pack id's approved content (its source's bytes when the hash matches, else BrowserHive's copy), the local file's state and approved content, the offer for first use; then assigns registrable domains by precedence (approved local content > approved other source > offer; a pack claiming a taken domain is skipped `domain_overlap`). */

import { join } from 'node:path';
import type { RegistryIndexPack } from '@browserhive/contracts/site-packs';
import { loadPackBytes } from '../../domain/site-packs/load.ts';
import type {
  SitePackChangeRecord,
  SitePackSourceId,
  SitePackStateRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { SitePackCache } from '../../ports/site-pack-files.ts';
import type {
  EffectivePack,
  SkippedPackVersion,
  SourceCatalog,
  SourcePackVersion,
} from '../../ports/site-packs.ts';
import type { HeldIndex, LocalEntry, PackEntry, RegistrySnapshot } from './registry-types.ts';

/** A pack id with its contents resolved, before domains are assigned. */
export interface ResolvedPack {
  readonly packId: string;
  readonly state: SitePackStateRecord | null;
  readonly approved: SourcePackVersion | null;
  readonly local: LocalEntry | null;
  readonly offer: SourcePackVersion | null;
  /** The bundled version this release ships (a candidate when newer than the approved one). */
  readonly bundled: SourcePackVersion | null;
  /**
   * A downloaded registry or imported candidate of a pack nothing approved and nothing bundles (a
   * registry-only pack): what its views describe until it is applied.
   */
  readonly candidate?: SourcePackVersion | null;
  readonly skipped: SkippedPackVersion | null;
}

/** Inputs of {@link resolvePacks}. */
export interface ResolveInput {
  readonly bundled: SourceCatalog;
  readonly local: SourceCatalog;
  readonly localDir: string;
  readonly states: readonly SitePackStateRecord[];
  readonly cache: SitePackCache;
  readonly binaryVersion: string;
  /** Packs whose stored state cannot be read (review #83 C-M5): treated as not approved. */
  readonly corrupt?: ReadonlySet<string>;
  /** Pack ids the held registry index lists (T4b). */
  readonly listed?: readonly string[];
  /** Pending candidates (registry-only packs show their downloaded content). */
  readonly pending?: readonly SitePackChangeRecord[];
}

/**
 * A registry-signed pack file BrowserHive verified and holds (`cache/remote/…` or
 * `cache/import/…`), checked again like any pack; `null` when neither copy is there.
 */
export async function readSigned(
  cache: SitePackCache,
  packId: string,
  sha256: string,
  binaryVersion: string,
  first: SitePackSourceId = 'remote',
): Promise<SourcePackVersion | null> {
  const order: SitePackSourceId[] =
    first === 'import' ? ['import', 'remote'] : ['remote', 'import'];
  for (const source of order) {
    const found = await readCached(cache, source, packId, sha256, binaryVersion);
    if (found !== null) return found;
  }
  return null;
}

/** Reads a cached copy and checks it like any pack; `null` when missing, altered or refused. */
export async function readCached(
  cache: SitePackCache,
  source: SitePackSourceId,
  packId: string,
  sha256: string,
  binaryVersion: string,
): Promise<SourcePackVersion | null> {
  const bytes = await cache.get(source, packId, sha256);
  if (bytes === null) return null;
  const loaded = loadPackBytes(bytes, {
    origin: cache.pathOf(source, packId, sha256),
    binaryVersion,
    expectedId: packId,
  });
  return loaded.ok && loaded.value.sha256 === sha256 ? loaded.value : null;
}

/** Resolves every pack id any source, file or state row knows. */
export async function resolvePacks(input: ResolveInput): Promise<readonly ResolvedPack[]> {
  const bundled = new Map(input.bundled.packs.map((p) => [p.pack.id, p]));
  const localFiles = new Map(input.local.packs.map((p) => [p.pack.id, p]));
  const localProblems = new Map(
    input.local.skipped
      .filter((s) => s.reason !== 'signed_layout_unsupported')
      .map((s) => [s.packId, s]),
  );
  const states = new Map(input.states.map((s) => [s.packId, s]));
  const ids = new Set<string>([
    ...bundled.keys(),
    ...localFiles.keys(),
    ...localProblems.keys(),
    ...(input.corrupt ?? []),
    ...(input.listed ?? []),
    ...(input.pending ?? []).map((p) => p.packId),
    ...input.states
      .filter((s) => s.approvedSha256 !== null || s.localApprovedSha256 !== null)
      .map((s) => s.packId),
  ]);
  const out: ResolvedPack[] = [];
  for (const packId of [...ids].sort()) {
    const state = states.get(packId) ?? null;
    const current = bundled.get(packId) ?? null;
    let skipped: SkippedPackVersion | null = input.corrupt?.has(packId) ? unreadable(packId) : null;
    const approved = await resolveApproved(input, packId, state, current);
    if (approved === 'missing') {
      skipped = missingCopy(packId, state?.approvedVersion ?? null);
    }
    const local = await resolveLocal(input, packId, state, {
      file: localFiles.get(packId) ?? null,
      problem: localProblems.get(packId) ?? null,
    });
    if (local.missingCopy) skipped = missingCopy(packId, null);
    const approvedContent = approved === 'missing' ? null : approved;
    const nothingApproved = state?.approvedSha256 == null && local.entry?.approved == null;
    const candidate =
      nothingApproved && current === null && local.entry === null
        ? await candidateOf(input, packId)
        : null;
    out.push({
      packId,
      state,
      approved: approvedContent,
      local: local.entry,
      offer: nothingApproved ? current : null,
      bundled: current,
      candidate,
      skipped: skipped ?? local.entry?.problem ?? null,
    });
  }
  return out;
}

/** The newest downloaded registry or imported candidate's content, for a registry-only pack. */
async function candidateOf(input: ResolveInput, packId: string): Promise<SourcePackVersion | null> {
  const rows = (input.pending ?? [])
    .filter(
      (p) =>
        p.packId === packId &&
        p.decision === 'downloaded' &&
        (p.source === 'remote' || p.source === 'import'),
    )
    .sort((a, b) => (b.toVersion ?? 0) - (a.toVersion ?? 0));
  for (const row of rows) {
    const found = await readSigned(
      input.cache,
      packId,
      row.toSha256,
      input.binaryVersion,
      row.source,
    );
    if (found !== null) return found;
  }
  return null;
}

function unreadable(packId: string): SkippedPackVersion {
  return {
    packId,
    version: null,
    reason: 'unreadable',
    detail: 'its stored approval cannot be read (SITE_PACKS_STATE_CORRUPT); approve it again',
  };
}

function missingCopy(packId: string, version: number | null): SkippedPackVersion {
  return {
    packId,
    version,
    reason: 'not_found',
    detail: "BrowserHive's copy of the approved version is missing or unreadable",
  };
}

async function resolveApproved(
  input: ResolveInput,
  packId: string,
  state: SitePackStateRecord | null,
  current: SourcePackVersion | null,
): Promise<SourcePackVersion | null | 'missing'> {
  const sha = state?.approvedSha256 ?? null;
  const source = state?.approvedSource ?? null;
  if (sha === null || source === null || source === 'local') return null;
  if (source === 'bundled' && current?.sha256 === sha) return current;
  const cached = await readCached(input.cache, source, packId, sha, input.binaryVersion);
  return cached ?? 'missing';
}

async function resolveLocal(
  input: ResolveInput,
  packId: string,
  state: SitePackStateRecord | null,
  found: { file: SourcePackVersion | null; problem: SkippedPackVersion | null },
): Promise<{ entry: LocalEntry | null; missingCopy: boolean }> {
  // A deleted file ends the override; the approved hash stays recorded for when it returns.
  if (found.file === null && found.problem === null) return { entry: null, missingCopy: false };
  const path = found.file?.origin ?? join(input.localDir, `${packId}.json`);
  const sha = state?.localApprovedSha256 ?? null;
  let approved: SourcePackVersion | null = null;
  let missing = false;
  if (sha !== null) {
    approved =
      found.file?.sha256 === sha
        ? found.file
        : await readCached(input.cache, 'local', packId, sha, input.binaryVersion);
    missing = approved === null;
  }
  const state_: LocalEntry['state'] =
    found.file !== null && found.file.sha256 === sha
      ? 'approved'
      : sha !== null
        ? 'changed'
        : 'not_approved';
  return {
    entry: { path, current: found.file, problem: found.problem, approved, state: state_ },
    missingCopy: missing,
  };
}

/** Inputs of {@link assembleSnapshot} besides the resolved packs. */
export interface AssembleInput {
  readonly enabled: boolean;
  readonly generation: number;
  readonly bundled: SourceCatalog;
  readonly local: SourceCatalog;
  readonly pending: readonly SitePackChangeRecord[];
  readonly sites: readonly TemplateSiteRecord[];
  readonly loadedAt: number | null;
  /** The held registry index (T4b), `null` when none. */
  readonly held?: HeldIndex | null;
}

/** When the content in force was approved (older approvals keep contested domains). */
function approvedAtOf(r: ResolvedPack): number {
  const at = r.local?.approved != null ? r.state?.localApprovedAt : r.state?.approvedAt;
  return at ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Assigns domains and freezes the snapshot. Approved content claims first (oldest approval first),
 * then offers. A domain another pack already holds is never taken from it (spec 13 §9.10, review
 * #83 C-M1): an approved newcomer keeps its other domains and is reported `domain_overlap` naming
 * the owner; an overlapping offer is not offered.
 */
export function assembleSnapshot(
  resolved: readonly ResolvedPack[],
  input: AssembleInput,
): RegistrySnapshot {
  const approved = (r: ResolvedPack) => r.local?.approved != null || r.approved !== null;
  const tier = (r: ResolvedPack) => (approved(r) ? 0 : r.offer !== null ? 1 : 2);
  const ordered = [...resolved].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      approvedAtOf(a) - approvedAtOf(b) ||
      (a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : 0),
  );
  const byDomain = new Map<string, string>();
  const packs = new Map<string, PackEntry>();
  const listings = new Map<string, RegistryIndexPack>(
    (input.held?.index.packs ?? []).map((p) => [p.id, p]),
  );
  const resolveSkips: RegistrySnapshot['resolveSkips'][number][] = [];
  for (const r of ordered) {
    const content = r.local?.approved ?? r.approved ?? r.offer;
    const taken = (content?.pack.domains ?? []).filter((d) => {
      const owner = byDomain.get(d);
      return owner !== undefined && owner !== r.packId;
    });
    const first = taken[0];
    const overlap =
      first === undefined ? null : { domain: first, owner: byDomain.get(first) ?? '' };
    const isApproved = approved(r);
    let claimed = 0;
    if (content !== null && (overlap === null || isApproved)) {
      for (const d of content.pack.domains) {
        if (taken.includes(d)) continue;
        byDomain.set(d, r.packId);
        claimed += 1;
      }
    }
    const overlapSkip =
      overlap === null || content === null
        ? null
        : {
            packId: r.packId,
            version: content.pack.version,
            reason: 'domain_overlap' as const,
            detail: `${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} covered by the pack ${overlap.owner}${isApproved ? '; its other domains still apply' : ''}`,
          };
    const skipped = overlapSkip ?? r.skipped;
    if (skipped !== null && skipped !== r.local?.problem) {
      resolveSkips.push({ ...skipped, source: sourceOfSkip(r, skipped) });
    }
    packs.set(r.packId, {
      packId: r.packId,
      state: r.state,
      approved: r.approved,
      local: r.local,
      offer: overlap === null ? r.offer : null,
      effective: claimed > 0 ? effectiveOf(r, input.enabled) : null,
      display: (content ?? r.local?.current ?? r.candidate ?? null)?.pack ?? null,
      pending: input.pending
        .filter((p) => p.packId === r.packId)
        .sort((a, b) => (b.toVersion ?? 0) - (a.toVersion ?? 0)),
      usedBy: [
        ...new Set(input.sites.filter((s) => s.packId === r.packId).map((s) => s.templateId)),
      ],
      skipped,
      overlap,
      listing: listings.get(r.packId) ?? null,
      inBundle: r.bundled !== null,
    });
  }
  return {
    held: input.held ?? null,
    generation: input.generation,
    packs,
    byDomain,
    bundled: input.bundled,
    local: input.local,
    resolveSkips,
    loadedAt: input.loadedAt,
  };
}

function sourceOfSkip(r: ResolvedPack, skipped: SkippedPackVersion): SitePackSourceId {
  if (skipped.reason === 'domain_overlap') {
    return r.local?.approved != null ? 'local' : (r.state?.approvedSource ?? 'bundled');
  }
  return r.local !== null && r.state?.localApprovedSha256 != null && r.approved === null
    ? 'local'
    : (r.state?.approvedSource ?? 'bundled');
}

function effectiveOf(r: ResolvedPack, enabled: boolean): EffectivePack | null {
  if (!enabled || r.state?.enabled === false) return null;
  const local = r.local?.approved ?? null;
  const content = local ?? r.approved;
  if (content === null) return null;
  return {
    packId: r.packId,
    pack: content.pack,
    version: content.pack.version,
    sha256: content.sha256,
    source: local !== null ? 'local' : (r.state?.approvedSource ?? 'bundled'),
    localOverride: local !== null,
  };
}

/** The snapshot with `used_by` re-read from the template sites; `changed` lists the packs it moved. */
export function withUsage(
  snapshot: RegistrySnapshot,
  sites: readonly TemplateSiteRecord[],
): { snapshot: RegistrySnapshot; changed: string[] } {
  const packs = new Map(snapshot.packs);
  const changed: string[] = [];
  for (const [packId, entry] of snapshot.packs) {
    const usedBy = [...new Set(sites.filter((s) => s.packId === packId).map((s) => s.templateId))];
    if (usedBy.join() === entry.usedBy.join()) continue;
    packs.set(packId, { ...entry, usedBy });
    changed.push(packId);
  }
  return { snapshot: { ...snapshot, packs }, changed };
}
