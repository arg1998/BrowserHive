/** @module app/site-packs/registry-build — builds the registry's snapshot (spec 13 §9.6, §10.5, D-67): resolves each pack id's approved content (its source's bytes when the hash matches, else BrowserHive's copy), the local file's state and approved content, the offer for first use; then assigns registrable domains by precedence (approved local content > approved other source > offer; a pack claiming a taken domain is skipped `domain_overlap`). */

import { join } from 'node:path';
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
import type { LocalEntry, PackEntry, RegistrySnapshot } from './registry-types.ts';

/** A pack id with its contents resolved, before domains are assigned. */
export interface ResolvedPack {
  readonly packId: string;
  readonly state: SitePackStateRecord | null;
  readonly approved: SourcePackVersion | null;
  readonly local: LocalEntry | null;
  readonly offer: SourcePackVersion | null;
  /** The bundled version this release ships (a candidate when newer than the approved one). */
  readonly bundled: SourcePackVersion | null;
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
    ...input.states
      .filter((s) => s.approvedSha256 !== null || s.localApprovedSha256 !== null)
      .map((s) => s.packId),
  ]);
  const out: ResolvedPack[] = [];
  for (const packId of [...ids].sort()) {
    const state = states.get(packId) ?? null;
    const current = bundled.get(packId) ?? null;
    let skipped: SkippedPackVersion | null = null;
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
    out.push({
      packId,
      state,
      approved: approvedContent,
      local: local.entry,
      offer: nothingApproved ? current : null,
      bundled: current,
      skipped: skipped ?? local.entry?.problem ?? null,
    });
  }
  return out;
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
}

/** Assigns domains by precedence and freezes the snapshot. */
export function assembleSnapshot(
  resolved: readonly ResolvedPack[],
  input: AssembleInput,
): RegistrySnapshot {
  const tier = (r: ResolvedPack) =>
    r.local?.approved != null ? 0 : r.approved !== null ? 1 : r.offer !== null ? 2 : 3;
  const ordered = [...resolved].sort(
    (a, b) => tier(a) - tier(b) || (a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : 0),
  );
  const byDomain = new Map<string, string>();
  const packs = new Map<string, PackEntry>();
  const resolveSkips: RegistrySnapshot['resolveSkips'][number][] = [];
  for (const r of ordered) {
    const content = r.local?.approved ?? r.approved ?? r.offer;
    let overlap: SkippedPackVersion | null = null;
    if (content !== null) {
      const taken = content.pack.domains.find((d) => {
        const owner = byDomain.get(d);
        return owner !== undefined && owner !== r.packId;
      });
      if (taken === undefined) {
        for (const d of content.pack.domains) byDomain.set(d, r.packId);
      } else {
        overlap = {
          packId: r.packId,
          version: content.pack.version,
          reason: 'domain_overlap',
          detail: `${taken} belongs to the pack ${byDomain.get(taken) ?? ''}`,
        };
      }
    }
    const skipped = overlap ?? r.skipped;
    if (skipped !== null && skipped !== r.local?.problem) {
      resolveSkips.push({ ...skipped, source: sourceOfSkip(r, skipped) });
    }
    packs.set(r.packId, {
      packId: r.packId,
      state: r.state,
      approved: r.approved,
      local: r.local,
      offer: overlap === null ? r.offer : null,
      effective: overlap === null ? effectiveOf(r, input.enabled) : null,
      display: (content ?? r.local?.current ?? null)?.pack ?? null,
      pending: input.pending
        .filter((p) => p.packId === r.packId)
        .sort((a, b) => (b.toVersion ?? 0) - (a.toVersion ?? 0)),
      usedBy: [
        ...new Set(input.sites.filter((s) => s.packId === r.packId).map((s) => s.templateId)),
      ],
      skipped,
    });
  }
  return {
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
