/** @module contracts/enums/retryable — Retryable enum: Retry guidance attached to every error code (D-07): whether and how an agent may retry. */

import { z } from 'zod';

/**
 * Retry guidance attached to every error code (D-07): whether and how an agent may retry.
 */
export const Retryable = z.enum([
  'never',
  'immediate',
  'backoff',
  'after_operator',
  'different_args',
]);
/** Union of {@link Retryable} members. */
export type Retryable = z.infer<typeof Retryable>;
