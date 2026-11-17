/** @module domain/site-packs/site-of-url — the template site a URL belongs to (spec 13 §9.3, §9.5): the site whose registrable domain it is, else the site whose pack owns the URL's domain (a pack's other domains: `licdn.com` for LinkedIn). */

import { registrableDomain } from '../../kernel/url.ts';

/** The fields the lookup reads. */
export interface SiteKey {
  readonly siteId: string;
  readonly packId: string | null;
}

/** The URL's host, lowercased, or `null` for a URL without one (`about:blank`, unparseable). */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The template site of `url`, or `null`. `packIdOf` answers the id of the effective pack owning a
 * host (`SitePackLookup.effectiveFor`), `null` when none.
 */
export function templateSiteOf<S extends SiteKey>(
  sites: readonly S[],
  url: string,
  packIdOf: (host: string) => string | null,
): S | null {
  const host = hostOf(url);
  if (host === null) return null;
  const domain = registrableDomain(host);
  if (domain !== '') {
    const direct = sites.find((s) => s.siteId === domain);
    if (direct !== undefined) return direct;
  }
  const packId = packIdOf(host);
  if (packId === null) return null;
  return sites.find((s) => s.packId === packId) ?? null;
}
