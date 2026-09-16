/** @module interface/http/dispatch — mounts route descriptors on Hono: authenticate → authorize → rate-limit → validate → handler → serialize (spec 03 §1.2, §2). */

import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { z } from 'zod';
import type { Authenticator } from '../../app/auth/authenticate.ts';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import { type AnyRoute, honoPath, type JsonReply, type RawReply } from './define-route.ts';
import type { HttpContext, HttpEnv } from './env.ts';
import { authenticateRoute, authorizeRoute, authViewOf } from './middleware/auth.ts';
import { DEFAULT_BODY_LIMIT_BYTES, readBodyWithin } from './middleware/body-limit.ts';
import {
  DEFAULT_RATE,
  OPERATOR_READ_RATE,
  type RateDecision,
  rateLimited,
  type Semaphore,
  type TokenBuckets,
} from './middleware/rate-limit.ts';
import { type FieldIssue, fieldIssues, validationFailed } from './problem.ts';
import type { HttpServices } from './services.ts';

/** What the dispatcher needs besides the routes. */
export interface DispatchDeps {
  readonly services: HttpServices;
  readonly authenticator: Authenticator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly buckets: TokenBuckets;
  readonly loginSemaphore: Semaphore;
}

/** Mounts every route under `prefix` (`/api/v1`). */
export function mountRoutes(
  app: Hono<HttpEnv>,
  prefix: string,
  routes: readonly AnyRoute[],
  deps: DispatchDeps,
): void {
  for (const route of routes) {
    if (route.selfMounted === true) continue;
    app.on(route.method.toUpperCase(), `${prefix}${honoPath(route.path)}`, (c) =>
      dispatch(c, route, deps),
    );
  }
}

function isRaw(
  reply: JsonReply<Readonly<Record<number, z.ZodType>>> | RawReply,
): reply is RawReply {
  return 'raw' in reply;
}

async function dispatch(c: HttpContext, route: AnyRoute, deps: DispatchDeps): Promise<Response> {
  c.set('operationId', route.operationId);
  const now = deps.clock.now();
  let principal = null;
  if (route.auth.length > 0) {
    const params = c.req.param();
    const grantRoute =
      route.grantRoute === undefined
        ? undefined
        : {
            route: route.grantRoute,
            resourceId:
              (route.grantRoute === 'trace' ? params['session_id'] : params['event_id']) ?? '',
          };
    principal = await authenticateRoute(
      deps.authenticator,
      authViewOf(c, 'http', grantRoute),
      route,
    );
    c.set('principal', principal);
    authorizeRoute(principal, route);
  }
  const decision = takeToken(c, route, deps, principal);
  const input = await validate(c, route);
  const call = {
    input,
    principal,
    services: deps.services,
    hono: c,
    ctx: {
      requestId: c.get('requestId'),
      now,
      ip: c.get('clientIp'),
      userAgent: c.req.header('user-agent'),
      secure: c.get('secure'),
      url: new URL(c.req.url),
      method: c.req.method,
      header: (name: string) => c.req.header(name),
    },
  };
  const run = () => route.handler(call);
  const guarded = () => (route.loginSemaphore === true ? deps.loginSemaphore.run(run) : run());

  let response: Response;
  if (route.idempotent === true && principal !== null) {
    response = await idempotent(c, route, deps, principal.subject, now, guarded);
  } else {
    response = toResponse(c, route, await guarded(), deps.logger);
  }
  if (decision !== null) {
    response.headers.set('ratelimit-limit', String(decision.limit));
    response.headers.set('ratelimit-remaining', String(decision.remaining));
    response.headers.set('ratelimit-reset', String(decision.resetS));
  }
  return response;
}

/** True for a safe request of a dashboard operator (password session cookie). */
function isOperatorRead(route: AnyRoute, principal: RequestPrincipal | null): boolean {
  const method = route.method.toUpperCase();
  return (
    principal !== null &&
    principal.auth.method === 'password-session' &&
    (method === 'GET' || method === 'HEAD')
  );
}

function takeToken(
  c: HttpContext,
  route: AnyRoute,
  deps: DispatchDeps,
  principal: RequestPrincipal | null,
): RateDecision | null {
  if (route.rateLimit === 'service') return null;
  const operatorRead = route.rateLimit === undefined && isOperatorRead(route, principal);
  const rule =
    route.rateLimit ??
    (operatorRead
      ? { ...OPERATOR_READ_RATE, key: 'principal' as const }
      : { ...DEFAULT_RATE, key: 'principal' as const });
  const subject = principal?.subject;
  const key =
    rule.key === 'principal' && subject !== undefined ? `p:${subject}` : `ip:${c.get('clientIp')}`;
  const bucket =
    route.rateLimit !== undefined
      ? `${route.operationId}:${key}`
      : operatorRead
        ? `read:${key}`
        : `default:${key}`;
  const decision = deps.buckets.take(bucket, rule.limit, rule.windowMs);
  if (!decision.allowed) throw rateLimited(decision.retryAfterMs);
  return decision;
}

/** Query values as zod sees them: repeated params become arrays, single ones strings. */
export function queryRecord(c: HttpContext): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    out[key] = values.length === 1 ? (values[0] ?? '') : values;
  }
  return out;
}

async function validate(c: HttpContext, route: AnyRoute) {
  const issues: FieldIssue[] = [];
  const part = <S extends z.ZodType | undefined>(schema: S, value: unknown, name: string) => {
    if (schema === undefined) return undefined;
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    issues.push(...fieldIssues(parsed.error, name));
    return undefined;
  };
  const params = part(route.request.params, c.req.param(), 'params');
  const query = part(route.request.query, queryRecord(c), 'query');
  const headers = part(route.request.headers, c.req.header(), 'headers');
  let body: unknown;
  if (route.request.body !== undefined) {
    const text = await readBodyWithin(c.req.raw, route.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES);
    let json: unknown;
    try {
      json = text.trim() === '' ? undefined : JSON.parse(text);
    } catch {
      issues.push({ path: 'body', message: 'body is not valid JSON', code: 'invalid_json' });
    }
    if (issues.every((i) => i.path !== 'body')) body = part(route.request.body, json, 'body');
  }
  if (issues.length > 0) throw validationFailed(issues);
  return { params, query, body, headers };
}

async function idempotent(
  c: HttpContext,
  route: AnyRoute,
  deps: DispatchDeps,
  subject: string,
  now: number,
  run: () => Promise<JsonReply<Readonly<Record<number, z.ZodType>>> | RawReply>,
): Promise<Response> {
  const key = c.req.header('idempotency-key') ?? '';
  const store = deps.services.idempotency;
  const stored = await store.get(key, subject, route.operationId);
  if (stored !== null) {
    return new Response(JSON.stringify(stored.response), {
      status: 200,
      headers: { 'content-type': 'application/json', 'idempotent-replay': 'true' },
    });
  }
  const reply = await run();
  const response = toResponse(c, route, reply, deps.logger);
  if (!isRaw(reply) && response.status === 200) {
    const body: unknown = JSON.parse(await response.clone().text());
    await store.put({
      key,
      principalId: subject,
      route: route.operationId,
      response: body,
      createdAt: now,
    });
  }
  return response;
}

function toResponse(
  c: HttpContext,
  route: AnyRoute,
  reply: JsonReply<Readonly<Record<number, z.ZodType>>> | RawReply,
  logger: Logger,
): Response {
  if (isRaw(reply)) return reply.raw;
  const schema = route.responses[reply.status];
  const parsed = schema?.safeParse(reply.body);
  if (schema === undefined || parsed === undefined || !parsed.success) {
    logger.error('response schema mismatch', {
      operation_id: route.operationId,
      status: reply.status,
      issues: parsed?.success === false ? fieldIssues(parsed.error, 'response') : [],
    });
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: c.get('requestId') },
      {
        message: `response of ${route.operationId} does not match its schema`,
      },
    );
  }
  const json = JSON.stringify(parsed.data);
  const headers = new Headers(reply.headers);
  headers.set('content-type', 'application/json');
  if (c.req.method === 'GET') {
    const etag = `W/"${createHash('sha1').update(json).digest('base64url')}"`;
    headers.set('etag', etag);
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
  }
  return new Response(json, { status: reply.status, headers });
}
