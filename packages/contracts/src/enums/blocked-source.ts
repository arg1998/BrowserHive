/** @module contracts/enums/blocked-source — BlockedSource enum: Which enforcement layer blocked a URL (D-22 dual enforcement): the tool-level check or the network route. */

import { z } from 'zod';

/**
 * Which enforcement layer blocked a URL (D-22 dual enforcement): the tool-level check or the network route.
 */
export const BlockedSource = z.enum(['tool', 'request']);
/** Union of {@link BlockedSource} members. */
export type BlockedSource = z.infer<typeof BlockedSource>;
