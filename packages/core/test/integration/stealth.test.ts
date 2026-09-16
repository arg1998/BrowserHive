/** @module test/integration/stealth — Phase 0 + Phase 1 stealth regression gate against real Chromium and the localhost fixture origin (spec 11 §9). */

import { describe, expect, it } from 'bun:test';
import { humanClick, humanType } from '../../src/infra/browsers/humanize/actions.ts';
import { CursorTracker } from '../../src/infra/browsers/humanize/cursor.ts';
import { seededRng } from '../../src/infra/browsers/humanize/rng.ts';
import { evalMain, useDriverFixtures } from './driver-fixture.ts';

/** The `/probe` page's `window.__probe` payload (see fixture-server). */
interface Probe {
  userAgent: string;
  webdriver: boolean;
  languages: string[];
  language: string;
  deviceMemory: number | undefined;
  hardwareConcurrency: number;
  hasChrome: boolean;
  plugins: number;
  brands: { brand: string; version: string }[] | null;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    availTop: number;
    availLeft: number;
  };
  window: {
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
    screenX: number;
    screenY: number;
    screenLeft: number;
    screenTop: number;
    devicePixelRatio: number;
  };
  timezone: string;
  locale: string;
  screenWidthGetterToString: string;
  screenWidthGetterName: string;
  toStringOfToString: string;
}

type Session = Awaited<ReturnType<ReturnType<typeof useDriverFixtures>['state']['launch']>>;

function readProbe(session: Session, page?: Session['page']): Promise<Probe> {
  return evalMain(session, () => (window as unknown as { __probe: Probe }).__probe, page);
}

describe('stealth Phase 0 (real browser)', () => {
  const { state } = useDriverFixtures();

  it('a stealth session presents a coherent, non-headless identity to the page', async () => {
    const session = await state.launch({ slug: 'stealthy', stealth: true });
    const { handle, page } = session;
    await page.goto(state.fixture.url('/probe'));
    const probe = await readProbe(session);

    expect(probe.userAgent).not.toContain('HeadlessChrome');
    expect(probe.userAgent).toContain('Chrome/');
    // The automation tell is gone.
    expect(probe.webdriver).toBe(false);
    // UA-CH now advertises Google Chrome (bundled Chromium natively reports only Chromium + GREASE).
    const brands = (probe.brands ?? []).map((b) => b.brand);
    expect(brands).toContain('Google Chrome');
    expect(brands).toContain('Chromium');
    // `navigator.deviceMemory` must be *present* — `undefined` is the tell the old headless shell
    // produced. The full-Chromium binary reports the host's real value.
    expect(typeof probe.deviceMemory).toBe('number');
    expect(probe.deviceMemory ?? 0).toBeGreaterThan(0);
    // The full-binary swap restored real-browser signals.
    expect(probe.hasChrome).toBe(true);
    expect(
      await evalMain(session, () => typeof (window as unknown as { chrome?: unknown }).chrome),
    ).toBe('object');
    expect(probe.plugins).toBeGreaterThan(0);

    // The session recorded the applied identity for metadata / the dashboard.
    expect(handle.identity).not.toBeNull();
    expect(handle.identity?.brands.map((b) => b.brand)).toContain('Google Chrome');
    expect(handle.identity?.userAgent).not.toContain('HeadlessChrome');
    expect(handle.warnings.map((w) => w.code)).not.toContain('STEALTH_INIT_FAILED');
    expect(['patchright', 'playwright']).toContain(handle.driver);
    expect(handle.capabilities.isolatedEvaluate).toBe(handle.driver === 'patchright');
  });

  it('a non-stealth session applies no override (native identity, no recorded identity)', async () => {
    const session = await state.launch({ slug: 'plain', stealth: false });
    const { handle, page } = session;
    await page.goto(state.fixture.url('/probe'));
    // Stock automation leaves navigator.webdriver true and applies no identity override.
    expect((await readProbe(session)).webdriver).toBe(true);
    expect(handle.identity).toBeNull();
    expect(handle.driver).toBe('playwright');
  });

  it("a new tab's FIRST request already carries the overridden identity", async () => {
    // The override is per-page and starts fire-and-forget from the context's `page` event, so a tab
    // that navigates immediately after being opened can beat it. `new_tab` awaits the application,
    // and this asserts the wire, not the DOM.
    const { handle } = await state.launch({ slug: 'newtab', stealth: true });
    const page = await handle.context.newPage();
    await handle.ensureIdentityForPage(page);

    const sentUserAgents: string[] = [];
    page.on('request', (req) => {
      const ua = req.headers()['user-agent'];
      if (ua !== undefined) sentUserAgents.push(ua);
    });
    await page.goto(state.fixture.url('/'));

    expect(sentUserAgents.length).toBeGreaterThan(0);
    for (const ua of sentUserAgents) expect(ua).not.toContain('HeadlessChrome');
    const wire = state.fixture.requests.find((r) => r.path === '/');
    expect(wire?.headers['user-agent']).not.toContain('HeadlessChrome');
  });

  it('applies the identity override to a SECOND tab, not just the first', async () => {
    // `Emulation.setUserAgentOverride` is page-scoped. Before this was fixed, a session presented a
    // clean Chrome in tab 1 and a raw `HeadlessChrome` in tab 2 — an inconsistency strictly worse
    // than being uniformly either.
    const session = await state.launch({ slug: 'tabs', stealth: true });
    const { handle, page } = session;
    await page.goto(state.fixture.url('/probe'));
    const second = await handle.context.newPage();
    await handle.ensureIdentityForPage(second);
    await second.goto(state.fixture.url('/probe'));
    const probe = await readProbe(session, second);
    expect(probe.userAgent).not.toContain('HeadlessChrome');
    expect((probe.brands ?? []).map((b) => b.brand)).toContain('Google Chrome');
  });
});

describe('stealth Phase 1 — fingerprint injection (real browser)', () => {
  const { state } = useDriverFixtures();

  it('presents a coherent display + locale identity to the page', async () => {
    const session = await state.launch({ slug: 'fingerprinted', stealth: true, fingerprint: true });
    const { handle, page, geo } = session;
    await page.goto(state.fixture.url('/probe'));
    const seen = await readProbe(session);

    // --- The coherence chain no headless default satisfies ---
    expect(seen.window.innerHeight).toBeLessThan(seen.window.outerHeight);
    expect(seen.window.outerHeight).toBeLessThanOrEqual(seen.screen.availHeight);
    expect(seen.screen.availHeight).toBeLessThanOrEqual(seen.screen.height);
    expect(seen.window.innerHeight).toBeLessThan(seen.screen.height);
    expect(`${seen.window.innerWidth}x${seen.window.innerHeight}`).not.toBe('1280x720');

    // --- The language story, coherent across JS and the wire ---
    expect(seen.languages.length).toBeGreaterThan(1);
    expect(seen.languages[0]).toBe(seen.language);
    expect(seen.locale).toBe(seen.language);
    const acceptLanguage = state.fixture.requests.find((r) => r.path === '/probe')?.headers[
      'accept-language'
    ];
    expect(acceptLanguage).toBeDefined();
    expect(acceptLanguage).toContain(';q=0.9');
    // A pre-weighted list sent to CDP produces `en-CA,en;q=0.9;q=0.9` — never emit a doubled q.
    expect(acceptLanguage).not.toMatch(/q=0\.9;q=/);
    expect(acceptLanguage?.startsWith(`${seen.language},`)).toBe(true);

    // --- Timezone agrees with the recorded seed ---
    expect(seen.timezone).toBe(geo?.timezoneId ?? '');
    expect(handle.identity?.geo?.timezoneId).toBe(seen.timezone);

    // --- The overrides are indistinguishable from native by descriptor inspection ---
    expect(seen.screenWidthGetterToString).toBe('function get width() { [native code] }');
    expect(seen.screenWidthGetterName).toBe('get width');
    expect(seen.toStringOfToString).toBe('function toString() { [native code] }');
    const descriptors = await evalMain(session, () => ({
      outerHeight: Object.getOwnPropertyDescriptor(window, 'outerHeight')?.get?.toString(),
      untouched: Object.getOwnPropertyDescriptor(
        Navigator.prototype,
        'hardwareConcurrency',
      )?.get?.toString(),
      untouchedName: Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency')
        ?.get?.name,
      throwsOnUndefined: (() => {
        try {
          Function.prototype.toString.call(undefined);
          return 'no-throw';
        } catch (e) {
          return e instanceof Error ? e.constructor.name : 'unknown';
        }
      })(),
    }));
    expect(descriptors.outerHeight).toBe('function get outerHeight() { [native code] }');
    expect(descriptors.untouched).toBe('function get hardwareConcurrency() { [native code] }');
    expect(descriptors.untouchedName).toBe('get hardwareConcurrency');
    expect(descriptors.throwsOnUndefined).toBe('TypeError');
    // `screenX`/`screenLeft` and `screenY`/`screenTop` are the same value under two names.
    expect(seen.window.screenX).toBe(seen.window.screenLeft);
    expect(seen.window.screenY).toBe(seen.window.screenTop);

    // --- What metadata reports matches what the page saw ---
    expect(handle.identity?.display?.screen).toEqual({
      width: seen.screen.width,
      height: seen.screen.height,
    });
    expect(handle.identity?.display?.viewport).toEqual({
      width: seen.window.innerWidth,
      height: seen.window.innerHeight,
    });
  });

  it('covers tabs opened after launch with the same display identity', async () => {
    const session = await state.launch({ slug: 'fp-tabs', stealth: true, fingerprint: true });
    const { handle, page } = session;
    await page.goto(state.fixture.url('/probe'));
    const first = (await readProbe(session)).screen.availHeight;
    const second = await handle.context.newPage();
    await handle.ensureIdentityForPage(second);
    await second.goto(state.fixture.url('/probe'));
    expect((await readProbe(session, second)).screen.availHeight).toBe(first);
  });

  it('leaves the display untouched when fingerprint injection is off', async () => {
    const session = await state.launch({ slug: 'no-fp', stealth: true, fingerprint: false });
    const { handle, page } = session;
    await page.goto(state.fixture.url('/probe'));
    // The un-fingerprinted baseline: screen mirrors the viewport exactly.
    const seen = await readProbe(session);
    expect(seen.screen.height).toBe(seen.window.innerHeight);
    expect(handle.identity?.display).toBeNull();
  });
});

describe('stealth Phase 1 — humanized input (real browser)', () => {
  const { state } = useDriverFixtures();

  it('drives a real curved pointer path and fires the events a page can observe', async () => {
    const { page } = await state.launch({ slug: 'human', stealth: true });
    await page.goto(state.fixture.url('/elements'));
    await page.evaluate(() => {
      const w = globalThis as unknown as { __moves: [number, number][]; __clicked: boolean };
      w.__moves = [];
      w.__clicked = false;
      document.addEventListener('mousemove', (e: MouseEvent) => {
        w.__moves.push([e.clientX, e.clientY]);
      });
      document.getElementById('btn')?.addEventListener('click', () => {
        w.__clicked = true;
      });
    });

    await humanClick({
      page,
      tracker: new CursorTracker(),
      rng: seededRng('human-session'),
      timeout: 30_000,
      selector: '#btn',
      native: async () => {
        throw new Error('should not have fallen back');
      },
    });

    const observed = await page.evaluate(() => {
      const w = globalThis as unknown as { __moves: [number, number][]; __clicked: boolean };
      return { moves: w.__moves, clicked: w.__clicked };
    });
    expect(observed.clicked).toBe(true);
    // Many intermediate points, not a teleport.
    expect(observed.moves.length).toBeGreaterThan(5);
    // The path is curved: the points must not all sit on the straight start→end line.
    const first = observed.moves[0];
    const last = observed.moves[observed.moves.length - 1];
    if (first === undefined || last === undefined) throw new Error('no moves observed');
    const offLine = observed.moves.some(([x, y]) => {
      const [x0, y0] = first;
      const [x1, y1] = last;
      const area = Math.abs((x1 - x0) * (y - y0) - (x - x0) * (y1 - y0));
      const length = Math.hypot(x1 - x0, y1 - y0) || 1;
      return area / length > 2; // more than 2px off the chord
    });
    expect(offLine).toBe(true);
    // The final click landed inside the button but not at its exact centre.
    const box = await page.locator('#btn').boundingBox();
    if (box === null) throw new Error('no box');
    const [lx, ly] = last;
    expect(lx).toBeGreaterThan(box.x);
    expect(lx).toBeLessThan(box.x + box.width);
    expect(ly).toBeGreaterThan(box.y);
    expect(ly).toBeLessThan(box.y + box.height);
    expect(lx === box.x + box.width / 2 && ly === box.y + box.height / 2).toBe(false);
  });

  it('types with varying inter-key intervals and lands the exact text', async () => {
    const { page } = await state.launch({ slug: 'typist', stealth: true });
    await page.goto(state.fixture.url('/elements'));
    await page.evaluate(() => {
      const w = globalThis as unknown as { __stamps: number[] };
      w.__stamps = [];
      document.getElementById('text')?.addEventListener('keydown', () => {
        w.__stamps.push(performance.now());
      });
    });
    const text = 'hello there friend';
    await humanType({
      page,
      tracker: new CursorTracker(),
      rng: seededRng('typist-session'),
      timeout: 30_000,
      selector: '#text',
      text,
      focus: () => page.click('#text'),
      native: async () => {
        throw new Error('should not have fallen back');
      },
    });
    expect(await page.inputValue('#text')).toBe(text);
    const gaps = await page.evaluate(() => {
      const stamps = (globalThis as unknown as { __stamps: number[] }).__stamps;
      return stamps.slice(1).map((t, i) => t - (stamps[i] ?? 0));
    });
    expect(gaps.length).toBeGreaterThan(5);
    // Real keystroke timing varies; a constant delay (Playwright's `delay` option) does not.
    expect(new Set(gaps.map((g) => Math.round(g / 5))).size).toBeGreaterThan(3);
    expect(Math.min(...gaps)).toBeGreaterThan(5);
  });

  it('leaves every tool on its exact native path when humanize is off', async () => {
    const session = await state.launch({ slug: 'fast', stealth: true });
    const { page } = session;
    await page.goto(state.fixture.url('/elements'));
    const started = performance.now();
    await page.click('#btn');
    // The native path is essentially instant; humanized motion takes hundreds of ms.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await evalMain(session, () => document.getElementById('btn')?.textContent)).toBe(
      'clicked',
    );
  });
});
