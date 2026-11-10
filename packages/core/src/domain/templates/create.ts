/** @module domain/templates/create — validating and building a new template from `TemplateInput` (spec 13 §2.1–§2.3, §6.1, §11.1): sites reduced to registrable domains, the pinned proxy, the pinned identity and the default access rule. */

import type { TemplateInput } from '@browserhive/contracts/http';
import { registrableDomain } from '../../kernel/url.ts';
import type { TemplateGeo } from '../../ports/geo-seed-resolver.ts';
import type {
  PinnedIdentityRecord,
  SessionChannel,
  TemplateProxyRecord,
  TemplateRecord,
  TemplateSiteRecord,
  TemplateStealthLevel,
} from '../../ports/persistence/index.ts';
import { UNKNOWN_SITE_HEALTH } from '../../ports/persistence/index.ts';
import { isReservedSubject } from '../auth/reserved-subjects.ts';
import { proxyLabelFor } from '../policies/proxy-request.ts';
import { LOCAL_SUBJECT } from '../session/principal.ts';

/** Default probe interval for a new template until `templateHealthInterval` arrives (T2): 6 h. */
export const DEFAULT_TEMPLATE_HEALTH_INTERVAL_MS = 21_600_000;
/** Default live-session cap (spec 13 §6.3). */
export const DEFAULT_TEMPLATE_MAX_CONCURRENT = 5;

/** Proxy schemes Chromium accepts for a pinned proxy. */
const PROXY_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'socks4:', 'socks5:']);

/** One field-level problem, in the `VALIDATION_FAILED` issue shape. */
export interface TemplateInputIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

/** A site after reduction to its registrable domain. */
export interface NormalizedSite {
  readonly siteId: string;
  readonly writePolicy: TemplateSiteRecord['writePolicy'];
}

/** What {@link validateTemplateInput} accepted. */
export interface ValidatedTemplateInput {
  readonly sites: readonly NormalizedSite[];
  readonly proxy: TemplateProxyRecord | null;
}

/** Server facts the validation depends on. */
export interface TemplateInputContext {
  /** `auth=token` requires an explicit access choice (spec 13 §6.1). */
  readonly authMode: 'off' | 'token';
}

function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function validateProxy(
  input: NonNullable<TemplateInput['proxy']>,
  issues: TemplateInputIssue[],
): TemplateProxyRecord | null {
  let url: URL;
  try {
    url = new URL(input.server);
  } catch {
    issues.push({
      path: 'proxy.server',
      message: 'the proxy server must be scheme://host:port, for example http://proxy.example:8080',
      code: 'invalid_proxy',
    });
    return null;
  }
  if (url.username !== '' || url.password !== '') {
    issues.push({
      path: 'proxy.server',
      message:
        'put no credentials in the proxy URL: give proxy.username and the name of the environment variable that holds the password (proxy.password_env)',
      code: 'proxy_credentials_inline',
    });
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  if (!PROXY_SCHEMES.has(scheme) || url.hostname === '') {
    issues.push({
      path: 'proxy.server',
      message: 'the proxy server must be http://, https://, socks4:// or socks5:// with a host',
      code: 'invalid_proxy',
    });
    return null;
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    issues.push({
      path: 'proxy.server',
      message: 'the proxy server must be scheme://host:port without a path',
      code: 'invalid_proxy',
    });
    return null;
  }
  const server = `${scheme}//${url.host}`;
  return {
    server,
    bypass: input.bypass ?? null,
    username: input.username ?? null,
    passwordEnv: input.password_env ?? null,
    label: input.label ?? proxyLabelFor(server),
  };
}

/**
 * Field-level validation the schema cannot express (spec 13 §11.1 `POST /templates` 400s):
 * registrable sites without duplicates, a credential-free proxy, `locale` and `timezone_id` given
 * explicitly with a proxy, a timezone ICU knows, and under `auth=token` an explicit
 * `policy.authorized_principals`. Pack-dependent refusals (`headless` with a `headed: 'required'`
 * pack, `stealth: 'off'` with a `human_only` pack) arrive with site packs (T3a).
 */
export function validateTemplateInput(
  input: TemplateInput,
  context: TemplateInputContext,
):
  | { readonly ok: true; readonly value: ValidatedTemplateInput }
  | {
      readonly ok: false;
      readonly issues: readonly TemplateInputIssue[];
    } {
  const issues: TemplateInputIssue[] = [];
  const sites: NormalizedSite[] = [];
  const seen = new Map<string, number>();
  input.sites.forEach((site, index) => {
    const siteId = registrableDomain(site.site_id);
    if (siteId === '') {
      issues.push({
        path: `sites.${index}.site_id`,
        message: `'${site.site_id}' is not a site: give a domain name like linkedin.com (not an IP address, localhost or a bare public suffix)`,
        code: 'not_registrable',
      });
      return;
    }
    const first = seen.get(siteId);
    if (first !== undefined) {
      issues.push({
        path: `sites.${index}.site_id`,
        message: `'${site.site_id}' is the same site as sites.${first} (${siteId})`,
        code: 'duplicate_site',
      });
      return;
    }
    seen.set(siteId, index);
    sites.push({ siteId, writePolicy: site.write_policy ?? null });
  });

  const proxy = input.proxy === undefined ? null : validateProxy(input.proxy, issues);
  if (input.proxy !== undefined) {
    if (input.locale === undefined) {
      issues.push({
        path: 'locale',
        message: "give the locale explicitly with a proxy: it must match the proxy's location",
        code: 'required_with_proxy',
      });
    }
    if (input.timezone_id === undefined) {
      issues.push({
        path: 'timezone_id',
        message: "give the time zone explicitly with a proxy: it must match the proxy's location",
        code: 'required_with_proxy',
      });
    }
  }
  if (input.timezone_id !== undefined && !isValidTimezone(input.timezone_id)) {
    issues.push({
      path: 'timezone_id',
      message: `'${input.timezone_id}' is not a time zone (use an IANA name like America/Toronto)`,
      code: 'invalid_timezone',
    });
  }
  const lists = [
    ['policy.authorized_principals', input.policy?.authorized_principals ?? []],
    ['policy.unseal.principals', input.policy?.unseal?.principals ?? []],
  ] as const;
  for (const [path, list] of lists) {
    list.forEach((subject, index) => {
      // `local` is the auth=off principal and a valid grant; the system subjects never call.
      if (subject !== LOCAL_SUBJECT && isReservedSubject(subject)) {
        issues.push({
          path: `${path}.${index}`,
          message: `'${subject}' is a reserved subject: no agent can be it`,
          code: 'reserved',
        });
      }
    });
  }
  if (context.authMode === 'token' && input.policy?.authorized_principals === undefined) {
    issues.push({
      path: 'policy.authorized_principals',
      message:
        'choose who may use this template: list the principals, or [] for every agent of this server',
      code: 'required_under_token_auth',
    });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { sites, proxy } };
}

/**
 * The pinned identity of a new template (spec 13 §2.2): the seed, the resolved geo and the
 * operator's coordinates, if any (never invented, spec 11 §2.5).
 */
export function pinnedIdentity(
  seed: string,
  geo: TemplateGeo,
  geolocation: TemplateInput['geolocation'],
): PinnedIdentityRecord {
  return {
    seed,
    locale: geo.locale,
    languages: geo.languages,
    timezoneId: geo.timezoneId,
    countryCode: geo.countryCode,
    ...(geolocation !== undefined && {
      geolocation: {
        latitude: geolocation.latitude,
        longitude: geolocation.longitude,
        ...(geolocation.accuracy !== undefined && { accuracy: geolocation.accuracy }),
      },
    }),
  };
}

/** Server defaults a new template takes when the input leaves a field out. */
export interface TemplateDefaults {
  readonly channel: SessionChannel;
  readonly stealth: TemplateStealthLevel;
  /** The server's `fingerprint` (derived from its stealth level). */
  readonly fingerprint: boolean;
  readonly humanize: boolean;
}

/** Everything a new template is built from besides the input. */
export interface NewTemplateFacts {
  readonly templateId: string;
  readonly owner: string;
  readonly now: number;
  /** The resolved pinned identity (seed plus explicit or host geo, spec 13 §2.2). */
  readonly identity: PinnedIdentityRecord;
  readonly defaults: TemplateDefaults;
  /** Decides the default access (spec 13 §6.1). */
  readonly authMode: 'off' | 'token';
}

/**
 * The access a template gets when the operator gave none, which only `auth=off` allows (spec 13
 * §6.1, D-52): the one principal every caller is there, `local`. It behaves as "every agent" while
 * auth is off, and after a switch to `auth=token` reaches no token (`local` is reserved, T0f) until
 * the operator edits the access, instead of silently opening the template to every token.
 */
export const AUTH_OFF_DEFAULT_PRINCIPALS: readonly string[] = ['local'];

/**
 * The new template (status `recording`, version 1) and its sites. `fingerprint` and `humanize` are
 * derived as for sessions: both collapse to `false` with stealth `off`; `fingerprint` defaults to
 * `true` at stealth `max`.
 */
export function buildTemplate(
  input: TemplateInput,
  validated: ValidatedTemplateInput,
  facts: NewTemplateFacts,
): { readonly template: TemplateRecord; readonly sites: readonly TemplateSiteRecord[] } {
  const stealth = input.stealth ?? facts.defaults.stealth;
  const stealthOn = stealth !== 'off';
  const fingerprint =
    stealthOn && (input.fingerprint ?? (stealth === 'max' || facts.defaults.fingerprint));
  const humanize = stealthOn && (input.humanize ?? facts.defaults.humanize);
  const unseal = input.policy?.unseal;
  const template: TemplateRecord = {
    templateId: facts.templateId,
    name: input.name,
    displayName: input.display_name ?? input.name,
    description: input.description ?? '',
    status: 'recording',
    owner: facts.owner,
    tenantId: null,
    channel: input.channel ?? facts.defaults.channel,
    headless: input.headless ?? false,
    stealth,
    fingerprint,
    humanize,
    identity: facts.identity,
    identityObserved: null,
    proxy: validated.proxy,
    agentWindows: input.agent_windows ?? 'normal',
    authorizedPrincipals:
      input.policy?.authorized_principals === undefined
        ? facts.authMode === 'off'
          ? AUTH_OFF_DEFAULT_PRINCIPALS
          : []
        : [...new Set(input.policy.authorized_principals)],
    harnesses:
      input.policy?.harnesses === undefined || input.policy.harnesses === null
        ? null
        : [...new Set(input.policy.harnesses)],
    maxConcurrent: input.policy?.max_concurrent ?? DEFAULT_TEMPLATE_MAX_CONCURRENT,
    unseal: {
      cookieValues: unseal?.cookie_values ?? false,
      evaluate: unseal?.evaluate ?? false,
      cookieWrites: unseal?.cookie_writes ?? false,
      stateExport: unseal?.state_export ?? false,
      principals:
        unseal?.principals === undefined || unseal.principals.length === 0
          ? null
          : [...new Set(unseal.principals)],
    },
    healthIntervalMs: input.policy?.health_interval_ms ?? DEFAULT_TEMPLATE_HEALTH_INTERVAL_MS,
    prelaunchCheck: input.policy?.prelaunch_check ?? true,
    currentVersion: null,
    checkpointAt: null,
    checkpointSizeBytes: null,
    version: 1,
    createdAt: facts.now,
    updatedAt: facts.now,
    lastUsedAt: null,
    disabledAt: null,
  };
  const sites = validated.sites.map(
    (site): TemplateSiteRecord => ({
      templateId: facts.templateId,
      siteId: site.siteId,
      packId: null,
      packVersion: null,
      enabled: true,
      writePolicy: site.writePolicy,
      vaultHandle: null,
      autoRelogin: false,
      form: null,
      learnedCookieNames: [],
      health: UNKNOWN_SITE_HEALTH,
      stoppedAt: null,
      deviceBound: false,
      addedAt: facts.now,
    }),
  );
  return { template, sites };
}
