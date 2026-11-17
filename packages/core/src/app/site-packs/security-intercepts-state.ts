/** @module app/site-packs/security-intercepts-state — the bookkeeping of open security intercepts (spec 13 §9.3, §9.5): which request holds which session, the per-session and per-template bounds, the one-time passes and the challenge rate. Pure state over a clock reading; no I/O. */

import type { PackGuardKind } from '@browserhive/contracts/site-packs';
import type { SiteHold, SiteHoldReason } from '../../ports/security-intercepts.ts';

/** At most this many security intercepts (write confirmations and site checks) open per template. */
export const MAX_OPEN_INTERCEPTS_PER_TEMPLATE = 10;
/** An approval on the tool path grants a one-time pass for the same guard and URL this long. */
export const WRITE_PASS_MS = 10 * 60_000;
/**
 * A tool-path pass that was used grants the network guard one pass for the request guard behind it
 * this long (the click that the approval covered sends its write within it).
 */
export const NETWORK_PASS_MS = 60_000;
/** At most one new site check per session in this window. */
export const CHALLENGE_SPACING_MS = 5 * 60_000;

/** One open intercept. */
export interface OpenIntercept {
  readonly requestId: string;
  readonly sessionId: string;
  readonly templateId: string;
  readonly site: string;
  readonly siteTitle: string;
  readonly reason: SiteHoldReason;
  readonly createdAt: number;
  /** Write confirmations: the guard. */
  readonly guard?: { readonly packId: string; readonly id: string; readonly kind: PackGuardKind };
  readonly method?: string | null;
  readonly url?: string;
  readonly tool?: string | null;
}

/** Who approved the write a pass stands for. */
export interface PassGrant {
  readonly requestId: string;
  readonly decidedBy: string | null;
}

interface Pass extends PassGrant {
  readonly expiresAt: number;
}

/** The open intercepts and passes of every template session. */
export class InterceptBook {
  readonly #open = new Map<string, OpenIntercept>();
  readonly #write = new Map<string, string>();
  readonly #challenge = new Map<string, string>();
  /** Sessions held on another session's request (the per-template bound, spec 13 §9.3). */
  readonly #borrowed = new Map<string, string>();
  readonly #lastChallengeAt = new Map<string, number>();
  readonly #toolPasses = new Map<string, Pass>();
  readonly #networkPasses = new Map<string, Pass>();

  /** The request holding `sessionId`: its write confirmation, its site check, else a borrowed one. */
  holdOf(sessionId: string): SiteHold | null {
    const id =
      this.#write.get(sessionId) ?? this.#challenge.get(sessionId) ?? this.#borrowed.get(sessionId);
    const open = id === undefined ? undefined : this.#open.get(id);
    if (open === undefined) return null;
    return { requestId: open.requestId, site: open.site, reason: open.reason };
  }

  get(requestId: string): OpenIntercept | undefined {
    return this.#open.get(requestId);
  }

  /** The session's open write confirmation. */
  writeOf(sessionId: string): OpenIntercept | undefined {
    const id = this.#write.get(sessionId);
    return id === undefined ? undefined : this.#open.get(id);
  }

  /** The session's open site check. */
  challengeOf(sessionId: string): OpenIntercept | undefined {
    const id = this.#challenge.get(sessionId);
    return id === undefined ? undefined : this.#open.get(id);
  }

  /** Open intercepts of a template. */
  openOf(templateId: string): OpenIntercept[] {
    return [...this.#open.values()].filter((o) => o.templateId === templateId);
  }

  /** Open write confirmations of one template site. */
  writesOf(templateId: string, site: string): OpenIntercept[] {
    return this.openOf(templateId).filter((o) => o.reason === 'write_confirm' && o.site === site);
  }

  /**
   * True when the template is at its bound; the session is then held on the template's newest open
   * request until that settles.
   */
  atBound(templateId: string, sessionId: string): boolean {
    const open = this.openOf(templateId);
    if (open.length < MAX_OPEN_INTERCEPTS_PER_TEMPLATE) return false;
    const newest = open.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
    this.#borrowed.set(sessionId, newest.requestId);
    return true;
  }

  /** A new site check would come too soon after the last one of the session. */
  challengeTooSoon(sessionId: string, now: number): boolean {
    const last = this.#lastChallengeAt.get(sessionId);
    return last !== undefined && now - last < CHALLENGE_SPACING_MS;
  }

  add(intercept: OpenIntercept): void {
    this.#open.set(intercept.requestId, intercept);
    if (intercept.reason === 'write_confirm') {
      this.#write.set(intercept.sessionId, intercept.requestId);
    } else {
      this.#challenge.set(intercept.sessionId, intercept.requestId);
      this.#lastChallengeAt.set(intercept.sessionId, intercept.createdAt);
    }
    this.#borrowed.delete(intercept.sessionId);
  }

  /** Forgets a settled request and every hold on it. */
  remove(requestId: string): OpenIntercept | undefined {
    const open = this.#open.get(requestId);
    if (open === undefined) return undefined;
    this.#open.delete(requestId);
    for (const map of [this.#write, this.#challenge, this.#borrowed]) {
      for (const [session, id] of map) if (id === requestId) map.delete(session);
    }
    return open;
  }

  /** Grants the tool path's one-time pass for (session, guard, URL). */
  grantToolPass(
    sessionId: string,
    guard: string,
    url: string,
    grant: PassGrant,
    now: number,
  ): void {
    this.#prune(now);
    this.#toolPasses.set(passKey(sessionId, guard, url), {
      ...grant,
      expiresAt: now + WRITE_PASS_MS,
    });
  }

  /** Uses the tool path's pass for (session, guard, URL), if any. */
  takeToolPass(sessionId: string, guard: string, url: string, now: number): PassGrant | null {
    return take(this.#toolPasses, passKey(sessionId, guard, url), now);
  }

  /** Grants the network guard one pass for a request-guard rule of the session. */
  grantNetworkPass(sessionId: string, ruleId: string, grant: PassGrant, now: number): void {
    this.#prune(now);
    this.#networkPasses.set(passKey(sessionId, ruleId, ''), {
      ...grant,
      expiresAt: now + NETWORK_PASS_MS,
    });
  }

  /** Uses the network guard's pass for a rule of the session, if any. */
  takeNetworkPass(sessionId: string, ruleId: string, now: number): PassGrant | null {
    return take(this.#networkPasses, passKey(sessionId, ruleId, ''), now);
  }

  /** A closed session: its passes and challenge rate go; open requests are settled by the broker. */
  forgetSession(sessionId: string): void {
    this.#borrowed.delete(sessionId);
    this.#lastChallengeAt.delete(sessionId);
    const prefix = `${sessionId}\u0000`;
    for (const map of [this.#toolPasses, this.#networkPasses]) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    }
  }

  #prune(now: number): void {
    for (const map of [this.#toolPasses, this.#networkPasses]) {
      for (const [key, pass] of map) if (pass.expiresAt <= now) map.delete(key);
    }
  }
}

function passKey(sessionId: string, guard: string, url: string): string {
  return `${sessionId}\u0000${guard}\u0000${url}`;
}

function take(map: Map<string, Pass>, key: string, now: number): PassGrant | null {
  const pass = map.get(key);
  if (pass === undefined) return null;
  map.delete(key);
  if (pass.expiresAt <= now) return null;
  return { requestId: pass.requestId, decidedBy: pass.decidedBy };
}
