/** @module contracts/http/site-packs — site-pack REST DTOs (spec 13 §11.1 "Site packs", PR T3a): the catalog with each pack's approval, provenance, local-file state and pending versions; the field-level diff; Apply, Reject, Revert, Pin, Follow, approving a local file by its SHA-256, enabling; reload and import of unsigned files; the change history and guard hits. The registry client (T4b): the status of the automatic check, Check now, Download & review, Download all, export and signed imports. */
import { z } from 'zod';
import { SitePackV1 } from '../site-packs/schema.ts';
import { Bytes, Count, csv, EpochMs, QueryBool, QueryText } from './common.ts';
import {
  Sha256Hex,
  SitePackClassification,
  SitePackLocalState,
  SitePackProvenance,
  SitePackSkipReason,
  SitePackSourceFilter,
  SitePackSourceKind,
  SitePackVersionRef,
} from './site-packs-vocabulary.ts';

export {
  SiteGuardHitAction,
  SiteGuardHitKind,
  SiteGuardHitRow,
  SiteGuardHitsPage,
  SiteGuardHitsQuery,
  SitePackChangeRow,
  SitePackChangesPage,
  SitePackChangesQuery,
  SitePackDecision,
} from './site-packs-history.ts';
export {
  Sha256Hex,
  SitePackClassification,
  SitePackLocalState,
  SitePackProvenance,
  SitePackSkipReason,
  SitePackSourceFilter,
  SitePackSourceKind,
  SitePackVersionRef,
} from './site-packs-vocabulary.ts';

// ------------------------------------------------------------------------------------------------
// The pack as operators see it.
// ------------------------------------------------------------------------------------------------

/**
 * A pending candidate (spec 13 §10.6): a newer bundled version, a registry version listed in the
 * signed index (`available`, with its size, release date and the publisher's notes) or downloaded
 * and verified (`downloaded`, classified against the approved version), or an imported one.
 */
export const SitePackPending = z.object({
  version: z.number().int(),
  sha256: Sha256Hex.nullable(),
  state: z.enum(['available', 'downloaded']),
  size: Bytes.nullable(),
  /** ISO date the publisher released it (registry versions). */
  released: z.string().nullable(),
  /** The publisher's signed change summary (plain text, at most 500 characters). */
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
  /** Every source that knows the pack: `bundled`, `remote` (the verified registry index), `import`, `local`. */
  sources: z.array(SitePackSourceKind),
  /**
   * The newest version the last verified registry index lists for this pack, whatever its client
   * range (spec 13 §10.3 step 3): `needs_client` names the BrowserHive range a version this binary
   * cannot use needs; `null` when the index does not list the pack.
   */
  online: z
    .object({
      version: z.number().int(),
      sha256: Sha256Hex,
      size: Bytes,
      released: z.string(),
      notes: z.string(),
      revoked: z.boolean(),
      needs_client: z.string().nullable(),
      /** The newest version this binary may use (non-revoked, inside its client range). */
      usable_version: z.number().int().nullable(),
    })
    .nullable(),
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

/** The outcome of one update check (spec 13 §11.1 `POST /site-packs/check`). */
export const SitePackCheckOutcome = z.enum(['updated', 'not_modified', 'failed', 'disabled']);
/** The outcome of one update check. */
export type SitePackCheckOutcome = z.infer<typeof SitePackCheckOutcome>;

/** Why the registry client makes no request (`update_check` false or the build trusts no registry). */
export const SitePackCheckOff = z.enum(['packs_off', 'update_check_off', 'no_trust_root']);

/** The registry's status (spec 13 §11.1 `RegistryStatus`). */
export const SitePackRegistryStatus = z.object({
  enabled: z.boolean(),
  /** `sitePacksUpdateCheck` as configured. */
  update_check: z.boolean(),
  /** Why no automatic check runs, `null` when it does. */
  check_off: SitePackCheckOff.nullable(),
  /** This build pins registry root keys (false until the key ceremony: no index can verify). */
  trusts_registry: z.boolean(),
  auto_update: z.boolean(),
  url: z.string().nullable(),
  last_check_at: EpochMs.nullable(),
  last_ok_at: EpochMs.nullable(),
  last_outcome: SitePackCheckOutcome.nullable(),
  /** The last failed check's reason (a network error or a refused file), `null` after a good one. */
  last_error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** Consecutive failed checks (3 or more record `SITE_PACKS_FETCH_FAILED`). */
  failures: Count,
  next_check_at: EpochMs.nullable(),
  index_version: z.number().int().nullable(),
  index_issued_at: EpochMs.nullable(),
  index_expires_at: EpochMs.nullable(),
  /** The online key that signed the held index. */
  index_signed_by: z.string().nullable(),
  /** Packs the held index lists. */
  index_packs: Count,
  /** Where the held index came from. */
  index_origin: z.enum(['registry', 'import', 'local']).nullable(),
  stale: z.boolean(),
  clock_skew_ms: z.number().int().optional(),
  keys_version: z.number().int().nullable(),
  /** The signed registry snapshot this release ships (spec 13 §10.9), `null` when it has none. */
  snapshot: z
    .object({
      index_version: z.number().int(),
      verified: z.boolean(),
      detail: z.string().nullable(),
    })
    .nullable(),
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
export const SitePacksQuery = z.strictObject({
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

/** `GET /site-packs/{pack_id}/diff` query: `to` a pending version, the previous approved version (what Revert restores) or `local`; `from` defaults to the approved version. */
export const SitePackDiffQuery = z.strictObject({
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
  /** The field's class (spec 13 §9.7); `null` for a new pack's fields and rows from before T3b. */
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

/** `POST /site-packs/check` body. */
export const SitePackCheckResponse = z.object({
  outcome: SitePackCheckOutcome,
  checked_at: EpochMs,
  /** Listed versions newer than the approved ones (all packs, followed or not). */
  available: Count,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  status: SitePackRegistryStatus,
});
/** `POST /site-packs/check` body. */
export type SitePackCheckResponse = z.infer<typeof SitePackCheckResponse>;

/** `POST /site-packs/{pack_id}/download` body: one version the verified index lists. */
export const SitePackDownloadRequest = z.strictObject({ version: z.number().int().min(1) });
/** `POST /site-packs/{pack_id}/download` body. */
export type SitePackDownloadRequest = z.infer<typeof SitePackDownloadRequest>;

/** `POST /site-packs/{pack_id}/download` response: the pack and the classified diff against the approved version. */
export const SitePackDownloadResponse = z.object({
  view: SitePackView,
  diff: SitePackDiffResponse,
});
/** `POST /site-packs/{pack_id}/download` response. */
export type SitePackDownloadResponse = z.infer<typeof SitePackDownloadResponse>;

/** One file of Download all that was refused. */
export const SitePackDownloadRefusal = z.object({
  pack_id: z.string(),
  version: z.number().int(),
  reason: z.string(),
  detail: z.string(),
});

/** `POST /site-packs/download-all` response: every listed version the client lacked, all packs (spec 13 §10.4). */
export const SitePackDownloadAllResponse = z.object({
  downloaded: z.array(
    z.object({ pack_id: z.string(), version: z.number().int(), sha256: Sha256Hex }),
  ),
  /** Already held, not fetched again. */
  held: Count,
  refused: z.array(SitePackDownloadRefusal),
  /** Pending versions of followed packs after the download (what the Updates section lists). */
  pending_count: Count,
});
/** `POST /site-packs/download-all` response. */
export type SitePackDownloadAllResponse = z.infer<typeof SitePackDownloadAllResponse>;

/** `GET /site-packs/export` response: the held signed layout (spec 13 §10.1) with every verified pack file held, base64 by path. */
export const SitePackExportResponse = z.object({
  files: z.record(z.string(), z.string()),
  index_version: z.number().int(),
  keys_version: z.number().int(),
  packs: Count,
});
/** `GET /site-packs/export` response. */
export type SitePackExportResponse = z.infer<typeof SitePackExportResponse>;

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

/** Largest signed layout file count in one import. */
export const SITE_PACK_IMPORT_MAX_FILES = 512;

/** Largest `POST /site-packs/import` body. */
export const SITE_PACK_IMPORT_MAX_BYTES = 1024 * 1024;

/**
 * `POST /site-packs/import` body: one unsigned pack (stored in `sitePacksDir` as `<id>.json`, then
 * approved like any local file). `{text}` is the file's exact text: it is validated, hashed and
 * stored byte for byte, so its SHA-256 is the file's own (what `sitepacks verify` prints); `{pack}`
 * is a parsed pack, stored re-serialized; `{files}` is a signed layout (`keys.json`, `index.json`,
 * their `.sig` files and `packs/<id>/<sha256>.json`, base64 by path), verified with the pinned keys
 * exactly as a fetch is and queued for approval (spec 13 §10.5).
 */
export const SitePackImportRequest = z.union([
  z.strictObject({ text: z.string().min(1).max(SITE_PACK_IMPORT_MAX_BYTES) }),
  z.strictObject({ pack: z.unknown() }),
  z.strictObject({
    files: z
      .record(z.string().min(1).max(200), z.string().max(SITE_PACK_IMPORT_MAX_BYTES))
      .refine((files) => Object.keys(files).length <= SITE_PACK_IMPORT_MAX_FILES, {
        message: `at most ${SITE_PACK_IMPORT_MAX_FILES} files`,
      }),
    /** A label for the provenance ("Imported file <name>"), e.g. the folder's name. */
    name: z.string().min(1).max(200).optional(),
  }),
]);
/** `POST /site-packs/import` body. */
export type SitePackImportRequest = z.infer<typeof SitePackImportRequest>;

/** `POST /site-packs/import` response. */
export const SitePackImportResponse = z.object({
  imported: z.array(
    z.object({
      pack_id: z.string(),
      version: z.number().int(),
      /**
       * An unsigned file: its local state. A signed layout's version: `downloaded` (queued for
       * approval), `available` (listed, its file not in the layout), `current` (already approved or
       * not newer), `refused` (its file did not verify), `other_client` (for another BrowserHive).
       */
      state: z.union([
        SitePackLocalState,
        z.enum(['downloaded', 'available', 'current', 'refused', 'other_client']),
      ]),
      sha256: Sha256Hex,
    }),
  ),
  /** A signed layout's index as accepted (`not_modified`: the one already held). */
  layout: z
    .object({
      outcome: z.enum(['updated', 'not_modified']),
      index_version: z.number().int(),
      keys_version: z.number().int(),
      signed_by: z.string(),
    })
    .optional(),
});
/** `POST /site-packs/import` response. */
export type SitePackImportResponse = z.infer<typeof SitePackImportResponse>;

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
