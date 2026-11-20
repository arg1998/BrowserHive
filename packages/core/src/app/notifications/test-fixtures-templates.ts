/** @module app/notifications/test-fixtures-templates — produced events of the three session-template producers (spec 13 §8.6) with every free-text input set by the caller: a sign-out or challenge (`template.health`), a failed re-login (`template.relogin`) and a failed browser (`template.host`). Used by the redaction property suite (review #81 L-9). */

import type { HostView, TemplateSiteView } from '@browserhive/contracts/http';
import type { ProducedEvent } from './producers.ts';

const TID = 'tp-fixture001';

function site(siteId: string, reason: string): TemplateSiteView {
  return {
    site_id: siteId,
    title: siteId,
    pack_id: null,
    pack_version: null,
    enabled: true,
    write_policy: null,
    vault_handle: null,
    auto_relogin: false,
    auto_relogin_at: null,
    form: null,
    learned_cookie_names: ['sid'],
    health: {
      state: 'signed_out',
      checked_at: 1,
      changed_at: 1,
      reason,
      consecutive_inconclusive: 0,
    },
    stopped_at: null,
    device_bound: false,
    added_at: 1,
    pack: null,
    strategy_notes: [],
  };
}

/** The free text a template producer copies into its notification. */
export interface TemplateTexts {
  readonly display: string;
  readonly name: string;
  readonly reason: string;
  readonly machine: string;
  readonly provider: string;
  readonly session?: string;
}

/** `template.health` with a transition to `signed_out` or `challenged`. */
export function templateSigninEvent(
  to: 'signed_out' | 'challenged',
  t: TemplateTexts,
): ProducedEvent {
  return {
    name: 'template.health',
    at: 1,
    payload: {
      type: 'template.health',
      template_id: TID,
      site: site('example.com', t.reason),
      transition: {
        template: { name: t.name, display_name: t.display },
        provider: t.provider,
        covers: [t.provider, 'example.com'],
        from: 'signed_in',
        to,
        reason: t.reason,
        provider_signed_in: false,
        machine: t.machine,
        at: 1,
        ...(t.session !== undefined && { session_id: t.session }),
      },
    },
  };
}

/** `template.relogin` ending `failed` with `error`. */
export function templateReloginFailedEvent(t: TemplateTexts, error: string): ProducedEvent {
  return {
    name: 'template.relogin',
    at: 1,
    payload: {
      type: 'template.relogin',
      template_id: TID,
      relogin: {
        site_id: 'example.com',
        method: 'vault',
        state: 'failed',
        session_id: null,
        requested_by: 'browserhive',
        requested_at: 1,
        deadline_at: null,
        finished_at: 2,
        agents_paused: false,
        sign_in_via: null,
        confirm_required: false,
        version: null,
        unlisted_domains: [],
        error,
      },
      names: { name: t.name, display_name: t.display },
      provider: t.provider,
      machine: t.machine,
    },
  };
}

/** `template.host` reaching `failed` with `last_error`. */
export function templateHostFailedEvent(t: TemplateTexts, lastError: string): ProducedEvent {
  const host: HostView = {
    state: 'failed',
    since: 1,
    started_at: null,
    restarts: 5,
    last_error: lastError,
    pages: 0,
    parked_pages: 0,
    sandboxed: null,
    profile_secrets: false,
    agents_paused: false,
  };
  return {
    name: 'template.host',
    at: 1,
    payload: {
      type: 'template.host',
      template_id: TID,
      host,
      names: { name: t.name, display_name: t.display },
      previous_state: 'running',
    },
  };
}
