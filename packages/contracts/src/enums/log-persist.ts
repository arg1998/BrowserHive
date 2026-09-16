/** @module contracts/enums/log-persist — LogPersist enum: Durable `logs` table sink threshold (config key `logPersist`, spec 10 §4.3). */

import { z } from 'zod';

/**
 * Durable `logs` table sink threshold (config key `logPersist`, spec 10 §4.3). `off` disables the sink.
 */
export const LogPersist = z.enum(['info', 'warn', 'off']);
/** Union of {@link LogPersist} members. */
export type LogPersist = z.infer<typeof LogPersist>;
