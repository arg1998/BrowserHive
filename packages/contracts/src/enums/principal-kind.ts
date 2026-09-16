/** @module contracts/enums/principal-kind — PrincipalKind enum: Kind of an authenticated principal (D-09). */

import { z } from 'zod';

/**
 * Kind of an authenticated principal (D-09).
 */
export const PrincipalKind = z.enum(['operator', 'agent', 'service']);
/** Union of {@link PrincipalKind} members. */
export type PrincipalKind = z.infer<typeof PrincipalKind>;
