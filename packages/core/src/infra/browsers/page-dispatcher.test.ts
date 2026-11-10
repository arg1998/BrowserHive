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
});
