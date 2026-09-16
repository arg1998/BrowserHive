/** @module interface/http/define-route — routes-as-data: one descriptor yields the Hono handler, the authorization matrix and the OpenAPI operation (spec 03 §1.2). */

import type { AuthMethod, Scope } from '@browserhive/contracts/enums';
import type { ErrorCode } from '@browserhive/contracts/errors';
import { findEndpoint, type GrantRoute, type HttpMethod } from '@browserhive/contracts/http';
import type { z } from 'zod';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { HttpContext } from './env.ts';
import type { HttpServices } from './services.ts';

/** Zod schemas validating the four request parts. Absent parts are not validated. */
export interface RouteRequest {
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  /** Lower-cased header names → schema (e.g. `{ 'idempotency-key': IdempotencyKey }`). */
  readonly headers?: z.ZodType;
}

type OutputOf<S> = S extends z.ZodType ? z.output<S> : undefined;

/** Typed, validated request parts handed to a handler. */
export interface RouteInput<Req extends RouteRequest> {
  readonly params: OutputOf<Req['params']>;
  readonly query: OutputOf<Req['query']>;
  readonly body: OutputOf<Req['body']>;
  readonly headers: OutputOf<Req['headers']>;
}

/** JSON responses by status code; the handler's `body` is typed against the matching schema. */
export type JsonResponses = Readonly<Record<number, z.ZodType>>;

/** A typed JSON reply: `status` selects the schema `body` must satisfy (a compile error otherwise). */
export type JsonReply<Res extends JsonResponses> = {
  [S in keyof Res & number]: {
    readonly status: S;
    readonly body: z.input<Res[S]>;
    readonly headers?: Readonly<Record<string, string>>;
  };
}[keyof Res & number];

/** A raw `Response` for non-JSON routes (bytes, streams, 204). */
export interface RawReply {
  readonly raw: Response;
}

/** Per-request facts the handler may need beyond the validated input. */
export interface RequestMeta {
  readonly requestId: string;
  /** Server clock at dispatch. */
  readonly now: number;
  /** Client IP after trusted-proxy resolution. */
  readonly ip: string;
  readonly userAgent: string | undefined;
  /** True when the request arrived over TLS via a trusted proxy. */
  readonly secure: boolean;
  readonly url: URL;
  readonly method: string;
  /** Raw request header lookup (case-insensitive). */
  header(name: string): string | undefined;
}

/** Everything a handler receives. */
export interface RouteCall<Req extends RouteRequest> {
  readonly input: RouteInput<Req>;
  /** `null` only on public routes. */
  readonly principal: RequestPrincipal | null;
  readonly services: HttpServices;
  readonly ctx: RequestMeta;
  /** The Hono context; only transport routes (WS upgrade, docs UI) may use it. */
  readonly hono: HttpContext;
}

/** Token-bucket rule for a route; `'service'` means the application service rate-limits itself. */
export type RateLimitRule =
  | { readonly limit: number; readonly windowMs: number; readonly key: 'ip' | 'principal' }
  | 'service';

/** Documentation of a non-JSON success response. */
export interface RawResponseDoc {
  readonly status: number;
  readonly contentType: string;
  readonly description: string;
}

/** Author-facing fields of a route (the manifest supplies method, path, scope and auth). */
export interface RouteSpec<Req extends RouteRequest, Res extends JsonResponses> {
  /** Must exist in `HTTP_ENDPOINTS`; method/path/scope/auth are taken from there. */
  readonly operationId: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly request: Req;
  readonly responses: Res;
  /** Route-specific registry codes documented as problem+json responses. */
  readonly errors?: readonly ErrorCode[];
  /** Non-JSON success responses to document. */
  readonly raw?: readonly RawResponseDoc[];
  /** Overrides the 1 MiB default body limit. */
  readonly bodyLimitBytes?: number;
  /** Overrides the default 600 req/min bucket. */
  readonly rateLimit?: RateLimitRule;
  /** Grant-enabled routes (`?grant=`): which grant route the token must name. */
  readonly grantRoute?: GrantRoute;
  /** Requires `Idempotency-Key` and replays the stored response for 24 h. */
  readonly idempotent?: boolean;
  /** Serialises Argon2 verifications (at most 2 concurrent). */
  readonly loginSemaphore?: boolean;
  readonly deprecated?: boolean;
  /** Mounted by a transport (the WS upgrade), not the dispatcher; still documented and in the matrix. */
  readonly selfMounted?: boolean;
  handler(call: RouteCall<NoInfer<Req>>): Promise<NoInfer<JsonReply<Res>> | RawReply>;
}

/** Manifest facts of a route (from `HTTP_ENDPOINTS`). */
export interface RouteManifest {
  readonly method: HttpMethod;
  /** OpenAPI-style path relative to `/api/v1` (`/sessions/{session_id}`). */
  readonly path: string;
  readonly scope: Scope | null;
  /** Accepted providers; empty = public. */
  readonly auth: readonly AuthMethod[];
}

/** A route with its generics erased (what the dispatcher and the OpenAPI generator consume). */
export interface AnyRoute
  extends Omit<RouteSpec<RouteRequest, JsonResponses>, 'handler'>,
    RouteManifest {
  handler(call: RouteCall<RouteRequest>): Promise<JsonReply<JsonResponses> | RawReply>;
}

/**
 * Declares one route. Method, path, scope and accepted auth methods come from the contracts
 * manifest so the router, the OpenAPI document, the authorization matrix and the dashboard client
 * share one source; an unknown `operationId` fails at module load. The dispatcher validates every
 * request part with the same schemas before `handler` runs, which is what makes the erasure sound.
 */
export function defineRoute<const Req extends RouteRequest, const Res extends JsonResponses>(
  spec: RouteSpec<Req, Res>,
): AnyRoute {
  const endpoint = findEndpoint(spec.operationId);
  if (endpoint === undefined) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'define-route' },
      { message: `operationId ${spec.operationId} is not in HTTP_ENDPOINTS` },
    );
  }
  const { handler, ...rest } = spec;
  return {
    ...rest,
    method: endpoint.method,
    path: endpoint.path,
    scope: endpoint.scope,
    auth: endpoint.auth,
    // The one erasure of the routes-as-data model: the dispatcher parses every part with
    // `spec.request` and every JSON body with `spec.responses`, so the typed views hold at runtime.
    handler: (call) =>
      handler(call as RouteCall<Req>) as Promise<JsonReply<JsonResponses> | RawReply>,
  };
}

/** `/sessions/{session_id}` → `/sessions/:session_id` (Hono syntax). */
export function honoPath(openApiPath: string): string {
  return openApiPath.replace(/\{([a-z_]+)\}/g, ':$1');
}

/** Regex matching concrete request paths of an OpenAPI-style pattern (used for 405 detection). */
export function pathPattern(openApiPath: string): RegExp {
  const escaped = openApiPath.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\?\{[a-z_]+\\?\}/g, '[^/]+')}$`);
}

/** Builds a typed JSON reply (keeps `status` and body literals such as `ok: true` narrow). */
export function reply<const S extends number, const B>(
  status: S,
  body: B,
  headers?: Readonly<Record<string, string>>,
): { readonly status: S; readonly body: B; readonly headers?: Readonly<Record<string, string>> } {
  return headers === undefined ? { status, body } : { status, body, headers };
}

/** Wraps a raw `Response` (bytes, streams, 204). */
export function raw(response: Response): RawReply {
  return { raw: response };
}
