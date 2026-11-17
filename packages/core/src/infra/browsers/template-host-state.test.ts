/** @module infra/browsers/template-host-state.test — `pageHeaps` over fakes (review #79 L-7): at most 8 reads at once, an overall deadline after which unread pages are skipped, maintenance pages and unattributed pages left out. */

import { describe, expect, it } from 'bun:test';
import type { BrowserContext, Page } from 'patchright';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import type { HostPageDispatcher } from './page-dispatcher.ts';
import type { ViewPages } from './template-host-ops.ts';
import { HEAP_READ_CONCURRENCY, HEAP_READS_DEADLINE_MS, pageHeaps } from './template-host-state.ts';

interface FakePage {
  readonly id: string;
  /** Heap in bytes, and how long the read takes. */
  readonly heap: number;
  readonly delayMs: number;
}

/** A context whose CDP sessions answer `Performance.getMetrics` with each page's heap. */
function fakeContext(): { context: BrowserContext; peak: () => number } {
  let inFlight = 0;
  let peak = 0;
  const context = {
    newCDPSession: async (page: FakePage) => ({
      send: async (method: string) => {
        if (method !== 'Performance.getMetrics') return {};
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, page.delayMs));
        inFlight -= 1;
        return { metrics: [{ name: 'JSHeapTotalSize', value: page.heap + 0.4 }] };
      },
      detach: async () => undefined,
    }),
  };
  return { context: context as unknown as BrowserContext, peak: () => peak };
}

const dispatcher = {
  targetIdOf: (page: Page) => (page as unknown as FakePage).id || undefined,
} as unknown as HostPageDispatcher;

function view(sessionId: string, pages: FakePage[], maintenance = false): ViewPages {
  return { sessionId, maintenance, pages: () => pages as unknown as Page[] };
}

function pagesOf(prefix: string, count: number, delayMs: number): FakePage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    heap: 1000 + i,
    delayMs,
  }));
}

describe('pageHeaps', () => {
  it('reads every agent page, 8 at a time, keeping session and target', async () => {
    expect(HEAP_READ_CONCURRENCY).toBe(8);
    expect(HEAP_READS_DEADLINE_MS).toBe(10_000);
    const { context, peak } = fakeContext();
    const views = [
      view('alpha', pagesOf('A', 20, 5)),
      view('bravo', pagesOf('B', 20, 5)),
      view('maint', pagesOf('M', 3, 5), true),
      view('nobody', [{ id: '', heap: 1, delayMs: 0 }]),
    ];
    const heaps = await pageHeaps(context, dispatcher, views, new CollectingLogger());
    expect(heaps).toHaveLength(40);
    expect(peak()).toBe(8);
    expect(heaps[0]).toEqual({ sessionId: 'alpha', targetId: 'A0', jsHeapTotalBytes: 1000 });
    expect(heaps[39]).toEqual({ sessionId: 'bravo', targetId: 'B19', jsHeapTotalBytes: 1019 });
    expect(heaps.some((h) => h.sessionId === 'maint' || h.sessionId === 'nobody')).toBe(false);
  });

  it('stops at the overall deadline: pages not read by then are skipped', async () => {
    const { context } = fakeContext();
    const fast = pagesOf('F', 2, 0);
    const slow = pagesOf('S', 4, 300);
    const log = new CollectingLogger();
    const started = performance.now();
    const heaps = await pageHeaps(context, dispatcher, [view('alpha', [...fast, ...slow])], log, {
      concurrency: 2,
      deadlineMs: 60,
    });
    expect(performance.now() - started).toBeLessThan(250);
    expect(heaps.map((h) => h.targetId)).toEqual(['F0', 'F1']);
  });
});
