/** @module contracts/http/template-edit — editing a session template (spec 13 §11.1, PR T1b): `PATCH`, disable and enable, sites, host start/stop/restart, closing parked pages, the access tester and the data-directory reveal. */
import { z } from 'zod';
import { Channel } from '../enums/channel.ts';
import { SiteWritePolicy } from '../enums/site-write-policy.ts';
import { HARNESS_SLUG_MAX } from '../harness/index.ts';
import { IfMatchVersion } from './common.ts';
import {
  TemplateId,
  TemplateName,
  TemplatePolicyInput,
  TemplateProxyInput,
  TemplateSiteHost,
} from './template-parts.ts';
import { AgentWindows, HostView, Template, TemplateSiteView } from './templates.ts';
import { VaultHarnessName } from './vault.ts';

/**
 * `PATCH /templates/{template_id}` body: any `TemplateInput` field except the frozen identity (seed,
 * locale, timezone, geolocation, stealth and fingerprint) and the sites (`PUT`/`DELETE …/sites/…`).
 * `proxy` (`null` removes it) and `channel` restart the browser and need
 * `confirm_identity_change: true`; `policy` fields are merged one by one, `policy.harnesses: null`
 * clears the harness list (every harness, D-48) and `policy.unseal` replaces every flag.
 */
export const TemplatePatchInput = z.strictObject({
  name: TemplateName.optional(),
  display_name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  channel: Channel.optional(),
  headless: z.boolean().optional(),
  humanize: z.boolean().optional(),
  proxy: TemplateProxyInput.nullable().optional(),
  agent_windows: AgentWindows.optional(),
  policy: TemplatePolicyInput.optional(),
  /** Required with `proxy` or `channel`: sites may sign the account out (spec 13 §2.2). */
  confirm_identity_change: z.boolean().optional(),
});
/** `PATCH /templates/{template_id}` body. */
export type TemplatePatchInput = z.infer<typeof TemplatePatchInput>;

/** `If-Match: <version>` of a template edit (optional; a stale version is 409 `CONFLICT`). */
export const TemplateIfMatchHeaders = z.object({ 'if-match': IfMatchVersion.optional() });

/**
 * `PATCH /templates/{template_id}`, `POST …/disable`, `POST …/enable` body: the template and the
 * live sessions the change closed (`closed_reason: 'operator'`): sessions whose principal or harness
 * lost access, and every session of a disabled template (spec 13 §3.2).
 */
export const TemplateChangeResponse = z.object({
  template: Template,
  closed_sessions: z.array(z.string()),
});
/** A template change and the sessions it closed. */
export type TemplateChangeResponse = z.infer<typeof TemplateChangeResponse>;

/** Path params `{template_id}/sites/{site_id}`. */
export const TemplateSiteParams = z.strictObject({
  template_id: TemplateId,
  site_id: TemplateSiteHost,
});
/** Path params `{template_id}/sites/{site_id}`. */
export type TemplateSiteParams = z.infer<typeof TemplateSiteParams>;

/**
 * `PUT /templates/{template_id}/sites/{site_id}` body: adds the site when absent (at most 16), else
 * changes it. `write_policy: null` = the pack's default (spec 13 §9.3).
 */
export const PutTemplateSiteRequest = z.strictObject({
  enabled: z.boolean().optional(),
  write_policy: SiteWritePolicy.nullable().optional(),
});
/** `PUT …/sites/{site_id}` body. */
export type PutTemplateSiteRequest = z.infer<typeof PutTemplateSiteRequest>;

/** `PUT …/sites/{site_id}` response. */
export const TemplateSiteResponse = z.object({ site: TemplateSiteView });
/** `PUT …/sites/{site_id}` response. */
export type TemplateSiteResponse = z.infer<typeof TemplateSiteResponse>;

/** `POST /templates/{template_id}/host/start|stop|restart` body: the browser afterwards. */
export const TemplateHostResponse = z.object({ host: HostView });
/** `POST …/host/start|stop|restart` body. */
export type TemplateHostResponse = z.infer<typeof TemplateHostResponse>;

/** Path params `{template_id}/host/pages/{target_id}`. */
export const TemplatePageParams = z.strictObject({
  template_id: TemplateId,
  target_id: z.string().min(1).max(128),
});
/** Path params `{template_id}/host/pages/{target_id}`. */
export type TemplatePageParams = z.infer<typeof TemplatePageParams>;

/**
 * `POST /templates/{template_id}/access/resolve` body: the D-48 tester applied to the template's
 * rule. `harness` is a harness slug, `harness_declared` the exact declared name; neither = the
 * harness list is not checked.
 */
export const ResolveTemplateAccessRequest = z.strictObject({
  principal: z.string().trim().min(1).max(128).optional(),
  harness: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a harness slug: lower-case letters, digits and dashes')
    .max(HARNESS_SLUG_MAX)
    .optional(),
  harness_declared: VaultHarnessName.optional(),
});
/** `POST …/access/resolve` body. */
export type ResolveTemplateAccessRequest = z.infer<typeof ResolveTemplateAccessRequest>;

/** `POST /templates/{template_id}/access/resolve` 200 body. */
export const ResolveTemplateAccessResponse = z.object({
  allowed: z.boolean(),
  /** Why the rule refused (operator surfaces only; agents get `TEMPLATE_NOT_FOUND`). */
  reason: z.enum(['principal_not_allowed', 'harness_not_allowed', 'recording']).optional(),
  /** The rule that was applied. `harnesses` absent = every harness (D-48). */
  rule: z
    .object({
      authorized_principals: z.array(z.string()),
      harnesses: z.array(z.string()).optional(),
    })
    .optional(),
  /** `true` when no harness was given, so a harness list on the template was not checked. */
  harness_list_unchecked: z.boolean(),
});
/** `POST …/access/resolve` 200 body. */
export type ResolveTemplateAccessResponse = z.infer<typeof ResolveTemplateAccessResponse>;
