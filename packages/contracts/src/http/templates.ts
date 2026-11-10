/** @module contracts/http/templates — session template REST DTOs (spec 13 §2.1–§2.3, §11.1; D-49, D-52) */
import { z } from 'zod';
import { Channel } from '../enums/channel.ts';
import { SiteWritePolicy } from '../enums/site-write-policy.ts';
import { StealthLevel } from '../enums/stealth-level.ts';
import { TemplateHealthState } from '../enums/template-health-state.ts';
import { TemplateHostState } from '../enums/template-host-state.ts';
import { TemplateStatus } from '../enums/template-status.ts';
import {
  Bytes,
  Count,
  csv,
  EpochMs,
  Facet,
  listQuery,
  page,
  QueryBool,
  QueryText,
  sortable,
} from './common.ts';
import {
  ObservedIdentity,
  PinnedIdentity,
  TEMPLATE_SITES_MAX,
  TemplateGeolocation,
  TemplateId,
  TemplateLocale,
  TemplateName,
  TemplatePolicy,
  TemplatePolicyInput,
  TemplateProxy,
  TemplateProxyInput,
  TemplateSiteHost,
  TemplateTimezoneId,
} from './template-parts.ts';

// ------------------------------------------------------------------------------------------------
// Sites (spec 13 §2.3).
// ------------------------------------------------------------------------------------------------

/** One site's sign-in state (spec 13 §8). */
export const TemplateSiteHealth = z.object({
  state: TemplateHealthState,
  checked_at: EpochMs.nullable(),
  changed_at: EpochMs.nullable(),
  reason: z.string().nullable(),
  consecutive_inconclusive: Count,
});
/** One site's sign-in state. */
export type TemplateSiteHealth = z.infer<typeof TemplateSiteHealth>;

/** Selectors auto-relogin fills (spec 13 §2.3, §8.4). */
export const TemplateSiteForm = z.object({
  username: z.string(),
  password: z.string(),
  submit: z.string().optional(),
  next: z.string().optional(),
});

/** A site of a template as operators see it. */
export const TemplateSiteView = z.object({
  site_id: z.string(),
  /** The pack's title, or the domain for a generic site. */
  title: z.string(),
  pack_id: z.string().nullable(),
  pack_version: z.number().int().nullable(),
  enabled: z.boolean(),
  write_policy: SiteWritePolicy.nullable(),
  vault_handle: z.string().nullable(),
  auto_relogin: z.boolean(),
  form: TemplateSiteForm.nullable(),
  learned_cookie_names: z.array(z.string()),
  health: TemplateSiteHealth,
  stopped_at: EpochMs.nullable(),
  device_bound: z.boolean(),
  added_at: EpochMs,
});
/** A site of a template. */
export type TemplateSiteView = z.infer<typeof TemplateSiteView>;

/** A site as submitted at creation. */
export const TemplateSiteInput = z.strictObject({
  site_id: TemplateSiteHost,
  write_policy: SiteWritePolicy.optional(),
});
/** A site as submitted. */
export type TemplateSiteInput = z.infer<typeof TemplateSiteInput>;

// ------------------------------------------------------------------------------------------------
// The template.
// ------------------------------------------------------------------------------------------------

/** A virtual session's window state on a headed host (spec 13 §3.3). */
export const AgentWindows = z.enum(['normal', 'minimized']);
/** A virtual session's window state. */
export type AgentWindows = z.infer<typeof AgentWindows>;

/** `Template`: the wire shape of spec 13 §2.1 (operator surfaces only; agents see `list_templates`). */
export const Template = z.object({
  template_id: TemplateId,
  name: z.string(),
  display_name: z.string(),
  description: z.string(),
  status: TemplateStatus,
  owner: z.string(),
  sites: z.array(TemplateSiteView),
  identity: PinnedIdentity,
  identity_observed: ObservedIdentity.nullable(),
  channel: Channel,
  headless: z.boolean(),
  stealth: StealthLevel,
  fingerprint: z.boolean(),
  humanize: z.boolean(),
  proxy: TemplateProxy.nullable(),
  policy: TemplatePolicy,
  agent_windows: AgentWindows,
  current_version: z.number().int().nullable(),
  checkpoint_at: EpochMs.nullable(),
  checkpoint_size_bytes: Bytes.nullable(),
  /** Optimistic-concurrency row version (`If-Match`, D-14). */
  version: z.number().int().positive(),
  created_at: EpochMs,
  updated_at: EpochMs,
  last_used_at: EpochMs.nullable(),
  disabled_at: EpochMs.nullable(),
});
/** A template. */
export type Template = z.infer<typeof Template>;

/** `POST /templates` body (`TemplateInput`, spec 13 §11.1). */
export const TemplateInput = z.strictObject({
  name: TemplateName,
  display_name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  sites: z
    .array(TemplateSiteInput)
    .min(1, 'a template needs at least one site')
    .max(TEMPLATE_SITES_MAX, `at most ${TEMPLATE_SITES_MAX} sites`),
  channel: Channel.optional(),
  headless: z.boolean().optional(),
  stealth: StealthLevel.optional(),
  fingerprint: z.boolean().optional(),
  humanize: z.boolean().optional(),
  proxy: TemplateProxyInput.optional(),
  locale: TemplateLocale.optional(),
  timezone_id: TemplateTimezoneId.optional(),
  geolocation: TemplateGeolocation.optional(),
  agent_windows: AgentWindows.optional(),
  policy: TemplatePolicyInput.optional(),
});
/** `POST /templates` body. */
export type TemplateInput = z.infer<typeof TemplateInput>;

/** One template. */
export const TemplateResponse = z.object({ template: Template });
/** One template. */
export type TemplateResponse = z.infer<typeof TemplateResponse>;

/** Path params `{template_id}`. */
export const TemplateIdParams = z.strictObject({ template_id: TemplateId });
/** Path params `{template_id}`. */
export type TemplateIdParams = z.infer<typeof TemplateIdParams>;

// ------------------------------------------------------------------------------------------------
// The host (operator surfaces only).
// ------------------------------------------------------------------------------------------------

/** `HostView`: a template's browser as the operator sees it (spec 13 §11.1). */
export const HostView = z.object({
  state: TemplateHostState,
  /** When the host entered `state`; `null` for a host that never ran in this process. */
  since: EpochMs.nullable(),
  started_at: EpochMs.nullable(),
  restarts: Count,
  last_error: z.string().optional(),
  /** Agent pages open in the host. */
  pages: Count,
  parked_pages: Count,
  rss_bytes: Bytes.optional(),
  recycle_at: EpochMs.optional(),
  /** `null` until the host has started. */
  sandboxed: z.boolean().nullable(),
  /** Saved passwords or autofill data were found in the profile at the last start (spec 13 §3.1). */
  profile_secrets: z.boolean(),
});
/** A template's browser. */
export type HostView = z.infer<typeof HostView>;

/** The host part of a list row. */
export const TemplateHostSummary = z.object({
  state: TemplateHostState,
  since: EpochMs.nullable(),
  pages: Count,
  rss_bytes: Bytes.optional(),
});

/** One site of a list row. */
export const TemplateSiteSummary = z.object({
  site_id: z.string(),
  title: z.string(),
  health_state: TemplateHealthState,
  checked_at: EpochMs.nullable(),
});

/** `TemplateSummary`: one row of `GET /templates` (spec 13 §11.1). */
export const TemplateSummary = z.object({
  template_id: TemplateId,
  name: z.string(),
  display_name: z.string(),
  status: TemplateStatus,
  channel: Channel,
  headless: z.boolean(),
  sites: z.array(TemplateSiteSummary),
  host: TemplateHostSummary,
  /** Live agent sessions launched from the template. */
  in_use: Count,
  /** The effective session cap (`max_concurrent`, bounded by packs from T3a). */
  cap: Count,
  current_version: z.number().int().nullable(),
  checkpoint_at: EpochMs.nullable(),
  last_used_at: EpochMs.nullable(),
  /** `true` while no unseal flag is set (spec 13 §5.4). */
  sealed: z.boolean(),
  identity_drift: z.object({ from: z.string(), to: z.string() }).optional(),
});
/** One row of `GET /templates`. */
export type TemplateSummary = z.infer<typeof TemplateSummary>;

/** Sort keys of `GET /templates`. */
export const TemplateSortKey = sortable(['name', 'created_at', 'last_used_at', 'in_use']);
/** Sort keys of `GET /templates`. */
export type TemplateSortKey = z.infer<typeof TemplateSortKey>;

/** `GET /templates` query (spec 13 §11.1). */
export const TemplatesQuery = listQuery({
  sort: TemplateSortKey.default('name'),
  filters: {
    status: csv(TemplateStatus),
    host_state: csv(TemplateHostState),
    site: z.string().trim().toLowerCase().min(1).max(253).optional(),
    q: QueryText.optional(),
  },
});
/** `GET /templates` query. */
export type TemplatesQuery = z.infer<typeof TemplatesQuery>;

/** Facets of `GET /templates` (counts over every template, before filtering). */
export const TemplateFacets = z.object({
  status: z.array(Facet),
  host_state: z.array(Facet),
  health: z.array(Facet),
});

/** `GET /templates` body: `Page<TemplateSummary>` with typed facets. */
export const TemplatesPage = page(TemplateSummary).extend({ facets: TemplateFacets });
/** `GET /templates` body. */
export type TemplatesPage = z.infer<typeof TemplatesPage>;

/** A page of a host that no session owns (spec 13 §3.4); `url` is sanitized (D-20). */
export const ParkedPage = z.object({
  target_id: z.string(),
  url: z.string(),
  title: z.string(),
  opened_at: EpochMs,
});

/** A window that shows pages of several sessions (spec 13 §3.4, placement is not attribution). */
export const SharedWindow = z.object({
  window_id: z.number().int(),
  session_ids: z.array(z.string()),
});

/** `GET /templates/{template_id}` body (spec 13 §11.1). */
export const TemplateDetailResponse = z.object({
  template: Template,
  host: HostView,
  sites: z.array(TemplateSiteView),
  /** Live agent sessions launched from the template. */
  sessions_live: Count,
  parked_pages: z.array(ParkedPage),
  shared_windows: z.array(SharedWindow),
  /** Signed-in domains that are not sites of the template (spec 13 §2.3); from T1b's versions. */
  unlisted_domains: z.array(z.string()),
  now: EpochMs,
});
/** `GET /templates/{template_id}` body. */
export type TemplateDetailResponse = z.infer<typeof TemplateDetailResponse>;

/** `DELETE /templates/{template_id}` query: `force=true` closes live sessions first. */
export const DeleteTemplateQuery = z.strictObject({ force: QueryBool.default(false) });
/** `DELETE /templates/{template_id}` query. */
export type DeleteTemplateQuery = z.infer<typeof DeleteTemplateQuery>;

/** `DELETE /templates/{template_id}` body. Deleting does not sign out at the sites. */
export const DeleteTemplateResponse = z.object({
  ok: z.literal(true),
  closed_sessions: z.array(z.string()),
  deleted_bytes: Bytes,
});
/** `DELETE /templates/{template_id}` body. */
export type DeleteTemplateResponse = z.infer<typeof DeleteTemplateResponse>;
