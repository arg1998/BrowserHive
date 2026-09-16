/** @module contracts/enums/operator-request-kind — OperatorRequestKind enum: Kind of an operator request handled by the one broker (D-15). */

import { z } from 'zod';

/**
 * Kind of an operator request handled by the one broker (D-15). `security_intercept` is a future value.
 */
export const OperatorRequestKind = z.enum(['attention', 'vault_confirm']);
/** Union of {@link OperatorRequestKind} members. */
export type OperatorRequestKind = z.infer<typeof OperatorRequestKind>;
