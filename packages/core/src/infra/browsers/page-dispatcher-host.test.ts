/** @module infra/browsers/page-dispatcher-host.test — the template-host additions to the dispatcher: targets that close before any page of them is read (browser-level discovery), pages of released sessions, and the commit hook. */

import { describe, expect, it } from 'bun:test';
import type { Page } from 'playwright';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { asPage, FakePage } from '../../../test/helpers/fake-page.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import { PARKED, type PageOwner, sessionOwner, type TargetFacts } from './page-attribution.ts';
import { ATTRIBUTION_HOLD_MS, HostPageDispatcher } from './page-dispatcher.ts';

function rig() {
  const clock = new FakeClock();
  const facts = new Map<Page, TargetFacts>();
  const committed: Array<{ owner: PageOwner; targetId: string }> = [];
  const released: Page[] = [];
  const dispatcher = new HostPageDispatcher({
    fallback: PARKED,
    clock,
    logger: createCollectingLogger(),
    factsOf: (page) => {
      const read = facts.get(page);
      if (read === undefined) throw new Error('no facts');
      return read;
    },
    onCommitted: (_page, owner, read) => committed.push({ owner, targetId: read.targetId }),
    onReleased: (page) => released.push(page),
  });
  const page = (targetId: string, openerId: string | null = null): Page => {
    const created = asPage(new FakePage());
    facts.set(created, { targetId, openerId });
    return created;
  };
  return { clock, dispatcher, page, committed, released };
}

describe('HostPageDispatcher on a template host', () => {
  it('a target that closed before its page was read still passes its owner to its child', () => {
    const { dispatcher, page } = rig();
    dispatcher.claim('S1', sessionOwner('s'));
    dispatcher.adopt(page('S1'));
    // P (opened by S1) closed before any page of it was read: discovery reports it.
    dispatcher.adoptClosedTarget({ targetId: 'P', openerId: 'S1' });
    const child = page('Q', 'P');
    dispatcher.adopt(child);
    expect(dispatcher.ownerOf(child)).toEqual(sessionOwner('s'));
    expect(dispatcher.knows('P')).toBe(true);
  });

  it('a closed target waits for its held opener, like a page would', async () => {
    const { dispatcher, page, clock } = rig();
    const settle = dispatcher.beginCreate();
    const window = page('W');
    dispatcher.adopt(window);
    dispatcher.adoptClosedTarget({ targetId: 'P', openerId: 'W' });
    expect(dispatcher.knows('P')).toBe(true);
    dispatcher.claim('W', sessionOwner('s'));
    settle();
    const child = page('Q', 'P');
    dispatcher.adopt(child);
    expect(dispatcher.ownerOf(child)).toEqual(sessionOwner('s'));
    await clock.advance(ATTRIBUTION_HOLD_MS * 3);
    expect(dispatcher.ownerOf(child)).toEqual(sessionOwner('s'));
  });

  it('an already known target is ignored', () => {
    const { dispatcher, page, committed } = rig();
    dispatcher.adopt(page('X'));
    dispatcher.adoptClosedTarget({ targetId: 'X', openerId: null });
    expect(committed.map((c) => c.targetId)).toEqual(['X']);
  });

  it('a page attributed to a released session reaches no listener and goes to onReleased', () => {
    const { dispatcher, page, released } = rig();
    const delivered: Page[] = [];
    dispatcher.claim('S1', sessionOwner('s'));
    dispatcher.adopt(page('S1'));
    dispatcher.onAttributed('s', (p) => delivered.push(p));
    dispatcher.releaseSession('s');
    dispatcher.onAttributed('s', (p) => delivered.push(p));
    const late = page('L', 'S1');
    dispatcher.adopt(late);
    expect(delivered).toEqual([]);
    expect(released).toEqual([late]);
    expect(dispatcher.everOwnedBy(late, 's')).toBe(true);
  });

  it('reports every committed open page, parked ones included, with its facts', () => {
    const { dispatcher, page, committed } = rig();
    dispatcher.adopt(page('A'));
    dispatcher.claim('B', sessionOwner('s'));
    dispatcher.adopt(page('B'));
    expect(committed).toEqual([
      { owner: PARKED, targetId: 'A' },
      { owner: sessionOwner('s'), targetId: 'B' },
    ]);
  });

  it('targetIdOf names the target a page was placed under', () => {
    const { dispatcher, page } = rig();
    const placed = page('T');
    dispatcher.adopt(placed);
    expect(dispatcher.targetIdOf(placed)).toBe('T');
  });
});
