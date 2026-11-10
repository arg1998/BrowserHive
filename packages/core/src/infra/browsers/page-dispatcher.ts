/** @module infra/browsers/page-dispatcher — one per host: feeds every page of the context through `PageAttribution` and delivers it to its session's view before any `TabRegistry` sees it (spec 13 §3.4). */

import type { Page } from 'playwright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import {
  PageAttribution,
  type PageOwner,
  sameOwner,
  sessionOwner,
  type TargetFacts,
} from './page-attribution.ts';

/** How long an undecided page waits for a pending `createTarget` response (spec 13 §3.4 rule 3). */
export const ATTRIBUTION_HOLD_MS = 2_000;

/**
 * Reads a new page's target facts. Synchronous facts keep delivery in the `page` event's own turn;
 * a template host reads `Target.getTargetInfo` over the page's CDP session (PR T1a).
 */
export type TargetFactsReader = (page: Page) => TargetFacts | Promise<TargetFacts>;

/** Constructor options of {@link HostPageDispatcher}. */
export interface HostPageDispatcherOptions {
  /** Owner of an unclaimed page without a known opener: the session (exclusive) or parked (template). */
  readonly fallback: PageOwner;
  /** Absent: every page gets a fresh id with no opener (an exclusive host needs neither). */
  readonly factsOf?: TargetFactsReader;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly holdMs?: number;
  readonly tombstoneLimit?: number;
}

interface HeldPage {
  readonly page: Page;
  readonly facts: TargetFacts;
  readonly timer: AbortController;
  expired: boolean;
}

/**
 * Attributes every page of one host. The host feeds it the context's `page` events (and the pages
 * present at start); the dispatcher decides each one with {@link PageAttribution}, records it, and
 * only then calls the listeners of the owning session, so a page enters a `TabRegistry` only after
 * it is attributed. Parked pages reach no session.
 */
export class HostPageDispatcher {
  private readonly attribution: PageAttribution;
  private readonly factsOf: TargetFactsReader | undefined;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly holdMs: number;
  /** Every page ever seen → its target id (closed pages stay, for `everOwnedBy`). */
  private readonly targets = new WeakMap<Page, string>();
  /** Open, attributed pages in attribution order. */
  private readonly open = new Map<Page, PageOwner>();
  private readonly held: HeldPage[] = [];
  private readonly listeners = new Map<string, Set<(page: Page) => void>>();
  private nextSynthetic = 0;
  /** Pages whose facts are still being read: a named opener may be one of them. */
  private factsInFlight = 0;
  private disposed = false;

  constructor(options: HostPageDispatcherOptions) {
    this.attribution = new PageAttribution({
      fallback: options.fallback,
      ...(options.tombstoneLimit !== undefined && { tombstoneLimit: options.tombstoneLimit }),
    });
    this.factsOf = options.factsOf;
    this.clock = options.clock;
    this.logger = options.logger.child({ module: 'browsers.attribution' });
    this.holdMs = options.holdMs ?? ATTRIBUTION_HOLD_MS;
  }

  /** Feeds one page (a context `page` event, or a page present at host start). Idempotent. */
  adopt(page: Page): void {
    if (this.disposed || this.targets.has(page)) return;
    const reader = this.factsOf;
    if (reader === undefined) {
      this.place(page, { targetId: `page-${(this.nextSynthetic++).toString(36)}`, openerId: null });
      return;
    }
    let facts: TargetFacts | Promise<TargetFacts>;
    try {
      facts = reader(page);
    } catch (err) {
      this.unreadable(page, err);
      return;
    }
    if (!(facts instanceof Promise)) {
      this.place(page, facts);
      return;
    }
    this.factsInFlight += 1;
    // Each arrival re-decides held pages too: one may have waited for this opener.
    facts.then(
      (read) => {
        this.factsInFlight -= 1;
        this.place(page, read);
        this.reevaluate();
      },
      (err: unknown) => {
        this.factsInFlight -= 1;
        this.unreadable(page, err);
        this.reevaluate();
      },
    );
  }

  /**
   * Claims `targetId` for `owner` (a page the host is creating for it). Returns `false` when the
   * target was already attributed elsewhere; the caller then closes it.
   */
  claim(targetId: string, owner: PageOwner): boolean {
    const accepted = this.attribution.claim(targetId, owner);
    this.reevaluate();
    return accepted;
  }

  /** Marks a `createTarget` in flight; call the returned function once it answered or failed. */
  beginCreate(): () => void {
    this.attribution.beginCreate();
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.attribution.endCreate();
      this.reevaluate();
    };
  }

  /** The owner of an open page, or `undefined` (unknown, held or closed). */
  ownerOf(page: Page): PageOwner | undefined {
    return this.open.get(page);
  }

  /** True when `page` is or was attributed to `sessionId`, open or closed. */
  everOwnedBy(page: Page, sessionId: string): boolean {
    const targetId = this.targets.get(page);
    if (targetId === undefined) return false;
    const owner = this.attribution.ownerOf(targetId);
    return owner !== undefined && sameOwner(owner, sessionOwner(sessionId));
  }

  /** Open pages attributed to `sessionId`, in attribution order. */
  pagesOf(sessionId: string): readonly Page[] {
    const owner = sessionOwner(sessionId);
    const pages: Page[] = [];
    for (const [page, attributed] of this.open) if (sameOwner(attributed, owner)) pages.push(page);
    return pages;
  }

  /** Open parked pages, oldest first. */
  parkedPages(): readonly Page[] {
    const pages: Page[] = [];
    for (const [page, owner] of this.open) if (owner.kind === 'parked') pages.push(page);
    return pages;
  }

  /** Calls `listener` for every page attributed to `sessionId` from now on. Returns an unsubscribe. */
  onAttributed(sessionId: string, listener: (page: Page) => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<(page: Page) => void>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
    };
  }

  /** Forgets a closed session's listeners and pending claims; its tombstones stay. */
  releaseSession(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.attribution.releaseSession(sessionId);
  }

  /** Stops every hold timer and ignores later pages (host teardown). */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.held.splice(0)) entry.timer.abort();
    this.listeners.clear();
  }

  private place(page: Page, facts: TargetFacts): void {
    if (this.disposed || this.targets.has(page)) return;
    this.targets.set(page, facts.targetId);
    page.once('close', () => this.closed(page));
    if (page.isClosed()) {
      this.closed(page);
      return;
    }
    const decision = this.attribution.decide(facts, this.decideOptions(false));
    if (decision.kind === 'attributed') {
      this.commit(page, facts.targetId, decision.owner);
      this.reevaluate();
      return;
    }
    this.attribution.hold(facts.targetId);
    const entry: HeldPage = { page, facts, timer: new AbortController(), expired: false };
    this.held.push(entry);
    this.clock.sleep(this.holdMs, entry.timer.signal).then(
      () => {
        entry.expired = true;
        this.reevaluate();
      },
      () => undefined,
    );
  }

  /** A page whose facts cannot be read gets a fresh id and no opener: never a session's by opener. */
  private unreadable(page: Page, err: unknown): void {
    this.logger.debug('target facts unreadable', { err: serializeError(err) });
    this.place(page, { targetId: `page-${(this.nextSynthetic++).toString(36)}`, openerId: null });
  }

  /** Re-decides held pages, oldest first, until nothing changes (one decision can free another). */
  private reevaluate(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const entry of [...this.held]) {
        const decision = this.attribution.decide(entry.facts, this.decideOptions(entry.expired));
        if (decision.kind === 'held') continue;
        this.held.splice(this.held.indexOf(entry), 1);
        entry.timer.abort();
        this.commit(entry.page, entry.facts.targetId, decision.owner);
        progressed = true;
      }
    }
  }

  private decideOptions(final: boolean): { final: boolean; openerPending: boolean } {
    return { final, openerPending: this.factsInFlight > 0 };
  }

  private commit(page: Page, targetId: string, owner: PageOwner): void {
    const inForce = this.attribution.commit(targetId, owner);
    this.open.set(page, inForce);
    if (inForce.kind !== 'session') return;
    for (const listener of [...(this.listeners.get(inForce.sessionId) ?? [])]) {
      try {
        listener(page);
      } catch (err) {
        this.logger.error('page listener threw', { err: serializeError(err) });
      }
    }
  }

  private closed(page: Page): void {
    const targetId = this.targets.get(page);
    if (targetId === undefined) return;
    const index = this.held.findIndex((entry) => entry.page === page);
    if (index >= 0) this.held.splice(index, 1)[0]?.timer.abort();
    this.open.delete(page);
    this.attribution.close(targetId);
    this.reevaluate();
  }
}
