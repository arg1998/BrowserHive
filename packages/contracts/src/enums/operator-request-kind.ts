/** @module contracts/enums/operator-request-kind — OperatorRequestKind enum: Kind of an operator request handled by the one broker (D-15). */

import { z } from 'zod';

/**
 * Kind of an operator request handled by the one broker (D-15). `security_intercept` (schema v10, spec 13 §9.5): a site check or a write approval raised by a site pack.
 */
export const OperatorRequestKind = z.enum(['attention', 'vault_confirm', 'security_intercept']);
/** Union of {@link OperatorRequestKind} members. */
export type OperatorRequestKind = z.infer<typeof OperatorRequestKind>;
