/** @module lib/install/support.test — `installSupport` with a UA fixture per row of 04 §18.8.2 (every listed browser and OS), standalone in each display mode, and the precedence of standalone, insecure and prompt */
import { describe, expect, it } from 'bun:test';
import {
  type InstallInput,
  type InstallKind,
  installSupport,
  isStandalone,
  readInstallInput,
  STANDALONE_QUERY,
} from './support.ts';

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const CHROME_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

/** Brand lists as Chromium reports them in `navigator.userAgentData.brands`. */
const BRANDS = {
  chrome: ['Google Chrome', 'Chromium', 'Not_A Brand'],
  edge: ['Microsoft Edge', 'Chromium', 'Not_A Brand'],
  brave: ['Brave', 'Chromium', 'Not_A Brand'],
  opera: ['Opera', 'Chromium', 'Not_A Brand'],
  vivaldi: ['Chromium', 'Not_A Brand'],
} as const;

interface Fixture {
  readonly name: string;
  readonly userAgent: string;
  readonly uaBrands?: readonly string[];
  readonly uaPlatform?: string | null;
  readonly maxTouchPoints?: number;
  readonly kind: InstallKind;
  readonly brand?: 'chrome' | 'edge' | 'other';
}

const desktopChromium = (
  name: string,
  brands: readonly string[],
  suffix: string,
  brand: 'chrome' | 'edge' | 'other',
): Fixture[] =>
  (
    [
      ['Windows', CHROME_WIN],
      ['macOS', CHROME_MAC],
      ['Linux', CHROME_LINUX],
    ] as const
  ).map(([platform, ua]) => ({
    name: `${name} on ${platform}`,
    userAgent: `${ua}${suffix}`,
    uaBrands: brands,
    uaPlatform: platform,
    kind: 'chromium',
    brand,
  }));

const FIXTURES: readonly Fixture[] = [
  ...desktopChromium('Chrome', BRANDS.chrome, '', 'chrome'),
  ...desktopChromium('Edge', BRANDS.edge, ' Edg/154.0.0.0', 'edge'),
  ...desktopChromium('Brave', BRANDS.brave, '', 'other'),
  ...desktopChromium('Opera', BRANDS.opera, ' OPR/120.0.0.0', 'other'),
  ...desktopChromium('Vivaldi', BRANDS.vivaldi, ' Vivaldi/7.6', 'other'),
  {
    name: 'Chrome on Linux without UA-CH (UA string only)',
    userAgent: CHROME_LINUX,
    kind: 'chromium',
    brand: 'chrome',
  },
  {
    name: 'Edge on Windows without UA-CH',
    userAgent: `${CHROME_WIN} Edg/154.0.0.0`,
    kind: 'chromium',
    brand: 'edge',
  },
  {
    name: 'Chrome on ChromeOS',
    userAgent:
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    uaBrands: BRANDS.chrome,
    uaPlatform: 'Chrome OS',
    kind: 'chromium',
    brand: 'chrome',
  },
  {
    name: 'Chrome on Android',
    userAgent:
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
    uaBrands: BRANDS.chrome,
    uaPlatform: 'Android',
    maxTouchPoints: 5,
    kind: 'chromium-android',
  },
  {
    name: 'Chrome on Android without UA-CH',
    userAgent:
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
    maxTouchPoints: 5,
    kind: 'chromium-android',
  },
  {
    name: 'Firefox on Windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0',
    kind: 'firefox-windows',
  },
  {
    name: 'Firefox on Linux',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0',
    kind: 'firefox-linux',
  },
  {
    name: 'Firefox on Ubuntu',
    userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0',
    kind: 'firefox-linux',
  },
  {
    name: 'Firefox on macOS',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0',
    kind: 'firefox-unsupported',
  },
  {
    // Firefox for Android installs sites from its own menu: the generic row's words are right.
    name: 'Firefox on Android',
    userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0',
    maxTouchPoints: 5,
    kind: 'unknown',
  },
  {
    name: 'Safari on macOS',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
    kind: 'safari-macos',
  },
  {
    name: 'Safari on iPhone',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
    kind: 'ios',
  },
  {
    name: 'Chrome on iOS',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.0.0 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
    kind: 'ios',
  },
  {
    name: 'Firefox on iOS',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/157.0 Mobile/15E148 Safari/605.1.15',
    maxTouchPoints: 5,
    kind: 'ios',
  },
  {
    name: 'iPad (iPadOS reports a Mac UA, with a touch screen)',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
    maxTouchPoints: 5,
    kind: 'ios',
  },
  {
    name: 'an unknown browser',
    userAgent: 'SomeBrowser/1.0 (PlanOS)',
    kind: 'unknown',
  },
];

function input(fixture: Fixture, overrides: Partial<InstallInput> = {}): InstallInput {
  return {
    hasPrompt: false,
    standalone: false,
    secure: true,
    userAgent: fixture.userAgent,
    uaBrands: fixture.uaBrands ?? [],
    uaPlatform: fixture.uaPlatform ?? null,
    maxTouchPoints: fixture.maxTouchPoints ?? 0,
    ...overrides,
  };
}

describe('installSupport', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(installSupport(input(fixture))).toEqual({
      kind: fixture.kind,
      brand: fixture.brand ?? null,
    });
  });

  it('every row of the table has a fixture', () => {
    const kinds = new Set(FIXTURES.map((f) => f.kind));
    for (const kind of [
      'ios',
      'chromium-android',
      'chromium',
      'firefox-windows',
      'firefox-linux',
      'firefox-unsupported',
      'safari-macos',
      'unknown',
    ] as const)
      expect(kinds.has(kind)).toBe(true);
  });

  it('standalone wins over everything, then insecure, then a held prompt (over every browser row)', () => {
    for (const fixture of FIXTURES) {
      expect(
        installSupport(input(fixture, { standalone: true, secure: false, hasPrompt: true })).kind,
      ).toBe('standalone');
      expect(installSupport(input(fixture, { secure: false, hasPrompt: true })).kind).toBe(
        'insecure',
      );
      expect(installSupport(input(fixture, { hasPrompt: true })).kind).toBe('prompt');
    }
  });
});

describe('isStandalone', () => {
  it('matches every display mode of an installed app, or iOS navigator.standalone', () => {
    expect(STANDALONE_QUERY.split(', ')).toEqual([
      '(display-mode: standalone)',
      '(display-mode: fullscreen)',
      '(display-mode: minimal-ui)',
      '(display-mode: window-controls-overlay)',
    ]);
    for (const mode of ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']) {
      // A real matchMedia matches the comma list when any one mode holds.
      const matchMedia = (query: string) => ({
        matches: query.split(', ').includes(`(display-mode: ${mode})`),
      });
      expect(isStandalone({ matchMedia })).toBe(true);
    }
    expect(isStandalone({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(
      isStandalone({ matchMedia: () => ({ matches: false }), navigatorStandalone: true }),
    ).toBe(true);
    expect(isStandalone({})).toBe(false);
  });

  it('readInstallInput reads the browser', () => {
    const read = readInstallInput(
      {
        isSecureContext: true,
        matchMedia: () => ({ matches: false }),
        navigator: {
          userAgent: CHROME_LINUX,
          maxTouchPoints: 0,
          userAgentData: { brands: [{ brand: 'Google Chrome' }], platform: 'Linux' },
        },
      },
      true,
    );
    expect(read).toEqual({
      hasPrompt: true,
      standalone: false,
      secure: true,
      userAgent: CHROME_LINUX,
      uaBrands: ['Google Chrome'],
      uaPlatform: 'Linux',
      maxTouchPoints: 0,
    });
  });
});
