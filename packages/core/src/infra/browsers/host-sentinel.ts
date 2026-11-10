/** @module infra/browsers/host-sentinel — a template host's sentinel window (spec 13 §1.1, §3.1, §3.2): the parked first window that keeps the browser alive, recreated when closed by hand, and the clock an operator stop is read from. */

import type { BrowserContext, Page } from 'playwright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { HostPageDispatcher } from './page-dispatcher.ts';
import type { HostTargets } from './template-targets.ts';

/** A browser exit this soon after the sentinel was closed by hand is an operator stop (spec 13 §3.2). */
export const OPERATOR_STOP_WINDOW_MS = 10_000;
/**
 * How long a host whose last window was closed by hand may take to exit before it gets a new
 * sentinel anyway (macOS keeps a browser with no window running, PR #76 F15).
 */
export const SENTINEL_GRACE_MS = 2_000;

/** What the keeper needs from its host. */
export interface SentinelHost {
  readonly context: BrowserContext;
  readonly dispatcher: HostPageDispatcher;
  readonly targets: HostTargets;
  readonly headless: boolean;
  readonly clock: Clock;
  readonly log: Logger;
  /** The host is closing or gone: nothing is recreated. */
  closing(): boolean;
  /** Opens a parked background window. */
  openParkedWindow(): Promise<Page>;
  /** The page is the sentinel now: it is not a listed parked page. */
  adopted(page: Page): void;
}

/** The sentinel of one host. */
export class SentinelKeeper {
  page: Page | null = null;
  private closedAt: number | null = null;
  private readonly host: SentinelHost;

  constructor(host: SentinelHost) {
    this.host = host;
  }

  /**
   * Takes the context's open pages at start: the first is the sentinel (parked, minimized when
   * headed), every other one (a restored window) is closed before any session is admitted.
   */
  async adoptStartPages(): Promise<void> {
    const { context, dispatcher } = this.host;
    const [first, ...restored] = context.pages();
    for (const page of context.pages()) dispatcher.adopt(page);
    if (first === undefined) {
      await this.recreate();
    } else {
      this.watch(first);
      if (!this.host.headless) await this.minimize(first);
    }
    await Promise.all(
      restored.map((page) => page.close({ runBeforeUnload: false }).catch(() => undefined)),
    );
  }

  /** True when the browser exited within the operator-stop window after the sentinel closed. */
  operatorStop(at: number): boolean {
    return this.closedAt !== null && at - this.closedAt <= OPERATOR_STOP_WINDOW_MS;
  }

  /**
   * Chromium destroyed a target. The sentinel's means its window was closed in the browser (by
   * hand, or by quitting it): a killed browser reports no target destroyed (spec 13 §3.2).
   */
  targetDestroyed(targetId: string): void {
    const sentinel = this.page;
    const { dispatcher, context, log, clock } = this.host;
    if (this.host.closing() || sentinel === null || dispatcher.targetIdOf(sentinel) !== targetId) {
      return;
    }
    this.page = null;
    this.closedAt = clock.now();
    log.info('sentinel closed by hand');
    // With other pages open the browser lives on: give it a new sentinel at once.
    if (context.pages().some((p) => p !== sentinel)) {
      void this.recreate();
      return;
    }
    // Its last window: Linux and Windows quit the browser now (an operator stop). macOS keeps a
    // browser with no window running; one still up after the grace gets a new sentinel.
    const timer = setTimeout(() => {
      if (!this.host.closing() && this.page === null) void this.recreate();
    }, SENTINEL_GRACE_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  }

  private watch(page: Page): void {
    this.page = page;
    this.host.adopted(page);
  }

  private async recreate(): Promise<void> {
    try {
      this.watch(await this.host.openParkedWindow());
    } catch (err) {
      this.host.log.warn('sentinel not recreated', { err: serializeError(err) });
    }
  }

  private async minimize(page: Page): Promise<void> {
    const { dispatcher, targets } = this.host;
    const targetId = dispatcher.targetIdOf(page) ?? (await targets.factsOf(page)).targetId;
    await targets.minimize(targetId);
  }
}
