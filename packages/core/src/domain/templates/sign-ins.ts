/** @module domain/templates/sign-ins — what the template's cookie jar says about sign-ins (spec 13 §2.3, §7.1): the cookie names a generic site learns at **I'm signed in**, and the unlisted sign-ins Finish lists. Cookie names and domains only, never a value (D-20). */

import { registrableDomain } from '../../kernel/url.ts';

/** A cookie as these rules read it (no value). */
export interface JarCookie {
  readonly name: string;
  readonly domain: string;
  /** Epoch seconds; `-1` (or ≤ 0) for a session cookie. */
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
}

/** At most this many learned cookie names per site (spec 13 §2.3). */
export const MAX_LEARNED_COOKIE_NAMES = 16;

/**
 * Analytics and bot-management cookies that say nothing about a sign-in (spec 13 §7.1
 * `ANALYTICS_COOKIE_PATTERNS`): `_ga*`, `_gid`, `_gat*`, `_fbp`, `_fbc`, `__cf_bm`, `_cfuvid`,
 * `__utm*`, `_hj*`, `_uetsid`, `_uetvid`, `ajs_*`.
 */
export const ANALYTICS_COOKIE_PATTERNS: readonly RegExp[] = [
  /^_ga/,
  /^_gid$/,
  /^_gat/,
  /^_fbp$/,
  /^_fbc$/,
  /^__cf_bm$/,
  /^_cfuvid$/,
  /^__utm/,
  /^_hj/,
  /^_uetsid$/,
  /^_uetvid$/,
  /^ajs_/,
];

/** True for an analytics cookie name. */
export function isAnalyticsCookie(name: string): boolean {
  return ANALYTICS_COOKIE_PATTERNS.some((pattern) => pattern.test(name));
}

/** The registrable domain a cookie belongs to (`.www.site-a.test` → `site-a.test`). */
export function cookieSite(cookie: Pick<JarCookie, 'domain'>): string {
  return registrableDomain(cookie.domain.replace(/^\./, ''));
}

/** The names on each registrable domain of `jar` (the snapshot taken when the window opens). */
export function jarNames(jar: readonly Pick<JarCookie, 'name' | 'domain'>[]): Set<string> {
  return new Set(jar.map((c) => `${cookieSite(c)}\t${c.name}`));
}

/**
 * The cookie names a generic site learns at **I'm signed in** (spec 13 §7.1): names on the site's
 * registrable domain now that were not there when the window opened, analytics names excluded, at
 * most {@link MAX_LEARNED_COOKIE_NAMES}, in jar order.
 */
export function learnedCookieNames(
  baseline: ReadonlySet<string>,
  jar: readonly Pick<JarCookie, 'name' | 'domain'>[],
  site: string,
): string[] {
  const names: string[] = [];
  for (const cookie of jar) {
    if (cookieSite(cookie) !== site || isAnalyticsCookie(cookie.name)) continue;
    if (baseline.has(`${site}\t${cookie.name}`) || names.includes(cookie.name)) continue;
    names.push(cookie.name);
    if (names.length === MAX_LEARNED_COOKIE_NAMES) break;
  }
  return names;
}

/** A cookie that marks a sign-in: persistent, `HttpOnly` and `Secure` (spec 13 §2.3). */
function isSignInCookie(cookie: JarCookie): boolean {
  return cookie.httpOnly && cookie.secure && cookie.expires > 0;
}

/**
 * Registrable domains the jar is signed in to that are not sites of the template (spec 13 §2.3):
 * at least one persistent `HttpOnly` and `Secure` cookie, sorted. Domains with no registrable
 * domain (IPs, `localhost`) are left out.
 */
export function unlistedDomains(jar: readonly JarCookie[], sites: readonly string[]): string[] {
  const own = new Set(sites);
  const found = new Set<string>();
  for (const cookie of jar) {
    const site = cookieSite(cookie);
    if (site !== '' && !own.has(site) && isSignInCookie(cookie)) found.add(site);
  }
  return [...found].sort();
}
