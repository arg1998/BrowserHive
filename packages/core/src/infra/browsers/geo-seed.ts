/** @module infra/browsers/geo-seed — the host GeoSeedResolver (LC_ALL → LANG → ICU → en-US) and the caller-truth seed (spec 11 §2.5). */

/**
 * The **geo seed** — the single source of truth for a session's linguistic/geographic identity.
 *
 * Every locale-shaped surface a page can read (`navigator.language`, `navigator.languages`, the
 * `Accept-Language` request header, `Intl.DateTimeFormat().resolvedOptions()`, `Date` offsets, and —
 * when known — the Geolocation API) must agree with **one** origin story, because anti-bot systems
 * score the *joint* distribution: an `en-US` identity whose clock sits in `Europe/Berlin` is a
 * stronger signal than either value alone. Deriving all of them from one seed makes that class of
 * incoherence structurally impossible.
 *
 * ## Why this is a port and not a function
 *
 * The seed's *content* depends on where the session's traffic actually exits:
 *   - **today** egress is the host's own IP, so the honest seed is the **host's** locale/timezone
 *     ({@link HostGeoSeedResolver}) — presenting a foreign identity over the host IP would be *less*
 *     coherent than presenting nothing at all;
 *   - **later**, when a managed proxy pool lands, the seed becomes the **proxy exit's** locale and
 *     timezone, resolved from the exit IP.
 *
 * That is the only thing proxy support changes here: a second `GeoSeedResolver` implementation
 * whose `source` is `'proxy'`. Everything downstream — identity derivation, context options, the init
 * script, persistence, the dashboard — consumes `GeoSeed` and is already indifferent to where it
 * came from.
 */

import type { BrowserContextOptions } from 'playwright';
import type { GeoSeed } from '../../ports/browser-driver.ts';
import type { GeoSeedResolver } from '../../ports/geo-seed-resolver.ts';
import type { HostFacts } from './host-facts.ts';

/** Fallback locale when the host exposes nothing usable. The most common desktop default. */
export const FALLBACK_LOCALE = 'en-US';
/** Fallback timezone when the host's is missing or unparseable by ICU. */
export const FALLBACK_TIMEZONE = 'UTC';

/** A plausible BCP-47 language tag. Deliberately permissive — we only need to reject junk. */
const BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Build `navigator.languages` from a single locale, the way Chrome does: the full locale first, then
 * its bare language subtag when the locale carries a region (`en-US` → `['en-US', 'en']`). A locale
 * that is already bare yields a single entry.
 */
export function languagesForLocale(locale: string): string[] {
  const base = locale.split('-')[0];
  return base !== undefined && base.length > 0 && base !== locale ? [locale, base] : [locale];
}

/**
 * The ISO 3166-1 alpha-2 region subtag of a locale, uppercased, or `null` when there is none.
 * Skips the optional 4-letter script subtag (`zh-Hant-TW` → `TW`).
 */
export function countryCodeForLocale(locale: string): string | null {
  for (const part of locale.split('-').slice(1)) {
    if (/^[A-Za-z]{2}$/.test(part)) return part.toUpperCase();
  }
  return null;
}

/**
 * Parse a POSIX locale env value (`en_US.UTF-8`, `de_DE@euro`, `C`, `POSIX`) into a BCP-47 locale.
 * Returns `undefined` for the non-locales (`C` / `POSIX`) and anything unparseable.
 */
export function localeFromPosixEnv(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  // Strip the codeset (`.UTF-8`) and modifier (`@euro`) suffixes POSIX allows.
  const bare = value.split('.')[0]?.split('@')[0];
  if (bare === undefined || bare.length === 0) return undefined;
  if (bare === 'C' || bare === 'POSIX') return undefined;
  const bcp47 = bare.replace('_', '-');
  return BCP47_RE.test(bcp47) ? bcp47 : undefined;
}

/** True if ICU accepts `timeZone` — a bogus `TZ` env var must not poison every session. */
export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Injectable host descriptors, so {@link resolveHostGeoSeed} stays unit-testable without ICU games. */
export interface HostGeoEnvironment {
  /** Resolved ICU locale — production passes `Intl.DateTimeFormat().resolvedOptions().locale`. */
  readonly icuLocale?: string;
  /** Resolved ICU timezone — production passes `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  readonly icuTimeZone?: string;
  /** Injected environment (`HostEnvironment.env`), read for the POSIX `LC_ALL` / `LANG` locale. */
  readonly env: HostFacts['env'];
}

/**
 * Resolves the seed from the **host machine** — the correct answer while egress is the host IP. No
 * network call, no geo database, no coordinates. The `proxyServer` request slot is ignored here by
 * design (spec 11 §11).
 */
export class HostGeoSeedResolver implements GeoSeedResolver {
  private readonly environment: HostGeoEnvironment;

  constructor(host: HostFacts, icu: Pick<HostGeoEnvironment, 'icuLocale' | 'icuTimeZone'> = {}) {
    this.environment = { env: host.env, ...icu };
  }

  resolve(): Promise<GeoSeed> {
    return Promise.resolve(resolveHostGeoSeed(this.environment));
  }
}

/**
 * Pure core of {@link HostGeoSeedResolver}.
 *
 * **Locale precedence is `LC_ALL` → `LANG` → ICU**, and the order is load-bearing rather than
 * stylistic: BrowserHive runs under both Node and Bun, and the two disagree. On a host with
 * `LANG=en_CA.UTF-8`, Node's `Intl.DateTimeFormat().resolvedOptions().locale` reports `en-CA` while
 * Bun's reports `en-US` — so seeding from ICU first would hand a Bun-launched session an `en-US`
 * identity on a `America/Toronto` clock. That is a self-inflicted incoherence on the host IP, with no
 * proxy involved, and it is precisely what this module exists to prevent. The environment is the
 * runtime-independent answer; ICU is the fallback for hosts (notably Windows and GUI macOS sessions)
 * that do not set the POSIX variables at all.
 *
 * Timezone has no such disagreement — both runtimes honour `TZ` through ICU — so it is read from ICU
 * and merely validated.
 */
export function resolveHostGeoSeed(environment: HostGeoEnvironment): GeoSeed {
  const resolved = intlDefaults();
  const env = environment.env;

  const locale =
    localeFromPosixEnv(env['LC_ALL']) ??
    localeFromPosixEnv(env['LANG']) ??
    normaliseLocale(environment.icuLocale ?? resolved.locale) ??
    FALLBACK_LOCALE;

  const candidateZone = environment.icuTimeZone ?? resolved.timeZone;
  const timezoneId =
    candidateZone !== undefined && candidateZone.length > 0 && isValidTimezone(candidateZone)
      ? candidateZone
      : FALLBACK_TIMEZONE;

  return {
    locale,
    languages: languagesForLocale(locale),
    countryCode: countryCodeForLocale(locale),
    timezoneId,
    source: 'host',
  };
}

/** ICU's resolved locale + timezone, guarded — a broken ICU build must not throw at session launch. */
function intlDefaults(): { locale?: string; timeZone?: string } {
  try {
    const options = new Intl.DateTimeFormat().resolvedOptions();
    return { locale: options.locale, timeZone: options.timeZone };
  } catch {
    return {};
  }
}

/**
 * Reject the ICU placeholders that are not real locales (`c`, `posix`, the root locale `und`) and
 * anything that is not a plausible BCP-47 tag, so the caller falls through to the default.
 */
function normaliseLocale(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'c' || lower === 'posix' || lower === 'und') return undefined;
  return BCP47_RE.test(value) ? value : undefined;
}

/**
 * The seed a caller stated in `context_options` (`locale` and/or `timezoneId`), with the missing
 * half taken from the host seed; `null` when the caller stated neither. Caller truth is honoured
 * without a warning (coherence rule 1, spec 11 §2.6).
 */
export function callerGeoSeed(
  contextOptions: BrowserContextOptions | undefined,
  host: GeoSeed,
): GeoSeed | null {
  const locale = contextOptions?.locale;
  const timezoneId = contextOptions?.timezoneId;
  if (locale === undefined && timezoneId === undefined) return null;
  const resolvedLocale = locale ?? host.locale;
  return {
    locale: resolvedLocale,
    languages: languagesForLocale(resolvedLocale),
    countryCode: countryCodeForLocale(resolvedLocale),
    timezoneId: timezoneId ?? host.timezoneId,
    source: 'host',
  };
}
