/** @module contracts/common/sensitive — marks wire fields whose values must be redacted before any sink (D-20) */
import type { z } from 'zod';

/** Metadata key set on schemas marked with {@link sensitive}. */
export const SENSITIVE_META_KEY = 'sensitive';

/**
 * Mark a schema as carrying a secret (password, token, cookie value, `Authorization`, OTLP header…).
 * The serialization codec in core (`toWire`) reads the marker and redacts the value before it reaches
 * logs, the database, WS frames, MCP results, problem+json or OTLP.
 *
 * @returns The same schema with `{ sensitive: true }` metadata attached.
 */
export function sensitive<T extends z.ZodType>(schema: T): T {
  return schema.meta({ [SENSITIVE_META_KEY]: true });
}

/**
 * Whether a schema was marked with {@link sensitive}.
 *
 * @returns `true` when the schema carries the sensitive marker.
 */
export function isSensitive(schema: z.ZodType): boolean {
  const meta = schema.meta();
  return meta !== undefined && meta[SENSITIVE_META_KEY] === true;
}
