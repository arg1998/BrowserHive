/** @module contracts/http/template-parts — the building blocks of a session template on the wire: ids, names, bounds, the pinned proxy, access and unseal policy, and the pinned and observed identity (spec 13 §2.1–§2.2, §5.4, §6). */
import { z } from 'zod';
import { SecretEnvName } from '../notifications/channel.ts';
import { TEMPLATE_NAME_RE } from '../tools/templates.ts';
import { EpochMs } from './common.ts';
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
export const TemplateLocale = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'a language tag like en-CA')
  .max(35);

/** An IANA time zone (`America/Toronto`); the server checks that ICU knows it. */
export const TemplateTimezoneId = z.string().min(1).max(64);

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
