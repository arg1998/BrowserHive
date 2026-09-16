/** @module infra/browsers/stealth-identity.test — coherent identity derivation and the platformVersion table. */

import { describe, expect, it } from 'bun:test';
import {
  deriveCoherentIdentity,
  deviceMemoryPayload,
  PRESENTED_DEVICE_MEMORY,
  platformVersionFor,
} from './stealth-identity.ts';

/**
 * The derivation must produce an identity coherent with the REAL browser + host: the same Chrome
 * version everywhere, the host's OS/arch, and a Google-Chrome brand added on top of Chromium — never
 * a foreign OS or invented version.
 */
describe('deriveCoherentIdentity', () => {
  const macArm = {
    product: 'HeadlessChrome/131.0.6778.86',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.6778.86 Safari/537.36',
    hostPlatform: 'darwin',
    hostArch: 'arm64',
  };

  it('normalises HeadlessChrome out of the UA string', () => {
    const { applied } = deriveCoherentIdentity(macArm);
    expect(applied.userAgent).not.toContain('HeadlessChrome');
    expect(applied.userAgent).toContain('Chrome/131.0.6778.86');
  });

  it('adds a Google Chrome brand alongside Chromium + a GREASE entry, all at the same major', () => {
    const { applied, override } = deriveCoherentIdentity(macArm);
    const brandNames = applied.brands.map((b) => b.brand);
    expect(brandNames).toEqual(['Not_A Brand', 'Chromium', 'Google Chrome']);
    for (const b of applied.brands) {
      if (b.brand === 'Google Chrome' || b.brand === 'Chromium') expect(b.version).toBe('131');
    }
    expect(override.userAgentMetadata.brands[0]).toEqual({ brand: 'Not_A Brand', version: '24' });
    const gc = override.userAgentMetadata.fullVersionList.find((b) => b.brand === 'Google Chrome');
    expect(gc?.version).toBe('131.0.6778.86');
  });

  it('mirrors the host OS + arch into UA-CH metadata (macOS / arm here)', () => {
    const { override } = deriveCoherentIdentity(macArm);
    const m = override.userAgentMetadata;
    expect(m.platform).toBe('macOS');
    expect(override.platform).toBe('macOS');
    expect(m.architecture).toBe('arm');
    expect(m.bitness).toBe('64');
    expect(m.mobile).toBe(false);
    expect(m.wow64).toBe(false);
    expect(m.model).toBe('');
    expect(m.fullVersion).toBe('131.0.6778.86');
    // No release supplied ⇒ the fallback constant.
    expect(m.platformVersion).toBe('15.0.0');
  });

  it('maps Windows x64 correctly', () => {
    const { override } = deriveCoherentIdentity({
      product: 'Chrome/130.0.6723.0',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.0 Safari/537.36',
      hostPlatform: 'win32',
      hostArch: 'x64',
    });
    expect(override.userAgentMetadata.platform).toBe('Windows');
    expect(override.userAgentMetadata.architecture).toBe('x86');
    expect(
      override.userAgentMetadata.brands.find((b) => b.brand === 'Google Chrome')?.version,
    ).toBe('130');
  });

  it('maps Linux and defaults deviceMemory to a realistic value', () => {
    const { override, deviceMemory, applied } = deriveCoherentIdentity({
      product: 'HeadlessChrome/131.0.0.0',
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
      hostPlatform: 'linux',
      hostArch: 'x64',
    });
    expect(override.userAgentMetadata.platform).toBe('Linux');
    expect(deviceMemory).toBe(PRESENTED_DEVICE_MEMORY);
    expect(applied.deviceMemory).toBe(PRESENTED_DEVICE_MEMORY);
    expect(PRESENTED_DEVICE_MEMORY).toBe(8);
    expect(deviceMemoryPayload()).toEqual({ deviceMemoryFallback: 8 });
  });

  it('falls back to a sane version when the product string is unparseable', () => {
    const { applied } = deriveCoherentIdentity({
      product: 'garbage',
      userAgent: 'Mozilla/5.0 something',
      hostPlatform: 'darwin',
      hostArch: 'arm64',
    });
    expect(applied.chromeMajor).toMatch(/^\d+$/);
  });

  it('emits an UNWEIGHTED Accept-Language from the seed, and none without a seed', () => {
    // Chrome appends the q-values itself; a pre-weighted list produced `en-CA,en;q=0.9;q=0.9`.
    const withGeo = deriveCoherentIdentity({
      ...macArm,
      geo: {
        locale: 'en-CA',
        languages: ['en-CA', 'en'],
        countryCode: 'CA',
        timezoneId: 'America/Toronto',
        source: 'host',
      },
    });
    expect(withGeo.override.acceptLanguage).toBe('en-CA,en');
    expect(withGeo.override.acceptLanguage).not.toContain('q=');
    expect(withGeo.applied.geo?.source).toBe('host');
    const withoutGeo = deriveCoherentIdentity({ ...macArm, geo: null });
    expect(withoutGeo.override).not.toHaveProperty('acceptLanguage');
    expect(withoutGeo.applied.geo).toBeNull();
  });

  it('records the display only when supplied', () => {
    const display = {
      screen: { width: 1440, height: 900 },
      viewport: { width: 1440, height: 788 },
      deviceScaleFactor: 2,
    };
    expect(deriveCoherentIdentity({ ...macArm, display }).applied.display).toEqual(display);
    expect(deriveCoherentIdentity(macArm).applied.display).toBeNull();
  });
});

describe('platformVersionFor (derived from os.release() with fallback constants)', () => {
  const table: [string, string | undefined, string][] = [
    ['darwin', '24.1.0', '15.0.0'],
    ['darwin', '23.6.0', '14.0.0'],
    ['darwin', '22.0.0', '13.0.0'],
    ['darwin', '25.0.0', '26.0.0'],
    ['darwin', '99.0.0', '15.0.0'],
    ['darwin', 'junk', '15.0.0'],
    ['darwin', undefined, '15.0.0'],
    ['win32', '10.0.22631', '15.0.0'],
    ['win32', '10.0.19045', '10.0.0'],
    ['win32', '10.0', '15.0.0'],
    ['win32', undefined, '15.0.0'],
    ['linux', '6.8.0-45-generic', '6.8.0'],
    ['linux', '5.15.0', '5.15.0'],
    ['linux', '', '6.5.0'],
    ['linux', undefined, '6.5.0'],
    ['android', '5.10.0', '14.0.0'],
    ['freebsd', '14.1-RELEASE', '14.1.0'],
  ];
  it.each(table)('%s / %s → %s', (platform, release, expected) => {
    expect(platformVersionFor(platform, release)).toBe(expected);
  });
});
