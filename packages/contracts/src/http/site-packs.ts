/** @module contracts/http/site-packs — site-pack REST DTOs (spec 13 §11.1 "Site packs", PR T3a): the catalog with each pack's approval, provenance, local-file state and pending versions; the field-level diff; Apply, Reject, Revert, Pin, Follow, approving a local file by its SHA-256, enabling; reload and import of unsigned files; the change history and guard hits. Registry fields (`update_check`, index versions) are filled by T4b and are `false`/`null` until then. */
import { z } from 'zod';
import { SitePackV1 } from '../site-packs/schema.ts';
import {
  Bytes,
  Count,
  Cursor,
  csv,
  EpochMs,
  limitQuery,
  page,
  QueryBool,
  QueryText,
  windowQuery,
} from './common.ts';

// ------------------------------------------------------------------------------------------------
// Vocabulary.
// ------------------------------------------------------------------------------------------------

/** Where a pack version came from (spec 13 §9.6 `SitePackSource.id`). */
export const SitePackSourceKind = z.enum(['bundled', 'remote', 'import', 'local']);
/** A pack version's source. */
export type SitePackSourceKind = z.infer<typeof SitePackSourceKind>;

/** The `?source=` filter: `registry` is the remote source. */
export const SitePackSourceFilter = z.enum(['local', 'registry', 'bundled', 'import']);

/**
 * What the operator was shown when approving: the release a bundled version shipped with, the
 * registry key and index (T4b), the imported file's name, or a local file's path.
 */
export const SitePackProvenance = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bundled'), release: z.string() }),
  z.object({ kind: z.literal('remote'), key_id: z.string(), index_version: z.number().int() }),
  z.object({ kind: z.literal('import'), file: z.string() }),
  z.object({ kind: z.literal('local'), path: z.string() }),
]);
/** A provenance. */
export type SitePackProvenance = z.infer<typeof SitePackProvenance>;

/** A lowercase hex SHA-256. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** A local file's state (spec 13 §10.5). */
export const SitePackLocalState = z.enum(['approved', 'changed', 'not_approved']);
/** A local file's state. */
export type SitePackLocalState = z.infer<typeof SitePackLocalState>;

/**
 * How a candidate compares with the approved version (spec 13 §9.7). T3a shows every diff as
 * `unclassified`; the classifier and its chips arrive with T3b.
 */
export const SitePackClassification = z.enum([
  'unclassified',
  'tightening',
  'restrictive',
  'loosening',
  'neutral',
  'new_pack',
  'revoked',
  'local_override',
]);
/** A classification. */
export type SitePackClassification = z.infer<typeof SitePackClassification>;

/** Why a pack version was not loaded. */
export const SitePackSkipReason = z.enum([
  'invalid',
  'too_large',
  'unknown_strategy',
  'min_client',
  'domain_overlap',
  'not_found',
  'id_mismatch',
  'signed_layout_unsupported',
  'unreadable',
]);
/** A skip reason. */
export type SitePackSkipReason = z.infer<typeof SitePackSkipReason>;

/** One version a pack id was offered or decided at. */
export const SitePackVersionRef = z.object({
  version: z.number().int().nullable(),
  sha256: Sha256Hex,
  source: SitePackSourceKind,
});
/** A version reference. */
export type SitePackVersionRef = z.infer<typeof SitePackVersionRef>;

// ------------------------------------------------------------------------------------------------
// The pack as operators see it.
// ------------------------------------------------------------------------------------------------

/** A pending candidate of an approved pack (spec 13 §10.6): a newer bundled version or (T4b) a registry one. */
export const SitePackPending = z.object({
  version: z.number().int(),
  sha256: Sha256Hex.nullable(),
  state: z.enum(['available', 'downloaded']),
  size: Bytes.nullable(),
  released: z.string().nullable(),
  notes: z.string().nullable(),
  classification: SitePackClassification.optional(),
  new_domains: z.array(z.string()).optional(),
  source: SitePackSourceKind,
  provenance: SitePackProvenance.nullable(),
});
/** A pending candidate. */
export type SitePackPending = z.infer<typeof SitePackPending>;

/** `SitePackView` (spec 13 §11.1). */
export const SitePackView = z.object({
  pack_id: z.string(),
  title: z.string(),
  domains: z.array(z.string()),
  identity_provider: z.string().nullable(),
  /** The version in force (with local content: the local override's base). */
  approved: z
    .object({
      version: z.number().int(),
      sha256: Sha256Hex,
      source: SitePackSourceKind,
      provenance: SitePackProvenance.nullable(),
      by: z.string().nullable(),
      at: EpochMs.nullable(),
    })
    .nullable(),
  /**
   * What adding a site would approve when nothing is approved yet (spec 13 §9.6 "First use"): the
   * best version on offer, shown with its provenance and SHA-256. `null` once approved.
   */
  offer: z
    .object({
      version: z.number().int(),
      sha256: Sha256Hex,
      source: SitePackSourceKind,
      provenance: SitePackProvenance,
    })
    .nullable(),
  previous: z.object({ version: z.number().int(), source: SitePackSourceKind }).nullable(),
  pinned_version: z.number().int().nullable(),
  follow: z.object({ setting: z.enum(['auto', 'on', 'off']), effective: z.boolean() }),
  enabled: z.boolean(),
  local: z
    .object({
      path: z.string(),
      sha256: Sha256Hex.nullable(),
      state: SitePackLocalState,
      approved_sha256: Sha256Hex.nullable(),
      /** The local file failed validation: the reason (its approved content, if any, keeps applying). */
      problem: z.string().nullable(),
    })
    .nullable(),
  /** The content in force comes from a local file ("Local file overrides v9"). */
  local_override: z.boolean(),
  pending: z.array(SitePackPending),
  /** Template ids whose sites use the pack. */
  used_by: z.array(z.string()),
  human_only: z.boolean(),
  write_policy_default: z.enum(['allow', 'warn', 'confirm']),
  stance: z.enum(['prohibited', 'restricted', 'writes_restricted', 'allowed']),
  /** Guards (network and element) of kind `write`: 0 means the write policy has nothing to act on yet. */
  write_guards: Count,
  verified: z.record(z.string(), z.string()),
  skipped: z
    .object({
      version: z.number().int().nullable(),
      reason: SitePackSkipReason,
      detail: z.string(),
    })
    .optional(),
});
/** A pack as operators see it. */
export type SitePackView = z.infer<typeof SitePackView>;

/** The registry's status (spec 13 §11.1 `RegistryStatus`); remote fields are T4b's. */
export const SitePackRegistryStatus = z.object({
  enabled: z.boolean(),
  update_check: z.boolean(),
  auto_update: z.boolean(),
  url: z.string().nullable(),
  last_check_at: EpochMs.nullable(),
  last_ok_at: EpochMs.nullable(),
  last_outcome: z.enum(['updated', 'not_modified', 'failed', 'disabled']).nullable(),
  index_version: z.number().int().nullable(),
  index_expires_at: EpochMs.nullable(),
  stale: z.boolean(),
  clock_skew_ms: z.number().int().optional(),
  keys_version: z.number().int().nullable(),
  bundled: z.object({ version: z.string(), built_at: EpochMs.nullable(), count: Count }),
  local: z.object({
    dir: z.string(),
    count: Count,
    signed_layouts: Count,
    needing_approval: Count,
  }),
  skipped: z.array(
    z.object({
      pack_id: z.string(),
      version: z.number().int().nullable(),
      source: SitePackSourceKind,
      reason: SitePackSkipReason,
      detail: z.string(),
    }),
  ),
  last_load_at: EpochMs.nullable(),
});
/** The registry's status. */
export type SitePackRegistryStatus = z.infer<typeof SitePackRegistryStatus>;

// ------------------------------------------------------------------------------------------------
// Routes.
// ------------------------------------------------------------------------------------------------

/** `{pack_id}` path params. */
export const SitePackIdParams = z.object({ pack_id: z.string().min(1).max(253) });

/** `GET /site-packs` query. */
export const SitePacksQuery = z.object({
  q: QueryText.optional(),
  source: csv(SitePackSourceFilter),
  pending: QueryBool.optional(),
  follow: QueryBool.optional(),
});
/** `GET /site-packs` query. */
export type SitePacksQuery = z.infer<typeof SitePacksQuery>;

/** `GET /site-packs` body. */
export const SitePacksResponse = z.object({
  data: z.array(SitePackView),
  status: SitePackRegistryStatus,
  /** Pending versions of followed, unpinned packs. */
  pending_count: Count,
  local_needing_approval: Count,
  now: EpochMs,
});
/** `GET /site-packs` body. */
export type SitePacksResponse = z.infer<typeof SitePacksResponse>;

/** `GET /site-packs/{pack_id}` body. */
export const SitePackDetailResponse = z.object({
  view: SitePackView,
  /** The content in force, else the offered one; `null` when neither exists (a local file only). */
  pack: SitePackV1.nullable(),
  versions: z.array(
    SitePackVersionRef.extend({
      state: z.enum(['approved', 'previous', 'pending', 'rejected', 'offered', 'local']),
    }),
  ),
});
/** `GET /site-packs/{pack_id}` body. */
export type SitePackDetailResponse = z.infer<typeof SitePackDetailResponse>;

/** `GET /site-packs/{pack_id}/diff` query: `to` a pending version or `local`; `from` defaults to the approved version. */
export const SitePackDiffQuery = z.object({
  to: z.union([z.literal('local'), z.coerce.number().int().min(1)]),
  from: z.coerce.number().int().min(1).optional(),
});
/** `GET /site-packs/{pack_id}/diff` query. */
export type SitePackDiffQuery = z.infer<typeof SitePackDiffQuery>;

/** One changed field: a JSON path (`guards[logout].action`), its old and new value as JSON. */
export const SitePackChange = z.object({
  path: z.string(),
  from: z.unknown(),
  to: z.unknown(),
  /** `null` until T3b's classifier. */
  class: z.enum(['tightening', 'restrictive', 'loosening', 'neutral']).nullable(),
});
/** One changed field. */
export type SitePackChange = z.infer<typeof SitePackChange>;

/** `GET /site-packs/{pack_id}/diff` body. */
export const SitePackDiffResponse = z.object({
  from: SitePackVersionRef.nullable(),
  to: SitePackVersionRef,
  classification: SitePackClassification,
  new_domains: z.array(z.string()),
  changes: z.array(SitePackChange),
});
/** `GET /site-packs/{pack_id}/diff` body. */
export type SitePackDiffResponse = z.infer<typeof SitePackDiffResponse>;

/** `POST …/apply` and `…/reject` body. */
export const SitePackVersionRequest = z.strictObject({ version: z.number().int().min(1) });
/** `POST …/apply` and `…/reject` body. */
export type SitePackVersionRequest = z.infer<typeof SitePackVersionRequest>;

/** `PUT …/pin` body: the approved version, or `null` to unpin. */
export const SitePackPinRequest = z.strictObject({ version: z.number().int().min(1).nullable() });
/** `PUT …/pin` body. */
export type SitePackPinRequest = z.infer<typeof SitePackPinRequest>;

/** `PUT …/follow` body: `null` = automatic (followed while a template uses the pack). */
export const SitePackFollowRequest = z.strictObject({ follow: z.boolean().nullable() });
/** `PUT …/follow` body. */
export type SitePackFollowRequest = z.infer<typeof SitePackFollowRequest>;

/** `POST …/approve-local` body: the content the operator reviewed. */
export const SitePackApproveLocalRequest = z.strictObject({ sha256: Sha256Hex });
/** `POST …/approve-local` body. */
export type SitePackApproveLocalRequest = z.infer<typeof SitePackApproveLocalRequest>;

/** The body of every action route. */
export const SitePackViewResponse = z.object({ view: SitePackView });
/** The body of every action route. */
export type SitePackViewResponse = z.infer<typeof SitePackViewResponse>;

/** What a load found, per source. */
export const SitePackRegistryStats = z.object({
  loaded_at: EpochMs,
  sources: z.array(
    z.object({
      source: SitePackSourceKind,
      loaded: Count,
      skipped: z.array(
        z.object({
          pack_id: z.string(),
          version: z.number().int().nullable(),
          reason: SitePackSkipReason,
          detail: z.string(),
        }),
      ),
    }),
  ),
});
/** What a load found. */
export type SitePackRegistryStats = z.infer<typeof SitePackRegistryStats>;

/** `POST /site-packs/reload` body. */
export const SitePackReloadResponse = z.object({ stats: SitePackRegistryStats });

/** Largest `POST /site-packs/import` body. */
export const SITE_PACK_IMPORT_MAX_BYTES = 1024 * 1024;

/**
 * `POST /site-packs/import` body: one unsigned pack (stored in `sitePacksDir` as `<id>.json`, then
 * approved like any local file). `{text}` is the file's exact text: it is validated, hashed and
 * stored byte for byte, so its SHA-256 is the file's own (what `sitepacks verify` prints); `{pack}`
 * is a parsed pack, stored re-serialized. Signed layouts (`{files}`) arrive with T4b and are refused (400).
 */
export const SitePackImportRequest = z.union([
  z.strictObject({ text: z.string().min(1).max(SITE_PACK_IMPORT_MAX_BYTES) }),
  z.strictObject({ pack: z.unknown() }),
  z.strictObject({ files: z.record(z.string(), z.string()) }),
]);
/** `POST /site-packs/import` body. */
export type SitePackImportRequest = z.infer<typeof SitePackImportRequest>;

/** `POST /site-packs/import` response. */
export const SitePackImportResponse = z.object({
  imported: z.array(
    z.object({
      pack_id: z.string(),
      version: z.number().int(),
      state: SitePackLocalState,
      sha256: Sha256Hex,
    }),
  ),
});
/** `POST /site-packs/import` response. */
export type SitePackImportResponse = z.infer<typeof SitePackImportResponse>;

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
export const SitePackChangesQuery = z.object({
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
export const SiteGuardHitsQuery = z.object({
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

// ------------------------------------------------------------------------------------------------
// A template site's pack, as the template page and the wizard show it (spec 13 §11.4).
// ------------------------------------------------------------------------------------------------

/** The pack in force for a template site. */
export const TemplateSitePack = z.object({
  pack_id: z.string(),
  title: z.string(),
  version: z.number().int(),
  sha256: Sha256Hex,
  source: SitePackSourceKind,
  local_override: z.boolean(),
  identity_provider: z.string().nullable(),
  human_only: z.boolean(),
  sign_in_url: z.string().nullable(),
  stance: z.enum(['prohibited', 'restricted', 'writes_restricted', 'allowed']),
  write_policy_default: z.enum(['allow', 'warn', 'confirm']),
  clause: z.object({ quote: z.string(), url: z.string(), checked: z.string() }).nullable(),
  exception: z.string().nullable(),
  guards: Count,
  element_guards: Count,
  /** Guards (network and element) of kind `write`: 0 means the write policy has nothing to act on yet. */
  write_guards: Count,
  challenges: Count,
  enabled: z.boolean(),
});
/** The pack in force for a template site. */
export type TemplateSitePack = z.infer<typeof TemplateSitePack>;
