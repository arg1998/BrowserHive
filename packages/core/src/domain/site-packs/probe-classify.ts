/** @module domain/site-packs/probe-classify — the pack probe's decision (spec 13 §8.1 steps 1–2): the cookie pre-check over the pack's `cookie_names` (names and expiry only), then the navigation's signals in their fixed order. Pure; the page is read through {@link PackProbeFacts}. */

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
  timeout: 'timeout',
  network: 'network',
  noSignal: 'no_signal',
} as const;

/** How long the probe's navigation may take (`domcontentloaded`, spec 13 §8.1). */
export const PROBE_NAVIGATION_MS = 20_000;

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

/** `https://<probe.host><probe.path>`. */
export function probeUrlOf(pack: SitePackV1): string {
  return `https://${pack.signed_in.probe.host}${pack.signed_in.probe.path}`;
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
  /** A selector is present (`locator('css=…').count() > 0`, queried, never evaluated). */
  hasSelector(selector: string): Promise<boolean>;
}

function samePlace(pack: SitePackV1, url: string): boolean {
  try {
    const parsed = new URL(url);
    const probe = pack.signed_in.probe;
    return (
      parsed.hostname.toLowerCase() === probe.host.toLowerCase() &&
      parsed.pathname.replace(/\/+$/, '') === probe.path.replace(/\/+$/, '')
    );
  } catch {
    return false;
  }
}

/**
 * Step 2, in order (spec 13 §8.1): a challenge → `challenged`; the final URL (inside the pack's
 * domains) matches a `signed_out_redirects` glob → `signed_out` `redirect`; the signed-out marker →
 * `signed_out` `marker`; the landmark → `signed_in` `landmark`; a `redirect` (or `either`) pack
 * still on the probe host and path (and not a 4xx/5xx) → `signed_in` `no_redirect`; otherwise
 * `inconclusive` (`timeout`, `network`, `http_<status>` ≥ 400, `no_signal`). A challenge is never
 * `signed_out`.
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
  if (
    inPackDomains(pack, facts.finalUrl) &&
    matchesAnyPackGlob(signals.signed_out_redirects, facts.finalUrl)
  ) {
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
  if (signals.kind !== 'landmark' && samePlace(pack, facts.finalUrl)) {
    return verdict('signed_in', PACK_PROBE_REASONS.noRedirect);
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
