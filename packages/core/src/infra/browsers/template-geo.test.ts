/** @module infra/browsers/template-geo.test — a new template's geo: explicit values win, the host seed fills the rest. */

import { describe, expect, it } from 'bun:test';
import type { GeoSeedResolver } from '../../ports/geo-seed-resolver.ts';
import { createTemplateGeoResolver } from './template-geo.ts';

const host: GeoSeedResolver = {
  resolve: () =>
    Promise.resolve({
      locale: 'en-CA',
      languages: ['en-CA', 'en'],
      countryCode: 'CA',
      timezoneId: 'America/Toronto',
      source: 'host',
    }),
};

describe('createTemplateGeoResolver', () => {
  it('takes the host seed when nothing is explicit', async () => {
    expect(await createTemplateGeoResolver(host).resolve({})).toEqual({
      locale: 'en-CA',
      languages: ['en-CA', 'en'],
      countryCode: 'CA',
      timezoneId: 'America/Toronto',
    });
  });

  it('derives languages and country from an explicit locale and keeps an explicit zone', async () => {
    expect(
      await createTemplateGeoResolver(host).resolve({
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
      }),
    ).toEqual({
      locale: 'de-DE',
      languages: ['de-DE', 'de'],
      countryCode: 'DE',
      timezoneId: 'Europe/Berlin',
    });
  });

  it('mixes an explicit zone with the host locale', async () => {
    const geo = await createTemplateGeoResolver(host).resolve({ timezoneId: 'UTC' });
    expect(geo.locale).toBe('en-CA');
    expect(geo.timezoneId).toBe('UTC');
  });
});
