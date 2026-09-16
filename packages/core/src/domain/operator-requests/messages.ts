/** @module domain/operator-requests/messages — the agent-facing outcome messages; byte-stable because agents may match on them. */

import type { ClosedReason } from '../../ports/persistence/enums.ts';

/** Message when a request times out. */
export const TIMEOUT_MESSAGE =
  'Attention request timed out; the operator was not available to respond.';

/** Message when the client disconnects or sends `notifications/cancelled`. */
export const CANCELLED_MESSAGE = 'Client cancelled the attention request.';

/** Message stamped on pending rows found at startup and on pending rows read without a waiter. */
export const RESTART_MESSAGE = 'Attention request was lost when the server restarted.';

/** Message for a request id nobody owns (also used for another principal's request). */
export function unknownRequestMessage(requestId: string): string {
  return `Unknown attention request '${requestId}'.`;
}

/** Per-close-reason rejection messages; stable texts, one per `ClosedReason`. */
export const SESSION_CLOSE_MESSAGE: Readonly<Record<ClosedReason, string>> = {
  user: 'Session was closed while the attention request was open (session_closed).',
  operator:
    'Session was closed by an operator while the attention request was open (session_closed).',
  crash: 'Session crashed while the attention request was open (session_dead).',
  lease_expired: 'Session lease expired while the attention request was open.',
  shutdown: 'Server is shutting down; attention request rejected (server_shutdown).',
  interrupted: 'Session was interrupted by a server restart while the attention request was open.',
  launch_failed: 'Session failed to launch while the attention request was open (session_dead).',
};
