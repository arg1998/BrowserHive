/** @module domain/site-packs/probe-classify — the pack probe's decision (spec 13 §8.1 steps 1–2): the cookie pre-check over the pack's `cookie_names` (names and expiry only), then the navigation's signals in their fixed order (the probe path or below it counts as staying; every sign-in cookie present with no other signal is the weakest `signed_in`). Pure; the page is read through {@link PackProbeFacts}. */

import type { PackChallengeKind, SitePackV1 } from '@browserhive/contracts/site-packs';
import { registrableDomain, sanitizeUrl } from '../../kernel/url.ts';
import type { ProbeVerdict } from '../templates/probe.ts';
import { cookieSite, type JarCookie } from '../templates/sign-ins.ts';
import { challengeReason } from './challenges.ts';
import { matchesAnyPackGlob } from './pack-glob.ts';

/** Reason codes of the pack probe (spec 13 §8.1 step 2). */
export const PACK_PROBE_REASONS = {
  cookiesAbsent: 'cookies_absent',
  redirect: 'redirect',
  marker: 'marker',
  landmark: 'landmark',
  noRedirect: 'no_redirect',
  /** An `either` probe that loaded and stayed put: a weaker sign than a `redirect` probe's (D48, D43). */
  noRedirectSettled: 'no_redirect_settled',
  timeout: 'timeout',
  network: 'network',
  noSignal: 'no_signal',
  /**
   * Every sign-in cookie of the pack is present and the probe path stayed on the pack's domains
   * without a signed-out signal, but nothing on the page confirmed it: the weakest `signed_in`.
   */
  cookiesPresent: 'cookies_present',
} as const;

/** How long the probe's navigation may take (`domcontentloaded`, spec 13 §8.1). */
export const PROBE_NAVIGATION_MS = 20_000;

/**
 * After `load`, how long a `redirect` or `either` probe still on the probe path waits for a
 * client-side navigation to a `signed_out_redirects` URL (D48: Reddit redirects after
 * `DOMContentLoaded`).
 */
export const PROBE_REDIRECT_WINDOW_MS = 4_000;

/**
 * Step 1 (no navigation): `signed_out` / `cookies_absent` when the pack names sign-in cookies and
 * none is present and unexpired on the pack's domains; otherwise `null` (navigate).
 */
export function packCookiePrecheck(
  pack: SitePackV1,
  jar: readonly Pick<JarCookie, 'name' | 'domain' | 'expires'>[],
  now: number,
): ProbeVerdict | null {
  const names = pack.signed_in.cookie_names;
  if (names.length === 0) return null;
  const seconds = now / 1000;
  const domains = new Set(pack.domains);
  const present = jar.some(
    (c) =>
      names.includes(c.name) &&
      domains.has(cookieSite(c)) &&
      (c.expires <= 0 || c.expires > seconds),
  );
  return present
    ? null
    : { outcome: 'signed_out', reason: PACK_PROBE_REASONS.cookiesAbsent, finalUrl: null };
}

/**
 * True when the pack names sign-in cookies and every one of them is present and unexpired on the
 * pack's domains (the strong half of the pre-check: what `cookies_present` needs).
 */
export function packCookiesAllPresent(
  pack: SitePackV1,
  jar: readonly Pick<JarCookie, 'name' | 'domain' | 'expires'>[],
  now: number,
): boolean {
  const names = pack.signed_in.cookie_names;
  if (names.length === 0) return false;
  const seconds = now / 1000;
  const domains = new Set(pack.domains);
  return names.every((name) =>
    jar.some(
      (c) =>
        c.name === name && domains.has(cookieSite(c)) && (c.expires <= 0 || c.expires > seconds),
    ),
  );
}

/** `https://<probe.host><probe.path>`, or another path on the probe host (the keeper's). */
export function probeUrlOf(pack: SitePackV1, path = pack.signed_in.probe.path): string {
  return `https://${pack.signed_in.probe.host}${path}`;
}

/** True when `url` is a `signed_out_redirects` URL inside the pack's domains. */
export function isSignedOutUrl(pack: SitePackV1, url: string): boolean {
  return inPackDomains(pack, url) && matchesAnyPackGlob(pack.signed_in.signed_out_redirects, url);
}

/** True when `url`'s registrable domain is one of the pack's domains (the probe's domain guard). */
export function inPackDomains(pack: Pick<SitePackV1, 'domains'>, url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return pack.domains.includes(registrableDomain(host));
  } catch {
    return false;
  }
}

/** What the navigation found; `failure` when it did not reach `domcontentloaded`. */
export interface PackProbeFacts {
  readonly failure: 'timeout' | 'network' | null;
  readonly finalUrl: string;
  readonly status: number | null;
  /** The first challenge the page matches (spec 13 §9.5), detected before anything else. */
  readonly challenge: PackChallengeKind | null;
  /**
   * The page reached `load` and then stayed off every signed-out redirect for the post-load window
   * ({@link PROBE_REDIRECT_WINDOW_MS}): a client-side redirect had its chance (D48).
   */
  readonly settled: boolean;
  /** The path the navigation visited on the probe host (the keeper's path); default the probe's. */
  readonly path?: string;
  /** Every pack sign-in cookie was present before the navigation ({@link packCookiesAllPresent}). */
  readonly cookiesPresent?: boolean;
  /** A selector is present (`locator('css=…').count() > 0`, queried, never evaluated). */
  hasSelector(selector: string): Promise<boolean>;
}

/**
 * True when `url` is on the probe host at `path` or below it at a segment boundary (`/feed/` covers
 * `/feed/foryou/`, `/feed` covers `/feed/x` but not `/feedback`): a signed-in site that moves its
 * home page one level down (LinkedIn's `/feed/` → `/feed/foryou/`) has still stayed put. A root
 * probe path (`/`) covers only itself, so the rule never widens to the whole host.
 */
export function samePlace(pack: SitePackV1, url: string, path: string): boolean {
  try {
    const parsed = new URL(url);
    const probe = pack.signed_in.probe;
    if (parsed.hostname.toLowerCase() !== probe.host.toLowerCase()) return false;
    const base = path.replace(/\/+$/, '');
    const final = parsed.pathname.replace(/\/+$/, '');
    return final === base || (base !== '' && final.startsWith(`${base}/`));
  } catch {
    return false;
  }
}

/**
 * Step 2, in order (spec 13 §8.1): a challenge → `challenged`; the final URL (inside the pack's
 * domains) matches a `signed_out_redirects` glob → `signed_out` `redirect`; the signed-out marker →
 * `signed_out` `marker`; the landmark → `signed_in` `landmark`; a `redirect` pack still on the
 * probe host at the probe path or below it ({@link samePlace}; not a 4xx/5xx) → `signed_in`
 * `no_redirect`, and an `either` pack only once the page `settled` (loaded, then no signed-out
 * redirect within the post-load window, D48), as `no_redirect_settled` (lower confidence: a later
 * redirect or a sign-in modal reads the same); a probe-path visit that found every sign-in cookie
 * before it and ended on the pack's domains with no other signal (an `either` pack once settled) →
 * `signed_in` `cookies_present` (the weakest sign in); otherwise `inconclusive` (`timeout`,
 * `network`, `http_<status>` ≥ 400, `no_signal`). A challenge is never `signed_out`. A visit of
 * another path (the keeper's) never answers `no_redirect` or `cookies_present`: only the probe
 * path's staying put means signed in.
 */
export async function classifyPackProbe(
  pack: SitePackV1,
  facts: PackProbeFacts,
): Promise<ProbeVerdict> {
  const finalUrl = facts.finalUrl === '' ? null : sanitizeUrl(facts.finalUrl);
  const verdict = (outcome: ProbeVerdict['outcome'], reason: string): ProbeVerdict => ({
    outcome,
    reason,
    finalUrl,
  });
  if (facts.challenge !== null) return verdict('challenged', challengeReason(facts.challenge));
  if (facts.failure !== null) return verdict('inconclusive', facts.failure);
  const signals = pack.signed_in;
  if (isSignedOutUrl(pack, facts.finalUrl)) {
    return verdict('signed_out', PACK_PROBE_REASONS.redirect);
  }
  if (
    signals.signed_out_marker !== undefined &&
    (await present(facts, signals.signed_out_marker))
  ) {
    return verdict('signed_out', PACK_PROBE_REASONS.marker);
  }
  if (signals.landmark !== undefined && (await present(facts, signals.landmark))) {
    return verdict('signed_in', PACK_PROBE_REASONS.landmark);
  }
  // An error page on the probe path (a 401/403 bot wall, a 5xx) is no sign of a session: it is
  // checked before `no_redirect` (review #83 C-L5).
  if (facts.status !== null && facts.status >= 400) {
    return verdict('inconclusive', `http_${facts.status}`);
  }
  const probePath = signals.probe.path;
  const onProbePath = (facts.path ?? probePath) === probePath;
  const trusted = signals.kind === 'redirect' || (signals.kind === 'either' && facts.settled);
  if (trusted && onProbePath && samePlace(pack, facts.finalUrl, probePath)) {
    return verdict(
      'signed_in',
      signals.kind === 'either'
        ? PACK_PROBE_REASONS.noRedirectSettled
        : PACK_PROBE_REASONS.noRedirect,
    );
  }
  // The cookies were all there and the site neither redirected to a sign-in nor showed one: a
  // signed-in page that moved elsewhere (a new home path) reads signed in, at the lowest confidence.
  if (
    facts.cookiesPresent === true &&
    onProbePath &&
    (signals.kind !== 'either' || facts.settled) &&
    inPackDomains(pack, facts.finalUrl)
  ) {
    return verdict('signed_in', PACK_PROBE_REASONS.cookiesPresent);
  }
  return verdict('inconclusive', PACK_PROBE_REASONS.noSignal);
}

/** A selector read that throws (a refused selector, a closed page) is "absent". */
async function present(facts: PackProbeFacts, selector: string): Promise<boolean> {
  try {
    return await facts.hasSelector(selector);
  } catch {
    return false;
  }
}
