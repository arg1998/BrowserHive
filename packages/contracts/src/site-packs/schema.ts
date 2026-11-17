/** @module contracts/site-packs/schema — the structural schema of one site pack version (spec 13 §9.2, D-54): data only, `.strict()` everywhere, every string and list capped. The refinements that need a registrable-domain helper, the glob grammar and a CSS grammar live in core (`refinePack`, spec 13 §9.10). */
import { z } from 'zod';

/** A lowercase DNS name with at least two labels and an alphabetic last label. */
export const PACK_DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** A registrable domain (refined in core: `registrableDomain(d) === d`). */
export const PackRegistrableDomain = z.string().min(4).max(253).regex(PACK_DOMAIN_RE);
/** A host (refined in core at pack level: its registrable domain is one of `domains`). */
export const PackHost = z.string().min(4).max(253).regex(PACK_DOMAIN_RE);
/** A path: no scheme, query or fragment. */
export const PackScopedPath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\/[A-Za-z0-9\-._~/%]*$/);
/** Always `https://<host><path>`. */
export const PackScopedUrl = z.strictObject({ host: PackHost, path: PackScopedPath });
/** A spec 11 §5 glob (`*` and `?` only, no scheme); refined in core. */
export const PackUrlGlob = z.string().min(1).max(300);
/** A CSS selector list; refined in core (spec 13 §9.10). */
export const PackCssSelector = z.string().min(1).max(200);
/** A short visible text. */
export const PackText = z.string().min(2).max(120);
/** `YYYY-MM-DD`. */
export const PackIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A guard, challenge or rule id. */
export const PackId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
/** `MAJOR.MINOR.PATCH` with an optional pre-release. */
export const PackSemVer = z.string().regex(/^\d{1,4}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/);

/** Methods a guard can name (equal to core's `GUARD_METHODS`, asserted by a test). */
export const PACK_GUARD_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
/** A guard method. */
export const PackMethod = z.enum(PACK_GUARD_METHODS);
/** Resource types a guard can name, Playwright's names; beacons are `ping` (equal to core's `GUARD_RESOURCE_TYPES`). */
export const PACK_RESOURCE_TYPES = [
  'document',
  'xhr',
  'fetch',
  'ping',
  'eventsource',
  'other',
] as const;
/** A guard resource type. */
export const PackResourceType = z.enum(PACK_RESOURCE_TYPES);

/** Where a fact comes from; display only, never fetched. */
export const PackSource = z.strictObject({
  url: z.string().url().max(500).startsWith('https://'),
  kind: z.enum(['official', 'vendor', 'community', 'observed']),
});
/** A source. */
export type PackSource = z.infer<typeof PackSource>;

/** What a matching guard does. */
export const PackGuardAction = z.enum(['block', 'confirm', 'warn', 'write_policy']);
/** A guard action. */
export type PackGuardAction = z.infer<typeof PackGuardAction>;
/** What a guard protects (`credential`: tokens, keys, app passwords, OAuth consent, recovery and passkey changes). */
export const PackGuardKind = z.enum(['logout', 'account', 'credential', 'destructive', 'write']);
/** A guard kind. */
export type PackGuardKind = z.infer<typeof PackGuardKind>;

/** A network guard (spec 13 §9.3 the request guard). */
export const PackGuard = z.strictObject({
  id: PackId,
  kind: PackGuardKind,
  match: z.strictObject({
    url: PackUrlGlob,
    /** Absent: every method. */
    methods: z.array(PackMethod).min(1).max(5).optional(),
    /** Absent: document, xhr, fetch, ping. */
    resource_types: z.array(PackResourceType).min(1).max(6).optional(),
  }),
  /** `write_policy` only when `kind` is `write` (refined in core). */
  action: PackGuardAction,
});
/** A network guard. */
export type PackGuard = z.infer<typeof PackGuard>;

/** A control guarded at the tool layer (spec 13 §9.3 the tool layer). */
export const PackElementGuard = z.strictObject({
  id: PackId,
  kind: PackGuardKind,
  /** Pages where the control is guarded. */
  page: PackUrlGlob,
  target: z.union([
    z.strictObject({ selector: PackCssSelector }),
    z.strictObject({ role: z.enum(['button', 'link', 'menuitem']), name: PackText }),
  ]),
  action: PackGuardAction,
  /** The request guard that enforces it on the network; refinePack warns when absent. */
  request_guard: PackId.optional(),
});
/** An element guard. */
export type PackElementGuard = z.infer<typeof PackElementGuard>;

/** Challenge providers BrowserHive recognises by frame (spec 13 §9.5 `CHALLENGE_PROVIDERS`). */
export const PACK_CHALLENGE_PROVIDERS = [
  'cloudflare',
  'recaptcha',
  'hcaptcha',
  'arkose',
  'datadome',
] as const;
/** A challenge provider. */
export const PackChallengeProvider = z.enum(PACK_CHALLENGE_PROVIDERS);
/** A challenge kind. */
export const PackChallengeKind = z.enum(['checkpoint', 'captcha', 'reauth', 'locked', 'rejected']);
/** A challenge kind. */
export type PackChallengeKind = z.infer<typeof PackChallengeKind>;

/** A page that needs a human (spec 13 §9.5). */
export const PackChallenge = z.strictObject({
  id: PackId,
  kind: PackChallengeKind,
  /** At least one member (refined in core). */
  match: z.strictObject({
    url: PackUrlGlob.optional(),
    frame: PackChallengeProvider.optional(),
    title_contains: PackText.optional(),
    landmark: PackCssSelector.optional(),
    text: PackText.optional(),
  }),
  action: z.enum(['attention', 'stop']),
});
/** A challenge. */
export type PackChallenge = z.infer<typeof PackChallenge>;

/** Pacing periods. */
export const PACE_PERIODS = ['minute', 'hour', 'day', 'week'] as const;

/** A write budget (strategy `pace-writes`, T3b); bounded by `PACE_CEILING` in core. */
export const PackPaceRule = z.strictObject({
  id: PackId,
  /** A guard of kind `write` in this pack (refined in core). */
  guard: PackId,
  per: z.enum(PACE_PERIODS),
  limit: z.number().int().min(1),
  kind: z.enum(['official', 'vendor']),
  source: PackSource,
});
/** A pace rule. */
export type PackPaceRule = z.infer<typeof PackPaceRule>;

/** The strategies compiled into the binary (spec 13 §9.4); implemented by T3b. */
export const STRATEGY_IDS = [
  'pace-writes',
  'launch-spacing',
  'ramp-up',
  'serialize-site',
  'human-dwell',
  'humanize-input',
  'entry-warmup',
  'keep-alive',
  'active-hours',
  'device-bound-session',
  'stealth-profile',
  'single-focus',
  'webrtc-policy',
] as const;
/** A strategy id. */
export const StrategyId = z.enum(STRATEGY_IDS);
/** A strategy id. */
export type StrategyId = z.infer<typeof StrategyId>;

/** The sections a pack can record a verification date for. */
export const PACK_SECTIONS = [
  'sign_in',
  'signed_in',
  'guards',
  'element_guards',
  'write_policy',
  'challenges',
  'concurrency',
  'pacing',
  'browser',
  'device_binding',
  'consistency',
  'strategies',
] as const;
/** A verifiable section. */
export const PackSection = z.enum(PACK_SECTIONS);

/** The terms' position on automation (spec 13 §9.3 stance rule). */
export const PackStance = z.enum(['prohibited', 'restricted', 'writes_restricted', 'allowed']);
/** A stance. */
export type PackStance = z.infer<typeof PackStance>;

/** A write policy. */
export const PackWritePolicyDefault = z.enum(['allow', 'warn', 'confirm']);

/** One pack version, schema 1 (spec 13 §9.2). */
export const SitePackV1 = z.strictObject({
  schema: z.literal(1),
  /** The pack's identity: a registrable domain (`linkedin.com`). */
  id: PackRegistrableDomain,
  /** Strictly increasing per pack. */
  version: z.number().int().min(1).max(1_000_000),
  min_client: PackSemVer,
  max_client: PackSemVer.optional(),
  title: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  /** `domains[0] === id`, unique (refined in core). */
  domains: z.array(PackRegistrableDomain).min(1).max(8),
  /** The pack whose sign-in this site uses (`youtube.com` → `google.com`). */
  identity_provider: PackRegistrableDomain.optional(),
  shares_login_with: z.array(PackRegistrableDomain).max(4).default([]),
  /** Required unless `identity_provider` is set (refined in core). */
  sign_in: z
    .strictObject({
      url: PackScopedUrl,
      /** `true`: never filled by the vault (spec 13 §7.3). */
      human_only: z.boolean(),
      /**
       * Where the sign-in form posts (its `action`, or the address its script posts to), as guard
       * globs inside the pack's domains, never a whole host (refined in core). Read only by the
       * change classifier: a guard covering one of them can stop the site. Absent: every
       * `POST`-capable guard on the sign-in page's host counts (spec 13 §9.7).
       */
      post: z.array(PackUrlGlob).min(1).max(4).optional(),
      /** Refused with `human_only` (refined in core). */
      form: z
        .strictObject({
          username: PackCssSelector,
          password: PackCssSelector,
          submit: PackCssSelector.optional(),
          next: PackCssSelector.optional(),
        })
        .optional(),
    })
    .optional(),
  signed_in: z.strictObject({
    probe: PackScopedUrl,
    /** `redirect` needs `signed_out_redirects`; `landmark` needs `landmark` or `signed_out_marker` (refined in core). */
    kind: z.enum(['redirect', 'landmark', 'either']),
    signed_out_redirects: z.array(PackUrlGlob).max(8).default([]),
    landmark: PackCssSelector.optional(),
    signed_out_marker: PackCssSelector.optional(),
    /** Presence only, never a value. */
    cookie_names: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
      )
      .max(8)
      .default([]),
    session_lifetime_days: z.number().int().min(1).max(730).optional(),
  }),
  guards: z.array(PackGuard).max(64).default([]),
  element_guards: z.array(PackElementGuard).max(16).default([]),
  write_policy: z.strictObject({
    /** Follows the stance rule unless `exception` is set (refined in core). */
    default: PackWritePolicyDefault,
    stance: PackStance,
    clause: z
      .strictObject({
        quote: z.string().min(1).max(300),
        url: z.string().url().max(500).startsWith('https://'),
        checked: PackIsoDate,
      })
      .optional(),
    /** Why `default` departs from the stance rule; shown to the operator. */
    exception: z.string().min(10).max(300).optional(),
  }),
  challenges: z.array(PackChallenge).max(32).default([]),
  concurrency: z
    .strictObject({ max_sessions: z.number().int().min(1).max(20), source: PackSource })
    .optional(),
  pacing: z
    .strictObject({
      rules: z.array(PackPaceRule).max(16).default([]),
      min_launch_gap_s: z.number().int().min(0).max(3600).default(0),
    })
    .optional(),
  browser: z
    .strictObject({
      channel: z.enum(['chrome', 'edge', 'any']).default('any'),
      headed: z.enum(['required', 'preferred', 'any']).default('any'),
    })
    .default({ channel: 'any', headed: 'any' }),
  device_binding: z
    .array(
      z.strictObject({
        platform: z.enum(['windows', 'macos', 'linux']),
        mechanism: z.enum(['dbsc', 'ip', 'device_cookie']),
        since: z.string().max(40).optional(),
        source: PackSource,
      }),
    )
    .max(4)
    .default([]),
  consistency: z
    .strictObject({
      pin_geo: z.boolean().default(true),
      pin_timezone: z.boolean().default(true),
      pin_locale: z.boolean().default(true),
      proxy: z.enum(['recommended', 'any']).default('any'),
    })
    .default({ pin_geo: true, pin_timezone: true, pin_locale: true, proxy: 'any' }),
  strategies: z
    .array(
      z.strictObject({
        id: StrategyId,
        params: z
          .record(z.string().max(40), z.union([z.number(), z.boolean(), z.string().max(200)]))
          .default({}),
      }),
    )
    .max(8)
    .default([]),
  keeper: z
    .strictObject({
      interval_hours: z.number().int().min(6).max(168),
      path: PackScopedPath.optional(),
    })
    .optional(),
  verified: z.partialRecord(PackSection, PackIsoDate).default({}),
  /** Display only, never fetched. */
  sources: z.array(PackSource).max(10).default([]),
});
/** A parsed pack version (defaults applied). */
export type SitePackV1 = z.infer<typeof SitePackV1>;
/** A pack version as written (defaults optional). */
export type SitePackV1Input = z.input<typeof SitePackV1>;

/** At most 64 KiB per serialized pack (spec 13 §9.2). */
export const SITE_PACK_MAX_BYTES = 64 * 1024;

/**
 * The pseudo-classes a pack selector may use (spec 13 §9.2 `CSS_PSEUDO_ALLOWLIST`); the functional
 * ones take an argument. Playwright's extensions (`:text*`, `:has-text`, `:visible`, layout
 * pseudo-classes) are refused.
 */
export const CSS_PSEUDO_ALLOWLIST = [
  'not',
  'is',
  'where',
  'has',
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'only-of-type',
  'checked',
  'disabled',
  'enabled',
  'empty',
  'root',
] as const;

/** Write budgets per period a pack may set (spec 13 §9.10 `PACE_CEILING`). */
export const PACE_CEILING: Readonly<Record<(typeof PACE_PERIODS)[number], number>> = Object.freeze({
  minute: 60,
  hour: 1000,
  day: 10_000,
  week: 50_000,
});
