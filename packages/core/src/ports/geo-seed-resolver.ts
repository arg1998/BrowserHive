/** @module ports/geo-seed-resolver — per-session geo seed resolution (spec 11 §2.5); async so a proxy-exit resolver is a one-line swap. */

import type { GeoSeed } from './browser-driver.ts';

/** Resolves the locale/timezone story for a session. Never process-memoised. */
export interface GeoSeedResolver {
  resolve(input: { readonly sessionId: string; readonly proxyServer?: string }): Promise<GeoSeed>;
}

/** The geo half of a template's pinned identity (spec 13 §2.2). */
export interface TemplateGeo {
  readonly locale: string;
  readonly languages: readonly string[];
  readonly countryCode: string | null;
  readonly timezoneId: string;
}

/**
 * Resolves the geo of a new template once, at creation: the operator's explicit `locale` and
 * `timezoneId` where given, the host geo seed (spec 11 §2.5) for the rest.
 */
export interface TemplateGeoResolver {
  resolve(explicit: {
    readonly locale?: string;
    readonly timezoneId?: string;
  }): Promise<TemplateGeo>;
}
