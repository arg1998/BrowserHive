/** @module app/site-packs/security-intercepts-state — the bookkeeping of open security intercepts (spec 13 §9.3, §9.5): which request holds which session, the per-session bound and the per-template bound counted per session owner, the challenge rate, and the reservations that make every check-then-open atomic (review PR #83 M3, M4). Pure state over a clock reading; no I/O. */

import type { PackGuardKind } from '@browserhive/contracts/site-packs';
import type { SiteHold, SiteHoldReason } from '../../ports/security-intercepts.ts';

/**
 * At most this many security intercepts (write confirmations and site checks) open per template
 * and session owner: one principal's sessions cannot use up the slots of another's (M4).
 */
export const MAX_OPEN_INTERCEPTS_PER_TEMPLATE = 10;
/** At most one new site check per session in this window. */
export const CHALLENGE_SPACING_MS = 5 * 60_000;

/** What an intercept is about (known before its request exists). */
export interface InterceptFacts {
  readonly sessionId: string;
  /** The session's owner principal (the bound is counted per owner). */
  readonly owner: string;
  readonly templateId: string;
  readonly site: string;
  readonly siteTitle: string;
  readonly reason: SiteHoldReason;
  /** Write confirmations: the guard. */
  readonly guard?: { readonly packId: string; readonly id: string; readonly kind: PackGuardKind };
  readonly method?: string | null;
  readonly url?: string;
  readonly tool?: string | null;
}

/** One open intercept, or a reserved one whose request is being opened. */
export interface OpenIntercept extends InterceptFacts {
  /** `null` while reserved. */
  readonly requestId: string | null;
  readonly createdAt: number;
  /** Resolves to the request id once opened, `null` when the open failed. */
  readonly ready: Promise<string | null>;
}

/** A slot taken synchronously before the request is opened. */
export interface Reservation {
  /** The request is open: the slot now holds it. */
  commit(requestId: string, createdAt: number): OpenIntercept;
  /** The open failed: the slot is free again. */
  cancel(): void;
}

interface Entry {
  current: OpenIntercept;
}

/** The open intercepts of every template session. */
export class InterceptBook {
  readonly #entries = new Set<Entry>();
  readonly #write = new Map<string, Entry>();
  readonly #challenge = new Map<string, Entry>();
  /** Sessions held on another session's request (the bound, spec 13 §9.3). */
  readonly #borrowed = new Map<string, Entry>();
  readonly #lastChallengeAt = new Map<string, number>();

  /**
   * The request holding `sessionId`: its write confirmation, its site check, else a borrowed one
   * (always of the same owner: the bound is per owner, so no other principal's request id leaks,
   * review I3). A reserved slot holds nothing yet.
   */
  holdOf(sessionId: string): SiteHold | null {
    const entry =
      this.#write.get(sessionId) ?? this.#challenge.get(sessionId) ?? this.#borrowed.get(sessionId);
    const open = entry?.current;
    if (open === undefined || open.requestId === null) return null;
    return { requestId: open.requestId, site: open.site, reason: open.reason };
  }

  /** The session's write confirmation, open or reserved. */
  writeOf(sessionId: string): OpenIntercept | undefined {
    return this.#write.get(sessionId)?.current;
  }

  /** The session's site check, open or reserved. */
  challengeOf(sessionId: string): OpenIntercept | undefined {
    return this.#challenge.get(sessionId)?.current;
  }

  /** Open write confirmations of one template site (reserved ones not counted). */
  writesOf(templateId: string, site: string): OpenIntercept[] {
    return [...this.#entries]
      .map((e) => e.current)
      .filter(
        (o) =>
          o.requestId !== null &&
          o.templateId === templateId &&
          o.reason === 'write_confirm' &&
          o.site === site,
      );
  }

  /**
   * True when the owner's open and reserved intercepts of the template reached the bound; the
   * session is then held on the owner's newest open request of the template until that settles.
   */
  atBound(templateId: string, owner: string, sessionId: string): boolean {
    const mine = [...this.#entries].filter(
      (e) => e.current.templateId === templateId && e.current.owner === owner,
    );
    if (mine.length < MAX_OPEN_INTERCEPTS_PER_TEMPLATE) return false;
    let newest: Entry | undefined;
    for (const e of mine) {
      if (e.current.requestId === null) continue;
      if (newest === undefined || e.current.createdAt >= newest.current.createdAt) newest = e;
    }
    if (newest !== undefined) this.#borrowed.set(sessionId, newest);
    return true;
  }

  /** A new site check would come too soon after the last one of the session. */
  challengeTooSoon(sessionId: string, now: number): boolean {
    const last = this.#lastChallengeAt.get(sessionId);
    return last !== undefined && now - last < CHALLENGE_SPACING_MS;
  }

  /**
   * Takes the slot of an intercept before its request is opened: the per-session check, the bound
   * and the challenge rate see it at once, so concurrent callers cannot all pass them (M3).
   */
  reserve(facts: InterceptFacts, now: number): Reservation {
    let settle: (id: string | null) => void = () => undefined;
    const ready = new Promise<string | null>((resolve) => {
      settle = resolve;
    });
    const entry: Entry = { current: { ...facts, requestId: null, createdAt: now, ready } };
    this.#entries.add(entry);
    const byReason = facts.reason === 'write_confirm' ? this.#write : this.#challenge;
    byReason.set(facts.sessionId, entry);
    if (facts.reason === 'challenge') this.#lastChallengeAt.set(facts.sessionId, now);
    this.#borrowed.delete(facts.sessionId);
    return {
      commit: (requestId, createdAt) => {
        entry.current = { ...entry.current, requestId, createdAt };
        settle(requestId);
        return entry.current;
      },
      cancel: () => {
        this.#drop(entry);
        settle(null);
      },
    };
  }

  /** Forgets a settled request and every hold on it. */
  remove(requestId: string): void {
    for (const entry of [...this.#entries]) {
      if (entry.current.requestId === requestId) this.#drop(entry);
    }
  }

  /** A closed session: its borrowed hold and challenge rate go; its requests are settled elsewhere. */
  forgetSession(sessionId: string): void {
    this.#borrowed.delete(sessionId);
    this.#lastChallengeAt.delete(sessionId);
  }

  #drop(entry: Entry): void {
    this.#entries.delete(entry);
    for (const map of [this.#write, this.#challenge, this.#borrowed]) {
      for (const [session, held] of [...map]) if (held === entry) map.delete(session);
    }
  }
}
