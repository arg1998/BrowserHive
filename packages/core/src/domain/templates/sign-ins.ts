/** @module domain/templates/sign-ins — what the template's cookie jar says about sign-ins (spec 13 §2.3, §7.1): the cookie names a generic site learns at **I'm signed in**, a pack site signed in by its pack's `cookie_names`, and the unlisted sign-ins Finish lists (a domain whose pack's sign-in cookies are present, or a domain the operator opened in a window that holds a sign-in-shaped cookie; ad, analytics and anti-bot cookies and domains never count). Cookie names and domains only, never a value (D-20). */

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
 * Analytics, advertising and bot-management cookies that say nothing about a sign-in (spec 13 §7.1
 * `ANALYTICS_COOKIE_PATTERNS`): `_ga*`, `_gid`, `_gat*`, `_fbp`, `_fbc`, `__cf_bm`, `_cfuvid`,
 * `__utm*`, `_hj*`, `_uetsid`, `_uetvid`, `ajs_*`, and the ad and anti-bot names third-party frames
 * set on a site's pages: `IDE`, `DSID`, `test_cookie`, `fr`, `_GRECAPTCHA`, `NID`, `AEC`,
 * `__Secure-ENID`, `ar_debug`, `receive-cookie-deprecation`, `_gcl_*`, `MUID`, `_clck`, `_clsk`,
 * `uuid2`, `anj`.
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
  /^IDE$/,
  /^DSID$/,
  /^test_cookie$/,
  /^fr$/,
  /^_GRECAPTCHA$/,
  /^NID$/,
  /^AEC$/,
  /^__Secure-ENID$/,
  /^ar_debug$/,
  /^receive-cookie-deprecation$/,
  /^_gcl_/,
  /^MUID$/,
  /^_clck$/,
  /^_clsk$/,
  /^uuid2$/,
  /^anj$/,
];

/**
 * Registrable domains of ad, analytics and tracking services: their cookies are never a sign-in
 * the operator made, however they are flagged (spec 13 §2.3).
 */
export const TRACKER_DOMAINS: ReadonlySet<string> = new Set([
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagmanager.com',
  'googletagservices.com',
  'google-analytics.com',
  'adnxs.com',
  'adsrvr.org',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'scorecardresearch.com',
  'quantserve.com',
  'rubiconproject.com',
  'pubmatic.com',
  'casalemedia.com',
  'openx.net',
  'demdex.net',
  'everesttech.net',
  'bidswitch.net',
  'clarity.ms',
  'hotjar.com',
  'segment.io',
  'amazon-adsystem.com',
]);

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

/** A cookie that marks a sign-in: persistent, `HttpOnly`, `Secure`, and not an ad or analytics name. */
function isSignInCookie(cookie: JarCookie): boolean {
  return cookie.httpOnly && cookie.secure && cookie.expires > 0 && !isAnalyticsCookie(cookie.name);
}

/** A pack's domains and sign-in `cookie_names`. */
export interface PackCookies {
  readonly domains: readonly string[];
  readonly cookieNames: readonly string[];
}

/**
 * True when every one of a pack's sign-in `cookie_names` is in the jar, unexpired, on one of the
 * pack's domains (spec 13 §7.1: a pack site counts as signed in without **I'm signed in**).
 * `false` for a pack that names none.
 */
export function packCookiesPresent(
  pack: PackCookies,
  jar: readonly Pick<JarCookie, 'name' | 'domain' | 'expires'>[],
  now: number,
): boolean {
  if (pack.cookieNames.length === 0) return false;
  const seconds = now / 1000;
  const domains = new Set(pack.domains);
  const present = new Set(
    jar
      .filter((c) => domains.has(cookieSite(c)) && (c.expires <= 0 || c.expires > seconds))
      .map((c) => c.name),
  );
  return pack.cookieNames.every((name) => present.has(name));
}

/** Each cookie's expiry by `<registrable domain>\t<name>` (a window-open baseline; names only). */
export function jarExpiries(
  jar: readonly Pick<JarCookie, 'name' | 'domain' | 'expires'>[],
): ReadonlyMap<string, number> {
  return new Map(jar.map((c) => [`${cookieSite(c)}\t${c.name}`, c.expires]));
}

/**
 * True when at least one of a pack's sign-in cookies appeared, or was set again with a new expiry,
 * since `baseline` (the jar when the sign-in window opened): the operator signed in in the window
 * (review #85 H2). Cookies that were all there unchanged prove nothing: a server that invalidated
 * the session keeps them. `false` without a baseline.
 */
export function packCookiesChanged(
  pack: PackCookies,
  baseline: ReadonlyMap<string, number> | undefined,
  jar: readonly Pick<JarCookie, 'name' | 'domain' | 'expires'>[],
): boolean {
  if (baseline === undefined) return false;
  const domains = new Set(pack.domains);
  return jar.some((c) => {
    const site = cookieSite(c);
    if (!domains.has(site) || !pack.cookieNames.includes(c.name)) return false;
    const before = baseline.get(`${site}\t${c.name}`);
    return before === undefined || before !== c.expires;
  });
}

/** What deciding the unlisted sign-ins needs beyond the jar. */
export interface UnlistedContext {
  /**
   * The sign-in `cookie_names` and domains of the pack that covers a registrable domain, or `null`
   * when no pack covers it (or the pack names no cookies).
   */
  readonly packOf: (domain: string) => PackCookies | null;
  /** Registrable domains a window of the browser opened as a page (main frame, not an embed). */
  readonly visited: ReadonlySet<string>;
  /** Now (epoch ms): an expired pack cookie is no sign-in. */
  readonly now: number;
}

/**
 * Registrable domains the jar is signed in to that are not sites of the template (spec 13 §2.3),
 * sorted: a domain a pack covers when every one of the pack's sign-in cookies is present (and the
 * domain holds one of them); any domain (a pack's too) when a window opened it as a page (a
 * top-level request or redirect hop, never an embedded frame) and it holds a persistent `HttpOnly`
 * and `Secure` cookie that is not an ad or analytics name. A domain of a pack whose site is a site
 * of the template is never listed. Ad and tracking domains ({@link TRACKER_DOMAINS}) and
 * domains with no registrable domain (IPs, `localhost`) are left out: the cookies embedded frames
 * and pixels of a site's pages leave are not sign-ins the operator made.
 */
export function unlistedDomains(
  jar: readonly JarCookie[],
  sites: readonly string[],
  context: UnlistedContext,
): string[] {
  const own = new Set(sites);
  const byDomain = new Map<string, JarCookie[]>();
  for (const cookie of jar) {
    const site = cookieSite(cookie);
    if (site === '' || own.has(site) || TRACKER_DOMAINS.has(site)) continue;
    byDomain.set(site, [...(byDomain.get(site) ?? []), cookie]);
  }
  const found: string[] = [];
  for (const [domain, cookies] of byDomain) {
    const pack = context.packOf(domain);
    // A pack's other domain (licdn.com of linkedin.com) is the site's own when a site uses it.
    if (pack?.domains.some((d) => own.has(d)) === true) continue;
    const byPack =
      pack !== null &&
      cookies.some((c) => pack.cookieNames.includes(c.name)) &&
      packCookiesPresent(pack, jar, context.now);
    // Without the pack's full set (or without a pack), a page the window opened that holds a
    // sign-in-shaped cookie still counts (review #85 L1).
    const signedIn = byPack || (context.visited.has(domain) && cookies.some(isSignInCookie));
    if (signedIn) found.push(domain);
  }
  return found.sort();
}
