/** @module contracts/enums/log-level — LogLevel enum: Log levels, most to least severe. */

import { z } from 'zod';

/**
 * Log levels, most to least severe. `trace` (below `debug`) is new: per-CDP-command payloads, ring-buffer only unless `otelVerbose` is set.
 */
export const LogLevel = z.enum(['error', 'warn', 'info', 'debug', 'trace']);
/** Union of {@link LogLevel} members. */
export type LogLevel = z.infer<typeof LogLevel>;
