/** @module infra/browsers/page-dispatcher.test — delivery after attribution, same-turn delivery for synchronous facts, holds (claim, settle, expiry), async facts, closes and listener isolation. */

import { describe, expect, it } from 'bun:test';
import type { Page } from 'playwright';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { asPage, FakePage } from '../../../test/helpers/fake-page.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import { PARKED, type PageOwner, sessionOwner, type TargetFacts } from './page-attribution.ts';
import { ATTRIBUTION_HOLD_MS, HostPageDispatcher } from './page-dispatcher.ts';

interface Rig {
  readonly clock: FakeClock;
  readonly dispatcher: HostPageDispatcher;
  page(targetId: string, openerId?: string | null): Page;
  readonly delivered: Map<string, Page[]>;
  listen(sessionId: string): void;
  /** Delivers the slow facts of `targetId`. */
  release(targetId: string): void;
}

function rig(options: { fallback?: PageOwner; slow?: Set<string> } = {}): Rig {
  const clock = new FakeClock();
  const facts = new Map<Page, TargetFacts>();
  const waiting = new Map<string, () => void>();
  const dispatcher = new HostPageDispatcher({
    fallback: options.fallback ?? PARKED,
    clock,
    logger: createCollectingLogger(),
    factsOf: (page) => {
      const read = facts.get(page);
      if (read === undefined) throw new Error('no facts');
      if (options.slow?.has(read.targetId) !== true) return read;
      return new Promise<TargetFacts>((resolve) => waiting.set(read.targetId, () => resolve(read)));
    },
  });
  const delivered = new Map<string, Page[]>();
  return {
    clock,
    dispatcher,
    delivered,
    page(targetId, openerId = null) {
      const page = asPage(new FakePage());
      facts.set(page, { targetId, openerId });
      return page;
    },
    listen(sessionId) {
      const list: Page[] = [];
      delivered.set(sessionId, list);
      dispatcher.onAttributed(sessionId, (page) => {
        // Delivery happens only after the page is attributed to this session.
        expect(dispatcher.ownerOf(page)).toEqual(sessionOwner(sessionId));
        list.push(page);
      });
    },
    release(targetId) {
      waiting.get(targetId)?.();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('HostPageDispatcher', () => {
  it('without a facts reader every page goes to the fallback session in the same turn', () => {
    const dispatcher = new HostPageDispatcher({
      fallback: sessionOwner('s1'),
      clock: new FakeClock(),
      logger: createCollectingLogger(),
    });
    const seen: Page[] = [];
    dispatcher.onAttributed('s1', (page) => seen.push(page));
    const first = asPage(new FakePage());
    const popup = asPage(new FakePage());
    dispatcher.adopt(first);
    dispatcher.adopt(popup);
    dispatcher.adopt(popup);
    expect(seen).toEqual([first, popup]);
    expect(dispatcher.pagesOf('s1')).toEqual([first, popup]);
    expect(dispatcher.parkedPages()).toEqual([]);
  });

  it('claimed pages and their popups reach only their session; unclaimed pages are parked', () => {
    const r = rig();
    r.listen('a');
    r.listen('b');
    r.dispatcher.claim('wa', sessionOwner('a'));
    r.dispatcher.claim('wb', sessionOwner('b'));
    const wa = r.page('wa');
    const wb = r.page('wb');
    const popup = r.page('pa', 'wa');
    const operatorTab = r.page('ctrl-t');
    for (const page of [wa, wb, popup, operatorTab]) r.dispatcher.adopt(page);
    expect(r.delivered.get('a')).toEqual([wa, popup]);
    expect(r.delivered.get('b')).toEqual([wb]);
    expect(r.dispatcher.ownerOf(operatorTab)).toEqual(PARKED);
    expect(r.dispatcher.parkedPages()).toEqual([operatorTab]);
  });

  it('holds a page adopted before its createTarget answered and gives it to the claim', () => {
    const r = rig();
    r.listen('a');
    const settle = r.dispatcher.beginCreate();
    const window = r.page('w');
    r.dispatcher.adopt(window);
    expect(r.dispatcher.ownerOf(window)).toBeUndefined();
    expect(r.delivered.get('a')).toEqual([]);
    expect(r.dispatcher.claim('w', sessionOwner('a'))).toBe(true);
    settle();
    expect(r.delivered.get('a')).toEqual([window]);
  });

  it('parks a held page when the create settles without claiming it, or when the hold expires', async () => {
    const r = rig();
    const settle = r.dispatcher.beginCreate();
    const stray = r.page('stray');
    r.dispatcher.adopt(stray);
    settle();
    expect(r.dispatcher.ownerOf(stray)).toEqual(PARKED);

    r.dispatcher.beginCreate();
    const late = r.page('late');
    r.dispatcher.adopt(late);
    await r.clock.advance(ATTRIBUTION_HOLD_MS - 1);
    expect(r.dispatcher.ownerOf(late)).toBeUndefined();
    await r.clock.advance(1);
    await flush();
    expect(r.dispatcher.ownerOf(late)).toEqual(PARKED);
    // The claim that arrives after the hold is refused: the attribution stands.
    expect(r.dispatcher.claim('late', sessionOwner('a'))).toBe(false);
  });

  it("a held opener's popup waits for it and follows it", () => {
    const r = rig();
    r.listen('a');
    const settle = r.dispatcher.beginCreate();
    const window = r.page('w');
    const popup = r.page('p', 'w');
    r.dispatcher.adopt(window);
    r.dispatcher.adopt(popup);
    expect(r.dispatcher.ownerOf(popup)).toBeUndefined();
    r.dispatcher.claim('w', sessionOwner('a'));
    settle();
    expect(r.delivered.get('a')).toEqual([window, popup]);
  });

  it('a popup whose opener facts are still being read waits for them', async () => {
    const slow = new Set(['w']);
    const r = rig({ slow });
    r.listen('a');
    r.dispatcher.claim('w', sessionOwner('a'));
    const window = r.page('w');
    const popup = r.page('p', 'w');
    r.dispatcher.adopt(window);
    r.dispatcher.adopt(popup);
    expect(r.dispatcher.ownerOf(popup)).toBeUndefined();
    r.release('w');
    await flush();
    expect(r.delivered.get('a')).toEqual([window, popup]);
  });

  it('a closed page keeps its attribution and leaves the open lists', async () => {
    const r = rig();
    r.dispatcher.claim('w', sessionOwner('a'));
    const window = r.page('w');
    r.dispatcher.adopt(window);
    await window.close();
    expect(r.dispatcher.ownerOf(window)).toBeUndefined();
    expect(r.dispatcher.pagesOf('a')).toEqual([]);
    expect(r.dispatcher.everOwnedBy(window, 'a')).toBe(true);
    expect(r.dispatcher.everOwnedBy(window, 'b')).toBe(false);
    // `window.open(); window.close()`: the child of the closed opener is still a's.
    const child = r.page('c', 'w');
    r.dispatcher.adopt(child);
    expect(r.dispatcher.ownerOf(child)).toEqual(sessionOwner('a'));
  });

  it('a throwing listener does not stop delivery to the others', () => {
    const dispatcher = new HostPageDispatcher({
      fallback: sessionOwner('s'),
      clock: new FakeClock(),
      logger: createCollectingLogger(),
    });
    const seen: Page[] = [];
    dispatcher.onAttributed('s', () => {
      throw new Error('observer bug');
    });
    dispatcher.onAttributed('s', (page) => seen.push(page));
    const page = asPage(new FakePage());
    dispatcher.adopt(page);
    expect(seen).toEqual([page]);
  });

  it('a page whose facts cannot be read is parked', async () => {
    const dispatcher = new HostPageDispatcher({
      fallback: PARKED,
      clock: new FakeClock(),
      logger: createCollectingLogger(),
      factsOf: () => Promise.reject(new Error('Target closed')),
    });
    const page = asPage(new FakePage());
    dispatcher.adopt(page);
    await flush();
    expect(dispatcher.ownerOf(page)).toEqual(PARKED);
  });

  it('after releaseSession the session gets nothing more and its claims are void', () => {
    const r = rig();
    r.listen('a');
    r.dispatcher.claim('w', sessionOwner('a'));
    r.dispatcher.releaseSession('a');
    const window = r.page('w');
    r.dispatcher.adopt(window);
    expect(r.delivered.get('a')).toEqual([]);
    expect(r.dispatcher.ownerOf(window)).toEqual(PARKED);
  });

  // Review of PR #74, F1: a listener that calls back into the dispatcher while a pass is running.
  it('a listener that claims another held page neither drops a third one nor double-delivers', async () => {
    const r = rig();
    const settle = r.dispatcher.beginCreate();
    const x = r.page('X');
    const y = r.page('Y');
    const z = r.page('Z');
    for (const page of [x, y, z]) r.dispatcher.adopt(page);
    const seen: Page[] = [];
    r.dispatcher.onAttributed('S', (page) => {
      seen.push(page);
      if (seen.length === 1) r.dispatcher.claim('Y', sessionOwner('S'));
    });
    r.dispatcher.claim('X', sessionOwner('S'));
    expect(seen).toEqual([x, y]);
    expect(r.dispatcher.ownerOf(z)).toBeUndefined();
    settle();
    expect(r.dispatcher.ownerOf(z)).toEqual(PARKED);
    await r.clock.advance(5 * ATTRIBUTION_HOLD_MS);
    await flush();
    expect(seen).toEqual([x, y]);
    expect(r.dispatcher.parkedPages()).toEqual([z]);
  });

  // Review of PR #74, F4: `window.open(url); window.close()` before the popup's facts were read.
  it("a popup that closes before its facts are read is tombstoned, so its own popup is the session's", async () => {
    const r = rig({ slow: new Set(['P']) });
    r.listen('S');
    r.dispatcher.claim('A', sessionOwner('S'));
    const a = r.page('A');
    r.dispatcher.adopt(a);
    const p = r.page('P', 'A');
    r.dispatcher.adopt(p);
    await p.close();
    r.release('P');
    await flush();
    expect(r.dispatcher.everOwnedBy(p, 'S')).toBe(true);
    expect(r.dispatcher.ownerOf(p)).toBeUndefined();
    const q = r.page('Q', 'P');
    r.dispatcher.adopt(q);
    expect(r.dispatcher.ownerOf(q)).toEqual(sessionOwner('S'));
    // The closed popup itself was never delivered.
    expect(r.delivered.get('S')).toEqual([a, q]);
  });

  it('a held page that closes keeps waiting for its claim and is tombstoned with it', () => {
    const r = rig();
    r.listen('S');
    const settle = r.dispatcher.beginCreate();
    const w = r.page('W');
    r.dispatcher.adopt(w);
    void w.close();
    return flush().then(() => {
      r.dispatcher.claim('W', sessionOwner('S'));
      settle();
      expect(r.dispatcher.everOwnedBy(w, 'S')).toBe(true);
      expect(r.delivered.get('S')).toEqual([]);
    });
  });

  // Review of PR #74, F5: the child's hold runs out while its opener is still held.
  it("a popup follows an opener that is decided after the popup's own hold ran out", async () => {
    const r = rig({ slow: new Set(['H']) });
    r.listen('S');
    const settle = r.dispatcher.beginCreate();
    const h = r.page('H');
    r.dispatcher.adopt(h);
    const c = r.page('C', 'H');
    r.dispatcher.adopt(c);
    await r.clock.advance(ATTRIBUTION_HOLD_MS / 2);
    r.release('H');
    await flush();
    // C's hold ends at 2 000 ms, H's (placed at 1 000 ms) at 3 000 ms: at 2 000 ms H is undecided.
    await r.clock.advance(ATTRIBUTION_HOLD_MS / 2);
    await flush();
    expect(r.dispatcher.ownerOf(c)).toBeUndefined();
    r.dispatcher.claim('H', sessionOwner('S'));
    settle();
    expect(r.dispatcher.ownerOf(h)).toEqual(sessionOwner('S'));
    expect(r.dispatcher.ownerOf(c)).toEqual(sessionOwner('S'));
  });

  it('two pages naming each other as opener are parked after two holds, never held forever', async () => {
    const r = rig();
    const settle = r.dispatcher.beginCreate();
    const a = r.page('a', 'b');
    const b = r.page('b', 'a');
    r.dispatcher.adopt(a);
    r.dispatcher.adopt(b);
    settle();
    expect(r.dispatcher.ownerOf(a)).toBeUndefined();
    await r.clock.advance(ATTRIBUTION_HOLD_MS);
    await flush();
    await r.clock.advance(ATTRIBUTION_HOLD_MS);
    await flush();
    expect(r.dispatcher.ownerOf(a)).toEqual(PARKED);
    expect(r.dispatcher.ownerOf(b)).toEqual(PARKED);
  });

  // Review of PR #74, F6: a facts read that never answers.
  it('a facts read that never settles parks the page at its deadline and ignores the late answer', async () => {
    const r = rig({ slow: new Set(['late']) });
    r.listen('S');
    r.dispatcher.claim('late', sessionOwner('S'));
    const page = r.page('late');
    r.dispatcher.adopt(page);
    await r.clock.advance(ATTRIBUTION_HOLD_MS);
    await flush();
    expect(r.dispatcher.ownerOf(page)).toEqual(PARKED);
    r.release('late');
    await flush();
    expect(r.dispatcher.ownerOf(page)).toEqual(PARKED);
    expect(r.delivered.get('S')).toEqual([]);
  });

  it('an unsubscribed listener set is dropped', () => {
    const r = rig({ fallback: sessionOwner('S') });
    const seen: Page[] = [];
    const off = r.dispatcher.onAttributed('S', (page) => seen.push(page));
    off();
    r.dispatcher.adopt(r.page('p'));
    expect(seen).toEqual([]);
  });
});
