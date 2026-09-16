/** @module contracts/enums/session-status — SessionStatus enum: Session state machine states (D-21): `reserved → launching → live ⇄ paused → draining → closed | crashed`. */

import { z } from 'zod';

/**
 * Session state machine states (D-21): `reserved → launching → live ⇄ paused → draining → closed | crashed`.
 */
export const SessionStatus = z.enum([
  'reserved',
  'launching',
  'live',
  'paused',
  'draining',
  'closed',
  'crashed',
]);
/** Union of {@link SessionStatus} members. */
export type SessionStatus = z.infer<typeof SessionStatus>;
