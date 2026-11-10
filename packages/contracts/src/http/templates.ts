/** @module contracts/http/templates — session template REST DTOs (spec 13 §2.1–§2.3, §11.1; D-49, D-52) */
import { z } from 'zod';
import { Channel } from '../enums/channel.ts';
import { SiteWritePolicy } from '../enums/site-write-policy.ts';
import { StealthLevel } from '../enums/stealth-level.ts';
import { TemplateHealthState } from '../enums/template-health-state.ts';
import { TemplateHostState } from '../enums/template-host-state.ts';
import { TemplateStatus } from '../enums/template-status.ts';
import { SecretEnvName } from '../notifications/channel.ts';
import { TEMPLATE_NAME_RE } from '../tools/templates.ts';
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
import { VaultHarnessList } from './vault.ts';

// ------------------------------------------------------------------------------------------------
// Primitives and bounds (spec 13 §2.1, §2.5).
// ------------------------------------------------------------------------------------------------

/** Template id, `tp-<nanoid10>` (D-05). */
export const TemplateId = z.string().regex(/^tp-[A-Za-z0-9_-]{10}$/, 'a template id (tp-…)');
/** Template id. */
export type TemplateId = z.infer<typeof TemplateId>;

/** A template's unique name: what agents pass as `launch_session.template`. */
export const TemplateName = z
  .string()
  .regex(TEMPLATE_NAME_RE, 'a name of 2–32 characters: a–z first, then a–z, 0–9 or -');

/** At most this many sites per template (spec 13 §2.1). */
export const TEMPLATE_SITES_MAX = 16;
/** Bounds of `policy.max_concurrent` (spec 13 §6.3, the migration's CHECK). */
export const TEMPLATE_MAX_CONCURRENT = { min: 1, max: 20, default: 5 } as const;
/** Bounds of `policy.health_interval_ms`: 30 min to 7 days (the migration's CHECK). */
export const TEMPLATE_HEALTH_INTERVAL_MS = { min: 1_800_000, max: 604_800_000 } as const;
/** At most this many principals in a template's access rule or unseal list. */
export const TEMPLATE_PRINCIPALS_MAX = 64;

/**
 * A site as the operator types it: a host name (`www.linkedin.com`) the server reduces to its
 * registrable domain (`linkedin.com`). Hosts on a public suffix only, IPs and `localhost` are refused
 * by the server with a field-level `VALIDATION_FAILED`.
 */
export const TemplateSiteHost = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/, 'a domain name like linkedin.com');

/** A principal subject in an access or unseal list. */
const PrincipalSubject = z.string().trim().min(1).max(128);

/** A BCP-47 language tag (`en-CA`). */
const Locale = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'a language tag like en-CA')
  .max(35);

/** An IANA time zone (`America/Toronto`); the server checks that ICU knows it. */
const TimezoneId = z.string().min(1).max(64);

/** Operator-given coordinates; BrowserHive never invents coordinates (spec 11 §2.5). */
export const TemplateGeolocation = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
});
/** Operator-given coordinates. */
export type TemplateGeolocation = z.infer<typeof TemplateGeolocation>;

// ------------------------------------------------------------------------------------------------
// Proxy, policy and unseal flags.
// ------------------------------------------------------------------------------------------------

/**
 * A template's pinned proxy (spec 13 §2.2). `server` is `scheme://host:port` without credentials;
 * `password_env` is the NAME of an environment variable (D-33), never a value.
 */
export const TemplateProxyInput = z.strictObject({
  server: z.string().trim().min(1).max(2048),
  bypass: z.string().max(2048).optional(),
  username: z.string().min(1).max(256).optional(),
  password_env: SecretEnvName.optional(),
  label: z.string().trim().min(1).max(80).optional(),
});
/** A template's pinned proxy as submitted. */
export type TemplateProxyInput = z.infer<typeof TemplateProxyInput>;

/** A template's pinned proxy as stored and returned (never a password value). */
export const TemplateProxy = z.object({
  server: z.string(),
  bypass: z.string().nullable(),
  username: z.string().nullable(),
  password_env: z.string().nullable(),
  label: z.string(),
});
/** A template's pinned proxy. */
export type TemplateProxy = z.infer<typeof TemplateProxy>;

/**
 * Unseal flags (spec 13 §5.4, D-51): each `false` (sealed) by default. `principals` absent or empty =
 * the flags apply to every principal the template allows; otherwise only to those principals.
 */
export const TemplateUnseal = z.object({
  cookie_values: z.boolean(),
  evaluate: z.boolean(),
  cookie_writes: z.boolean(),
  state_export: z.boolean(),
  principals: z.array(z.string()).optional(),
});
/** Unseal flags. */
export type TemplateUnseal = z.infer<typeof TemplateUnseal>;

/** Unseal flags as submitted: omitted flags are `false`. */
export const TemplateUnsealInput = z.strictObject({
  cookie_values: z.boolean().default(false),
  evaluate: z.boolean().default(false),
  cookie_writes: z.boolean().default(false),
  state_export: z.boolean().default(false),
  principals: z.array(PrincipalSubject).max(TEMPLATE_PRINCIPALS_MAX).optional(),
});

/**
 * Access and operation policy as submitted (spec 13 §6). `authorized_principals` empty = any
 * principal; under `auth=token` it is required at creation (spec 13 §6.1). `harnesses` follows D-48:
 * absent or `null` = every harness, `[]` = none.
 */
export const TemplatePolicyInput = z.strictObject({
  authorized_principals: z.array(PrincipalSubject).max(TEMPLATE_PRINCIPALS_MAX).optional(),
  harnesses: VaultHarnessList.nullable().optional(),
  max_concurrent: z
    .number()
    .int()
    .min(TEMPLATE_MAX_CONCURRENT.min)
    .max(TEMPLATE_MAX_CONCURRENT.max)
    .optional(),
  unseal: TemplateUnsealInput.optional(),
  health_interval_ms: z
    .number()
    .int()
    .min(TEMPLATE_HEALTH_INTERVAL_MS.min)
    .max(TEMPLATE_HEALTH_INTERVAL_MS.max)
    .optional(),
  prelaunch_check: z.boolean().optional(),
});
/** Policy as submitted. */
export type TemplatePolicyInput = z.infer<typeof TemplatePolicyInput>;

/** Access and operation policy as stored. `harnesses` absent = every harness (D-48). */
export const TemplatePolicy = z.object({
  authorized_principals: z.array(z.string()),
  harnesses: z.array(z.string()).optional(),
  max_concurrent: z.number().int(),
  unseal: TemplateUnseal,
  health_interval_ms: z.number().int(),
  prelaunch_check: z.boolean(),
});
/** Policy as stored. */
export type TemplatePolicy = z.infer<typeof TemplatePolicy>;

// ------------------------------------------------------------------------------------------------
// Identity (spec 13 §2.2): pinned at creation, observed at the first host start.
// ------------------------------------------------------------------------------------------------

/** The identity fixed at creation; never re-derived. No secret. */
export const PinnedIdentity = z.object({
  seed: z.string(),
  locale: z.string(),
  languages: z.array(z.string()),
  timezone_id: z.string(),
  country_code: z.string().nullable(),
  geolocation: TemplateGeolocation.optional(),
});
/** The identity fixed at creation. */
export type PinnedIdentity = z.infer<typeof PinnedIdentity>;

/** What the first host start recorded from the running browser; never faked (D-26). */
export const ObservedIdentity = z.object({
  chrome_major: z.string(),
  user_agent: z.string(),
  ua_ch: z.object({
    brands: z.array(z.object({ brand: z.string(), version: z.string() })),
    full_version_list: z.array(z.object({ brand: z.string(), version: z.string() })),
    platform: z.string(),
    platform_version: z.string(),
    architecture: z.string(),
    bitness: z.string(),
  }),
  screen: z.object({
    width: z.number().int(),
    height: z.number().int(),
    device_scale_factor: z.number(),
  }),
  window: z.object({ width: z.number().int(), height: z.number().int() }),
  observed_at: EpochMs,
});
/** What the first host start recorded. */
export type ObservedIdentity = z.infer<typeof ObservedIdentity>;

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
  locale: Locale.optional(),
  timezone_id: TimezoneId.optional(),
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
