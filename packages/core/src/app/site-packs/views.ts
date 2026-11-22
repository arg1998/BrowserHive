/** @module app/site-packs/views — snapshot entries and rows → the wire shapes of spec 13 §11.1: `SitePackView`, `RegistryStatus`, a template site's `TemplateSitePack`, change rows and guard hits. */

import type {
  SiteGuardHitRow,
  SitePackChangeRow,
  SitePackPending,
  SitePackProvenance,
  SitePackRegistryStats,
  SitePackRegistryStatus,
  SitePackView,
  TemplateSitePack,
} from '@browserhive/contracts/http';
import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import {
  bestUsable,
  neededClient,
  newestListed,
} from '../../domain/site-packs/registry-listing.ts';
import type {
  SiteGuardHitRecord,
  SitePackChangeRecord,
  SitePackProvenanceRecord,
} from '../../ports/persistence/site-packs.ts';
import type { EffectivePack } from '../../ports/site-packs.ts';
import { baselineOf } from './registry-core.ts';
import type {
  HeldIndex,
  PackEntry,
  RegistrySnapshot,
  RemoteStatusPart,
  SourceStats,
} from './registry-types.ts';

/** What the views read from the registry client (T4b). */
export interface RemoteViewFacts {
  readonly held: HeldIndex | null;
  readonly binaryVersion: string;
  /** Auto-update paused for a pack after an operator's revert or reject (D-87). */
  readonly autoPaused?: (packId: string) => boolean;
  /** The last refused download of a file. */
  readonly refusal?: (
    sha256: string,
  ) => { readonly reason: string; readonly detail: string } | null;
  /** Provenance of a pending remote or imported version. */
  readonly provenance: (
    source: 'remote' | 'import',
    sha256: string,
  ) => SitePackProvenanceRecord | null;
}

const NO_REMOTE: RemoteViewFacts = { held: null, binaryVersion: '0.0.0', provenance: () => null };

/** Provenance record → wire. */
export function toProvenance(record: SitePackProvenanceRecord): SitePackProvenance {
  switch (record.kind) {
    case 'bundled':
      return { kind: 'bundled', release: record.release };
    case 'remote':
      return { kind: 'remote', key_id: record.keyId, index_version: record.indexVersion };
    case 'import':
      return {
        kind: 'import',
        file: record.file,
        ...(record.keyId !== undefined && { key_id: record.keyId }),
        ...(record.indexVersion !== undefined && { index_version: record.indexVersion }),
      };
    case 'local':
      return { kind: 'local', path: record.path };
  }
}

/** Whether a pack's follow setting applies (`null` = automatic: while a template uses it). */
export function followEffective(entry: PackEntry): boolean {
  return entry.state?.follow ?? entry.usedBy.length > 0;
}

/** One pack for operators. */
export function toSitePackView(
  entry: PackEntry,
  release: string,
  sizeOf: (sha256: string) => number | null = () => null,
  remote: RemoteViewFacts = NO_REMOTE,
): SitePackView {
  const { state, display } = entry;
  const local = entry.local;
  const follow = state?.follow ?? null;
  const listed = (sha: string) => entry.listing?.versions.find((v) => v.sha256 === sha) ?? null;
  return {
    pack_id: entry.packId,
    title: display?.title ?? entry.listing?.title ?? entry.packId,
    domains: [...(display?.domains ?? [])],
    identity_provider: display?.identity_provider ?? null,
    sources: sourcesOf(entry),
    online: onlineOf(entry, remote.binaryVersion),
    approved_revoked: approvedRevoked(entry),
    auto_update_paused: remote.autoPaused?.(entry.packId) ?? false,
    approved: approvedOf(entry),
    offer:
      entry.offer === null
        ? null
        : {
            version: entry.offer.pack.version,
            sha256: entry.offer.sha256,
            source: 'bundled',
            provenance: { kind: 'bundled', release: entry.offer.origin },
          },
    previous:
      state?.previousVersion == null || state.previousSource === null
        ? null
        : { version: state.previousVersion, source: state.previousSource },
    pinned_version: state?.pinnedVersion ?? null,
    follow: {
      setting: follow === null ? 'auto' : follow ? 'on' : 'off',
      effective: followEffective(entry),
    },
    enabled: state?.enabled ?? true,
    local:
      local === null
        ? null
        : {
            path: local.path,
            sha256: local.current?.sha256 ?? null,
            state: local.state,
            approved_sha256: state?.localApprovedSha256 ?? null,
            problem: local.problem?.detail ?? null,
          },
    local_override: entry.effective?.localOverride ?? false,
    pending: entry.pending.flatMap((row) =>
      pendingOf(row, release, sizeOf, listed, remote, baselineRef(entry)),
    ),
    used_by: [...entry.usedBy],
    human_only: display?.sign_in?.human_only ?? false,
    write_policy_default: display?.write_policy.default ?? 'allow',
    write_guards: display == null ? 0 : writeGuardsOf(display),
    stance: display?.write_policy.stance ?? 'allowed',
    verified: { ...(display?.verified ?? {}) },
    ...(entry.skipped !== null && {
      skipped: {
        version: entry.skipped.version,
        reason: entry.skipped.reason,
        detail: entry.skipped.detail,
      },
    }),
  };
}

function approvedOf(entry: PackEntry): SitePackView['approved'] {
  const state = entry.state;
  if (state === null) return null;
  if (
    state.approvedVersion !== null &&
    state.approvedSha256 !== null &&
    state.approvedSource !== null
  ) {
    return {
      version: state.approvedVersion,
      sha256: state.approvedSha256,
      source: state.approvedSource,
      provenance: state.approvedProvenance === null ? null : toProvenance(state.approvedProvenance),
      by: state.approvedBy,
      at: state.approvedAt,
    };
  }
  const local = entry.local?.approved ?? null;
  if (local === null || state.localApprovedSha256 === null) return null;
  return {
    version: local.pack.version,
    sha256: state.localApprovedSha256,
    source: 'local',
    provenance: { kind: 'local', path: state.localPath ?? local.origin },
    by: state.localApprovedBy,
    at: state.localApprovedAt,
  };
}

function pendingOf(
  row: SitePackChangeRecord,
  release: string,
  sizeOf: (sha256: string) => number | null,
  listed: (sha256: string) => { readonly size: number; readonly released: string } | null,
  remote: RemoteViewFacts,
  from: SitePackPending['from'],
): SitePackPending[] {
  if (row.toVersion === null || (row.decision !== 'available' && row.decision !== 'downloaded')) {
    return [];
  }
  const entry = listed(row.toSha256);
  const provenance: SitePackProvenance | null =
    row.source === 'bundled'
      ? { kind: 'bundled', release }
      : row.source === 'remote' || row.source === 'import'
        ? provenanceOrNull(remote.provenance(row.source, row.toSha256))
        : null;
  return [
    {
      version: row.toVersion,
      sha256: row.toSha256,
      state: row.decision,
      size: sizeOf(row.toSha256) ?? entry?.size ?? null,
      released: entry?.released ?? null,
      notes: row.notes,
      classification: row.classification,
      new_domains: [...row.newDomains],
      source: row.source,
      provenance,
      from,
      refused: remote.refusal?.(row.toSha256) ?? null,
    },
  ];
}

/** What a pending version is compared with (`pending[].from`). */
function baselineRef(entry: PackEntry): SitePackPending['from'] {
  const base = baselineOf(entry);
  return base === null ? null : { version: base.version, source: base.source };
}

function provenanceOrNull(record: SitePackProvenanceRecord | null): SitePackProvenance | null {
  return record === null ? null : toProvenance(record);
}

/** Every source that knows the pack (spec 13 §11.4 filter chips). */
export function sourcesOf(entry: PackEntry): SitePackView['sources'] {
  const out = new Set<SitePackView['sources'][number]>();
  const approved = entry.state?.approvedSource ?? null;
  if (entry.inBundle || approved === 'bundled') out.add('bundled');
  if (entry.listing !== null || approved === 'remote') out.add('remote');
  if (approved === 'import' || entry.pending.some((p) => p.source === 'import')) out.add('import');
  if (entry.local !== null || approved === 'local') out.add('local');
  return (['bundled', 'remote', 'import', 'local'] as const).filter((s) => out.has(s));
}

function onlineOf(entry: PackEntry, binaryVersion: string): SitePackView['online'] {
  const listing = entry.listing;
  if (listing === null) return null;
  const newest = newestListed(listing);
  if (newest === null) return null;
  return {
    version: newest.v,
    sha256: newest.sha256,
    size: newest.size,
    released: newest.released,
    notes: newest.notes,
    revoked: newest.revoked === true,
    needs_client: neededClient(newest, binaryVersion),
    usable_version: bestUsable(listing, binaryVersion)?.v ?? null,
    declined: entry.declined === true,
  };
}

/** The approved version is in force and the held index marks it (same bytes) revoked. */
export function approvedRevoked(entry: PackEntry): boolean {
  const state = entry.state;
  if (state?.approvedVersion == null || state.approvedSha256 === null) return false;
  if (entry.effective === null || entry.effective.localOverride) return false;
  const listed = entry.listing?.versions.find(
    (v) => v.v === state.approvedVersion && v.sha256 === state.approvedSha256,
  );
  return listed?.revoked === true;
}

/** The registry's status (registry-client fields stay empty until T4b). */
export function toRegistryStatus(
  snapshot: RegistrySnapshot,
  facts: {
    readonly enabled: boolean;
    readonly release: string;
    readonly builtAt: number | null;
    readonly localDir: string;
    /** The registry client's part (T4b); `null`: no client (tests, `sitePacks=false`). */
    readonly remote?: RemoteStatusPart | null;
  },
): SitePackRegistryStatus {
  const remote = facts.remote ?? null;
  const needing = [...snapshot.packs.values()].filter(
    (e) => e.local !== null && e.local.current !== null && e.local.state !== 'approved',
  ).length;
  const { layoutSkips = [], ...client } = remote ?? {};
  return {
    enabled: facts.enabled,
    update_check: false,
    check_off: facts.enabled ? 'update_check_off' : 'packs_off',
    trusts_registry: false,
    auto_update: false,
    url: null,
    last_check_at: null,
    last_ok_at: null,
    last_outcome: null,
    last_error: null,
    failures: 0,
    next_check_at: null,
    index_version: null,
    index_issued_at: null,
    index_expires_at: null,
    index_signed_by: null,
    index_packs: 0,
    index_origin: null,
    stale: false,
    keys_version: null,
    snapshot: null,
    ...client,
    bundled: {
      version: facts.release,
      built_at: facts.builtAt,
      count: snapshot.bundled.packs.length,
    },
    local: {
      dir: facts.localDir,
      count: snapshot.local.packs.length,
      signed_layouts: snapshot.local.signedLayouts,
      needing_approval: needing,
    },
    skipped: [
      ...snapshot.bundled.skipped.map((s) => ({ ...s, source: 'bundled' as const })),
      ...snapshot.local.skipped.map((s) => ({ ...s, source: 'local' as const })),
      ...snapshot.resolveSkips,
      ...layoutSkips.map((s) => ({ ...s, source: 'import' as const })),
    ].map((s) => ({
      pack_id: s.packId,
      version: s.version,
      source: s.source,
      reason: s.reason,
      detail: s.detail,
    })),
    last_load_at: snapshot.loadedAt,
  };
}

/** What the last load found, per source. */
export function toRegistryStats(
  stats: readonly SourceStats[],
  loadedAt: number,
): SitePackRegistryStats {
  return {
    loaded_at: loadedAt,
    sources: stats.map((s) => ({
      source: s.source,
      loaded: s.loaded,
      skipped: s.skipped.map((k) => ({
        pack_id: k.packId,
        version: k.version,
        reason: k.reason,
        detail: k.detail,
      })),
    })),
  };
}

/** The pack in force for a template site (spec 13 §11.4 Sites tab). */
export function toTemplateSitePack(
  effective: EffectivePack,
  humanOnly: boolean,
  enabled: boolean,
): TemplateSitePack {
  const pack: SitePackV1 = effective.pack;
  const policy = pack.write_policy;
  return {
    pack_id: effective.packId,
    title: pack.title,
    version: effective.version,
    sha256: effective.sha256,
    source: effective.source,
    local_override: effective.localOverride,
    identity_provider: pack.identity_provider ?? null,
    human_only: humanOnly,
    sign_in_url:
      pack.sign_in === undefined
        ? null
        : `https://${pack.sign_in.url.host}${pack.sign_in.url.path}`,
    stance: policy.stance,
    write_policy_default: policy.default,
    write_guards: writeGuardsOf(pack),
    clause: policy.clause === undefined ? null : { ...policy.clause },
    exception: policy.exception ?? null,
    guards: pack.guards.length,
    element_guards: pack.element_guards.length,
    challenges: pack.challenges.length,
    enabled,
  };
}

/** One `site_pack_changes` row. */
export function toChangeRow(record: SitePackChangeRecord): SitePackChangeRow {
  return {
    seq: record.seq,
    event_id: record.eventId,
    pack_id: record.packId,
    from_version: record.fromVersion,
    to_version: record.toVersion,
    to_sha256: record.toSha256,
    source: record.source,
    classification: record.classification,
    new_domains: [...record.newDomains],
    notes: record.notes,
    decision: record.decision,
    decided_by: record.decidedBy,
    created_at: record.createdAt,
    decided_at: record.decidedAt,
  };
}

/** One `site_guard_hits` row. */
export function toGuardHitRow(record: SiteGuardHitRecord): SiteGuardHitRow {
  return {
    event_id: record.eventId,
    session_id: record.sessionId,
    template_id: record.templateId,
    pack_id: record.packId,
    guard_id: record.guardId,
    guard_kind: record.guardKind,
    action: record.action,
    outcome: record.outcome,
    decided_by: record.decidedBy,
    source: record.source,
    method: record.method,
    url: record.url,
    request_id: record.requestId,
    tool: record.tool,
    ts: record.ts,
  };
}

/** Guards and element guards of kind `write`: what a write policy acts on (0 = nothing yet). */
export function writeGuardsOf(pack: Pick<SitePackV1, 'guards' | 'element_guards'>): number {
  return (
    pack.guards.filter((g) => g.kind === 'write').length +
    pack.element_guards.filter((g) => g.kind === 'write').length
  );
}
