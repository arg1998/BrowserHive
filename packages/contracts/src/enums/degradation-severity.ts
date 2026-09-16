/** @module contracts/enums/degradation-severity — DegradationSeverity enum: Severity of a `system_events` degradation row (spec 10 §3); `error` rows also become `system` notifications. */

import { z } from 'zod';

/**
 * Severity of a `system_events` degradation row (spec 10 §3); `error` rows also become `system` notifications.
 */
export const DegradationSeverity = z.enum(['info', 'warn', 'error']);
/** Union of {@link DegradationSeverity} members. */
export type DegradationSeverity = z.infer<typeof DegradationSeverity>;
