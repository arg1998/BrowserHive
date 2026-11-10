/** @module contracts/http/template-recording — recording a template's sign-ins and the T1a host routes (spec 13 §7.1, §11.1): start, **I'm signed in**, Finish, Cancel, removing an unlisted sign-in and clearing saved passwords and autofill. */
import { z } from 'zod';
import { Count } from './common.ts';
import { TEMPLATE_SITES_MAX, TemplateId, TemplateSiteHost } from './template-parts.ts';
import { HostView, Template, TemplateSiteView } from './templates.ts';

/** Path params `{template_id}/domains/{domain}`. */
export const TemplateDomainParams = z.strictObject({
  template_id: TemplateId,
  domain: TemplateSiteHost,
});
/** Path params `{template_id}/domains/{domain}`. */
export type TemplateDomainParams = z.infer<typeof TemplateDomainParams>;

/** `POST /templates/{template_id}/domains/{domain}/remove-sign-in` body (spec 13 §2.3). */
export const RemoveSignInResponse = z.object({
  ok: z.literal(true),
  /** Cookies of the domain's registrable domain removed from the template's browser. */
  cookies_removed: Count,
  /** Origins under the domain whose site data (storage, IndexedDB, service workers, caches) was cleared. */
  origins_cleared: z.array(z.string()),
  /** Origins whose site data could not be cleared: the sign-in may survive there. */
  uncleared_origins: z.array(z.string()),
});
/** `POST …/remove-sign-in` body. */
export type RemoveSignInResponse = z.infer<typeof RemoveSignInResponse>;

/**
 * `POST /templates/{template_id}/recording` request: the sites to open, one tab each (default: every
 * enabled site).
 */
export const StartRecordingRequest = z.strictObject({
  sites: z.array(TemplateSiteHost).min(1).max(TEMPLATE_SITES_MAX).optional(),
});
/** `POST /templates/{template_id}/recording` request. */
export type StartRecordingRequest = z.infer<typeof StartRecordingRequest>;

/**
 * `POST /templates/{template_id}/recording` body: the maintenance session that holds the sign-in
 * window on the BrowserHive machine (an open recording is returned again, its window raised).
 */
export const StartRecordingResponse = z.object({
  session_id: z.string(),
  host: HostView,
});
/** `POST /templates/{template_id}/recording` body. */
export type StartRecordingResponse = z.infer<typeof StartRecordingResponse>;

/** `POST /templates/{template_id}/recording/confirm` request: **I'm signed in** for a site without a pack. */
export const ConfirmRecordingRequest = z.strictObject({ site_id: TemplateSiteHost });
/** `POST …/recording/confirm` request. */
export type ConfirmRecordingRequest = z.infer<typeof ConfirmRecordingRequest>;

/** `POST /templates/{template_id}/recording/confirm` body: the site with its learned cookie names. */
export const ConfirmRecordingResponse = z.object({ site: TemplateSiteView });
/** `POST …/recording/confirm` body. */
export type ConfirmRecordingResponse = z.infer<typeof ConfirmRecordingResponse>;

/**
 * `POST /templates/{template_id}/recording/finish` request: the unlisted sign-ins to remove
 * (registrable domains from `unlisted_domains` of `GET /templates/{template_id}`).
 */
export const FinishRecordingRequest = z.strictObject({
  remove_sign_ins: z.array(TemplateSiteHost).max(64).optional(),
});
/** `POST …/recording/finish` request. */
export type FinishRecordingRequest = z.infer<typeof FinishRecordingRequest>;

/**
 * `POST /templates/{template_id}/recording/finish` body: the template, now `ready`; `version` is the
 * version written (`null` until versions arrive in T1b).
 */
export const FinishRecordingResponse = z.object({
  template: Template,
  version: z.number().int().positive().nullable(),
  /** The unlisted sign-ins removed, with what could not be cleared. */
  removed_sign_ins: z.array(
    z.object({
      domain: z.string(),
      cookies_removed: Count,
      origins_cleared: z.array(z.string()),
      uncleared_origins: z.array(z.string()),
    }),
  ),
});
/** `POST …/recording/finish` body. */
export type FinishRecordingResponse = z.infer<typeof FinishRecordingResponse>;

/** `{ok: true}` (`DELETE …/recording`, `POST …/host/clear-profile-secrets`). */
export const TemplateOkResponse = z.object({ ok: z.literal(true) });
/** `{ok: true}`. */
export type TemplateOkResponse = z.infer<typeof TemplateOkResponse>;
