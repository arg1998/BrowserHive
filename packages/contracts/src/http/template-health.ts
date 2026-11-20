/** @module contracts/http/template-health — template health and re-login REST DTOs (spec 13 §8, §11.1, PR T2): probes, the probe history, re-login by window or vault, **Show window**, letting agents continue during a sign-in window (D-60), and linking a vault binding for auto-relogin. */
import { z } from 'zod';
import { TemplateProbeOutcome } from '../enums/template-probe-outcome.ts';
import { TemplateProbeTrigger } from '../enums/template-probe-trigger.ts';
import { TemplateReloginMethod } from '../enums/template-relogin-method.ts';
import { Count, csv, EpochMs, PageQuery, page, QueryEpochMs } from './common.ts';
import { TEMPLATE_SITES_MAX, TemplateId, TemplateSiteHost } from './template-parts.ts';
import { ReloginView } from './template-relogin-view.ts';
import { TemplateSiteForm, TemplateSiteView } from './templates.ts';

// ------------------------------------------------------------------------------------------------
// Probes (spec 13 §8.1–§8.3).
// ------------------------------------------------------------------------------------------------

/** `POST /templates/{template_id}/probe` request: the sites to check (default: every enabled site). */
export const ProbeTemplateRequest = z.strictObject({
  site_ids: z.array(TemplateSiteHost).min(1).max(TEMPLATE_SITES_MAX).optional(),
});
/** `POST /templates/{template_id}/probe` request. */
export type ProbeTemplateRequest = z.infer<typeof ProbeTemplateRequest>;

/** One probe's result (`POST …/probe`). */
export const ProbeResult = z.object({
  site_id: z.string(),
  outcome: TemplateProbeOutcome,
  /** Reason code of spec 13 §8.1 (`learned_cookies`, `cookies_absent`, `partial_cookies`, `no_pack`, …). */
  reason: z.string(),
  duration_ms: Count,
});
/** One probe's result. */
export type ProbeResult = z.infer<typeof ProbeResult>;

/** `POST /templates/{template_id}/probe` body (**Check now**; waits at most 120 s). */
export const ProbeTemplateResponse = z.object({ results: z.array(ProbeResult) });
/** `POST …/probe` body. */
export type ProbeTemplateResponse = z.infer<typeof ProbeTemplateResponse>;

/** One `template_probes` row (`GET …/probes`); `final_url` is sanitized (D-20). */
export const TemplateProbeRow = z.object({
  seq: z.number().int().positive(),
  site_id: z.string(),
  outcome: TemplateProbeOutcome,
  reason: z.string(),
  trigger: TemplateProbeTrigger,
  final_url: z.string().nullable(),
  duration_ms: Count,
  at: EpochMs,
});
/** One probe row. */
export type TemplateProbeRow = z.infer<typeof TemplateProbeRow>;

/** `GET /templates/{template_id}/probes` query: newest first, keyset cursor. */
export const TemplateProbesQuery = PageQuery.pick({ cursor: true, limit: true }).extend({
  site_id: TemplateSiteHost.optional(),
  outcome: csv(TemplateProbeOutcome),
  trigger: csv(TemplateProbeTrigger),
  since: QueryEpochMs.optional(),
  until: QueryEpochMs.optional(),
});
/** `GET …/probes` query. */
export type TemplateProbesQuery = z.infer<typeof TemplateProbesQuery>;

/** `GET /templates/{template_id}/probes` body. */
export const TemplateProbesPage = page(TemplateProbeRow);
/** `GET …/probes` body. */
export type TemplateProbesPage = z.infer<typeof TemplateProbesPage>;

// ------------------------------------------------------------------------------------------------
// Re-login (spec 13 §8.4).
// ------------------------------------------------------------------------------------------------

/**
 * `POST /templates/{template_id}/relogin` request. `window` opens a window at the site on the
 * BrowserHive machine (agents paused unless `let_agents_continue`); `vault` fills the linked binding
 * in the background.
 */
export const StartReloginRequest = z.strictObject({
  site_id: TemplateSiteHost,
  method: TemplateReloginMethod.default('window'),
  /** Do not pause agents while the window is open (the urgent override, D-60). */
  let_agents_continue: z.boolean().default(false),
});
/** `POST …/relogin` request. */
export type StartReloginRequest = z.infer<typeof StartReloginRequest>;

/** `POST /templates/{template_id}/relogin` body and the body of every re-login route. */
export const ReloginResponse = z.object({
  /** The maintenance session (`null` when nothing is open: a queued, finished or cancelled re-login). */
  session_id: z.string().nullable(),
  relogin: ReloginView,
});
/** A re-login route's body. */
export type ReloginResponse = z.infer<typeof ReloginResponse>;

/**
 * `POST /templates/{template_id}/relogin/confirm` request: **I'm signed in** for a site without a
 * pack. `requested_at` (the `relogin.requested_at` the caller saw) is a precondition: when another
 * re-login replaced that one meanwhile, the route answers 409 `CONFLICT` and confirms nothing.
 */
export const ConfirmReloginRequest = z.strictObject({
  site_id: TemplateSiteHost,
  requested_at: EpochMs.optional(),
});
/** `POST …/relogin/confirm` request. */
export type ConfirmReloginRequest = z.infer<typeof ConfirmReloginRequest>;

/**
 * `DELETE /templates/{template_id}/relogin` query: `requested_at` (the `relogin.requested_at` the
 * caller saw) is a precondition: when another re-login replaced that one meanwhile, the route
 * answers 409 `CONFLICT` and cancels nothing.
 */
export const CancelReloginQuery = z.strictObject({ requested_at: QueryEpochMs.optional() });
/** `DELETE …/relogin` query. */
export type CancelReloginQuery = z.infer<typeof CancelReloginQuery>;

/** `POST /templates/{template_id}/host/show` body: which queued or open window was raised. */
export const ShowTemplateWindowResponse = z.object({
  ok: z.literal(true),
  window: z.enum(['relogin', 'recording']),
  session_id: z.string(),
});
/** `POST …/host/show` body. */
export type ShowTemplateWindowResponse = z.infer<typeof ShowTemplateWindowResponse>;

/** `POST /templates/{template_id}/agents/continue` body: agents are no longer paused (D-60). */
export const ContinueAgentsResponse = z.object({
  ok: z.literal(true),
  agents_paused: z.literal(false),
});
/** `POST …/agents/continue` body. */
export type ContinueAgentsResponse = z.infer<typeof ContinueAgentsResponse>;

// ------------------------------------------------------------------------------------------------
// Vault auto-relogin (spec 13 §8.4).
// ------------------------------------------------------------------------------------------------

/** Path params `{template_id}/sites/{site_id}`. */
export const TemplateReloginSiteParams = z.strictObject({
  template_id: TemplateId,
  site_id: TemplateSiteHost,
});
/** Path params `{template_id}/sites/{site_id}`. */
export type TemplateReloginSiteParams = z.infer<typeof TemplateReloginSiteParams>;

/**
 * `PUT /templates/{template_id}/sites/{site_id}/relogin` request (`templates:login` and `vault:write`).
 * `vault_handle: null` unlinks (and turns auto-relogin off). `allow_template` is **Allow this
 * template**: adds `template:<template_id>` to the binding's principals and nothing else (the
 * template's own sign-in sessions meet the binding's session rule), which widens who can use the
 * credential.
 */
export const PutReloginLinkRequest = z.strictObject({
  vault_handle: z.string().min(1).max(128).nullable(),
  auto_relogin: z.boolean().optional(),
  form: TemplateSiteForm.extend({
    username: z.string().min(1).max(200),
    password: z.string().min(1).max(200),
    submit: z.string().min(1).max(200).optional(),
    next: z.string().min(1).max(200).optional(),
    path: z
      .string()
      .max(200)
      .regex(/^\/[A-Za-z0-9\-._~/%]*$/, 'a path on the site: no scheme, query or fragment')
      .optional(),
  })
    .strict()
    .nullable()
    .optional(),
  allow_template: z.boolean().default(false),
});
/** `PUT …/sites/{site_id}/relogin` request. */
export type PutReloginLinkRequest = z.infer<typeof PutReloginLinkRequest>;

/** Why a linked binding would refuse the template's fill (each gate of spec 02 §3.13 that applies). */
export const BindingProblem = z.enum([
  /** No binding has this handle. */
  'binding_not_found',
  /** The binding allows every principal; auto-relogin needs `template:<id>` named explicitly. */
  'principals_open',
  /** `template:<id>` is not among the binding's principals (**Allow this template** adds it). */
  'principal_not_listed',
  /** Never produced since review #81 M-1 (the template's sessions meet any session rule); kept for readers. */
  'slug_not_allowed',
  /** The binding (or its group) names harnesses; a template fill has none. */
  'harness_list',
]);
/** Why a binding refuses. */
export type BindingProblem = z.infer<typeof BindingProblem>;

/** `PUT /templates/{template_id}/sites/{site_id}/relogin` body. */
export const PutReloginLinkResponse = z.object({
  site: TemplateSiteView,
  /** Every gate that can be checked without a page lets the template fill with this binding. */
  binding_allows_template: z.boolean(),
  binding_problems: z.array(BindingProblem),
});
/** `PUT …/sites/{site_id}/relogin` body. */
export type PutReloginLinkResponse = z.infer<typeof PutReloginLinkResponse>;
