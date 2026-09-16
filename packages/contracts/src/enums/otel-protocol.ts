/** @module contracts/enums/otel-protocol — OtelProtocol enum: OTLP/HTTP encoding used by the exporters (D-08). */

import { z } from 'zod';

/**
 * OTLP/HTTP encoding used by the exporters (D-08).
 */
export const OtelProtocol = z.enum(['http/protobuf', 'http/json']);
/** Union of {@link OtelProtocol} members. */
export type OtelProtocol = z.infer<typeof OtelProtocol>;
