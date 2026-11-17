/** @module contracts/enums/stealth-driver-name — StealthDriverName enum: the browser driver every session runs on (D-65); reported by `server_status`, session metadata and the banner. */

import { z } from 'zod';

/**
 * The browser driver every session runs on. Patchright is the only driver since 0.3.0 (D-65); the
 * enum stays so outputs that report it keep their shape.
 */
export const StealthDriverName = z.enum(['patchright']);
/** Union of {@link StealthDriverName} members. */
export type StealthDriverName = z.infer<typeof StealthDriverName>;
