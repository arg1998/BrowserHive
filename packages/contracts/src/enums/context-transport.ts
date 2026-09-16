/** @module contracts/enums/context-transport — ContextTransport enum: Entry point that established a request context (spec 10 §5); stamped on every log record as `transport`. */

import { z } from 'zod';

/**
 * Entry point that established a request context (spec 10 §5); stamped on every log record as `transport`.
 */
export const ContextTransport = z.enum(['http', 'stdio', 'ws', 'cli']);
/** Union of {@link ContextTransport} members. */
export type ContextTransport = z.infer<typeof ContextTransport>;
