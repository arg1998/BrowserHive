/** @module interface/http/middleware/error-handler — `app.onError`/`notFound`: every failure leaves as problem+json (spec 03 §2, spec 10 §2.2). */

import type { ErrorHandler, NotFoundHandler } from 'hono';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type { Logger } from '../../../ports/logger.ts';
import type { HttpContext, HttpEnv } from '../env.ts';
import { type ProblemResponse, problemFromError } from '../problem.ts';

/** Renders a problem as a `Response`. */
export function problemResponse(problem: ProblemResponse): Response {
  return new Response(JSON.stringify(problem.body), {
    status: problem.status,
    headers: problem.headers,
  });
}

function contextOf(c: HttpContext, allow?: readonly string[]) {
  const requestId = c.get('requestId') ?? 'unknown';
  return {
    instance: new URL(c.req.url).pathname,
    requestId,
    ...(allow !== undefined && { allow }),
  };
}

/** Maps thrown values to problem+json; unknown errors are logged with their stack at `error`. */
export function errorHandler(logger: Logger): ErrorHandler<HttpEnv> {
  const log = logger.child({ module: 'http' });
  return (error, c) => {
    const problem = problemFromError(error, contextOf(c));
    if (problem.status >= 500) {
      const details: unknown = problem.body.details;
      const ref =
        typeof details === 'object' && details !== null ? Reflect.get(details, 'ref') : undefined;
      log.error('request failed', {
        // A thrown non-Error is serialized as `NonError` by the logger, never `[object Object]`.
        err: error,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        operation_id: c.get('operationId'),
        status: problem.status,
        ...(typeof ref === 'string' && { ref }),
        request_id: c.get('requestId'),
      });
    }
    return problemResponse(problem);
  };
}

/** A route pattern and its method, for 405 detection. */
export interface KnownRoute {
  readonly method: string;
  readonly pattern: RegExp;
}

/** 404 `NOT_FOUND`, or 405 `METHOD_NOT_ALLOWED` with `Allow` when the path exists for other methods. */
export function notFoundHandler(routes: () => readonly KnownRoute[]): NotFoundHandler<HttpEnv> {
  return (c) => {
    const path = new URL(c.req.url).pathname;
    const allow = [
      ...new Set(
        routes()
          .filter((r) => r.pattern.test(path))
          .map((r) => r.method.toUpperCase()),
      ),
    ];
    if (allow.length > 0) {
      const error = new AppError('METHOD_NOT_ALLOWED', { allow });
      return problemResponse(problemFromError(error, contextOf(c, allow)));
    }
    return problemResponse(problemFromError(new AppError('NOT_FOUND', {}), contextOf(c)));
  };
}
