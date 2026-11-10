/** @module features/templates/pending/contracts — the wire shapes of the template routes that arrive with T1b (spec 13 §11.1: PATCH, enable/disable, sites, host start/stop/restart, parked pages, versions, restore, seed, operations, the access tester, data-dir reveal) and the `templates` topic's events (§11.3), written from the spec until `@browserhive/contracts` exports them. When T1b lands, these schemas are replaced by the contracts' and the calls move into `OPERATIONS`; the UI does not change. */
import { SiteWritePolicy, TemplateHealthState } from '@browserhive/contracts/enums';
import {
  HostView,
  RevealDataDirResponse,
  Template,
  TemplateSiteView,
} from '@browserhive/contracts/http';
import { z } from 'zod';

const EpochMs = z.number().int().nonnegative();

/** Why a version was written (spec 13 §3.9). */
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

/** One registrable domain of a version's summary: counts and cookie names only (D-20). */
export const VersionDomainSummary = z
  .object({
    cookies: z.number().int().nonnegative().optional(),
    signin_cookies: z.array(z.string()).optional(),
    earliest_expiry: EpochMs.nullable().optional(),
    session_cookie: z.boolean().optional(),
  })
  .passthrough();
/** One domain of a version's summary. */
export type VersionDomainSummary = z.infer<typeof VersionDomainSummary>;

/** `TemplateVersionRow` (spec 13 §11.1). */
export const TemplateVersionRow = z.object({
  version: z.number().int().positive(),
  reason: TemplateVersionReason,
  restored_from: z.number().int().nonnegative().nullable(),
  size_bytes: z.number().int().nonnegative(),
  summary: z.record(z.string(), VersionDomainSummary),
  health: z.record(z.string(), TemplateHealthState),
  pinned: z.boolean(),
  last_good: z.boolean(),
  readable: z.boolean(),
  created_by: z.string().nullable(),
  created_at: EpochMs,
});
/** One version. */
export type TemplateVersionRow = z.infer<typeof TemplateVersionRow>;

/** The rolling checkpoint (`versions/latest`). */
export const TemplateCheckpoint = z.object({
  at: EpochMs,
  size_bytes: z.number().int().nonnegative(),
  readable: z.boolean(),
});

/** `GET /templates/{id}/versions` body. */
export const TemplateVersionsPage = z.object({
  data: z.array(TemplateVersionRow),
  page: z.object({ next_cursor: z.string().nullable(), limit: z.number().int().positive() }),
  checkpoint: TemplateCheckpoint.nullable(),
});
/** `GET /templates/{id}/versions` body. */
export type TemplateVersionsPage = z.infer<typeof TemplateVersionsPage>;

/** `POST /templates/{id}/versions` body (`null`: nothing changed since the newest version). */
export const SaveVersionResponse = z.object({ version: z.number().int().positive().nullable() });

/** `PATCH /templates/{id}/versions/{version}` body. */
export const PinVersionResponse = z.object({ version: TemplateVersionRow });

/** A background operation started (restore, seed). */
export const OperationStarted = z.object({ operation_id: z.string() });
/** A background operation started. */
export type OperationStarted = z.infer<typeof OperationStarted>;

/** `GET /templates/operations/{operation_id}` body. */
export const TemplateOperation = z.object({
  operation_id: z.string(),
  kind: z.enum(['restore', 'seed']),
  state: z.enum(['running', 'done', 'failed']),
  version: z.number().int().positive().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
/** A background operation. */
export type TemplateOperation = z.infer<typeof TemplateOperation>;

/** `{host}` (host start, stop, restart). */
export const HostResponse = z.object({ host: HostView });

/** `{template, closed_sessions}` (PATCH, enable, disable). */
export const TemplateChangeResponse = z.object({
  template: Template,
  closed_sessions: z.array(z.string()),
});
/** `{template, closed_sessions}`. */
export type TemplateChangeResponse = z.infer<typeof TemplateChangeResponse>;

/** `PUT /templates/{id}/sites/{site}` body. */
export const PutSiteRequest = z.strictObject({
  enabled: z.boolean().optional(),
  write_policy: SiteWritePolicy.nullable().optional(),
});
/** `PUT /templates/{id}/sites/{site}` request. */
export type PutSiteRequest = z.infer<typeof PutSiteRequest>;

/** `{site}`. */
export const SiteResponse = z.object({ site: TemplateSiteView });

/** `{ok}`. */
export const OkResponse = z.object({ ok: z.literal(true) });

/** `POST /templates/{id}/access/resolve` body. */
export const AccessResolveResponse = z.object({
  allowed: z.boolean(),
  reason: z.enum(['principal_not_allowed', 'harness_not_allowed']).optional(),
  rule: z.unknown().optional(),
});
/** The access tester's answer. */
export type AccessResolveResponse = z.infer<typeof AccessResolveResponse>;

/** `POST /templates/{id}/data-dir/reveal` body (as for sessions, spec 03 §4.2). */
export const RevealResponse = RevealDataDirResponse;
