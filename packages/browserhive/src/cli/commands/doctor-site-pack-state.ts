/** @module cli/commands/doctor-site-pack-state — what the `site packs` row of `doctor` learns from the stored approvals (spec 13 §11.9, review #83 S-M8, C-M5): it resolves them against the bundled and local packs and BrowserHive's approved copies exactly as the registry does, and names approved packs that do not apply (`domain_overlap`, a missing approved copy, an unreadable row) and the pending updates of followed packs (review #100 L11). Read-only: nothing is written. */
import { join } from 'node:path';
import { SITE_PACK_MAX_BYTES } from '@browserhive/contracts/site-packs';
import type { TemplateSiteRecord } from '@browserhive/core/ports/persistence/records-templates';
import type {
  SitePackChangeRecord,
  SitePackStateRecord,
} from '@browserhive/core/ports/persistence/site-packs';
import type { SitePackCache } from '@browserhive/core/ports/site-pack-files';
import type { SourceCatalog, SourcePackVersion } from '@browserhive/core/ports/site-packs';
import { assembleSnapshot, resolvePacks } from '@browserhive/core/server';
import type { CliDeps } from '../deps.ts';

type Deps = Pick<CliDeps, 'fs'>;

/** Inputs of {@link resolvedProblems}. */
export interface ResolveCheckInput {
  readonly dataDir: string;
  readonly localDir: string;
  readonly binaryVersion: string;
  readonly bundled: readonly SourcePackVersion[];
  readonly local: readonly SourcePackVersion[];
  readonly states: readonly SitePackStateRecord[];
  /** Packs whose stored row cannot be read. */
  readonly unreadable: readonly string[];
  /** Open candidates (`site_pack_changes` rows waiting for a decision). */
  readonly pending: readonly SitePackChangeRecord[];
  readonly sites: readonly TemplateSiteRecord[];
}

/** What the stored approvals say. */
export interface ResolvedFacts {
  /** Approved packs that do not apply, as `id (reason: detail)`, plus unreadable rows. */
  readonly notInForce: string[];
  /**
   * Pending versions of followed, unpinned packs (and revoked fallbacks, which wait whatever the
   * follow setting), as `id vN`: the same rule as the server's `pending_count` (spec 13 §10.6).
   */
  readonly pending: string[];
}

/** BrowserHive's approved copies, read through the doctor's filesystem (never written). */
function readOnlyCache(deps: Deps, dataDir: string): SitePackCache {
  const pathOf: SitePackCache['pathOf'] = (source, packId, sha256) =>
    join(dataDir, 'site-packs', 'cache', source, packId, `${sha256}.json`);
  return {
    pathOf,
    put: () => Promise.reject(new Error('doctor never writes the pack cache')),
    async get(source, packId, sha256) {
      const path = pathOf(source, packId, sha256);
      const stat = await deps.fs.stat(path).catch(() => null);
      if (stat === null || !stat.isFile || stat.sizeBytes > SITE_PACK_MAX_BYTES) return null;
      try {
        return new TextEncoder().encode(await deps.fs.readFile(path));
      } catch {
        return null;
      }
    },
  };
}

function catalog(source: 'bundled' | 'local', packs: readonly SourcePackVersion[]): SourceCatalog {
  return { source, packs, skipped: [], signedLayouts: 0 };
}

/**
 * Pending versions as the server counts them (`pending_count`): of packs followed explicitly or
 * while a template uses them, and not pinned; a revoked fallback waits regardless (review #100 L11).
 * Counted from the stored rows, so a pack only the registry lists is included too.
 */
function followedPending(input: ResolveCheckInput): string[] {
  const states = new Map(input.states.map((s) => [s.packId, s]));
  const used = new Set(input.sites.flatMap((site) => (site.packId === null ? [] : [site.packId])));
  const out = new Set<string>();
  for (const row of input.pending) {
    if (row.toVersion === null) continue;
    const state = states.get(row.packId);
    const followed = (state?.follow ?? used.has(row.packId)) && state?.pinnedVersion == null;
    if (followed || row.classification === 'revoked') out.add(`${row.packId} v${row.toVersion}`);
  }
  return [...out].sort();
}

/**
 * Approved packs that do not apply, and pending updates of followed packs.
 *
 * @returns The facts.
 */
export async function resolvedFacts(deps: Deps, input: ResolveCheckInput): Promise<ResolvedFacts> {
  const bundled = catalog('bundled', input.bundled);
  const local = catalog('local', input.local);
  const resolved = await resolvePacks({
    bundled,
    local,
    localDir: input.localDir,
    states: input.states,
    cache: readOnlyCache(deps, input.dataDir),
    binaryVersion: input.binaryVersion,
    corrupt: new Set(input.unreadable),
  });
  const snapshot = assembleSnapshot(resolved, {
    enabled: true,
    generation: 0,
    bundled,
    local,
    pending: [],
    sites: [],
    loadedAt: null,
  });
  const out: string[] = [];
  const pending = followedPending(input);
  for (const entry of snapshot.packs.values()) {
    const skipped = entry.skipped;
    if (skipped === null) continue;
    const approved =
      entry.state?.approvedSha256 != null || entry.state?.localApprovedSha256 != null;
    const relevant =
      skipped.reason === 'unreadable' || skipped.reason === 'domain_overlap' || approved;
    // An invalid local file is reported with the local files.
    if (!relevant || skipped === entry.local?.problem) continue;
    out.push(`${entry.packId} (${skipped.reason}: ${skipped.detail})`);
  }
  return { notInForce: out, pending };
}
