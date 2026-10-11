/** @module test/stealth/probe.test — the client-hint coherence checks of the stealth probe (issue #18): vendor per channel, UA agreement, majors, engine versions. */
import { describe, expect, it } from 'bun:test';
import { brandProblems } from './probe.ts';

const chromeUa =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const edgeUa = `${chromeUa.replace('154', '155')} Edg/155.0.0.0`;

/** Real Google Chrome 154 (and the bundled Chromium relabelled the same way). */
const chrome = {
  ua: chromeUa,
  brands: ['Not_A Brand/24', 'Chromium/154', 'Google Chrome/154'],
  fullVersionList: [
    'Not_A Brand/24.0.0.0',
    'Chromium/154.0.8037.57',
    'Google Chrome/154.0.8037.57',
  ],
  uaFullVersion: '154.0.8037.57',
};

/** Real Microsoft Edge 155, as measured on Windows. */
const edge = {
  ua: edgeUa,
  brands: ['Microsoft Edge/155', 'Chromium/155', 'Not(A:Brand/24'],
  fullVersionList: [
    'Microsoft Edge/155.0.4283.45',
    'Chromium/155.0.8059.40',
    'Not(A:Brand/24.0.0.0',
  ],
  uaFullVersion: '155.0.4283.45',
};

describe('brandProblems', () => {
  it('passes real Chrome, the relabelled Chromium, and real Edge', () => {
    expect(brandProblems('chrome', chrome, '154.0.8037.57')).toEqual([]);
    expect(brandProblems('chromium', chrome, '154.0.8037.57')).toEqual([]);
    expect(brandProblems('edge', edge, '155.0.4283.45')).toEqual([]);
    expect(brandProblems('edge', edge, null)).toEqual([]);
  });

  it('flags Edge presented as Google Chrome (the issue #18 regression)', () => {
    const relabelled = {
      ua: edgeUa,
      brands: ['Not_A Brand/24', 'Chromium/155', 'Google Chrome/155'],
      fullVersionList: [
        'Not_A Brand/24.0.0.0',
        'Chromium/155.0.4283.45',
        'Google Chrome/155.0.4283.45',
      ],
      uaFullVersion: '155.0.4283.45',
    };
    const problems = brandProblems('edge', relabelled, '155.0.4283.45');
    expect(problems).toContain('brands list Microsoft Edge 0 times');
    expect(problems).toContain('client hints claim Google Chrome');
    // The old relabel also gave Chromium Edge's own version; its build numbers are not checked for
    // Edge, but the vendor's full version is, and it is missing here.
    expect(problems).toContain(
      `fullVersionList ${JSON.stringify(relabelled.fullVersionList)} != 155.0.4283.45`,
    );
  });

  it('flags a UA and brand that disagree about Edge, either way round', () => {
    expect(brandProblems('chrome', { ...chrome, ua: `${chromeUa} Edg/154.0.0.0` }, null)).toContain(
      'UA says Edg/ while the brand is Google Chrome',
    );
    expect(brandProblems('edge', { ...edge, ua: chromeUa.replace('154', '155') }, null)).toContain(
      'UA does not say Edg/ while the brand is Microsoft Edge',
    );
  });

  it('flags a duplicated vendor, a missing Chromium, and a foreign major', () => {
    expect(
      brandProblems('chrome', { ...chrome, brands: [...chrome.brands, 'Google Chrome/154'] }, null),
    ).toContain('brands list Google Chrome 2 times');
    expect(
      brandProblems('chrome', { ...chrome, brands: ['Not_A Brand/24', 'Google Chrome/154'] }, null),
    ).toContain('brands do not list Chromium exactly once');
    expect(
      brandProblems(
        'chrome',
        { ...chrome, brands: ['Not_A Brand/24', 'Chromium/153', 'Google Chrome/154'] },
        null,
      ),
    ).toContain("Chromium/153 has not the UA's major 154");
  });

  it('checks the full versions against the engine, per vendor', () => {
    expect(brandProblems('chrome', chrome, '154.0.9999.1')).toEqual([
      `fullVersionList ${JSON.stringify(chrome.fullVersionList)} != 154.0.9999.1`,
      'uaFullVersion 154.0.8037.57 != 154.0.9999.1',
      'Chromium 154.0.8037.57 != 154.0.9999.1',
    ]);
    // Edge's Chromium carries its own build numbers, but must be a full version.
    expect(
      brandProblems(
        'edge',
        {
          ...edge,
          fullVersionList: ['Microsoft Edge/155.0.4283.45', 'Chromium/155', 'Not(A:Brand/24.0.0.0'],
        },
        '155.0.4283.45',
      ),
    ).toEqual(['Chromium 155 is not a full version']);
    expect(
      brandProblems(
        'edge',
        { ...edge, fullVersionList: ['Microsoft Edge/155.0.4283.45'] },
        '155.0.4283.45',
      ),
    ).toEqual(['fullVersionList has no Chromium']);
  });
});
