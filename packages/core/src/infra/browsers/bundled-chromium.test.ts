/** @module infra/browsers/bundled-chromium.test — driver package → pinned Chromium version. */

import { describe, expect, it } from 'bun:test';
import { bundledChromiumVersion } from './bundled-chromium.ts';

const manifest = JSON.stringify({
  browsers: [
    { name: 'chromium', revision: '1', browserVersion: '150.0.1.2' },
    { name: 'firefox', revision: '2', browserVersion: '140.0' },
  ],
});

describe('bundledChromiumVersion', () => {
  it('reads playwright-core for playwright and patchright-core through patchright', () => {
    const lookups: string[] = [];
    const locate = (specifier: string, from: string) => {
      lookups.push(`${specifier}<-${from}`);
      return `/nm/${specifier}/package.json`;
    };
    const read = (path: string) => (path.endsWith('/browsers.json') ? manifest : null);
    expect(bundledChromiumVersion('playwright', { locate, read, from: '/app' })).toBe('150.0.1.2');
    expect(bundledChromiumVersion('patchright', { locate, read, from: '/app' })).toBe('150.0.1.2');
    expect(lookups).toEqual([
      'playwright-core<-/app',
      'patchright<-/app',
      'patchright-core<-/nm/patchright/package.json',
    ]);
  });

  it('is null when the package, manifest or chromium entry is missing', () => {
    const found = () => '/nm/x/package.json';
    expect(bundledChromiumVersion('patchright', { locate: () => null, read: () => manifest })).toBe(
      null,
    );
    expect(bundledChromiumVersion('playwright', { locate: found, read: () => null })).toBeNull();
    expect(bundledChromiumVersion('playwright', { locate: found, read: () => '{' })).toBeNull();
    expect(
      bundledChromiumVersion('playwright', {
        locate: found,
        read: () => JSON.stringify({ browsers: [{ name: 'webkit', browserVersion: '1' }] }),
      }),
    ).toBeNull();
  });

  it('resolves the real installed driver packages', () => {
    expect(bundledChromiumVersion('playwright')).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
