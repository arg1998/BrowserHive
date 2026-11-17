/** @module domain/templates/probe — the generic sign-in probe and the health rules over probe results (spec 13 §8.1–§8.3): cookie names and expiry only, never a value (D-20). */

import type {
  TemplateProbeOutcome,
  TemplateSiteHealthRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import { cookieSite, type JarCookie } from './sign-ins.ts';

/** What one probe found. */
export interface ProbeVerdict {
  readonly outcome: TemplateProbeOutcome;
  /** Reason code of spec 13 §8.1. */
  readonly reason: string;
  /** Sanitized final URL of a navigation probe; `null` for the cookie pre-check. */
  readonly finalUrl: string | null;
}

/** Generic-probe reason codes (spec 13 §8.1 step 3). */
export const PROBE_REASONS = {
  learnedCookies: 'learned_cookies',
  cookiesAbsent: 'cookies_absent',
  partialCookies: 'partial_cookies',
  noPack: 'no_pack',
  /** The probe could not run: the template's browser is not running (a launch's unfinished budget). */
  notRunning: 'not_running',
  /** A pre-launch probe that did not finish within its budget counts inconclusive for that launch. */
  timeout: 'timeout',
} as const;

/** A cookie that is present: a session cookie, or a persistent one not yet expired. */
function isLive(cookie: Pick<JarCookie, 'expires'>, nowSeconds: number): boolean {
  return cookie.expires <= 0 || cookie.expires > nowSeconds;
}

/**
 * The generic probe (spec 13 §8.1 step 3), decided by the site's learned cookie names on its
 * registrable domain: every name present and unexpired → `signed_in`; none → `signed_out`; some →
 * `inconclusive` (`partial_cookies`); no learned names → `inconclusive` (`no_pack`).
 */
export function classifyGenericProbe(
  site: Pick<TemplateSiteRecord, 'siteId' | 'learnedCookieNames'>,
  jar: readonly Pick<JarCookie, 'name' | 'domain' | 'expires'>[],
  now: number,
): ProbeVerdict {
  const names = site.learnedCookieNames;
  if (names.length === 0)
    return { outcome: 'inconclusive', reason: PROBE_REASONS.noPack, finalUrl: null };
  const seconds = now / 1000;
  const present = new Set(
    jar.filter((c) => cookieSite(c) === site.siteId && isLive(c, seconds)).map((c) => c.name),
  );
  const found = names.filter((n) => present.has(n)).length;
  if (found === names.length) {
    return { outcome: 'signed_in', reason: PROBE_REASONS.learnedCookies, finalUrl: null };
  }
  if (found === 0) {
    return { outcome: 'signed_out', reason: PROBE_REASONS.cookiesAbsent, finalUrl: null };
  }
  return { outcome: 'inconclusive', reason: PROBE_REASONS.partialCookies, finalUrl: null };
}

/** Consecutive inconclusive probes after which the template page warns (spec 13 §8.3). */
export const INCONCLUSIVE_WARNING_AFTER = 3;

/** A site's health after one probe: `changedAt` moves only when the state changes. */
export function healthAfter(
  previous: TemplateSiteHealthRecord,
  verdict: Pick<ProbeVerdict, 'outcome' | 'reason'>,
  now: number,
): TemplateSiteHealthRecord {
  return {
    state: verdict.outcome,
    reason: verdict.reason,
    checkedAt: now,
    changedAt: previous.state === verdict.outcome ? previous.changedAt : now,
    consecutiveInconclusive:
      verdict.outcome === 'inconclusive' ? previous.consecutiveInconclusive + 1 : 0,
  };
}

/** A site is "out" when it is signed out or held by a challenge (spec 13 §8.2). */
export function isOut(state: TemplateSiteRecord['health']['state']): boolean {
  return state === 'signed_out' || state === 'challenged';
}

/**
 * The identity provider a site's sign-in belongs to (spec 13 §8.6): the pack's
 * `identity_provider` once packs exist (T3a), else the site itself.
 */
export function providerOf(site: Pick<TemplateSiteRecord, 'siteId'>): string {
  return site.siteId;
}

/** The enabled sites that share `provider`'s sign-in. */
export function sitesOfProvider(
  sites: readonly TemplateSiteRecord[],
  provider: string,
): readonly TemplateSiteRecord[] {
  return sites.filter((s) => s.enabled && providerOf(s) === provider);
}

/** Sites whose last probe is older than `maxAgeMs` (or never ran): what a pre-launch check probes. */
export function staleSites(
  sites: readonly TemplateSiteRecord[],
  now: number,
  maxAgeMs: number,
): readonly TemplateSiteRecord[] {
  return sites.filter(
    (s) => s.enabled && (s.health.checkedAt === null || now - s.health.checkedAt > maxAgeMs),
  );
}

/** The probe interval of a template with ±10 % jitter (spec 13 §8.3); `random` in `[0, 1)`. */
export function jitteredInterval(intervalMs: number, random: number): number {
  return Math.round(intervalMs * (0.9 + 0.2 * random));
}

/** The gap between two sites of one template: 5–20 s (spec 13 §8.3); `random` in `[0, 1)`. */
export function siteGapMs(random: number): number {
  return Math.round(5_000 + 15_000 * random);
}
