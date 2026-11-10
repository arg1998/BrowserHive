/** @module infra/browsers/page-attribution — the page-attribution decision of spec 13 §3.4 (claim, opener with tombstones, hold, park) as pure state over target ids; no driver, no timers. */

/** Who a page belongs to: one session, or nobody (parked on its host). */
export type PageOwner =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'parked' };

/** What the dispatcher knows about a new page target (CDP `Target.getTargetInfo`). */
export interface TargetFacts {
  readonly targetId: string;
  /** The target that opened this one; CDP sets it for `noopener` popups and `target=_blank` too. */
  readonly openerId: string | null;
}

/** The rule that attributed a page, in decision order (`committed`: it was attributed before). */
export type AttributionRule = 'committed' | 'claim' | 'opener' | 'fallback';

/** Outcome of {@link PageAttribution.decide}. */
export type AttributionDecision =
  | { readonly kind: 'attributed'; readonly owner: PageOwner; readonly rule: AttributionRule }
  | { readonly kind: 'held' };

/** Tombstones kept per host (spec 13 §3.4): enough for OAuth-style opener chains over a host's life. */
export const TOMBSTONE_LIMIT = 10_000;

/** The parked owner (no session). */
export const PARKED: PageOwner = { kind: 'parked' };

/** The owner value for session `sessionId`. */
export function sessionOwner(sessionId: string): PageOwner {
  return { kind: 'session', sessionId };
}

/** True when two owners are the same session, or both parked. */
export function sameOwner(a: PageOwner, b: PageOwner): boolean {
  if (a.kind === 'parked' || b.kind === 'parked') return a.kind === b.kind;
  return a.sessionId === b.sessionId;
}

/** Constructor options of {@link PageAttribution}. */
export interface PageAttributionOptions {
  /**
   * Owner of a page no claim or opener decides. A template host parks it; an exclusive host has
   * exactly one session, which owns every page of its context.
   */
  readonly fallback: PageOwner;
  /** Bound of the closed-target map (default {@link TOMBSTONE_LIMIT}). */
  readonly tombstoneLimit?: number;
}

/**
 * The attribution state of one host. Decisions run in the order of spec 13 §3.4: a pending claim by
 * target id; else the opener's attribution, live or tombstoned; else, while a `createTarget` of the
 * host awaits its response (or the opener itself is still undecided), the page is held; else the
 * fallback owner.
 *
 * @remarks Invariant (D-50): a target is committed at most once, so an attribution never changes;
 * a claim for a target already committed to another owner is refused. The window a page appears
 * in is not an input.
 */
export class PageAttribution {
  private readonly fallback: PageOwner;
  private readonly tombstoneLimit: number;
  private readonly claims = new Map<string, PageOwner>();
  private readonly live = new Map<string, PageOwner>();
  /** Closed targets → owner, insertion-ordered so the oldest is evicted first. */
  private readonly tombstones = new Map<string, PageOwner>();
  /** Targets seen but not yet decided (held). */
  private readonly undecided = new Set<string>();
  private pendingCreates = 0;

  constructor(options: PageAttributionOptions) {
    this.fallback = options.fallback;
    this.tombstoneLimit = Math.max(0, options.tombstoneLimit ?? TOMBSTONE_LIMIT);
  }

  /**
   * Records that `targetId` (created by the host for `owner`) belongs to it. Returns `false` when
   * the target was already attributed to a different owner (the attribution stands).
   */
  claim(targetId: string, owner: PageOwner): boolean {
    const current = this.ownerOf(targetId);
    if (current !== undefined) return sameOwner(current, owner);
    this.claims.set(targetId, owner);
    return true;
  }

  /** A `createTarget` of this host was sent; pages that no rule decides are held until it settles. */
  beginCreate(): void {
    this.pendingCreates += 1;
  }

  /** A `createTarget` of this host answered (or failed). */
  endCreate(): void {
    this.pendingCreates = Math.max(0, this.pendingCreates - 1);
  }

  /** Whether a `createTarget` is still awaiting its response. */
  get creating(): boolean {
    return this.pendingCreates > 0;
  }

  /**
   * Decides a page without recording anything. A named opener that is not known yet holds the page
   * while the opener is itself held, or while `openerPending` says some page's facts are still being
   * read (the opener may be among them). With `expired` (the page's own hold ran out), the page no
   * longer waits for a `createTarget` response or for facts in flight, but it still follows an
   * opener that is held: that opener's own hold bounds the wait, and a page opened by a session's
   * page must not be parked merely because its opener was decided later. A doubt that remains goes
   * to the fallback, so it never hands a page to a session. `final` (a second hold has passed)
   * stops every wait, so even malformed facts (two targets naming each other) cannot hold forever.
   */
  decide(
    facts: TargetFacts,
    options: {
      readonly expired: boolean;
      readonly final?: boolean;
      readonly openerPending?: boolean;
    },
  ): AttributionDecision {
    const committed = this.ownerOf(facts.targetId);
    if (committed !== undefined) return { kind: 'attributed', owner: committed, rule: 'committed' };
    const claimed = this.claims.get(facts.targetId);
    if (claimed !== undefined) return { kind: 'attributed', owner: claimed, rule: 'claim' };
    // A target is never its own opener; such facts are treated as having none.
    if (facts.openerId !== null && facts.openerId !== facts.targetId) {
      const opener = this.ownerOf(facts.openerId);
      if (opener !== undefined) return { kind: 'attributed', owner: opener, rule: 'opener' };
      if (options.final !== true && this.undecided.has(facts.openerId)) return { kind: 'held' };
      if (!options.expired && options.openerPending === true) return { kind: 'held' };
    }
    if (!options.expired && this.pendingCreates > 0) return { kind: 'held' };
    return { kind: 'attributed', owner: this.fallback, rule: 'fallback' };
  }

  /** Marks a target as seen and held. */
  hold(targetId: string): void {
    if (this.ownerOf(targetId) === undefined) this.undecided.add(targetId);
  }

  /**
   * Records the attribution of a live target and consumes its claim. Returns the owner in force:
   * `owner`, or the earlier attribution when the target was already committed.
   */
  commit(targetId: string, owner: PageOwner): PageOwner {
    const current = this.ownerOf(targetId);
    if (current !== undefined) return current;
    this.undecided.delete(targetId);
    this.claims.delete(targetId);
    this.live.set(targetId, owner);
    return owner;
  }

  /** The target closed: its attribution moves to the tombstones (bounded), a pending claim is dropped. */
  close(targetId: string): void {
    this.undecided.delete(targetId);
    this.claims.delete(targetId);
    const owner = this.live.get(targetId);
    if (owner === undefined) return;
    this.live.delete(targetId);
    if (this.tombstoneLimit === 0) return;
    this.tombstones.set(targetId, owner);
    while (this.tombstones.size > this.tombstoneLimit) {
      const oldest = this.tombstones.keys().next();
      if (oldest.done === true) break;
      this.tombstones.delete(oldest.value);
    }
  }

  /** The owner of a live or closed (tombstoned) target, or `undefined` when it was never committed. */
  ownerOf(targetId: string): PageOwner | undefined {
    return this.live.get(targetId) ?? this.tombstones.get(targetId);
  }

  /** Drops the pending claims of a closed session; its tombstones stay (spec 13 §3.5). */
  releaseSession(sessionId: string): void {
    for (const [targetId, owner] of this.claims) {
      if (owner.kind === 'session' && owner.sessionId === sessionId) this.claims.delete(targetId);
    }
  }
}
