/** @module contracts/enums/log-color — LogColor enum: Colour policy for logs and CLI output (config key `color`). */

import { z } from 'zod';

/**
 * Colour policy for logs and CLI output (config key `color`). `auto` honours `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb` and TTY detection.
 */
export const LogColor = z.enum(['auto', 'always', 'never']);
/** Union of {@link LogColor} members. */
export type LogColor = z.infer<typeof LogColor>;
