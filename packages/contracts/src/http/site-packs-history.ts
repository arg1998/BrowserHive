/** @module contracts/http/site-packs-history — the change history and guard hits of site packs (spec 13 §9.9, §11.1): `GET /site-packs/changes` and `GET /site-packs/guard-hits`. */
import { z } from 'zod';
import { Cursor, csv, EpochMs, limitQuery, page, windowQuery } from './common.ts';
import { Sha256Hex, SitePackClassification, SitePackSourceKind } from './site-packs-vocabulary.ts';

/** Decisions recorded per candidate (spec 13 §9.9 `site_pack_changes.decision`). */
export const SitePackDecision = z.enum([
  'available',
  'downloaded',
  'auto',
  'approved',
  'rejected',
  'superseded',
  'reverted',
]);

/** One `site_pack_changes` row. */
export const SitePackChangeRow = z.object({
  seq: z.number().int(),
  event_id: z.string(),
  pack_id: z.string(),
  from_version: z.number().int().nullable(),
  to_version: z.number().int().nullable(),
  to_sha256: Sha256Hex,
  source: SitePackSourceKind,
  classification: SitePackClassification,
  new_domains: z.array(z.string()),
  notes: z.string().nullable(),
  decision: SitePackDecision,
  decided_by: z.string().nullable(),
  created_at: EpochMs,
  decided_at: EpochMs.nullable(),
});
/** One change row. */
export type SitePackChangeRow = z.infer<typeof SitePackChangeRow>;

/** `GET /site-packs/changes` query. */
export const SitePackChangesQuery = z.strictObject({
  pack_id: z.string().max(253).optional(),
  decision: csv(SitePackDecision),
  ...windowQuery,
  cursor: Cursor.optional(),
  limit: limitQuery(),
});
/** `GET /site-packs/changes` query. */
export type SitePackChangesQuery = z.infer<typeof SitePackChangesQuery>;

/** `GET /site-packs/changes` body. */
export const SitePackChangesPage = page(SitePackChangeRow);
/** `GET /site-packs/changes` body. */
export type SitePackChangesPage = z.infer<typeof SitePackChangesPage>;

/** What a guard decision did (spec 13 §9.9 `site_guard_hits.action`). */
export const SiteGuardHitAction = z.enum(['block', 'confirm', 'warn', 'paced', 'held']);
/** A guard kind as recorded (`stop` for a stopped site). */
export const SiteGuardHitKind = z.enum([
  'logout',
  'account',
  'credential',
  'destructive',
  'write',
  'stop',
]);

/** One `site_guard_hits` row. */
export const SiteGuardHitRow = z.object({
  event_id: z.string(),
  session_id: z.string().nullable(),
  template_id: z.string().nullable(),
  pack_id: z.string(),
  guard_id: z.string(),
  guard_kind: SiteGuardHitKind,
  action: SiteGuardHitAction,
  outcome: z.enum(['approved', 'denied', 'timeout', 'cancelled']).nullable(),
  decided_by: z.string().nullable(),
  source: z.enum(['tool', 'request', 'element']),
  method: z.string().nullable(),
  /** Sanitized (D-20). */
  url: z.string(),
  request_id: z.string().nullable(),
  tool: z.string().nullable(),
  ts: EpochMs,
});
/** One guard hit. */
export type SiteGuardHitRow = z.infer<typeof SiteGuardHitRow>;

/** `GET /site-packs/guard-hits` query. */
export const SiteGuardHitsQuery = z.strictObject({
  template_id: z.string().max(64).optional(),
  session_id: z.string().max(128).optional(),
  pack_id: z.string().max(253).optional(),
  action: csv(SiteGuardHitAction),
  ...windowQuery,
  cursor: Cursor.optional(),
  limit: limitQuery(),
});
/** `GET /site-packs/guard-hits` query. */
export type SiteGuardHitsQuery = z.infer<typeof SiteGuardHitsQuery>;

/** `GET /site-packs/guard-hits` body. */
export const SiteGuardHitsPage = page(SiteGuardHitRow);
/** `GET /site-packs/guard-hits` body. */
export type SiteGuardHitsPage = z.infer<typeof SiteGuardHitsPage>;
