/** @module infra/browsers/template-geo — the geo of a new template's pinned identity (spec 13 §2.2): the operator's explicit locale and time zone where given, the host geo seed (spec 11 §2.5) for the rest. Never re-resolved afterwards. */

import type {
  GeoSeedResolver,
  TemplateGeo,
  TemplateGeoResolver,
} from '../../ports/geo-seed-resolver.ts';
import { countryCodeForLocale, languagesForLocale } from './geo-seed.ts';

/**
 * Builds the {@link TemplateGeoResolver} over the host's `GeoSeedResolver`.
 *
 * @returns The resolver.
 */
export function createTemplateGeoResolver(host: GeoSeedResolver): TemplateGeoResolver {
  return {
    async resolve(explicit): Promise<TemplateGeo> {
      const seed = await host.resolve({ sessionId: 'template' });
      const locale = explicit.locale ?? seed.locale;
      return {
        locale,
        languages: explicit.locale === undefined ? [...seed.languages] : languagesForLocale(locale),
        countryCode:
          explicit.locale === undefined ? seed.countryCode : countryCodeForLocale(locale),
        timezoneId: explicit.timezoneId ?? seed.timezoneId,
      };
    },
  };
}
