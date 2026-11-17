/** @module test/helpers/fake-template-health — a recording `TemplateHealthPort` for HTTP route tests (spec 13 §11.1, T2). */

import type { ReloginResponse, ReloginView, TemplateSiteView } from '@browserhive/contracts/http';
import type { TemplateHealthPort } from '../../src/interface/http/services.ts';

/** A re-login view with defaults. */
export function reloginView(patch: Partial<ReloginView> = {}): ReloginView {
  return {
    site_id: 'site-a.test',
    method: 'window',
    state: 'open',
    session_id: 'relogin-a1b2c3d4',
    requested_by: 'admin',
    requested_at: 1_700_000_000_000,
    deadline_at: 1_700_001_800_000,
    finished_at: null,
    agents_paused: true,
    sign_in_via: 'window',
    confirm_required: false,
    version: null,
    unlisted_domains: [],
    error: null,
    ...patch,
  };
}

function defaultSite(): TemplateSiteView {
  return {
    site_id: 'site-a.test',
    title: 'site-a.test',
    pack_id: null,
    pack_version: null,
    enabled: true,
    write_policy: null,
    vault_handle: 'github',
    auto_relogin: false,
    auto_relogin_at: null,
    form: null,
    learned_cookie_names: ['sid'],
    health: {
      state: 'signed_out',
      checked_at: 1_700_000_000_000,
      changed_at: 1_700_000_000_000,
      reason: 'cookies_absent',
      consecutive_inconclusive: 0,
    },
    stopped_at: null,
    device_bound: false,
    added_at: 1_700_000_000_000,
  };
}

/** Records every call and answers canned bodies. */
export class FakeTemplateHealth implements TemplateHealthPort {
  readonly calls: { readonly op: string; readonly args: readonly unknown[] }[] = [];
  site: TemplateSiteView | null = null;

  #record(op: string, args: readonly unknown[]): void {
    this.calls.push({ op, args });
  }

  #relogin(patch: Partial<ReloginView> = {}): ReloginResponse {
    const relogin = reloginView(patch);
    return { session_id: relogin.session_id, relogin };
  }

  async probe(...args: Parameters<TemplateHealthPort['probe']>) {
    this.#record('probe', args);
    return {
      results: [
        {
          site_id: 'site-a.test',
          outcome: 'signed_in' as const,
          reason: 'learned_cookies',
          duration_ms: 3,
        },
      ],
    };
  }

  async probes(...args: Parameters<TemplateHealthPort['probes']>) {
    this.#record('probes', args);
    return {
      data: [],
      page: { next_cursor: null, limit: args[1].limit },
      applied: { filters: {}, sort: { key: 'at', dir: 'desc' as const } },
      meta: { now: 1_700_000_000_000 },
    };
  }

  async startRelogin(...args: Parameters<TemplateHealthPort['startRelogin']>) {
    this.#record('startRelogin', args);
    return this.#relogin({ site_id: args[1].siteId, method: args[1].method });
  }

  async confirmRelogin(...args: Parameters<TemplateHealthPort['confirmRelogin']>) {
    this.#record('confirmRelogin', args);
    return this.#relogin({ state: 'signed_in', session_id: null, agents_paused: false });
  }

  async cancelRelogin(...args: Parameters<TemplateHealthPort['cancelRelogin']>) {
    this.#record('cancelRelogin', args);
    return this.#relogin({ state: 'cancelled', session_id: null, agents_paused: false });
  }

  async show(...args: Parameters<TemplateHealthPort['show']>) {
    this.#record('show', args);
    return { ok: true as const, window: 'relogin' as const, session_id: 'relogin-a1b2c3d4' };
  }

  async continueAgents(...args: Parameters<TemplateHealthPort['continueAgents']>) {
    this.#record('continueAgents', args);
    return { ok: true as const, agents_paused: false as const };
  }

  async putLink(...args: Parameters<TemplateHealthPort['putLink']>) {
    this.#record('putLink', args);
    return {
      site: this.site ?? defaultSite(),
      binding_allows_template: true,
      binding_problems: [],
    };
  }
}
