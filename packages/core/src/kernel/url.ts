/** @module kernel/url — URL classification, sanitization and host predicates (D-20). */

import { getDomain } from 'tldts';

/**
 * Coarse, security-oriented bucket for a visited URL. Mirrors the contracts `UrlCategory` enum.
 *
 * - `public` — http(s)/ws(s) to a DNS host name (the normal case).
 * - `ip`     — http(s)/ws(s) to a **non-loopback IP literal**: an agent addressing a host by
 *              number instead of name, bypassing DNS/domain allow-lists.
 * - `local`  — `file:` URLs, or http(s)/ws(s) to a loopback host. A loopback IP is `local`, not `ip`.
 * - `ftp`    — `ftp:`/`ftps:`.
 * - `other`  — anything else (`data:`, `blob:`, `chrome:`, `about:`, `javascript:`, `mailto:`, …).
 */
export type UrlCategory = 'public' | 'ip' | 'local' | 'ftp' | 'other';

/** The fixed set of categories, in display order — mirrored by the dashboard filter chips. */
export const URL_CATEGORIES: readonly UrlCategory[] = ['public', 'ip', 'local', 'ftp', 'other'];

/** Result of {@link classifyUrl}. */
export interface UrlClassification {
  /** Host name (lowercased, IPv6 brackets stripped), or `''` for hostless URLs. */
  readonly domain: string;
  /** Registrable domain (eTLD+1 via the public suffix list), or `''` when none applies. */
  readonly registrableDomain: string;
  readonly category: UrlCategory;
}

/** Classifies a URL into a {@link UrlCategory} plus its host domain. Never throws. */
export function classifyUrl(rawUrl: string): UrlClassification {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return { domain: '', registrableDomain: '', category: 'other' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { domain: '', registrableDomain: '', category: 'other' };
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme === 'file:') return { domain: '', registrableDomain: '', category: 'local' };
  if (scheme === 'ftp:' || scheme === 'ftps:') {
    const host = normalizeHost(url.hostname);
    return { domain: host, registrableDomain: registrable(host), category: 'ftp' };
  }
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'ws:' || scheme === 'wss:') {
    const host = normalizeHost(url.hostname);
    if (host.length === 0) return { domain: '', registrableDomain: '', category: 'other' };
    if (isLoopbackHost(host)) return { domain: host, registrableDomain: '', category: 'local' };
    if (isIpLiteral(host)) return { domain: host, registrableDomain: '', category: 'ip' };
    return { domain: host, registrableDomain: registrable(host), category: 'public' };
  }
  return { domain: '', registrableDomain: '', category: 'other' };
}

function registrable(host: string): string {
  if (host.length === 0 || isIpLiteral(host)) return '';
  return getDomain(host, { allowPrivateDomains: false }) ?? '';
}

/** Lowercases the host and strips IPv6 brackets so `[::1]` and `::1` compare equal. */
export function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/** Loopback / localhost: `localhost` (and `*.localhost`), `127.0.0.0/8`, and `::1`. */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Whether `host` is a bare IP literal (IPv4 dotted-quad or IPv6 hex-colon), not a DNS name. */
export function isIpLiteral(host: string): boolean {
  const h = normalizeHost(host);
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return h.split('.').every((o) => Number(o) <= 255);
  }
  // IPv6: at least two colons and only hex digits / colons.
  return h.includes(':') && /^[0-9a-f:]+$/.test(h);
}

/**
 * Private / link-local address space: RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), link-local
 * `169.254/16`, IPv6 ULA `fc00::/7` and link-local `fe80::/10`. Loopback is *not* included; use
 * {@link isLoopbackHost} for that.
 */
export function isPrivateNetworkHost(host: string): boolean {
  const h = normalizeHost(host);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (h.includes(':') && /^[0-9a-f:]+$/.test(h)) {
    return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  }
  return false;
}

/**
 * True when binding `host` would expose the listener beyond the machine: anything that is not
 * loopback, including `0.0.0.0` and `::`.
 */
export function isInsecureBind(host: string): boolean {
  return !isLoopbackHost(host);
}

/** Options for {@link sanitizeUrl}. */
export interface SanitizeUrlOptions {
  /** Query keys kept verbatim (`--urlQueryAllowlist`). Everything else is stripped. */
  readonly allowQueryKeys?: readonly string[];
}

/** Placeholder returned for values that do not parse as a URL at all. */
export const INVALID_URL = '[invalid-url]';

/**
 * Reduces a URL to what may be persisted or exported (D-20): scheme, host, port and path. The
 * fragment and userinfo are always dropped; query pairs survive only when their key is on the
 * allow-list. Non-network schemes (`about:`, `data:`, `blob:`, `chrome:`) keep only the scheme
 * plus a bounded prefix so a `data:` payload never lands in a sink.
 */
export function sanitizeUrl(rawUrl: string, options: SanitizeUrlOptions = {}): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return INVALID_URL;
  }
  const scheme = url.protocol.toLowerCase();
  if (!NETWORK_SCHEMES.has(scheme)) {
    if (scheme === 'about:' || scheme === 'chrome:' || scheme === 'chrome-extension:') {
      const authority = url.host.length > 0 ? `//${url.host}` : '';
      return `${scheme}${authority}${url.pathname}`.slice(0, MAX_OPAQUE_URL_LENGTH);
    }
    return scheme;
  }
  const allow = options.allowQueryKeys ?? [];
  const kept = new URLSearchParams();
  if (allow.length > 0) {
    for (const [key, value] of url.searchParams) {
      if (allow.includes(key)) kept.append(key, value);
    }
  }
  const query = kept.size > 0 ? `?${kept.toString()}` : '';
  return `${scheme}//${url.host}${url.pathname}${query}`;
}

/** Bound on opaque-scheme output so `about:` / `chrome:` paths stay short. */
const MAX_OPAQUE_URL_LENGTH = 128;

/** Schemes with a host, i.e. the ones a URL policy can address. */
export const NETWORK_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'ws:',
  'wss:',
  'ftp:',
  'ftps:',
]);
