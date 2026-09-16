/** @module contracts/http/common — shared HTTP wire primitives: timestamps, pagination, health, problem+json */
import { z } from 'zod';

export { ProblemDetails } from '../errors/index.ts';

// ------------------------------------------------------------------------------------------------
// Scalars. Wire timestamps are epoch milliseconds as numbers, never strings (D-05).
// ------------------------------------------------------------------------------------------------

/** Epoch milliseconds (integer, ≥ 0). Every `*_at` / `ts` wire field uses this. */
export const EpochMs = z.number().int().nonnegative();
/** Duration in milliseconds (integer, ≥ 0). Every `*_ms` wire field uses this. */
export const DurationMs = z.number().int().nonnegative();
/** Byte count (integer, ≥ 0). Every `*_bytes` wire field uses this. */
export const Bytes = z.number().int().nonnegative();
/** Non-negative integer counter. */
export const Count = z.number().int().nonnegative();
/** Sort direction. */
export const SortDir = z.enum(['asc', 'desc']);
/** Sort direction. */
export type SortDir = z.infer<typeof SortDir>;

/** Default page size (spec 03 §5). */
export const LIMIT_DEFAULT = 50;
/** Maximum page size (spec 03 §5). */
export const LIMIT_MAX = 500;
/** Longest accepted opaque cursor (base64url JSON keyset, spec 03 §5). */
export const CURSOR_MAX_LENGTH = 4096;

/** Opaque keyset cursor: base64url, validated server-side against the resource that minted it. */
export const Cursor = z
  .string()
  .min(1)
  .max(CURSOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'cursor must be base64url');

// ------------------------------------------------------------------------------------------------
// Query-string parsers. Query values arrive as strings (or string arrays for repeated params).
// ------------------------------------------------------------------------------------------------

/** Boolean query flag: `true|false|1|0` (a bare boolean also passes). */
export const QueryBool = z.preprocess((value) => {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
}, z.boolean());
/** Integer query value coerced from its string form. */
export const QueryInt = z.coerce.number().int();
/** Epoch-ms query value coerced from its string form. */
export const QueryEpochMs = z.coerce.number().int().nonnegative();
/** Free-text `q` filter (LIKE with `%`/`_` escaped server-side). */
export const QueryText = z.string().trim().min(1).max(200);

function splitCsv(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  const parts = Array.isArray(value) ? value : [value];
  return parts.flatMap((part) =>
    typeof part === 'string'
      ? part
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [part],
  );
}

/**
 * Multi-value filter: repeated params (`?state=live&state=paused`) or comma lists (`?state=live,paused`)
 * both parse to an array of `item` (spec 03 §5). Empty input → `undefined`.
 */
export function csv<T extends z.ZodType>(item: T) {
  return z.preprocess(splitCsv, z.array(item).min(1).optional());
}

/** `limit` query parameter with bounds; default 50, max 500 unless the resource declares otherwise. */
export function limitQuery(max: number = LIMIT_MAX, fallback: number = LIMIT_DEFAULT) {
  return z.coerce.number().int().min(1).max(max).default(fallback);
}

/**
 * Declare a resource's sort allow-list. Unknown keys fail validation with the offending field
 * (spec 03 §5) — never silently dropped.
 */
export function sortable<const K extends readonly [string, ...string[]]>(keys: K) {
  return z.enum(keys);
}

/** Base list query shared by every collection endpoint (spec 03 §5). */
export const PageQuery = z.strictObject({
  cursor: Cursor.optional(),
  limit: limitQuery(),
  dir: SortDir.default('desc'),
  total: QueryBool.default(false),
});
/** Base list query shared by every collection endpoint. */
export type PageQuery = z.infer<typeof PageQuery>;

/**
 * Build a resource's list query: base paging + a `sort` allow-list (pass `SortKey.default('…')`) +
 * the resource's filters. Unknown query keys are rejected (strict object).
 */
export function listQuery<S extends z.ZodType<string>, F extends z.ZodRawShape>(options: {
  readonly sort: S;
  readonly filters: F;
  readonly limitMax?: number;
  readonly limitDefault?: number;
}) {
  const base =
    options.limitMax !== undefined || options.limitDefault !== undefined
      ? PageQuery.extend({ limit: limitQuery(options.limitMax, options.limitDefault) })
      : PageQuery;
  return base.extend({ sort: options.sort, ...options.filters });
}

// ------------------------------------------------------------------------------------------------
// Collection envelope (spec 03 §5).
// ------------------------------------------------------------------------------------------------

/** One facet value with its count. */
export const Facet = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  count: Count,
});
/** One facet value with its count. */
export type Facet = z.infer<typeof Facet>;

/** Paging block of a collection response. `total` is present only when `?total=true`. */
export const PageInfo = z.object({
  next_cursor: z.string().nullable(),
  prev_cursor: z.string().nullable().optional(),
  limit: z.number().int().positive(),
  total: Count.optional(),
});
/** Paging block of a collection response. */
export type PageInfo = z.infer<typeof PageInfo>;

/** Echo of the filters and sort the server actually applied (defaults included). */
export const AppliedQuery = z.object({
  filters: z.record(z.string(), z.unknown()),
  sort: z.object({ key: z.string(), dir: SortDir }),
});
/** Echo of the filters and sort the server actually applied. */
export type AppliedQuery = z.infer<typeof AppliedQuery>;

/** Response metadata: the server clock at serialization time (clients anchor timers on it). */
export const ResponseMeta = z.object({ now: EpochMs });
/** Response metadata. */
export type ResponseMeta = z.infer<typeof ResponseMeta>;

/**
 * Collection envelope for `item`: `{ data, page, facets?, applied, meta }` (spec 03 §5).
 * Resources with typed facets extend the returned object (`.extend({ facets: ... })`).
 */
export function page<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    page: PageInfo,
    facets: z.record(z.string(), z.array(Facet)).optional(),
    applied: AppliedQuery,
    meta: ResponseMeta,
  });
}
/** Inferred collection envelope for items of type `T`. */
export type Page<T> = z.infer<ReturnType<typeof page<z.ZodType<T>>>>;

/** Half-open time window echoed by windowed endpoints; `null` = unbounded on that side. */
export const TimeWindow = z.object({ since: EpochMs.nullable(), until: EpochMs.nullable() });
/** Half-open time window. */
export type TimeWindow = z.infer<typeof TimeWindow>;

/** Optional `since`/`until` query pair. */
export const windowQuery = {
  since: QueryEpochMs.optional(),
  until: QueryEpochMs.optional(),
} as const;

// ------------------------------------------------------------------------------------------------
// Small shared responses and headers.
// ------------------------------------------------------------------------------------------------

/** `{ ok: true }` acknowledgement. */
export const OkResponse = z.object({ ok: z.literal(true) });
/** `{ ok: true }` acknowledgement. */
export type OkResponse = z.infer<typeof OkResponse>;

/** Per-item error inside a bulk result. */
export const BulkItemError = z.object({ code: z.string(), title: z.string() });
/** Per-item error inside a bulk result. */
export type BulkItemError = z.infer<typeof BulkItemError>;

/** `Idempotency-Key` header value required by bulk endpoints (UUID, 24 h replay window). */
export const IdempotencyKey = z.uuid();
/** `If-Match` header value: the row `version` an update must match (412 `CONFLICT` otherwise). */
export const IfMatchVersion = z.coerce.number().int().positive();

// ------------------------------------------------------------------------------------------------
// Health (spec 03 §4.1, phases from spec 01 §6).
// ------------------------------------------------------------------------------------------------

/** Aggregate readiness; `/health` is 200 only for `ready`. */
export const HealthStatus = z.enum(['starting', 'ready', 'degraded', 'stopping']);
/** Aggregate readiness. */
export type HealthStatus = z.infer<typeof HealthStatus>;

/** Composition-root phase (spec 01 §6) the process is in or last completed. */
export const BootPhase = z.enum([
  'resolve-config',
  'open-storage',
  'build-domain',
  'wire-observers',
  'open-listeners',
  'ready',
  'stopping',
]);
/** Composition-root phase. */
export type BootPhase = z.infer<typeof BootPhase>;

/** State of one readiness check. */
export const HealthCheckState = z.enum(['pending', 'ok', 'degraded', 'failed']);
/** State of one readiness check. */
export type HealthCheckState = z.infer<typeof HealthCheckState>;

/** `GET /health` body (public; 503 unless `status === 'ready'`). */
export const HealthResponse = z.object({
  status: HealthStatus,
  phase: BootPhase,
  version: z.string(),
  uptime_ms: DurationMs,
  checks: z.object({
    db: HealthCheckState,
    browser: HealthCheckState,
    listeners: HealthCheckState,
  }),
});
/** `GET /health` body. */
export type HealthResponse = z.infer<typeof HealthResponse>;
