/** @module contracts/enums/notification-action-outcome — NotificationActionOutcome enum: How an act-button press ended (D-41); one audit row per press of a known token. */

import { z } from 'zod';

/**
 * How an act-button press ended (D-41): `done` ran the command; `failed` ran it and it failed;
 * the others refused it before running anything.
 */
export const NotificationActionOutcome = z.enum([
  'done',
  'failed',
  'not_allowed',
  'used',
  'expired',
  'stale',
  'wrong_channel',
  'disabled',
]);
/** Union of {@link NotificationActionOutcome} members. */
export type NotificationActionOutcome = z.infer<typeof NotificationActionOutcome>;
