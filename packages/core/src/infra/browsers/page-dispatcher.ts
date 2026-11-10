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

/**
 * How long an undecided page waits for a pending `createTarget` response (spec 13 §3.4 rule 3);
 * also the deadline of one target-facts read. A page following a held opener waits at most one
 * more hold.
 */
export const ATTRIBUTION_HOLD_MS = 2_000;

/**
 * Reads a new page's target facts. Synchronous facts keep delivery in the `page` event's own turn;
 * a template host reads `Target.getTargetInfo` (PR T1a). A read that fails, or does not settle
 * within the facts deadline, leaves the page with no known target id or opener: it goes to the
 * fallback owner (parked on a template host).
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
  /** Hold length (default {@link ATTRIBUTION_HOLD_MS}). */
  readonly holdMs?: number;
  /** Deadline of one facts read (default {@link ATTRIBUTION_HOLD_MS}). */
  readonly factsTimeoutMs?: number;
  readonly tombstoneLimit?: number;
}

/** How far a held page's own clock has run: `held` → `expired` (one hold) → `final` (two). */
type HoldStage = 'held' | 'expired' | 'final';

interface HeldPage {
  readonly page: Page;
  readonly facts: TargetFacts;
  readonly timer: AbortController;
  stage: HoldStage;
  /** The page closed while held: once decided, it is recorded and tombstoned, never delivered. */
  closed: boolean;
}

/**
 * Attributes every page of one host. The host feeds it the context's `page` events (and the pages
 * present at start); the dispatcher decides each one with {@link PageAttribution}, records it, and
 * only then calls the listeners of the owning session, so a page enters a `TabRegistry` only after
 * it is attributed. Parked pages reach no session.
 *
 * @remarks Listeners run after the dispatcher's own state is consistent (a delivery queue drained
 * once the current decision pass is over), so a listener may call back into the dispatcher
 * (`claim`, a create's settle, a close) without corrupting the held set or being called twice.
 * A page that closes before it is decided keeps waiting for its decision and is then recorded and
 * tombstoned at once, so a page it opened still follows it.
 */
export class HostPageDispatcher {
  private readonly attribution: PageAttribution;
  private readonly factsOf: TargetFactsReader | undefined;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly holdMs: number;
  private readonly factsTimeoutMs: number;
  /** Every page ever placed → its target id (closed pages stay, for `everOwnedBy`). */
  private readonly targets = new WeakMap<Page, string>();
  /** Pages already fed to `adopt`, placed or not (a facts read may still be in flight). */
  private readonly seen = new WeakSet<Page>();
  /** Open, attributed pages in attribution order. */
  private readonly open = new Map<Page, PageOwner>();
  private readonly held: HeldPage[] = [];
  private readonly listeners = new Map<string, Set<(page: Page) => void>>();
  /** Attributed pages waiting for their listeners, in commit order. */
  private readonly deliveries: Array<{ readonly page: Page; readonly sessionId: string }> = [];
  private delivering = false;
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
    this.factsTimeoutMs = options.factsTimeoutMs ?? ATTRIBUTION_HOLD_MS;
  }

  /** Feeds one page (a context `page` event, or a page present at host start). Idempotent. */
  adopt(page: Page): void {
    if (this.disposed || this.seen.has(page)) return;
    this.seen.add(page);
    const reader = this.factsOf;
    if (reader === undefined) {
      this.run(() => this.place(page, this.syntheticFacts()));
      return;
    }
    let facts: TargetFacts | Promise<TargetFacts>;
    try {
      facts = reader(page);
    } catch (err) {
      this.run(() => this.unreadable(page, err));
      return;
    }
    if (!(facts instanceof Promise)) {
      this.run(() => this.place(page, facts));
      return;
    }
    this.awaitFacts(page, facts);
  }

  /**
   * Claims `targetId` for `owner` (a page the host is creating for it). Returns `false` when the
   * target was already attributed elsewhere; the caller then closes it.
   */
  claim(targetId: string, owner: PageOwner): boolean {
    let accepted = false;
    this.run(() => {
      accepted = this.attribution.claim(targetId, owner);
    });
    return accepted;
  }

  /** Marks a `createTarget` in flight; call the returned function once it answered or failed. */
  beginCreate(): () => void {
    this.attribution.beginCreate();
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.run(() => this.attribution.endCreate());
    };
  }

  /** The owner of an open page, or `undefined` (unknown, held or closed). */
  ownerOf(page: Page): PageOwner | undefined {
    return this.open.get(page);
  }

  /** The attribution of `page`, open or closed (tombstoned); `undefined` while it is undecided. */
  attributionOf(page: Page): PageOwner | undefined {
    const targetId = this.targets.get(page);
    return targetId === undefined ? undefined : this.attribution.ownerOf(targetId);
  }

  /** True when `page` is or was attributed to `sessionId`, open or closed. */
  everOwnedBy(page: Page, sessionId: string): boolean {
    const owner = this.attributionOf(page);
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
      // An empty set is dropped, so a long-lived host does not keep one per closed session.
      if (set.size === 0 && this.listeners.get(sessionId) === set) this.listeners.delete(sessionId);
    };
  }

  /** Forgets a closed session's listeners and pending claims; its tombstones stay. */
  releaseSession(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.run(() => this.attribution.releaseSession(sessionId));
  }

  /** Stops every hold timer and ignores later pages (host teardown). */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.held.splice(0)) entry.timer.abort();
    this.deliveries.length = 0;
    this.listeners.clear();
  }

  /** Runs one state change, re-decides held pages, then drains the delivery queue (once, outermost). */
  private run(change: () => void): void {
    change();
    this.reevaluate();
    this.deliver();
  }

  private syntheticFacts(): TargetFacts {
    return { targetId: `page-${(this.nextSynthetic++).toString(36)}`, openerId: null };
  }

  /** Waits for an asynchronous facts read, at most the facts deadline; a late answer is ignored. */
  private awaitFacts(page: Page, facts: Promise<TargetFacts>): void {
    this.factsInFlight += 1;
    const deadline = new AbortController();
    let settled = false;
    const settle = (place: () => void): void => {
      if (settled) return;
      settled = true;
      deadline.abort();
      this.factsInFlight -= 1;
      try {
        this.run(place);
      } catch (err) {
        this.logger.error('page attribution failed', { err: serializeError(err) });
      }
    };
    facts.then(
      (read) => settle(() => this.place(page, read)),
      (err: unknown) => settle(() => this.unreadable(page, err)),
    );
    this.clock.sleep(this.factsTimeoutMs, deadline.signal).then(
      () => settle(() => this.unreadable(page, new Error('target facts read timed out'))),
      (err: unknown) => this.timerStopped(deadline.signal, err),
    );
  }

  private place(page: Page, facts: TargetFacts): void {
    if (this.disposed || this.targets.has(page)) return;
    this.targets.set(page, facts.targetId);
    const isClosed = page.isClosed();
    if (!isClosed) page.once('close', () => this.run(() => this.closed(page)));
    const decision = this.attribution.decide(facts, this.decideOptions('held'));
    if (decision.kind === 'attributed') {
      this.commit(page, facts.targetId, decision.owner, isClosed);
      return;
    }
    this.attribution.hold(facts.targetId);
    const entry: HeldPage = {
      page,
      facts,
      timer: new AbortController(),
      stage: 'held',
      closed: isClosed,
    };
    this.held.push(entry);
    this.startHold(entry);
  }

  /** One hold, then (if still undecided) a second: `expired`, then `final`. */
  private startHold(entry: HeldPage): void {
    const advance = (stage: HoldStage): void => {
      if (!this.held.includes(entry)) return;
      entry.stage = stage;
      this.run(() => undefined);
      if (stage === 'expired' && this.held.includes(entry)) wait('final');
    };
    const wait = (stage: HoldStage): void => {
      this.clock.sleep(this.holdMs, entry.timer.signal).then(
        () => advance(stage),
        (err: unknown) => this.timerStopped(entry.timer.signal, err),
      );
    };
    wait('expired');
  }

  /** A page whose facts cannot be read gets a fresh id and no opener: never a session's by opener. */
  private unreadable(page: Page, err: unknown): void {
    this.logger.debug('target facts unreadable', { err: serializeError(err) });
    this.place(page, this.syntheticFacts());
  }

  /** An aborted timer is expected (decided, closed, disposed); anything else is reported. */
  private timerStopped(signal: AbortSignal, err: unknown): void {
    if (signal.aborted) return;
    this.logger.error('attribution timer failed', { err: serializeError(err) });
  }

  /** Re-decides held pages, oldest first, until nothing changes (one decision can free another). */
  private reevaluate(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const entry of [...this.held]) {
        const index = this.held.indexOf(entry);
        if (index < 0) continue;
        const decision = this.attribution.decide(entry.facts, this.decideOptions(entry.stage));
        if (decision.kind === 'held') continue;
        this.held.splice(index, 1);
        entry.timer.abort();
        this.commit(entry.page, entry.facts.targetId, decision.owner, entry.closed);
        progressed = true;
      }
    }
  }

  private decideOptions(stage: HoldStage): {
    expired: boolean;
    final: boolean;
    openerPending: boolean;
  } {
    return {
      expired: stage !== 'held',
      final: stage === 'final',
      openerPending: this.factsInFlight > 0,
    };
  }

  /** Records the decision; an open page is queued for its session's listeners, a closed one tombstoned. */
  private commit(page: Page, targetId: string, owner: PageOwner, closed: boolean): void {
    const inForce = this.attribution.commit(targetId, owner);
    if (closed) {
      this.attribution.close(targetId);
      return;
    }
    this.open.set(page, inForce);
    if (inForce.kind === 'session') this.deliveries.push({ page, sessionId: inForce.sessionId });
  }

  /** Calls listeners for queued pages; reentrant calls only enqueue, the outermost call drains. */
  private deliver(): void {
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (let next = this.deliveries.shift(); next !== undefined; next = this.deliveries.shift()) {
        const { page, sessionId } = next;
        // A page that closed before its turn is no longer the session's to receive.
        if (!this.open.has(page)) continue;
        for (const listener of [...(this.listeners.get(sessionId) ?? [])]) {
          try {
            listener(page);
          } catch (err) {
            this.logger.error('page listener threw', { err: serializeError(err) });
          }
        }
      }
    } finally {
      this.delivering = false;
    }
  }

  private closed(page: Page): void {
    const targetId = this.targets.get(page);
    if (targetId === undefined) return;
    const entry = this.held.find((held) => held.page === page);
    if (entry !== undefined) {
      // Still undecided: keep waiting, so the decision (and its tombstone) is the same as if open.
      entry.closed = true;
      return;
    }
    this.open.delete(page);
    this.attribution.close(targetId);
  }
}
