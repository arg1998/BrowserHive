/** @module contracts/enums/otel-signal — OtelSignal enum: Telemetry signals that can be exported (config key `otelSignals`, spec 10 §8). */

import { z } from 'zod';

/**
 * Telemetry signals that can be exported (config key `otelSignals`, spec 10 §8).
 */
export const OtelSignal = z.enum(['traces', 'metrics', 'logs']);
/** Union of {@link OtelSignal} members. */
export type OtelSignal = z.infer<typeof OtelSignal>;
