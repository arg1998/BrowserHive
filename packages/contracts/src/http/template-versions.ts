/** @module contracts/http/template-versions — a template's checkpoint and versions, restore and seed operations (spec 13 §2.4, §3.9, §3.12, §7.4, §11.1, PR T1b). */
import { z } from 'zod';
import { TemplateHealthState } from '../enums/template-health-state.ts';
import { Bytes, Count, EpochMs, PageQuery, page, QueryBool } from './common.ts';
import { TemplateId } from './template-parts.ts';

/** Why a version was written (spec 13 §3.9; the migration's CHECK). */
export const TemplateVersionReason = z.enum([
  'recording',
  'relogin',
  'restore',
  'manual',
  'import',
  'signin_change',
  'daily',
]);
/** Why a version was written. */
export type TemplateVersionReason = z.infer<typeof TemplateVersionReason>;

/**
 * One registrable domain of a version's cookie jar (spec 13 §2.4 `summary`): counts and cookie
 * NAMES only, never a value (D-20).
 */
export const TemplateVersionDomain = z.object({
  domain: z.string(),
  cookies: Count,
  /** The site's sign-in cookie names (learned or the pack's) that are present. */
  sign_in_cookies: z.array(z.string()),
  /** The earliest expiry of a persistent cookie, epoch ms; `null` when every cookie is a session cookie. */
  earliest_expiry: EpochMs.nullable(),
  session_cookie: z.boolean(),
});
/** One registrable domain of a version's summary. */
export type TemplateVersionDomain = z.infer<typeof TemplateVersionDomain>;

/** What a version holds, by registrable domain (spec 13 §2.4). */
export const TemplateVersionSummary = z.object({
  domains: z.array(TemplateVersionDomain),
  /** Origins with localStorage or IndexedDB data. */
  storage_origins: Count,
});
/** What a version holds. */
export type TemplateVersionSummary = z.infer<typeof TemplateVersionSummary>;

/** One site's health when the version was written (`health_json`). */
export const TemplateVersionHealth = z.object({
  site_id: z.string(),
  state: TemplateHealthState,
  enabled: z.boolean(),
});

/** `TemplateVersionRow` (spec 13 §11.1). */
export const TemplateVersionRow = z.object({
  version: z.number().int().positive(),
  reason: TemplateVersionReason,
  /** Set for `reason: 'restore'`: the version restored (`0` = the rolling checkpoint). */
  restored_from: z.number().int().nonnegative().nullable(),
  size_bytes: Bytes,
  summary: TemplateVersionSummary,
  health: z.array(TemplateVersionHealth),
  /** Exempt from `templateVersionsKeep`. */
  pinned: z.boolean(),
  /** The newest version with every enabled site signed in ("Last good"); kept like a pinned one. */
  last_good: z.boolean(),
  /** `false`: the file is missing or written with a key this server does not hold. */
  readable: z.boolean(),
  /** The operator, or `browserhive` for automatic versions. */
  created_by: z.string().nullable(),
  created_at: EpochMs,
});
/** One version of a template. */
export type TemplateVersionRow = z.infer<typeof TemplateVersionRow>;

/** The rolling checkpoint (`versions/latest.state.enc`). */
export const TemplateCheckpoint = z.object({
  at: EpochMs,
  size_bytes: Bytes,
  readable: z.boolean(),
});
/** The rolling checkpoint. */
export type TemplateCheckpoint = z.infer<typeof TemplateCheckpoint>;

/** `GET /templates/{template_id}/versions` query: newest first, cursor-paged. */
export const TemplateVersionsQuery = PageQuery.pick({ cursor: true, limit: true });
/** `GET /templates/{template_id}/versions` query. */
export type TemplateVersionsQuery = z.infer<typeof TemplateVersionsQuery>;

/** `GET /templates/{template_id}/versions` body: `Page<TemplateVersionRow>` plus the checkpoint. */
export const TemplateVersionsPage = page(TemplateVersionRow).extend({
  checkpoint: TemplateCheckpoint.nullable(),
});
/** `GET /templates/{template_id}/versions` body. */
export type TemplateVersionsPage = z.infer<typeof TemplateVersionsPage>;

/** A version in a path: a number, or `latest` (the rolling checkpoint) where a route allows it. */
export const TemplateVersionRef = z.union([
  z.literal('latest'),
  z.coerce.number().int().positive(),
]);

/** Path params `{template_id}/versions/{version}` (`version` may be `latest` for a restore). */
export const TemplateVersionParams = z.strictObject({
  template_id: TemplateId,
  version: TemplateVersionRef,
});
/** Path params `{template_id}/versions/{version}`. */
export type TemplateVersionParams = z.infer<typeof TemplateVersionParams>;

/** `POST /templates/{template_id}/versions` body: the version written, `null` when nothing changed. */
export const SaveTemplateVersionResponse = z.object({
  version: z.number().int().positive().nullable(),
});
/** `POST /templates/{template_id}/versions` body. */
export type SaveTemplateVersionResponse = z.infer<typeof SaveTemplateVersionResponse>;

/**
 * `POST /templates/{template_id}/versions/{version}/restore` body: `force_close` closes the
 * template's sessions at once (`closed_reason: 'operator'`); otherwise the restore waits for them,
 * up to `templateDrainTimeout`.
 */
export const RestoreTemplateVersionRequest = z
  .strictObject({ force_close: z.boolean().optional() })
  .default({});
/** `POST …/restore` body. */
export type RestoreTemplateVersionRequest = z.infer<typeof RestoreTemplateVersionRequest>;

/** `PATCH /templates/{template_id}/versions/{version}` body. */
export const PatchTemplateVersionRequest = z.strictObject({ pinned: z.boolean() });
/** `PATCH …/versions/{version}` body. */
export type PatchTemplateVersionRequest = z.infer<typeof PatchTemplateVersionRequest>;

/** `PATCH …/versions/{version}` response. */
export const TemplateVersionResponse = z.object({ version: TemplateVersionRow });
/** `PATCH …/versions/{version}` response. */
export type TemplateVersionResponse = z.infer<typeof TemplateVersionResponse>;

// ------------------------------------------------------------------------------------------------
// Seeding (spec 13 §7.4).
// ------------------------------------------------------------------------------------------------

/** At most 16 MiB of storage state (spec 13 §7.4). */
export const TEMPLATE_SEED_MAX_BYTES = 16 * 1024 * 1024;

/** A cookie of a Playwright storage state. */
export const StorageStateCookie = z.object({
  name: z.string().min(1).max(4096),
  value: z.string().max(16_384),
  domain: z.string().min(1).max(253),
  path: z.string().max(4096).default('/'),
  /** Epoch seconds; `-1` = a session cookie (Playwright's convention). */
  expires: z.number().default(-1),
  httpOnly: z.boolean().default(false),
  secure: z.boolean().default(false),
  sameSite: z.enum(['Strict', 'Lax', 'None']).default('Lax'),
});

/** One origin of a Playwright storage state; `indexedDB` is passed through as Playwright wrote it. */
export const StorageStateOrigin = z.object({
  origin: z.string().regex(/^https?:\/\/[^/\s]+$/, 'an origin like https://example.com'),
  localStorage: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  indexedDB: z.array(z.record(z.string(), z.unknown())).optional(),
});

/**
 * `POST /templates/{template_id}/state` body: a Playwright storage state (`save_storage_state`,
 * `context.storageState()`, `playwright … --save-storage`), at most 16 MiB. It is read in memory
 * and never stored in plain text.
 */
export const TemplateStorageState = z.object({
  cookies: z.array(StorageStateCookie).max(10_000),
  origins: z.array(StorageStateOrigin).max(2_000).default([]),
});
/** A Playwright storage state. */
export type TemplateStorageState = z.infer<typeof TemplateStorageState>;

/** `POST /templates/{template_id}/state` query: `confirm=true` is required over a `ready` template. */
export const SeedTemplateQuery = z.strictObject({ confirm: QueryBool.default(false) });
/** `POST /templates/{template_id}/state` query. */
export type SeedTemplateQuery = z.infer<typeof SeedTemplateQuery>;

// ------------------------------------------------------------------------------------------------
// Operations (restore, seed).
// ------------------------------------------------------------------------------------------------

/** A background operation on a template (spec 13 §3.12, §7.4). */
export const TemplateOperationKind = z.enum(['restore', 'seed']);
/** A background operation's state. */
export const TemplateOperationState = z.enum(['running', 'done', 'failed']);

/** `202` body of a restore or seed: poll `GET /templates/operations/{operation_id}` or watch `template.operation`. */
export const TemplateOperationAccepted = z.object({ operation_id: z.string() });
/** `202` body of a restore or seed. */
export type TemplateOperationAccepted = z.infer<typeof TemplateOperationAccepted>;

/** Path params `operations/{operation_id}`. */
export const TemplateOperationParams = z.strictObject({
  operation_id: z.string().regex(/^op-[A-Za-z0-9_-]{12}$/, 'an operation id (op-…)'),
});

/** `GET /templates/operations/{operation_id}` body. */
export const TemplateOperation = z.object({
  operation_id: z.string(),
  kind: TemplateOperationKind,
  state: TemplateOperationState,
  template_id: TemplateId,
  /** The version written (`restore` or `import`), once done. */
  version: z.number().int().positive().optional(),
  /** Why it failed (`{code, message}`), once failed. */
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  /** Sessions the operation closed. */
  closed_sessions: z.array(z.string()),
  started_at: EpochMs,
  finished_at: EpochMs.nullable(),
});
/** A background operation on a template. */
export type TemplateOperation = z.infer<typeof TemplateOperation>;
