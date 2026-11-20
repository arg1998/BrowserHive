/** @module app/templates/host-memory.test — the memory limit of a template host (spec 13 §3.2): the session with the most heap loses its largest page and is warned, and a host still above the limit five minutes later is drained. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeTemplateHost } from '../../../test/helpers/fake-template-host.ts';
import {
  HostMemoryGuard,
  largestConsumer,
  MEMORY_BACKSTOP_AFTER_MS,
  MEMORY_DRAIN_AFTER_MS,
  RESOURCE_LIMIT_CLOSED_ALL_MESSAGE,
  RESOURCE_LIMIT_KEPT_MESSAGE,
  RESOURCE_LIMIT_MESSAGE,
  resourceLimitMessage,
  type TrimAction,
} from './host-memory.ts';

const GIB = 1024 ** 3;

function setup() {
  const clock = new FakeClock();
  const warned: {
    sessionId: string;
    details: Readonly<Record<string, unknown>>;
    action: TrimAction;
  }[] = [];
  const guard = new HostMemoryGuard({
    limitBytes: 3 * GIB,
    clock,
    logger: new CollectingLogger(),
    warn: (sessionId, details, action) => void warned.push({ sessionId, details, action }),
  });
  const host = new FakeTemplateHost('tp-aaaaaaaaaa');
  for (const id of ['alpha-aaaaaaaa', 'bravo-bbbbbbbb']) {
    void host.openView(id, { windowState: 'normal' });
  }
  host.heaps = [
    { sessionId: 'alpha-aaaaaaaa', targetId: 'A1', jsHeapTotalBytes: 300 },
    { sessionId: 'alpha-aaaaaaaa', targetId: 'A2', jsHeapTotalBytes: 200 },
    { sessionId: 'bravo-bbbbbbbb', targetId: 'B1', jsHeapTotalBytes: 400 },
  ];
  return { clock, warned, guard, host };
}

describe('host memory limit (spec 13 §3.2)', () => {
  it('ranks sessions by summed heap and picks their largest page', () => {
    const { host } = setup();
    expect(largestConsumer(host.heaps)).toMatchObject({
      sessionId: 'alpha-aaaaaaaa',
      total: 500,
      page: { targetId: 'A1' },
    });
    expect(largestConsumer([])).toBeNull();
  });

  it('below the limit nothing happens', async () => {
    const { guard, host, warned } = setup();
    expect(await guard.check('tp-aaaaaaaaaa', 2 * GIB, host)).toBe('ok');
    expect(host.closedPages).toEqual([]);
    expect(warned).toEqual([]);
  });

  it('above it: trims and warns the largest session first, drains five minutes later', async () => {
    const { guard, host, warned, clock } = setup();
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('trimmed');
    expect(host.closedPages).toEqual([{ targetId: 'A1', scope: 'session' }]);
    expect(warned.map((w) => [w.sessionId, w.action])).toEqual([['alpha-aaaaaaaa', 'background']]);
    expect(warned[0]?.details).toMatchObject({ rss_bytes: 4 * GIB, limit_bytes: 3 * GIB });
    await clock.advance(30_000);
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('waiting');
    await clock.advance(MEMORY_DRAIN_AFTER_MS);
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('drain');
  });

  it('dropping below the limit forgets the trim', async () => {
    const { guard, host, clock } = setup();
    await guard.check('tp-aaaaaaaaaa', 4 * GIB, host);
    expect(await guard.check('tp-aaaaaaaaaa', GIB, host)).toBe('ok');
    await clock.advance(MEMORY_DRAIN_AFTER_MS);
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('trimmed');
  });

  it("never closes a session's active tab: the largest other page goes (workload test B2)", async () => {
    const { guard, host, warned } = setup();
    host.heaps = [
      { sessionId: 'alpha-aaaaaaaa', targetId: 'A1', jsHeapTotalBytes: 300, active: true },
      { sessionId: 'alpha-aaaaaaaa', targetId: 'A2', jsHeapTotalBytes: 200 },
      { sessionId: 'bravo-bbbbbbbb', targetId: 'B1', jsHeapTotalBytes: 400, active: true },
    ];
    expect(largestConsumer(host.heaps)).toMatchObject({
      sessionId: 'alpha-aaaaaaaa',
      page: { targetId: 'A2' },
    });
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('trimmed');
    expect(host.closedPages).toEqual([{ targetId: 'A2', scope: 'session' }]);
    expect(warned.map((w) => [w.sessionId, w.action])).toEqual([['alpha-aaaaaaaa', 'background']]);
  });

  it("never closes a lighter session's tab for the heaviest one (review #88 M1)", async () => {
    const { guard, host, warned } = setup();
    host.heaps = [
      { sessionId: 'alpha-aaaaaaaa', targetId: 'A1', jsHeapTotalBytes: 3 * GIB, active: true },
      { sessionId: 'bravo-bbbbbbbb', targetId: 'B1', jsHeapTotalBytes: 40, active: true },
      { sessionId: 'bravo-bbbbbbbb', targetId: 'B2', jsHeapTotalBytes: 10 },
    ];
    expect(largestConsumer(host.heaps)).toEqual({
      sessionId: 'alpha-aaaaaaaa',
      page: null,
      total: 3 * GIB,
    });
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('trimmed');
    expect(host.closedPages).toEqual([]);
    expect(warned.map((w) => [w.sessionId, w.action])).toEqual([['alpha-aaaaaaaa', 'none']]);
  });

  it('an active-only hog: warned, then its tabs closed a minute later, then the host drains (M2)', async () => {
    const clock = new FakeClock();
    const warned: [string, TrimAction][] = [];
    const closedAll: string[] = [];
    const guard = new HostMemoryGuard({
      limitBytes: 3 * GIB,
      clock,
      logger: new CollectingLogger(),
      warn: (sessionId, _details, action) => void warned.push([sessionId, action]),
      closeAll: async (sessionId) => void closedAll.push(sessionId),
    });
    const host = new FakeTemplateHost('tp-aaaaaaaaaa');
    for (const id of ['alpha-aaaaaaaa', 'bravo-bbbbbbbb']) {
      void host.openView(id, { windowState: 'normal' });
    }
    host.heaps = [
      { sessionId: 'alpha-aaaaaaaa', targetId: 'A1', jsHeapTotalBytes: 3 * GIB, active: true },
      { sessionId: 'bravo-bbbbbbbb', targetId: 'B1', jsHeapTotalBytes: 40, active: true },
    ];
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('trimmed');
    expect(warned).toEqual([['alpha-aaaaaaaa', 'none']]);
    await clock.advance(MEMORY_BACKSTOP_AFTER_MS - 1);
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('waiting');
    await clock.advance(1);
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('trimmed');
    expect(closedAll).toEqual(['alpha-aaaaaaaa']);
    expect(warned.at(-1)).toEqual(['alpha-aaaaaaaa', 'all']);
    // The backstop runs once; the host drains five minutes after the first trim.
    await clock.advance(60_000);
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('waiting');
    await clock.advance(MEMORY_DRAIN_AFTER_MS);
    expect(await guard.check('tp-aaaaaaaaaa', 4 * GIB, host)).toBe('drain');
    expect(closedAll).toEqual(['alpha-aaaaaaaa']);
  });

  it('without closeAll the backstop closes the pages the heap read found', async () => {
    const { guard, host, clock } = setup();
    host.heaps = [
      { sessionId: 'alpha-aaaaaaaa', targetId: 'A1', jsHeapTotalBytes: 900, active: true },
      { sessionId: 'bravo-bbbbbbbb', targetId: 'B1', jsHeapTotalBytes: 100, active: true },
    ];
    await guard.check('tp-aaaaaaaaaa', 4 * GIB, host);
    await clock.advance(MEMORY_BACKSTOP_AFTER_MS);
    await guard.check('tp-aaaaaaaaaa', 4 * GIB, host);
    expect(host.closedPages).toEqual([{ targetId: 'A1', scope: 'session' }]);
  });

  it('the warning text says what was done', () => {
    expect(resourceLimitMessage('background')).toBe(RESOURCE_LIMIT_MESSAGE);
    expect(resourceLimitMessage('none')).toBe(RESOURCE_LIMIT_KEPT_MESSAGE);
    expect(resourceLimitMessage('all')).toBe(RESOURCE_LIMIT_CLOSED_ALL_MESSAGE);
  });
});
