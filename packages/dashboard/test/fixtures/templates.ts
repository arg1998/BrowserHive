/** @module dashboard/test/fixtures/templates — typed builders for template DTOs (list rows, the template, its detail, sites, versions) used by the templates page tests; shaped by the contracts schemas (and `pending/contracts.ts` for the T1b shapes) */
import type {
  HostView,
  Template,
  TemplateDetailResponse,
  TemplateSiteView,
  TemplateSummary,
  TemplatesPage,
} from '@browserhive/contracts/http';
import type {
  TemplateVersionRow,
  TemplateVersionsPage,
} from '@/features/templates/pending/contracts.ts';

/** Server clock used by fixtures. */
export const TT0 = 1_700_000_000_000;

/** A valid template id for index `i`. */
export function tid(i: number): string {
  return `tp-${String(i).padStart(10, '0')}`;
}

/** A site of a template. */
export function templateSite(
  siteId: string,
  patch: Partial<TemplateSiteView> = {},
): TemplateSiteView {
  return {
    site_id: siteId,
    title: siteId,
    pack_id: null,
    pack_version: null,
    enabled: true,
    write_policy: null,
    vault_handle: null,
    auto_relogin: false,
    form: null,
    learned_cookie_names: [],
    health: {
      state: 'unknown',
      checked_at: null,
      changed_at: null,
      reason: null,
      consecutive_inconclusive: 0,
    },
    stopped_at: null,
    device_bound: false,
    added_at: TT0 - 86_400_000,
    ...patch,
  };
}

/** A signed-in site. */
export function signedInSite(siteId: string): TemplateSiteView {
  return templateSite(siteId, {
    learned_cookie_names: ['sid'],
    health: {
      state: 'signed_in',
      checked_at: TT0 - 60_000,
      changed_at: TT0 - 3_600_000,
      reason: 'confirmed_by_operator',
      consecutive_inconclusive: 0,
    },
  });
}

/** The browser of a template. */
export function hostView(patch: Partial<HostView> = {}): HostView {
  return {
    state: 'stopped',
    since: null,
    started_at: null,
    restarts: 0,
    pages: 0,
    parked_pages: 0,
    sandboxed: null,
    profile_secrets: false,
    ...patch,
  };
}

/** A template. */
export function template(i: number, patch: Partial<Template> = {}): Template {
  const name = patch.name ?? (i === 1 ? 'job-hunt' : `tpl-${i}`);
  return {
    template_id: tid(i),
    name,
    display_name: i === 1 ? 'Job hunt' : `Template ${i}`,
    description: 'LinkedIn and Indeed, signed in as the recruiter account.',
    status: 'ready',
    owner: 'operator',
    sites: [signedInSite('linkedin.com'), signedInSite('indeed.com')],
    identity: {
      seed: 'abcdefghijklmnopqrstu',
      locale: 'en-CA',
      languages: ['en-CA', 'en'],
      timezone_id: 'America/Toronto',
      country_code: 'CA',
    },
    identity_observed: null,
    channel: 'chromium',
    headless: false,
    stealth: 'standard',
    fingerprint: true,
    humanize: true,
    proxy: null,
    policy: {
      authorized_principals: [],
      max_concurrent: 5,
      unseal: { cookie_values: false, evaluate: false, cookie_writes: false, state_export: false },
      health_interval_ms: 21_600_000,
      prelaunch_check: true,
    },
    agent_windows: 'normal',
    current_version: null,
    checkpoint_at: null,
    checkpoint_size_bytes: null,
    version: 1,
    created_at: TT0 - 86_400_000 * i,
    updated_at: TT0 - 3_600_000,
    last_used_at: TT0 - 600_000,
    disabled_at: null,
    ...patch,
  };
}

/** A list row from a template. */
export function templateSummary(i: number, patch: Partial<TemplateSummary> = {}): TemplateSummary {
  const t = template(i);
  return {
    template_id: t.template_id,
    name: t.name,
    display_name: t.display_name,
    status: t.status,
    channel: t.channel,
    headless: t.headless,
    sites: t.sites.map((s) => ({
      site_id: s.site_id,
      title: s.title,
      health_state: s.health.state,
      checked_at: s.health.checked_at,
    })),
    host: { state: 'running', since: TT0 - 120_000, pages: 3 },
    in_use: 2,
    cap: 5,
    current_version: null,
    checkpoint_at: null,
    last_used_at: t.last_used_at,
    sealed: true,
    ...patch,
  };
}

/** `GET /templates` body. */
export function templatesPage(rows: readonly TemplateSummary[]): TemplatesPage {
  const count = (values: readonly string[]) => {
    const map = new Map<string, number>();
    for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
    return [...map].map(([value, n]) => ({ value, count: n }));
  };
  return {
    data: [...rows],
    page: { next_cursor: null, limit: 25, total: rows.length },
    applied: { filters: {}, sort: { key: 'name', dir: 'asc' } },
    meta: { now: TT0 },
    facets: {
      status: count(rows.map((r) => r.status)),
      host_state: count(rows.map((r) => r.host.state)),
      health: count(rows.flatMap((r) => r.sites.map((s) => s.health_state))),
    },
  };
}

/** `GET /templates/{id}` body. */
export function templateDetail(
  patch: Partial<Template> = {},
  extra: Partial<Omit<TemplateDetailResponse, 'template'>> = {},
): TemplateDetailResponse {
  const t = template(1, patch);
  return {
    template: t,
    host: hostView({
      state: 'running',
      since: TT0 - 120_000,
      started_at: TT0 - 120_000,
      pages: 3,
      sandboxed: true,
    }),
    sites: t.sites,
    sessions_live: 2,
    parked_pages: [],
    shared_windows: [],
    unlisted_domains: [],
    now: TT0,
    ...extra,
  };
}

/** A version row (T1b shape). */
export function versionRow(
  version: number,
  patch: Partial<TemplateVersionRow> = {},
): TemplateVersionRow {
  return {
    version,
    reason: version === 1 ? 'recording' : 'manual',
    restored_from: null,
    size_bytes: 48_000 + version * 1000,
    summary: {
      'linkedin.com': {
        cookies: 14,
        signin_cookies: ['li_at'],
        earliest_expiry: TT0 + 86_400_000 * 300,
        session_cookie: true,
      },
    },
    health: { 'linkedin.com': 'signed_in', 'indeed.com': 'signed_in' },
    pinned: false,
    last_good: version === 1,
    readable: true,
    created_by: 'operator',
    created_at: TT0 - 3_600_000 * (10 - version),
    ...patch,
  };
}

/** `GET /templates/{id}/versions` body (T1b shape). */
export function versionsPage(rows: readonly TemplateVersionRow[]): TemplateVersionsPage {
  return {
    data: [...rows],
    page: { next_cursor: null, limit: 50 },
    checkpoint: { at: TT0 - 300_000, size_bytes: 52_000, readable: true },
  };
}
