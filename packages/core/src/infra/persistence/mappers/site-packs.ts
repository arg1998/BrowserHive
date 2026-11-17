/** @module infra/persistence/mappers/site-packs — `site_pack_state` / `site_pack_changes` / `site_guard_hits` rows ↔ records (spec 13 §9.9). JSON columns hold snake_case shapes and are parsed, never cast. */

import type { Insertable, Selectable } from 'kysely';
import { z } from 'zod';
import {
  SITE_GUARD_ACTIONS,
  SITE_GUARD_KINDS,
  SITE_GUARD_OUTCOMES,
  SITE_GUARD_SOURCES,
  SITE_PACK_CLASSIFICATIONS,
  SITE_PACK_DECISIONS,
  SITE_PACK_SOURCES,
  type SiteGuardHitRecord,
  type SitePackChangeFieldRecord,
  type SitePackChangeRecord,
  type SitePackProvenanceRecord,
  type SitePackStateRecord,
} from '../../../ports/persistence/site-packs.ts';
import type { SiteGuardHits, SitePackChanges, SitePackState } from '../generated/db.d.ts';
import { boolToInt, intToBool, parseEnum, parseEnumOrNull, parseStringArray } from './codec.ts';
import { parseWith } from './templates.ts';

/** `approved_provenance_json`: what the operator was shown at approval. */
const provenanceJson = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bundled'), release: z.string() }),
  z.object({ kind: z.literal('remote'), key_id: z.string(), index_version: z.number() }),
  z.object({ kind: z.literal('import'), file: z.string() }),
  z.object({ kind: z.literal('local'), path: z.string() }),
]);

/** `diff_json`: one element per changed field; `class` is `null` until T3b's classifier. */
const diffJson = z.array(
  z.object({
    path: z.string(),
    from: z.unknown(),
    to: z.unknown(),
    class: z.enum(['tightening', 'restrictive', 'loosening', 'neutral']).nullable(),
  }),
);

function provenanceFromJson(text: string | null, where: string): SitePackProvenanceRecord | null {
  if (text === null) return null;
  const j = parseWith(provenanceJson, text, `${where}.approved_provenance_json`);
  switch (j.kind) {
    case 'bundled':
      return { kind: 'bundled', release: j.release };
    case 'remote':
      return { kind: 'remote', keyId: j.key_id, indexVersion: j.index_version };
    case 'import':
      return { kind: 'import', file: j.file };
    case 'local':
      return { kind: 'local', path: j.path };
  }
}

function provenanceToJson(p: SitePackProvenanceRecord | null): string | null {
  if (p === null) return null;
  switch (p.kind) {
    case 'bundled':
      return JSON.stringify({ kind: 'bundled', release: p.release });
    case 'remote':
      return JSON.stringify({ kind: 'remote', key_id: p.keyId, index_version: p.indexVersion });
    case 'import':
      return JSON.stringify({ kind: 'import', file: p.file });
    case 'local':
      return JSON.stringify({ kind: 'local', path: p.path });
  }
}

function diffFromJson(text: string | null, where: string): SitePackChangeFieldRecord[] | null {
  if (text === null) return null;
  return parseWith(diffJson, text, `${where}.diff_json`).map((f) => ({
    path: f.path,
    from: f.from,
    to: f.to,
    class: f.class,
  }));
}

/** `diff_json` of a classified diff (also written alone by `classify`). */
export function diffToJson(diff: readonly SitePackChangeFieldRecord[] | null): string | null {
  if (diff === null) return null;
  return JSON.stringify(
    diff.map((f) => ({ path: f.path, from: f.from, to: f.to, class: f.class })),
  );
}

/** `site_pack_state` row → record. */
export function sitePackStateFromRow(row: Selectable<SitePackState>): SitePackStateRecord {
  const where = `site_pack_state.${row.pack_id}`;
  return {
    packId: row.pack_id,
    approvedVersion: row.approved_version,
    approvedSha256: row.approved_sha256,
    approvedSource: parseEnumOrNull(SITE_PACK_SOURCES, row.approved_source, where),
    approvedProvenance: provenanceFromJson(row.approved_provenance_json, where),
    approvedDomains: parseStringArray(row.approved_domains_json, `${where}.approved_domains_json`),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    previousVersion: row.previous_version,
    previousSha256: row.previous_sha256,
    previousSource: parseEnumOrNull(SITE_PACK_SOURCES, row.previous_source, where),
    localPath: row.local_path,
    localApprovedSha256: row.local_approved_sha256,
    localApprovedBy: row.local_approved_by,
    localApprovedAt: row.local_approved_at,
    pinnedVersion: row.pinned_version,
    follow: row.follow === null ? null : intToBool(row.follow),
    enabled: intToBool(row.enabled),
    updatedAt: row.updated_at,
  };
}

/** Record → `site_pack_state` row (the whole row; `put` replaces it). */
export function sitePackStateToRow(r: SitePackStateRecord): Insertable<SitePackState> {
  return {
    pack_id: r.packId,
    approved_version: r.approvedVersion,
    approved_sha256: r.approvedSha256,
    approved_source: r.approvedSource,
    approved_provenance_json: provenanceToJson(r.approvedProvenance),
    approved_domains_json: JSON.stringify(r.approvedDomains),
    approved_by: r.approvedBy,
    approved_at: r.approvedAt,
    previous_version: r.previousVersion,
    previous_sha256: r.previousSha256,
    previous_source: r.previousSource,
    local_path: r.localPath,
    local_approved_sha256: r.localApprovedSha256,
    local_approved_by: r.localApprovedBy,
    local_approved_at: r.localApprovedAt,
    pinned_version: r.pinnedVersion,
    follow: r.follow === null ? null : boolToInt(r.follow),
    enabled: boolToInt(r.enabled),
    updated_at: r.updatedAt,
  };
}

/** `site_pack_changes` row → record. */
export function sitePackChangeFromRow(row: Selectable<SitePackChanges>): SitePackChangeRecord {
  const where = `site_pack_changes.${row.event_id}`;
  return {
    seq: row.seq ?? 0,
    eventId: row.event_id,
    packId: row.pack_id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    toSha256: row.to_sha256,
    source: parseEnum(SITE_PACK_SOURCES, row.source, where),
    classification: parseEnum(SITE_PACK_CLASSIFICATIONS, row.classification, where),
    newDomains: parseStringArray(row.new_domains_json, `${where}.new_domains_json`),
    notes: row.notes,
    diff: diffFromJson(row.diff_json, where),
    decision: parseEnum(SITE_PACK_DECISIONS, row.decision, where),
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/** Record → `site_pack_changes` insert row (`seq` assigned by the store). */
export function sitePackChangeToRow(r: SitePackChangeRecord): Insertable<SitePackChanges> {
  return {
    event_id: r.eventId,
    pack_id: r.packId,
    from_version: r.fromVersion,
    to_version: r.toVersion,
    to_sha256: r.toSha256,
    source: r.source,
    classification: r.classification,
    new_domains_json: JSON.stringify(r.newDomains),
    notes: r.notes,
    diff_json: diffToJson(r.diff),
    decision: r.decision,
    decided_by: r.decidedBy,
    created_at: r.createdAt,
    decided_at: r.decidedAt,
  };
}

/** `site_guard_hits` row → record. */
export function siteGuardHitFromRow(row: Selectable<SiteGuardHits>): SiteGuardHitRecord {
  const where = `site_guard_hits.${row.event_id}`;
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    templateId: row.template_id,
    packId: row.pack_id,
    guardId: row.guard_id,
    guardKind: parseEnum(SITE_GUARD_KINDS, row.guard_kind, where),
    action: parseEnum(SITE_GUARD_ACTIONS, row.action, where),
    outcome: parseEnumOrNull(SITE_GUARD_OUTCOMES, row.outcome, where),
    decidedBy: row.decided_by,
    source: parseEnum(SITE_GUARD_SOURCES, row.source, where),
    method: row.method,
    url: row.url,
    requestId: row.request_id,
    tool: row.tool,
    ts: row.ts,
  };
}

/** Record → `site_guard_hits` insert row. */
export function siteGuardHitToRow(r: SiteGuardHitRecord): Insertable<SiteGuardHits> {
  return {
    event_id: r.eventId,
    session_id: r.sessionId,
    template_id: r.templateId,
    pack_id: r.packId,
    guard_id: r.guardId,
    guard_kind: r.guardKind,
    action: r.action,
    outcome: r.outcome,
    decided_by: r.decidedBy,
    source: r.source,
    method: r.method,
    url: r.url,
    request_id: r.requestId,
    tool: r.tool,
    ts: r.ts,
  };
}
