/** @module app/sessions/session-counters — keeps each live session's `counts` in step with the same bus events the recorder projects into the database. */

import type { SessionCounter } from '../../domain/session/session.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { DomainEvents } from '../events/catalog.ts';

/** What the projector needs from the session service. */
export interface SessionCounterTarget {
  /** Applies `delta` to one counter of a registered session; unknown ids are ignored. */
  bumpCounter(sessionId: string, counter: SessionCounter, delta: number): void;
}

/**
 * Subscribes the counter projection. The mapping mirrors the stored aggregates of the sessions
 * list view so live and stored counts agree:
 *
 * - `tool.called` → `toolCalls` (+1), `errors` (+1 when `error_code` is set, soft errors included)
 * - `page.visited` → `pages`
 * - `blocklist.hit` → `blocked`
 * - `vault.access` → `vaultAccess`
 * - `attention.created` / `attention.resolved` → `attentionOpen` (+1 / −1; vault confirms excluded)
 *
 * @returns The unsubscribe function.
 */
export function subscribeSessionCounters(
  bus: EventBus<DomainEvents>,
  target: SessionCounterTarget,
): () => void {
  const unsubscribes = [
    bus.subscribe('tool.called', ({ payload }) => {
      const sessionId = payload.row.session_id;
      if (sessionId === null) return;
      target.bumpCounter(sessionId, 'toolCalls', 1);
      if (payload.row.error_code !== null) target.bumpCounter(sessionId, 'errors', 1);
    }),
    bus.subscribe('page.visited', ({ payload }) => {
      target.bumpCounter(payload.row.session_id, 'pages', 1);
    }),
    bus.subscribe('blocklist.hit', ({ payload }) => {
      if (payload.row.session_id !== null) target.bumpCounter(payload.row.session_id, 'blocked', 1);
    }),
    bus.subscribe('vault.access', ({ payload }) => {
      target.bumpCounter(payload.row.session_id, 'vaultAccess', 1);
    }),
    bus.subscribe('attention.created', ({ payload }) => {
      target.bumpCounter(payload.request.session_id, 'attentionOpen', 1);
    }),
    bus.subscribe('attention.resolved', ({ payload }) => {
      target.bumpCounter(payload.request.session_id, 'attentionOpen', -1);
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
