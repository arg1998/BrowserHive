/** @module app/sessions/registry — the in-memory live-session registry with a short promise-chain lock. */

import type { Session } from '../../domain/session/session.ts';
import { canServeTools } from '../../domain/session/state.ts';
import { AppError } from '../../kernel/errors/app-error.ts';

/**
 * Every session that occupies capacity, keyed by id: reserved, launching, live, paused and draining
 * ones. Closed/crashed sessions leave the registry when their close settles.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private chain: Promise<void> = Promise.resolve();

  /**
   * Runs `fn` under the registry lock (append-to-tail mutex). Keep critical sections short —
   * capacity check + insert — and never launch inside one (D-21).
   */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.chain;
    let release: () => void = () => undefined;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Inserts a reserved session.
   *
   * @throws `SESSION_ALREADY_EXISTS` on an id collision (registry message text).
   */
  reserve(session: Session): void {
    if (this.sessions.has(session.id)) {
      throw new AppError(
        'SESSION_ALREADY_EXISTS',
        { session_id: session.id },
        {
          publicMessage: `Session '${session.id}' already exists. Slug+nanoid collision is exceptionally rare; the caller should retry.`,
        },
      );
    }
    this.sessions.set(session.id, session);
  }

  /** Removes a session; returns it when it was present. Idempotent. */
  release(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) this.sessions.delete(sessionId);
    return session;
  }

  /** Looks a session up without any side effect. */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** True when `sessionId` occupies capacity. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Sessions occupying capacity (the admission input). */
  get size(): number {
    return this.sessions.size;
  }

  /** Sessions tools may drive (`live` or `paused`). */
  liveCount(): number {
    let n = 0;
    for (const session of this.sessions.values()) if (canServeTools(session.state)) n++;
    return n;
  }

  /** Snapshot in insertion order. */
  values(): readonly Session[] {
    return [...this.sessions.values()];
  }

  /** Snapshot filtered to one owner. */
  ownedBy(owner: string): readonly Session[] {
    return this.values().filter((s) => s.owner === owner);
  }
}
