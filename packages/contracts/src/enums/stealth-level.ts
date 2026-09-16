/** @module contracts/enums/stealth-level — StealthLevel enum: Stealth umbrella level. */

import { z } from 'zod';

/**
 * Stealth umbrella level. `max` only differs from `standard` by defaulting `fingerprint` to true.
 */
export const StealthLevel = z.enum(['off', 'standard', 'max']);
/** Union of {@link StealthLevel} members. */
export type StealthLevel = z.infer<typeof StealthLevel>;
