/** @module infra/browsers/page-waiters — a template host's waits for pages it caused (a window it created, a tab it opened): resolved when the dispatcher commits a matching page, or `null` at the deadline. */

import type { Page } from 'playwright';
import type { Clock } from '../../ports/clock.ts';
import type { PageOwner, TargetFacts } from './page-attribution.ts';

interface PageWaiter {
  /** The owner the page must be committed to: a session id, or `null` for parked. */
  readonly sessionId: string | null;
  readonly match: (facts: TargetFacts) => boolean;
  readonly resolve: (page: Page | null) => void;
}

/** One pending wait; `cancel` resolves it with `null`. */
export interface PageWait {
  readonly promise: Promise<Page | null>;
  cancel(): void;
}

/** The waits of one host. */
export class PageWaiters {
  private readonly clock: Clock;
  private readonly waiters = new Set<PageWaiter>();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Waits at most `ms` (or until `signal`) for a page committed to `sessionId` whose facts match. */
  wait(
    sessionId: string | null,
    match: (facts: TargetFacts) => boolean,
    ms: number,
    signal?: AbortSignal,
  ): PageWait {
    let waiter: PageWaiter | undefined;
    const timer = new AbortController();
    const promise = new Promise<Page | null>((resolve) => {
      const done = (page: Page | null) => {
        if (waiter !== undefined) this.waiters.delete(waiter);
        timer.abort();
        resolve(page);
      };
      waiter = { sessionId, match, resolve: done };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', () => done(null), { once: true });
      this.clock.sleep(ms, timer.signal).then(
        () => done(null),
        () => undefined,
      );
    });
    return { promise, cancel: () => waiter?.resolve(null) };
  }

  /** A page was committed: the first matching wait takes it. Returns whether one did. */
  committed(page: Page, owner: PageOwner, facts: TargetFacts): boolean {
    const sessionId = owner.kind === 'session' ? owner.sessionId : null;
    for (const waiter of [...this.waiters]) {
      if (waiter.sessionId === sessionId && waiter.match(facts)) {
        waiter.resolve(page);
        return true;
      }
    }
    return false;
  }

  /** Ends every wait with `null` (the host is gone). */
  cancelAll(): void {
    for (const waiter of [...this.waiters]) waiter.resolve(null);
  }
}
