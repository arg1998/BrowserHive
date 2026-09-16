/** @module infra/browsers/fingerprint.test — display catalogue, inequality chain over many seeds, determinism, context options. */

import { describe, expect, it } from 'bun:test';
import type { GeoSeed } from '../../ports/browser-driver.ts';
import {
  contextOptionsFor,
  DISPLAYS,
  deriveFingerprint,
  displayFamilyFor,
  FURNITURE,
  scriptPayloadFor,
} from './fingerprint.ts';

const HOSTS: string[] = ['darwin', 'win32', 'linux'];

const GEO: GeoSeed = {
  locale: 'en-CA',
  languages: ['en-CA', 'en'],
  countryCode: 'CA',
  timezoneId: 'America/Toronto',
  source: 'host',
};

describe('display catalogue (spec 11 §2.4, must not change)', () => {
  it('carries exactly the catalogued displays and furniture', () => {
    const shape = (family: 'macos' | 'windows' | 'linux') =>
      DISPLAYS[family].map((d) => `${d.width}x${d.height}@${d.scale}`);
    expect(shape('macos')).toEqual([
      '1440x900@2',
      '1470x956@2',
      '1512x982@2',
      '1728x1117@2',
      '1920x1080@2',
      '2560x1440@2',
    ]);
    expect(shape('windows')).toEqual([
      '1920x1080@1',
      '1536x864@1.25',
      '1366x768@1',
      '1707x960@1.5',
      '2560x1440@1',
    ]);
    expect(shape('linux')).toEqual(['1920x1080@1', '1366x768@1', '2560x1440@1']);
    expect(FURNITURE.macos).toEqual({
      systemBarHeight: 25,
      systemBarAtTop: true,
      browserChromeHeight: 87,
    });
    expect(FURNITURE.windows).toEqual({
      systemBarHeight: 48,
      systemBarAtTop: false,
      browserChromeHeight: 96,
    });
    expect(FURNITURE.linux).toEqual({
      systemBarHeight: 27,
      systemBarAtTop: true,
      browserChromeHeight: 96,
    });
  });
});

describe('displayFamilyFor', () => {
  it('maps host platforms onto the three modelled families, defaulting to linux', () => {
    expect(displayFamilyFor('darwin')).toBe('macos');
    expect(displayFamilyFor('win32')).toBe('windows');
    expect(displayFamilyFor('linux')).toBe('linux');
    expect(displayFamilyFor('freebsd')).toBe('linux');
  });
});

describe('deriveFingerprint', () => {
  it('is a pure function of the seed, so a restored profile resurrects the same machine', () => {
    const a = deriveFingerprint({ seed: 'session-abcd1234', hostPlatform: 'darwin' });
    const b = deriveFingerprint({ seed: 'session-abcd1234', hostPlatform: 'darwin' });
    expect(a).toEqual(b);
    expect(a.family).toBe('macos');
    expect(a.hardwareConcurrency).toBeNull();
  });

  it('gives different sessions different machines', () => {
    // A fleet that shares one screen size is correlatable regardless of how real that size looks.
    const seeds = Array.from({ length: 40 }, (_, i) => `session-${i}`);
    const shapes = new Set(
      seeds.map((seed) => {
        const fp = deriveFingerprint({ seed, hostPlatform: 'darwin' });
        return `${fp.screen.width}x${fp.screen.height}/${fp.viewport.width}x${fp.viewport.height}`;
      }),
    );
    expect(shapes.size).toBeGreaterThan(3);
  });

  it.each(HOSTS)('holds the coherence chain on %s over many seeds', (hostPlatform) => {
    // innerHeight < outerHeight <= availHeight <= height is what a real desktop browser reports.
    // Playwright's default gives screen === viewport === outer, which is three tells in one line.
    for (let i = 0; i < 200; i++) {
      const fp = deriveFingerprint({ seed: `seed-${i}`, hostPlatform });
      expect(fp.viewport.height).toBeLessThan(fp.window.outerHeight);
      expect(fp.window.outerHeight).toBeLessThanOrEqual(fp.screen.availHeight);
      expect(fp.screen.availHeight).toBeLessThanOrEqual(fp.screen.height);
      expect(fp.window.outerWidth).toBeLessThanOrEqual(fp.screen.availWidth);
      expect(fp.screen.availWidth).toBeLessThanOrEqual(fp.screen.width);
      expect(fp.viewport.height).toBeGreaterThanOrEqual(400);
      // The window must sit inside the screen, below any top system bar.
      expect(fp.window.screenY).toBeGreaterThanOrEqual(fp.screen.availTop);
      expect(fp.window.screenX + fp.window.outerWidth).toBeLessThanOrEqual(fp.screen.width);
    }
  });

  it('never emits the Playwright default viewport', () => {
    // 1280x720 is the single most recognisable automation viewport there is.
    for (let i = 0; i < 60; i++) {
      const fp = deriveFingerprint({ seed: `seed-${i}`, hostPlatform: 'win32' });
      expect(`${fp.viewport.width}x${fp.viewport.height}`).not.toBe('1280x720');
      expect(`${fp.screen.width}x${fp.screen.height}`).not.toBe('1280x720');
    }
  });

  it('uses Retina scale factors on macOS and non-Retina tiers elsewhere', () => {
    // A dpr-1 Mac would be the anomaly, and a dpr-2 Windows desktop is rare enough to be a signal.
    for (let i = 0; i < 30; i++) {
      expect(deriveFingerprint({ seed: `m${i}`, hostPlatform: 'darwin' }).deviceScaleFactor).toBe(
        2,
      );
      const windows = deriveFingerprint({ seed: `w${i}`, hostPlatform: 'win32' });
      expect(windows.deviceScaleFactor).toBeLessThanOrEqual(1.5);
      expect(windows.deviceScaleFactor).toBeGreaterThanOrEqual(1);
    }
  });

  it('puts the system bar at the top only on macOS/linux', () => {
    expect(
      deriveFingerprint({ seed: 's', hostPlatform: 'darwin' }).screen.availTop,
    ).toBeGreaterThan(0);
    expect(deriveFingerprint({ seed: 's', hostPlatform: 'win32' }).screen.availTop).toBe(0);
  });
});

describe('contextOptionsFor', () => {
  it('contributes display + geo, and never the User-Agent', () => {
    // The UA and its UA-CH metadata must be written together, which only CDP can do. A second writer
    // here is exactly how a "Chrome" UA string with "Chromium" client hints happens.
    const fp = deriveFingerprint({ seed: 's', hostPlatform: 'darwin' });
    const options = contextOptionsFor(fp, GEO);
    expect(options).toMatchObject({
      viewport: fp.viewport,
      deviceScaleFactor: fp.deviceScaleFactor,
      locale: 'en-CA',
      timezoneId: 'America/Toronto',
    });
    expect(options).not.toHaveProperty('userAgent');
    expect(options).not.toHaveProperty('extraHTTPHeaders');
    // Pinning a minority colour scheme is a signal of its own; leave it at the browser default.
    expect(options).not.toHaveProperty('colorScheme');
  });

  it('omits every geo field when no geo is asserted', () => {
    const options = contextOptionsFor(
      deriveFingerprint({ seed: 's', hostPlatform: 'linux' }),
      null,
    );
    expect(options).not.toHaveProperty('locale');
    expect(options).not.toHaveProperty('timezoneId');
    expect(options).not.toHaveProperty('geolocation');
    expect(options).toHaveProperty('viewport');
  });

  it('omits geolocation unless the seed genuinely knows coordinates', () => {
    const fp = deriveFingerprint({ seed: 's', hostPlatform: 'linux' });
    expect(contextOptionsFor(fp, GEO)).not.toHaveProperty('geolocation');
    const located: GeoSeed = {
      ...GEO,
      geolocation: { latitude: 43.65, longitude: -79.38, accuracy: 5000 },
    };
    expect(contextOptionsFor(fp, located).geolocation).toEqual(located.geolocation);
  });

  it('asks for the real window — not an omitted viewport — when display is not asserted', () => {
    // Omitting `viewport` does NOT mean "use the real window": Playwright substitutes its 1280x720
    // default and resizes the window to match, handing every such session the single most
    // recognisable automation viewport there is. `viewport: null` is what actually opts out, and
    // `deviceScaleFactor` must be absent alongside it (Playwright rejects the pair).
    const fp = deriveFingerprint({ seed: 's', hostPlatform: 'darwin' });
    const options = contextOptionsFor(fp, GEO, false);
    expect(options.viewport).toBeNull();
    expect(options).not.toHaveProperty('deviceScaleFactor');
    expect(options.locale).toBe('en-CA');
  });
});

describe('scriptPayloadFor', () => {
  it('carries only the display half, and is JSON-serialisable', () => {
    const fp = deriveFingerprint({ seed: 's', hostPlatform: 'darwin' });
    const payload = scriptPayloadFor(fp);
    expect(Object.keys(payload).sort()).toEqual(['screen', 'window']);
    // The init script is serialised across the process boundary; a non-plain value would not survive.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});
