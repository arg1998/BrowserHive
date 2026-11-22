/** @module app/site-packs/registry-reads — the registry's read side over a snapshot (spec 13 §11.1): the filtered catalog with counts, one pack's detail and versions, the field-level diff, the pending list, and the change and guard-hit histories. */

import type {
  SiteGuardHitsPage,
  SiteGuardHitsQuery,
  SitePackChangesPage,
  SitePackChangesQuery,
  SitePackDetailResponse,
  SitePackDiffQuery,
  SitePackDiffResponse,
  SitePacksQuery,
  SitePacksResponse,
  SitePackVersionRef,
  SitePackView,
} from '@browserhive/contracts/http';
import { newDomains } from '../../domain/site-packs/diff.ts';
import type {
  SiteGuardHitRepository,
  SitePackChangeRecord,
  SitePackChangeRepository,
} from '../../ports/persistence/site-packs.ts';
import type { SourcePackVersion } from '../../ports/site-packs.ts';
import { readCached, readSigned } from './registry-build.ts';
import { classifyForRow, usageOf } from './registry-classify.ts';
import { packConflict } from './registry-errors.ts';
import type {
  PackEntry,
  PendingUpdate,
  RegistrySnapshot,
  SitePackRegistryDeps,
} from './registry-types.ts';
import {
  followEffective,
  sourcesOf,
  toChangeRow,
  toGuardHitRow,
  toRegistryStatus,
} from './views.ts';

/** What the reads need besides the snapshot. */
export interface ReadFacts {
  readonly view: (entry: PackEntry) => SitePackView;
  readonly status: Parameters<typeof toRegistryStatus>[1];
  readonly now: number;
}

/**
 * What of the entry needs an operator: candidates of a followed, unpinned pack, a revocation's
 * decision whatever the pack's follow and pin (spec 13 §9.7), and a local file to approve.
 */
function needsReview(entry: PackEntry): { rows: SitePackChangeRecord[]; local: boolean } {
  const local =
    entry.local !== null && entry.local.current !== null && entry.local.state !== 'approved';
  const followed = followEffective(entry) && entry.state?.pinnedVersion == null;
  const rows = entry.pending.filter((row) => followed || row.classification === 'revoked');
  return { rows, local };
}

/** `GET /site-packs`. */
export function listPacks(
  snapshot: RegistrySnapshot,
  query: SitePacksQuery,
  facts: ReadFacts,
): SitePacksResponse {
  const q = query.q?.toLowerCase();
  const entries = [...snapshot.packs.values()].filter((entry) => {
    const display = entry.display;
    if (q !== undefined && q !== '') {
      const hay = [entry.packId, display?.title ?? '', ...(display?.domains ?? [])]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (query.source !== undefined && query.source.length > 0) {
      const sources = new Set(query.source);
      const known = new Set(sourcesOf(entry));
      const matches =
        (sources.has('local') && known.has('local')) ||
        (sources.has('bundled') && known.has('bundled')) ||
        (sources.has('registry') && known.has('remote')) ||
        (sources.has('import') && known.has('import'));
      if (!matches) return false;
    }
    if (query.pending !== undefined) {
      const review = needsReview(entry);
      if ((review.rows.length > 0 || review.local) !== query.pending) return false;
    }
    if (query.follow !== undefined && followEffective(entry) !== query.follow) return false;
    return true;
  });
  let pendingCount = 0;
  let localNeeding = 0;
  for (const entry of snapshot.packs.values()) {
    const review = needsReview(entry);
    pendingCount += review.rows.length;
    if (review.local) localNeeding += 1;
  }
  return {
    data: entries.map(facts.view),
    status: toRegistryStatus(snapshot, facts.status),
    pending_count: pendingCount,
    local_needing_approval: localNeeding,
    now: facts.now,
  };
}

/** `GET /site-packs/{pack_id}`. */
export function packDetail(entry: PackEntry, facts: ReadFacts): SitePackDetailResponse {
  const versions: SitePackDetailResponse['versions'] = [];
  const state = entry.state;
  if (state?.approvedVersion != null && state.approvedSha256 !== null && state.approvedSource) {
    versions.push({
      version: state.approvedVersion,
      sha256: state.approvedSha256,
      source: state.approvedSource,
      state: 'approved',
    });
  }
  if (state?.previousVersion != null && state.previousSha256 !== null && state.previousSource) {
    versions.push({
      version: state.previousVersion,
      sha256: state.previousSha256,
      source: state.previousSource,
      state: 'previous',
    });
  }
  for (const row of entry.pending) {
    versions.push({
      version: row.toVersion,
      sha256: row.toSha256,
      source: row.source,
      state: 'pending',
    });
  }
  if (entry.offer !== null) {
    versions.push({ ...ref(entry.offer, 'bundled'), state: 'offered' });
  }
  if (entry.local?.current != null) {
    versions.push({ ...ref(entry.local.current, 'local'), state: 'local' });
  }
  return { view: facts.view(entry), pack: entry.display, versions };
}

function ref(version: SourcePackVersion, source: SitePackVersionRef['source']): SitePackVersionRef {
  return { version: version.pack.version, sha256: version.sha256, source };
}

/**
 * `GET /site-packs/{pack_id}/diff`: a pending version or the local file against the approved one,
 * classified with the templates' current settings (spec 13 §9.7).
 */
export async function diffOf(
  entry: PackEntry,
  snapshot: RegistrySnapshot,
  query: SitePackDiffQuery,
  deps: Pick<SitePackRegistryDeps, 'cache' | 'binaryVersion' | 'repos'>,
): Promise<SitePackDiffResponse> {
  let to: { content: SourcePackVersion; source: SitePackVersionRef['source'] };
  if (query.to === 'local') {
    const current = entry.local?.current ?? null;
    if (current === null) throw packConflict(`${entry.packId} has no valid local file`);
    to = { content: current, source: 'local' };
  } else {
    const version = query.to;
    const row = entry.pending.find((p) => p.toVersion === version && p.decision === 'downloaded');
    const content =
      row === undefined
        ? null
        : (snapshot.bundled.packs.find((p) => p.sha256 === row.toSha256) ??
          (row.classification === 'revoked'
            ? await readCached(
                deps.cache,
                row.source,
                entry.packId,
                row.toSha256,
                deps.binaryVersion,
              )
            : row.source === 'remote' || row.source === 'import'
              ? await readSigned(
                  deps.cache,
                  entry.packId,
                  row.toSha256,
                  deps.binaryVersion,
                  row.source,
                )
              : null));
    // The previous approved version too: what Revert restores, classified like Apply (review #84 L4).
    const found =
      row !== undefined && content !== undefined && content !== null
        ? { content, source: row.source }
        : await previousOf(entry, snapshot, version, deps);
    if (found === null) {
      throw packConflict(`version ${version} of ${entry.packId} is not downloaded`);
    }
    to = found;
  }
  const from = await fromOf(entry, query, to.source === 'local', deps);
  const ctx = await usageOf(deps.repos, entry.packId);
  const classified = classifyForRow(from?.content.pack ?? null, to.content.pack, ctx);
  return {
    from: from === null ? null : ref(from.content, from.source),
    to: ref(to.content, to.source),
    classification: classified.classification,
    new_domains: [...newDomains(from?.content.pack ?? null, to.content.pack)],
    changes: classified.diff.map((c) => ({ ...c })),
  };
}

/** The previous approved version's content when it is `version` (the release's bytes, else BrowserHive's copy). */
async function previousOf(
  entry: PackEntry,
  snapshot: RegistrySnapshot,
  version: number,
  deps: Pick<SitePackRegistryDeps, 'cache' | 'binaryVersion'>,
): Promise<{ content: SourcePackVersion; source: SitePackVersionRef['source'] } | null> {
  const state = entry.state;
  if (
    state === null ||
    state.previousVersion !== version ||
    state.previousSha256 === null ||
    state.previousSource === null
  ) {
    return null;
  }
  const sha = state.previousSha256;
  const bundled = snapshot.bundled.packs.find((p) => p.sha256 === sha);
  if (state.previousSource === 'bundled' && bundled !== undefined) {
    return { content: bundled, source: 'bundled' };
  }
  const cached = await readCached(
    deps.cache,
    state.previousSource,
    entry.packId,
    sha,
    deps.binaryVersion,
  );
  return cached === null ? null : { content: cached, source: state.previousSource };
}

async function fromOf(
  entry: PackEntry,
  query: SitePackDiffQuery,
  local: boolean,
  deps: Pick<SitePackRegistryDeps, 'cache' | 'binaryVersion'>,
): Promise<{ content: SourcePackVersion; source: SitePackVersionRef['source'] } | null> {
  const state = entry.state;
  if (query.from === undefined) {
    if (local && entry.local?.approved != null)
      return { content: entry.local.approved, source: 'local' };
    if (entry.approved !== null && state?.approvedSource) {
      return { content: entry.approved, source: state.approvedSource };
    }
    return null;
  }
  if (
    entry.approved !== null &&
    entry.approved.pack.version === query.from &&
    state?.approvedSource
  ) {
    return { content: entry.approved, source: state.approvedSource };
  }
  if (
    state?.previousVersion === query.from &&
    state.previousSha256 !== null &&
    state.previousSource !== null
  ) {
    const cached = await readCached(
      deps.cache,
      state.previousSource,
      entry.packId,
      state.previousSha256,
      deps.binaryVersion,
    );
    if (cached !== null) return { content: cached, source: state.previousSource };
  }
  throw packConflict(`version ${query.from} of ${entry.packId} is not available to compare`);
}

/** Pending candidates of followed, unpinned packs and local files waiting for approval. */
export function pendingOf(snapshot: RegistrySnapshot): readonly PendingUpdate[] {
  const out: PendingUpdate[] = [];
  for (const entry of snapshot.packs.values()) {
    const title = entry.display?.title ?? entry.packId;
    const review = needsReview(entry);
    for (const row of review.rows) {
      if (row.toVersion === null) continue;
      out.push({
        kind: 'candidate',
        packId: entry.packId,
        title,
        fromVersion: entry.state?.approvedVersion ?? null,
        toVersion: row.toVersion,
        sha256: row.toSha256,
        source: row.source,
        classification: row.classification,
      });
    }
    const current = entry.local?.current ?? null;
    if (
      review.local &&
      current !== null &&
      entry.local !== null &&
      entry.local.state !== 'approved'
    ) {
      out.push({
        kind: 'local',
        packId: entry.packId,
        title,
        state: entry.local.state,
        sha256: current.sha256,
        version: current.pack.version,
      });
    }
  }
  return out;
}

/** `GET /site-packs/changes`. */
export async function listChanges(
  repo: SitePackChangeRepository,
  query: SitePackChangesQuery,
  now: number,
): Promise<SitePackChangesPage> {
  const page = await repo.list({
    limit: query.limit,
    ...(query.cursor !== undefined && { cursor: query.cursor }),
    ...(query.pack_id !== undefined && { packId: query.pack_id }),
    ...(query.decision !== undefined && { decisions: query.decision }),
    window: {
      ...(query.since !== undefined && { since: query.since }),
      ...(query.until !== undefined && { until: query.until }),
    },
  });
  return {
    data: page.items.map(toChangeRow),
    page: { next_cursor: page.nextCursor, limit: query.limit },
    applied: {
      filters: {
        ...(query.pack_id !== undefined && { pack_id: query.pack_id }),
        ...(query.decision !== undefined && { decision: query.decision }),
      },
      sort: { key: 'seq', dir: 'desc' },
    },
    meta: { now },
  };
}

/** `GET /site-packs/guard-hits`. */
export async function listGuardHits(
  repo: SiteGuardHitRepository,
  query: SiteGuardHitsQuery,
  now: number,
): Promise<SiteGuardHitsPage> {
  const page = await repo.list({
    limit: query.limit,
    ...(query.cursor !== undefined && { cursor: query.cursor }),
    ...(query.template_id !== undefined && { templateId: query.template_id }),
    ...(query.session_id !== undefined && { sessionId: query.session_id }),
    ...(query.pack_id !== undefined && { packId: query.pack_id }),
    ...(query.action !== undefined && { actions: query.action }),
    window: {
      ...(query.since !== undefined && { since: query.since }),
      ...(query.until !== undefined && { until: query.until }),
    },
  });
  return {
    data: page.items.map(toGuardHitRow),
    page: { next_cursor: page.nextCursor, limit: query.limit },
    applied: {
      filters: {
        ...(query.template_id !== undefined && { template_id: query.template_id }),
        ...(query.session_id !== undefined && { session_id: query.session_id }),
        ...(query.pack_id !== undefined && { pack_id: query.pack_id }),
        ...(query.action !== undefined && { action: query.action }),
      },
      sort: { key: 'ts', dir: 'desc' },
    },
    meta: { now },
  };
}
