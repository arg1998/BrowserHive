/** @module lib/api/client — `api.<operationId>(input)`: typed calls over the contracts manifest with dev parse / prod safeParse+report (spec 04 §5) */
import { findEndpoint, type HttpEndpoint } from '@browserhive/contracts/http';
import type { z } from 'zod';
import { malformedError } from './errors.ts';
import { type AuthSignals, createHttp, type FetchLike, type HttpTransport } from './http.ts';
import {
  OPERATIONS,
  type OperationId,
  type OpInput,
  type OpOutput,
  type PathParams,
  type QueryParams,
} from './operations.ts';

/** A response the contracts schema rejected in production (sent to the client-error sink). */
export interface WireMismatch {
  readonly operationId: string;
  readonly issues: readonly z.core.$ZodIssue[];
}

/** Client options. All injectable for tests. */
export interface ApiClientOptions {
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
  readonly signals?: Partial<AuthSignals>;
  /** `true` → responses are `.parse()`d and mismatches throw; `false` → `safeParse` + `report`. */
  readonly strict?: boolean;
  readonly report?: (mismatch: WireMismatch) => void;
  readonly timeoutMs?: number;
}

type OpFn<K extends OperationId> =
  Record<never, never> extends OpInput<K>
    ? (input?: OpInput<K>) => Promise<OpOutput<K>>
    : (input: OpInput<K>) => Promise<OpOutput<K>>;

/** The typed client: one method per operation plus `url()` for binary/stream routes. */
export type ApiClient = { readonly [K in OperationId]: OpFn<K> } & {
  /** Absolute URL for any manifest route (screenshots, trace.zip, exports). */
  readonly url: (operationId: string, params?: PathParams, query?: QueryParams) => string;
  /** The underlying transport (for one-off calls such as `HEAD`). */
  readonly transport: HttpTransport;
};

/** Substitute `{param}` placeholders. */
export function buildPath(endpoint: HttpEndpoint, params: PathParams | undefined): string {
  return endpoint.path.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params?.[key];
    if (value === undefined)
      throw new Error(`missing path param ${key} for ${endpoint.operationId}`);
    return encodeURIComponent(String(value));
  });
}

/** Serialise query params: skip empty, arrays as comma lists (contracts `csv()` accepts both). */
export function buildQuery(query: QueryParams | undefined): string {
  if (query === undefined) return '';
  const search = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.map(String).join(','));
      continue;
    }
    search.set(key, String(value));
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : '';
}

/**
 * Validate a wire payload. Strict mode (development) throws on mismatch; lenient mode (production)
 * reports and returns the payload as-is so a schema drift never blanks a page (spec 05 §11).
 */
export function parseWire<T>(
  schema: z.ZodType<T>,
  data: unknown,
  operationId: string,
  options: { readonly strict: boolean; readonly report?: (mismatch: WireMismatch) => void },
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  if (options.strict) throw malformedError(operationId, result.error.issues);
  options.report?.({ operationId, issues: result.error.issues });
  // Lenient mode returns the raw payload: the page keeps rendering and the mismatch is reported.
  return data as T;
}

function readRecord(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Build the typed client. Construct one per app instance (in `AuthProvider`); never a module singleton. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const transport = createHttp({
    ...(options.fetch !== undefined && { fetch: options.fetch }),
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    ...(options.signals !== undefined && { signals: options.signals }),
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  });
  const baseUrl = options.baseUrl ?? '/api/v1';
  const strict = options.strict ?? false;
  const parseOptions = { strict, ...(options.report !== undefined && { report: options.report }) };

  const call = async (operationId: OperationId, input: unknown): Promise<unknown> => {
    const endpoint = findEndpoint(operationId);
    if (endpoint === undefined) throw new Error(`unknown operation ${operationId}`);
    const def = OPERATIONS[operationId];
    const params = readRecord(input, 'params');
    const query = readRecord(input, 'query');
    const body = readRecord(input, 'body');
    const signal = readRecord(input, 'signal');
    const timeoutMs = readRecord(input, 'timeoutMs');
    const idempotencyKey = readRecord(input, 'idempotencyKey');
    const ifMatch = readRecord(input, 'ifMatch');
    const headers: Record<string, string> = {};
    if (typeof idempotencyKey === 'string') headers['Idempotency-Key'] = idempotencyKey;
    if (typeof ifMatch === 'number') headers['If-Match'] = String(ifMatch);
    const result = await transport.request({
      operationId,
      method: endpoint.method,
      path:
        buildPath(endpoint, params as PathParams | undefined) +
        buildQuery(query as QueryParams | undefined),
      ...(body !== undefined && { body }),
      headers,
      ...(signal instanceof AbortSignal && { signal }),
      ...(typeof timeoutMs === 'number' && { timeoutMs }),
    });
    const response: z.ZodType | undefined = 'response' in def ? def.response : undefined;
    if (response === undefined) return undefined;
    return parseWire(response, result.body, operationId, parseOptions);
  };

  const methods = Object.fromEntries(
    (Object.keys(OPERATIONS) as OperationId[]).map((id) => [
      id,
      (input: unknown) => call(id, input),
    ]),
  );
  const url = (operationId: string, params?: PathParams, query?: QueryParams): string => {
    const endpoint = findEndpoint(operationId);
    if (endpoint === undefined) throw new Error(`unknown operation ${operationId}`);
    return `${baseUrl}${buildPath(endpoint, params)}${buildQuery(query)}`;
  };
  // Structural assembly of the typed surface from the manifest keys (not a payload cast).
  return { ...methods, url, transport } as ApiClient;
}
