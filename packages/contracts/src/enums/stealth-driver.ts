/** @module contracts/enums/stealth-driver — StealthDriver enum: Chromium driver selection for stealth sessions (config key `stealthDriver`). */

import { z } from 'zod';

/**
 * Chromium driver selection for stealth sessions (config key `stealthDriver`). `auto` = Patchright when resolvable, else Playwright (fail-open, logged).
 */
export const StealthDriver = z.enum(['auto', 'patchright', 'playwright']);
/** Union of {@link StealthDriver} members. */
export type StealthDriver = z.infer<typeof StealthDriver>;
