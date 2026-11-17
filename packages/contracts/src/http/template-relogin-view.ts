/** @module contracts/http/template-relogin-view — the re-login and machine views shared by the template detail and the re-login routes (spec 13 §8.4, §3.11). */
import { z } from 'zod';
import { TemplateReloginMethod } from '../enums/template-relogin-method.ts';
import { TemplateReloginState } from '../enums/template-relogin-state.ts';
import { EpochMs } from './common.ts';

/**
 * A template's current (or last) re-login as operators see it. One re-login runs per template at a
 * time; a finished one stays visible until the next starts.
 */
export const ReloginView = z.object({
  site_id: z.string(),
  method: TemplateReloginMethod,
  state: TemplateReloginState,
  /** The maintenance session holding the window or the fill; `null` while queued. */
  session_id: z.string().nullable(),
  /** Who asked: an operator principal, or the presser of a notification button (`telegram:<id>`). */
  requested_by: z.string(),
  requested_at: EpochMs,
  /** When the window gives up (30 min after it opened); `null` while queued or finished. */
  deadline_at: EpochMs.nullable(),
  finished_at: EpochMs.nullable(),
  /**
   * Agents of the template are paused while the window is open (D-60): launches and tool calls wait
   * (bounded), `false` once the operator let them continue or the window closed.
   */
  agents_paused: z.boolean(),
  /**
   * Where the operator signs in: `window` (a window on the machine running BrowserHive) or
   * `live_view` (a headless template, or no display: the maintenance session's live view, whose
   * input is open to operators with `templates:login` while the re-login runs). `null` for `vault`.
   */
  sign_in_via: z.enum(['window', 'live_view']).nullable(),
  /**
   * The site's sign-in cookies were all present when the re-login started, so nothing changing
   * cannot be told from a sign-in: the operator finishes it with **Done** (`relogin/confirm`).
   */
  confirm_required: z.boolean(),
  /** The version written when the site was signed in again. */
  version: z.number().int().positive().nullable(),
  /** Signed-in domains that are not sites of the template, listed when the re-login succeeds (§2.3). */
  unlisted_domains: z.array(z.string()),
  /** Operator-facing reason of a failure (`fill_failed`, `not_authorized`, `still_signed_out`, …). */
  error: z.string().nullable(),
});
/** A template's re-login. */
export type ReloginView = z.infer<typeof ReloginView>;

/**
 * The machine windows open on (spec 13 §3.11, deferred D31): its host name, so remote-operator copy
 * can name it. Whether the dashboard runs on that machine cannot be told from the server (an SSH
 * tunnel arrives as a loopback client), so no such flag is given.
 */
export const TemplateMachine = z.object({ name: z.string() });
/** Where windows open. */
export type TemplateMachine = z.infer<typeof TemplateMachine>;
