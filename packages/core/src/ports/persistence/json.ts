/** @module ports/persistence/json — JSON value aliases used by every record family. */

/** A JSON object as stored in a `*_json` column (already parsed, never re-validated by callers). */
export type JsonObject = Readonly<Record<string, unknown>>;

/** Any JSON value (idempotency responses, preference values). */
export type JsonValue = unknown;
