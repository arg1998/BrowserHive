/** @module domain/operator-requests/support — option serialisation and the bounded-queue error of the broker. */

import { AppError } from '../../kernel/errors/app-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { JsonObject } from '../../ports/persistence/json.ts';
import type { LeaseController, OperatorRequestLimits } from './types.ts';

/** `retry_after_ms` reported when the queue is full. */
export const QUEUE_FULL_RETRY_MS = 5_000;

/** The typed error for a full per-session or global queue (`RATE_LIMITED`, an existing registry code). */
export function queueFullError(
  perSession: number,
  total: number,
  limits: OperatorRequestLimits,
): AppError<'RATE_LIMITED'> {
  return new AppError(
    'RATE_LIMITED',
    { retry_after_ms: QUEUE_FULL_RETRY_MS },
    {
      publicMessage: `Too many open operator requests (session: ${perSession}/${limits.perSession}, total: ${total}/${limits.global}). Wait for an operator to settle one and retry.`,
    },
  );
}

/** Persists `options` verbatim when it is a JSON object; other values are wrapped as `{ value }`. */
export function toJsonObject(value: unknown): JsonObject | null {
  if (value === undefined) return null;
  try {
    const roundTripped: unknown = JSON.parse(JSON.stringify(value) ?? 'null');
    return isJsonObject(roundTripped) ? roundTripped : { value: roundTripped };
  } catch {
    return { value: '[unserializable]' };
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pauses or resumes a session lease; a failing controller is logged, never fatal for the request. */
export function leaseCall(
  leases: LeaseController,
  log: Logger,
  action: 'pause' | 'resume',
  sessionId: string,
  at: number,
): void {
  try {
    if (action === 'pause') leases.pause(sessionId, at);
    else leases.resume(sessionId, at);
  } catch (err) {
    log.warn(action === 'pause' ? 'lease pause failed' : 'lease resume failed', {
      session_id: sessionId,
      err,
    });
  }
}
