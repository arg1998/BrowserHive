/** @module domain/vault/origin — origin allow-list check for vault fills (registrable-domain wildcard + optional path glob). */

import { matchesGlob } from '../../kernel/glob.ts';
import { classifyUrl } from '../../kernel/url.ts';

/**
 * Two rules decide whether a credential may be typed into the page loaded in the target tab:
 *
 * 1. **Scheme gate.** Only `http:`/`https:` can satisfy an allow-list; `file:`, `data:`, `chrome:`,
 *    `about:` are always rejected (`bad_scheme`), unparseable input fails closed (`no_host`).
 * 2. **Pattern match.** Each `allowed_origins[]` entry is `host[/pathGlob]`, split at its first `/`.
 *    - exact host `linkedin.com` matches iff the page hostname equals it (no subdomains);
 *    - wildcard `*.linkedin.com` matches iff the page's **registrable domain** (eTLD+1) equals the
 *      base — admits the apex and any subdomain, never `evil-linkedin.com` nor
 *      `linkedin.com.attacker.com`; port-agnostic;
 *    - the optional path glob is matched **case-sensitively** against `pathname`; a host-only
 *      pattern admits any path; a path miss falls through to the next pattern.
 *
 * Deterministic and side-effect free (the property tests pin the exact match set).
 */

/** Pass/fail of one check (the audit column additionally knows `skipped`). */
export type OriginCheckOutcome = 'pass' | 'fail';

/** Why a check failed, for the audit trail. */
export type OriginFailReason = 'bad_scheme' | 'no_host' | 'not_allowed';

/** Result of {@link checkOrigin}. */
export interface OriginCheckResult {
  readonly outcome: OriginCheckOutcome;
  /** Lowercased hostname, or `null` when the URL had no host / bad scheme. */
  readonly hostname: string | null;
  /** Registrable domain (eTLD+1), or `null` (IPs, `localhost`, bad scheme). */
  readonly registrableDomain: string | null;
  /** The allow-list pattern that matched, or `null`. */
  readonly matchedPattern: string | null;
  /** The path glob of the matched pattern, `null` when host-only or nothing matched. */
  readonly matchedPath?: string | null;
  /** Absent on `pass`. */
  readonly reason?: OriginFailReason;
}

const HTTP_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

function fail(
  reason: OriginFailReason,
  hostname: string | null = null,
  registrableDomain: string | null = null,
): OriginCheckResult {
  return { outcome: 'fail', hostname, registrableDomain, matchedPattern: null, reason };
}

/** Decides whether `url` is permitted by `allowedOrigins`. Never throws. */
export function checkOrigin(url: string, allowedOrigins: readonly string[]): OriginCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail('no_host');
  }
  if (!HTTP_SCHEMES.has(parsed.protocol.toLowerCase())) return fail('bad_scheme');

  const classified = classifyUrl(url);
  const hostname = classified.domain.length > 0 ? classified.domain : null;
  const registrableDomain =
    classified.registrableDomain.length > 0 ? classified.registrableDomain : null;
  if (hostname === null) return fail('no_host', null, registrableDomain);

  const urlPathname = parsed.pathname || '/';

  for (const raw of allowedOrigins) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const slash = trimmed.indexOf('/');
    const host = (slash < 0 ? trimmed : trimmed.slice(0, slash)).toLowerCase();
    const pathPattern = slash < 0 ? null : trimmed.slice(slash);

    let hostMatched = false;
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      if (base.length > 0 && registrableDomain === base) hostMatched = true;
    } else if (hostname === host) {
      hostMatched = true;
    }
    if (!hostMatched) continue;

    if (pathPattern === null) {
      return {
        outcome: 'pass',
        hostname,
        registrableDomain,
        matchedPattern: raw,
        matchedPath: null,
      };
    }
    if (matchesGlob(urlPathname, pathPattern)) {
      return {
        outcome: 'pass',
        hostname,
        registrableDomain,
        matchedPattern: raw,
        matchedPath: pathPattern,
      };
    }
  }
  return fail('not_allowed', hostname, registrableDomain);
}

/**
 * True when `url` is still on `allowedOrigins`. Unparseable or non-http(s) input counts as *off*
 * the allow-list — the safe direction (the redaction window closes).
 */
export function isUrlAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  return checkOrigin(url, allowedOrigins).outcome === 'pass';
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The domain key of a URL or bare host for the honesty probe and page scoping: the registrable
 * domain when it has one, else the hostname (IPs, `localhost`). `null` when nothing host-like
 * parses. Both `https://sub.example.com/x` and a bare `example.com` are accepted.
 */
export function domainKey(urlOrHost: string): string | null {
  const s = urlOrHost.trim();
  if (s.length === 0) return null;
  const classified = classifyUrl(SCHEME_RE.test(s) ? s : `https://${s}`);
  if (classified.registrableDomain.length > 0) return classified.registrableDomain;
  return classified.domain.length > 0 ? classified.domain : null;
}

/** Scope of an http(s) page: lowercased host + domain key. `null` for non-http(s) / hostless URLs. */
export function pageScope(url: string): { readonly host: string; readonly key: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!HTTP_SCHEMES.has(parsed.protocol.toLowerCase())) return null;
  const host = classifyUrl(url).domain;
  if (host.length === 0) return null;
  return { host, key: domainKey(url) ?? host };
}

/** The lowercased http(s) hostname of `uri`, or `undefined`. A scheme-less uri is read as https. */
export function hostFromUri(uri: string): string | undefined {
  const trimmed = uri.trim();
  if (trimmed.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  return host.length > 0 ? host : undefined;
}

/**
 * Derives an EXACT-HOST allow-list from an item's saved login URIs (tight, non-wildcard patterns);
 * uris without an http(s) host are skipped; deduped.
 */
export function originsFromUris(uris: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const uri of uris) {
    const host = hostFromUri(uri);
    if (host !== undefined) out.add(host);
  }
  return [...out];
}
