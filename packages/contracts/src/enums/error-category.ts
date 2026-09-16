/** @module contracts/enums/error-category — ErrorCategory enum: Error registry category (D-07). */

import { z } from 'zod';

/**
 * Error registry category (D-07). `audit` codes are never thrown (classification results); `warning` codes are `SessionWarning`s (logged and broadcast, never thrown).
 */
export const ErrorCategory = z.enum(['domain', 'boot', 'auth', 'transport', 'audit', 'warning']);
/** Union of {@link ErrorCategory} members. */
export type ErrorCategory = z.infer<typeof ErrorCategory>;
