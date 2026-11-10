/** @module app/templates/host-memory.test — the memory limit of a template host (spec 13 §3.2): the session with the most heap loses its largest page and is warned, and a host still above the limit five minutes later is drained. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeTemplateHost } from '../../../test/helpers/fake-template-host.ts';
import { HostMemoryGuard, largestConsumer, MEMORY_DRAIN_AFTER_MS } from './host-memory.ts';

const GIB = 1024 ** 3;

function setup() {
  const clock = new FakeClock();
  const warned: { sessionId: string; details: Readonly<Record<string, unknown>> }[] = [];
  const guard = new HostMemoryGuard({
    limitBytes: 3 * GIB,
    clock,
    logger: new CollectingLogger(),
    warn: (sessionId, details) => void warned.push({ sessionId, details }),
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
    expect(warned.map((w) => w.sessionId)).toEqual(['alpha-aaaaaaaa']);
    expect(warned[0]?.details).toMatchObject({ rss_bytes: 4 * GIB, limit_bytes: 3 * GIB });
    await clock.advance(60_000);
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
});
