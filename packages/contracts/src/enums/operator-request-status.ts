/** @module contracts/enums/operator-request-status — OperatorRequestStatus enum: Operator request lifecycle: `pending` then exactly one terminal state. */

import { z } from 'zod';

/**
 * Operator request lifecycle: `pending` then exactly one terminal state.
 */
export const OperatorRequestStatus = z.enum([
  'pending',
  'resolved',
  'rejected',
  'timeout',
  'cancelled',
]);
/** Union of {@link OperatorRequestStatus} members. */
export type OperatorRequestStatus = z.infer<typeof OperatorRequestStatus>;
