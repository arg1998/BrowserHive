/** @module test/integration/site-pack-strategies-actions.test — spec 13 §17 T3b acceptance for the before-action strategies on real headless Chromium with the HTTPS fixture sites: `serialize-site` makes a second session wait for its turn and answers `TEMPLATE_BUSY` `pace` when the wait runs out (a short test seam stands in for the production 30 s); `human-dwell` delays a session's next action on the site; `entry-warmup` loads the entry path with the chosen referrer before a deep link, once, and aborts a warm-up that leaves the pack's domains by script while the agent's navigation still succeeds (a server redirect is the driver's known routing limit, §3.8); `single-focus` leaves one focused page per site across sessions, keeps an unfocused page unfocused across a reload, screenshots it, and gives focus back when the pack drops the strategy; `humanize-input` forces humanized pointer input (ignored with stealth `off`); with `sitePacks=false` none of them applies. */

import { afterEach, describe, expect, it } from 'bun:test';
import { STRATEGY_SLOW_MS } from '../helpers/https-sites-strategies.ts';
import { fixturePack } from './site-pack-fixture.ts';
import {
  hasFocus,
  ok,
  refusal,
  SITE,
  type StrategyWorld,
  strategyWorld,
} from './site-pack-strategies-fixture.ts';
import { STEALTH_LEGS } from './template-fixture.ts';

let world: StrategyWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

const url = (path: string) => `https://${SITE}${path}`;
/** Requests the fixture saw for `host` (favicon fetches left out). */
const requestsTo = (p: StrategyWorld, host: string) =>
  p.w.sites.requests.filter((r) => r.host.startsWith(host) && r.path !== '/favicon.ico');

describe('serialize-site', () => {
  it('a second session waits for its turn, then answers TEMPLATE_BUSY pace when it runs out', async () => {
    world = await strategyWorld([{ id: 'serialize-site', params: { max_parallel: 1 } }], {
      serializeWaitMs: 1_500,
    });
    const p = world;
    const a = await p.session('a');
    const b = await p.session('b');
    ok(await a.call('navigate', { url: url('/strategy/input') }));
    ok(await b.call('navigate', { url: url('/strategy/input') }));
    // A holds the site's turn with a slow navigation; B's click on the site is refused.
    const slow = a.call('navigate', { url: url('/strategy/slow') });
    await Bun.sleep(300);
    const startedAt = Date.now();
    const refused = refusal(await b.call('click', { selector: '#btn' }));
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
    expect(refused).toEqual({
      code: 'TEMPLATE_BUSY',
      details: {
        template: p.w.template.name,
        limit_kind: 'pace',
        limit_text: `Actions on ${SITE} are being paced.`,
        retry_after_ms: 5_000,
        retry_after_s: 5,
      },
    });
    // Reads are not paced.
    ok(await b.call('snapshot'));
    ok(await slow);
    // Free again: B acts at once.
    ok(await b.call('click', { selector: '#btn' }));
  }, 40_000);

  it('a waiting action goes on when the turn is released', async () => {
    world = await strategyWorld([{ id: 'serialize-site', params: {} }], {
      serializeWaitMs: 15_000,
    });
    const p = world;
    const a = await p.session('a');
    const b = await p.session('b');
    ok(await b.call('navigate', { url: url('/strategy/input') }));
    const slowAt = Date.now();
    const slow = a.call('navigate', { url: url('/strategy/slow') });
    await Bun.sleep(300);
    ok(await b.call('click', { selector: '#btn' }));
    // B ran after A's navigation finished (the slow page takes STRATEGY_SLOW_MS).
    expect(Date.now() - slowAt).toBeGreaterThanOrEqual(STRATEGY_SLOW_MS - 200);
    ok(await slow);
  }, 40_000);
});

describe('human-dwell', () => {
  it("delays a session's next action on the site, not its first", async () => {
    world = await strategyWorld([{ id: 'human-dwell', params: { min_ms: 1_500, max_ms: 1_500 } }]);
    const a = await world.session();
    ok(await a.call('navigate', { url: url('/strategy/input') }));
    const startedAt = Date.now();
    ok(await a.call('click', { selector: '#btn' }));
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_450);
    // Another site is not delayed.
    ok(await a.call('navigate', { url: 'https://site-b.test/landing' }));
    const other = Date.now();
    ok(await a.call('navigate', { url: 'https://site-b.test/' }));
    expect(Date.now() - other).toBeLessThan(1_450);
  });
});

describe('entry-warmup', () => {
  it('loads the entry path with the referrer before the first deep link, once', async () => {
    world = await strategyWorld([
      { id: 'entry-warmup', params: { path: '/', dwell_ms: 500, referrer: 'same-site' } },
    ]);
    const p = world;
    const a = await p.session();
    const result = ok(await a.call('navigate', { url: url('/landing') }));
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      url: url('/landing'),
      status: 200,
    });
    const documents = requestsTo(p, SITE).map((r) => [r.path, r.referer]);
    expect(documents).toEqual([
      ['/', `https://${SITE}/`],
      ['/landing', null],
    ]);
    ok(await a.call('navigate', { url: url('/landing?again') }));
    expect(requestsTo(p, SITE).map((r) => r.path)).toEqual(['/', '/landing', '/landing?again']);
    // Another session warms up on its own first visit (the search referrer variant).
    p.lookup.swap(
      fixturePack('/pack/probe/in', {
        strategies: [
          { id: 'entry-warmup', params: { path: '/', referrer: 'search', dwell_ms: 500 } },
        ],
      }),
    );
    const b = await p.session('b');
    ok(await b.call('new_tab', { url: url('/landing?b') }));
    expect(requestsTo(p, SITE).slice(-2)).toEqual([
      expect.objectContaining({ path: '/', referer: 'https://www.google.com/' }),
      expect.objectContaining({ path: '/landing?b' }),
    ]);
  });

  it("aborts a warm-up that leaves the pack's domains by script; the navigation succeeds", async () => {
    world = await strategyWorld([
      { id: 'entry-warmup', params: { path: '/strategy/leave-js', dwell_ms: 1_500 } },
    ]);
    const p = world;
    const a = await p.session();
    ok(await a.call('navigate', { url: url('/landing') }));
    expect(requestsTo(p, 'site-b.test')).toEqual([]);
    expect(a.page().url()).toBe(url('/landing'));
  });

  it('a server redirect off the domains is not routed (the driver limit of §3.8); the navigation succeeds', async () => {
    world = await strategyWorld([
      { id: 'entry-warmup', params: { path: '/strategy/leave', dwell_ms: 500 } },
    ]);
    const p = world;
    const a = await p.session();
    ok(await a.call('navigate', { url: url('/landing') }));
    // Pinned: Playwright routes only the first URL of a redirect chain, so the hop goes out.
    expect(requestsTo(p, 'site-b.test').map((r) => r.path)).toEqual(['/landing?from=warmup-302']);
    expect(a.page().url()).toBe(url('/landing'));
  });
});

for (const stealth of STEALTH_LEGS) {
  describe(`single-focus (stealth ${stealth})`, () => {
    it('leaves one focused page per site, screenshots the others, and gives focus back', async () => {
      world = await strategyWorld([{ id: 'single-focus', params: {} }], { stealth });
      const p = world;
      const a = await p.session('a');
      const b = await p.session('b');
      ok(await a.call('navigate', { url: url('/strategy/input') }));
      ok(await b.call('navigate', { url: url('/strategy/input') }));
      expect([await hasFocus(a.page()), await hasFocus(b.page())]).toEqual([false, true]);
      ok(await a.call('click', { selector: '#btn' }));
      expect([await hasFocus(a.page()), await hasFocus(b.page())]).toEqual([true, false]);
      // The unfocused page still reports `visible`, stays unfocused across a reload by the site,
      // and screenshots through the tool.
      expect(await b.page().evaluate(() => document.visibilityState)).toBe('visible');
      await b.page().reload();
      expect(await hasFocus(b.page())).toBe(false);
      const shot = ok(await b.call('screenshot'));
      expect(shot.content.some((c) => c.type === 'image')).toBe(true);
      // B leaves the site: its page is focused again whatever happens on site-a.
      ok(await b.call('navigate', { url: 'https://site-b.test/landing' }));
      expect(await hasFocus(b.page())).toBe(true);
      ok(await b.call('navigate', { url: url('/strategy/input') }));
      expect([await hasFocus(a.page()), await hasFocus(b.page())]).toEqual([false, true]);
      // The pack stops selecting the strategy: every page is focused again.
      p.lookup.swap(fixturePack('/pack/probe/in'));
      await p.runner.reconcile();
      expect([await hasFocus(a.page()), await hasFocus(b.page())]).toEqual([true, true]);
    });
  });

  describe(`humanize-input (stealth ${stealth})`, () => {
    it(
      stealth === 'off'
        ? 'is ignored when the template has stealth off'
        : 'forces humanized pointer input for a session without humanize',
      async () => {
        world = await strategyWorld([{ id: 'humanize-input', params: {} }], { stealth });
        const a = await world.session();
        ok(await a.call('navigate', { url: url('/strategy/input') }));
        ok(await a.call('click', { selector: '#btn' }));
        const moves = Number(await a.page().evaluate(() => document.body.dataset['moves'] ?? '0'));
        // A native click moves the pointer once; the humanized path moves it along a curve.
        if (stealth === 'off') expect(moves).toBeLessThanOrEqual(2);
        else expect(moves).toBeGreaterThan(5);
      },
    );
  });
}

describe('sitePacks=false', () => {
  it('no strategy applies', async () => {
    world = await strategyWorld(
      [
        { id: 'serialize-site', params: {} },
        { id: 'human-dwell', params: { min_ms: 3_000, max_ms: 3_000 } },
        { id: 'entry-warmup', params: { path: '/', dwell_ms: 500 } },
        { id: 'single-focus', params: {} },
        { id: 'humanize-input', params: {} },
      ],
      { sitePacks: false, serializeWaitMs: 1_000 },
    );
    const p = world;
    const a = await p.session('a');
    const b = await p.session('b');
    ok(await a.call('navigate', { url: url('/strategy/input') }));
    ok(await b.call('navigate', { url: url('/strategy/input') }));
    expect(requestsTo(p, SITE).map((r) => r.path)).not.toContain('/');
    const slow = a.call('navigate', { url: url('/strategy/slow') });
    await Bun.sleep(300);
    const startedAt = Date.now();
    ok(await b.call('click', { selector: '#btn' }));
    ok(await b.call('click', { selector: '#btn' }));
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(
      Number(await b.page().evaluate(() => document.body.dataset['moves'] ?? '0')),
    ).toBeLessThanOrEqual(2);
    ok(await slow);
    expect([await hasFocus(a.page()), await hasFocus(b.page())]).toEqual([true, true]);
  }, 40_000);
});
