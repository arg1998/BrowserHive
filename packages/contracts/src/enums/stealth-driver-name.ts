/** @module contracts/enums/stealth-driver-name — StealthDriverName enum: The driver actually in use once `stealthDriver=auto` has been resolved; reported by `server_status` and the banner. */

import { z } from 'zod';

/**
 * The driver actually in use once `stealthDriver=auto` has been resolved; reported by `server_status` and the banner.
 */
export const StealthDriverName = z.enum(['patchright', 'playwright']);
/** Union of {@link StealthDriverName} members. */
export type StealthDriverName = z.infer<typeof StealthDriverName>;
