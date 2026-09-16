/** @module app/sessions/lease-controller — the narrow lease pause/resume contract the operator-request broker uses (D-15). */

import type { PauseReason } from '../../domain/session/state.ts';

/**
 * Pauses and resumes a session's sliding lease while an operator request is open, so waiting on a
 * human never expires the session.
 *
 * Contract:
 * - `pause(sessionId, at)`: `live → paused`, banks the remaining lease time. Idempotent while paused.
 * - `resume(sessionId, at)`: `paused → live`, restores the banked time from `at`. Idempotent while live.
 * - Unknown ids and sessions in any other state (launching, draining, closed, crashed) are a no-op:
 *   the broker settles on `session.closed` events, and a pause that races a close must not throw.
 * - `at` is the caller's clock reading (epoch ms), so broker and lease agree on the instant.
 * - Both publish `session.updated` (state + lease) on a change.
 */
export interface LeaseController {
  pause(sessionId: string, at: number, reason?: PauseReason): void;
  resume(sessionId: string, at: number): void;
}
