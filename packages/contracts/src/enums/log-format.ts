/** @module contracts/enums/log-format — LogFormat enum: Log renderer. */

import { z } from 'zod';

/**
 * Log renderer. `auto` = pretty when the log stream is a TTY and transport is not stdio, else JSON lines. The unsupported `--pretty-logs`/`--log-pretty` spellings map to this key.
 */
export const LogFormat = z.enum(['auto', 'json', 'pretty']);
/** Union of {@link LogFormat} members. */
export type LogFormat = z.infer<typeof LogFormat>;
