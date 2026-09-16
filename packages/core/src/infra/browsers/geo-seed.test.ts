/** @module infra/browsers/geo-seed.test — locale precedence, fallbacks and the caller-truth seed. */

import { describe, expect, it } from 'bun:test';
import {
  callerGeoSeed,
  countryCodeForLocale,
  HostGeoSeedResolver,
  isValidTimezone,
  languagesForLocale,
  localeFromPosixEnv,
  resolveHostGeoSeed,
} from './geo-seed.ts';

/**
 * The geo seed is the single source of truth for a session's locale/timezone story, so the tests that
 * matter are the ones that pin *coherence* rules rather than string formatting: where the locale is
 * read from (and in what order), and when the seed must stand down entirely.
 */

describe('languagesForLocale', () => {
  it('appends the bare language subtag, the way Chrome does', () => {
    expect(languagesForLocale('en-US')).toEqual(['en-US', 'en']);
    expect(languagesForLocale('de-DE')).toEqual(['de-DE', 'de']);
    expect(languagesForLocale('zh-Hant-TW')).toEqual(['zh-Hant-TW', 'zh']);
  });

  it('leaves an already-bare locale as a single entry', () => {
    expect(languagesForLocale('en')).toEqual(['en']);
  });
});

describe('countryCodeForLocale', () => {
  it('extracts and uppercases the region subtag, skipping a script subtag', () => {
    expect(countryCodeForLocale('en-us')).toBe('US');
    expect(countryCodeForLocale('zh-Hant-TW')).toBe('TW');
  });

  it('returns null when the locale carries no region', () => {
    expect(countryCodeForLocale('en')).toBeNull();
  });
});

describe('localeFromPosixEnv', () => {
  it('strips the codeset and modifier suffixes and converts to BCP-47', () => {
    expect(localeFromPosixEnv('en_CA.UTF-8')).toBe('en-CA');
    expect(localeFromPosixEnv('de_DE@euro')).toBe('de-DE');
    expect(localeFromPosixEnv('fr_FR')).toBe('fr-FR');
  });

  it('rejects the POSIX non-locales and junk', () => {
    for (const value of ['C', 'POSIX', '', undefined, '!!!', '.UTF-8']) {
      expect(localeFromPosixEnv(value)).toBeUndefined();
    }
  });
});

describe('isValidTimezone', () => {
  it('accepts a real IANA zone and rejects junk', () => {
    expect(isValidTimezone('America/Toronto')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});

describe('resolveHostGeoSeed', () => {
  it('reads the locale from the environment BEFORE ICU', () => {
    // This ordering is load-bearing, not stylistic. BrowserHive runs under both Node and Bun, and on
    // a host with LANG=en_CA.UTF-8 they disagree: Node's ICU reports en-CA, Bun's reports en-US.
    // Seeding from ICU first would hand a Bun-launched session an en-US identity on a Toronto clock —
    // a self-inflicted incoherence on the host IP, with no proxy involved.
    const seed = resolveHostGeoSeed({
      icuLocale: 'en-US',
      icuTimeZone: 'America/Toronto',
      env: { LANG: 'en_CA.UTF-8' },
    });
    expect(seed.locale).toBe('en-CA');
    expect(seed.languages).toEqual(['en-CA', 'en']);
    expect(seed.countryCode).toBe('CA');
    expect(seed.timezoneId).toBe('America/Toronto');
  });

  it('prefers LC_ALL over LANG', () => {
    const seed = resolveHostGeoSeed({ env: { LC_ALL: 'de_DE.UTF-8', LANG: 'en_CA.UTF-8' } });
    expect(seed.locale).toBe('de-DE');
  });

  it('falls back to ICU when the environment carries no usable locale', () => {
    const seed = resolveHostGeoSeed({ icuLocale: 'fr-FR', env: { LANG: 'C' } });
    expect(seed.locale).toBe('fr-FR');
  });

  it('rejects the ICU placeholders c / posix / und', () => {
    for (const icuLocale of ['c', 'posix', 'und', 'POSIX']) {
      expect(resolveHostGeoSeed({ icuLocale, icuTimeZone: 'UTC', env: {} }).locale).toBe('en-US');
    }
  });

  it('falls back to en-US and UTC when nothing is resolvable', () => {
    const seed = resolveHostGeoSeed({ icuLocale: 'und', icuTimeZone: 'Not/AZone', env: {} });
    expect(seed.locale).toBe('en-US');
    expect(seed.timezoneId).toBe('UTC');
  });

  it('never invents coordinates', () => {
    // A machine's locale says nothing trustworthy about where it is. Guessing would manufacture the
    // exact incoherence this module exists to prevent; a proxy exit-geo lookup is what fills this in.
    expect(resolveHostGeoSeed({ env: {} }).geolocation).toBeUndefined();
  });

  it('reports its provenance as host', () => {
    expect(resolveHostGeoSeed({ env: {} }).source).toBe('host');
  });
});

describe('HostGeoSeedResolver', () => {
  it('reads the injected env, never process.env, and resolves per call', async () => {
    const resolver = new HostGeoSeedResolver(
      { platform: 'linux', arch: 'x64', release: '6.0.0', env: { LANG: 'ja_JP.UTF-8' } },
      { icuTimeZone: 'Asia/Tokyo' },
    );
    const seed = await resolver.resolve();
    expect(seed).toEqual({
      locale: 'ja-JP',
      languages: ['ja-JP', 'ja'],
      countryCode: 'JP',
      timezoneId: 'Asia/Tokyo',
      source: 'host',
    });
  });
});

describe('callerGeoSeed', () => {
  const host = resolveHostGeoSeed({ icuLocale: 'en-US', icuTimeZone: 'UTC', env: {} });

  it('returns null when the caller stated neither half', () => {
    expect(callerGeoSeed(undefined, host)).toBeNull();
    expect(callerGeoSeed({ viewport: { width: 1, height: 1 } }, host)).toBeNull();
  });

  it('fills the missing half from the host seed', () => {
    expect(callerGeoSeed({ timezoneId: 'Europe/Berlin' }, host)).toEqual({
      locale: 'en-US',
      languages: ['en-US', 'en'],
      countryCode: 'US',
      timezoneId: 'Europe/Berlin',
      source: 'host',
    });
    expect(callerGeoSeed({ locale: 'de-DE' }, host)?.languages).toEqual(['de-DE', 'de']);
    expect(callerGeoSeed({ locale: 'de-DE' }, host)?.timezoneId).toBe('UTC');
  });
});
