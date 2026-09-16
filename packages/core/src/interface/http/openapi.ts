/** @module interface/http/openapi — the OpenAPI 3.1 document generated from the route descriptors (named components, problem+json on every route; spec 03 §1.2, D-05). */

import { ERROR_REGISTRY, type ErrorCode, ProblemDetails } from '@browserhive/contracts/errors';
import * as HttpContracts from '@browserhive/contracts/http';
import { API_PREFIX } from '@browserhive/contracts/http';
import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import type { AnyRoute } from './define-route.ts';
import { PROBLEM_CONTENT_TYPE } from './problem.ts';

/** Security scheme names per accepted auth method. */
export const SECURITY_SCHEMES = {
  'password-session': 'cookieAuth',
  bearer: 'bearerAuth',
  grant: 'grantAuth',
} as const;

function isComponent(name: string, value: unknown): value is z.ZodType {
  if (!(value instanceof z.ZodObject || value instanceof z.ZodDiscriminatedUnion)) return false;
  return !/(Query|Params)$/.test(name);
}

let named: Map<z.ZodType, z.ZodType> | undefined;

/**
 * Component-named clones (`.meta({ id })`) of every contracts DTO, built once per process (zod's
 * global registry refuses duplicate ids). `.meta` is used instead of `.openapi()` because zod 4
 * snapshots prototype methods at construction, so schemas created before the generator loads
 * never gain `.openapi`.
 */
function namedSchemas(): Map<z.ZodType, z.ZodType> {
  if (named !== undefined) return named;
  const map = new Map<z.ZodType, z.ZodType>();
  map.set(ProblemDetails, ProblemDetails.meta({ id: 'ProblemDetails' }));
  for (const [name, value] of Object.entries(HttpContracts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (name !== 'ProblemDetails' && isComponent(name, value) && !map.has(value)) {
      map.set(value, value.meta({ id: name }));
    }
  }
  named = map;
  return map;
}

function nameOf(schema: z.ZodType): z.ZodType {
  return namedSchemas().get(schema) ?? schema;
}

function universalCodes(route: AnyRoute): ErrorCode[] {
  const codes: ErrorCode[] = [];
  const request = route.request;
  if (
    request.params !== undefined ||
    request.query !== undefined ||
    request.body !== undefined ||
    request.headers !== undefined
  ) {
    codes.push('VALIDATION_FAILED');
  }
  if (route.auth.length > 0) codes.push('UNAUTHORIZED', 'FORBIDDEN', 'PASSWORD_CHANGE_REQUIRED');
  if (request.body !== undefined) codes.push('PAYLOAD_TOO_LARGE');
  codes.push('RATE_LIMITED', 'INTERNAL_ERROR');
  return codes;
}

function problemResponses(
  route: AnyRoute,
): Record<string, { description: string; content: object }> {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of [...universalCodes(route), ...(route.errors ?? [])]) {
    const status = ERROR_REGISTRY[code].httpStatus;
    const list = byStatus.get(status) ?? [];
    if (!list.includes(code)) list.push(code);
    byStatus.set(status, list);
  }
  const out: Record<string, { description: string; content: object }> = {};
  for (const [status, codes] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    out[String(status)] = {
      description: codes.join(', '),
      content: { [PROBLEM_CONTENT_TYPE]: { schema: nameOf(ProblemDetails) } },
    };
  }
  return out;
}

/** Builds the OpenAPI 3.1 document for `routes`. Deterministic for a given route table. */
export function buildOpenApiDocument(routes: readonly AnyRoute[], version: string): object {
  const app = new OpenAPIHono();
  const registry = app.openAPIRegistry;
  registry.registerComponent('securitySchemes', SECURITY_SCHEMES['password-session'], {
    type: 'apiKey',
    in: 'cookie',
    name: 'browserhive_session',
  });
  registry.registerComponent('securitySchemes', SECURITY_SCHEMES.bearer, {
    type: 'http',
    scheme: 'bearer',
  });
  registry.registerComponent('securitySchemes', SECURITY_SCHEMES.grant, {
    type: 'apiKey',
    in: 'query',
    name: 'grant',
  });
  for (const route of routes) {
    const responses: Record<string, { description: string; content?: object }> = {};
    for (const [status, schema] of Object.entries(route.responses)) {
      responses[status] = {
        description: route.summary,
        content: { 'application/json': { schema: nameOf(schema) } },
      };
    }
    for (const doc of route.raw ?? []) {
      const media =
        doc.contentType === 'none'
          ? undefined
          : { [doc.contentType]: { schema: { type: 'string', format: 'binary' } } };
      responses[String(doc.status)] = {
        description: doc.description,
        ...(media !== undefined && { content: media }),
      };
    }
    Object.assign(responses, problemResponses(route));
    const request = route.request;
    registry.registerPath({
      method: route.method,
      path: `${API_PREFIX}${route.path}`,
      operationId: route.operationId,
      tags: [...route.tags],
      summary: route.summary,
      ...(route.deprecated === true && { deprecated: true }),
      security: route.auth.map((method) => ({ [SECURITY_SCHEMES[method]]: [] })),
      request: {
        ...(request.params instanceof z.ZodObject && { params: request.params }),
        ...(request.query instanceof z.ZodObject && { query: request.query }),
        ...(request.headers instanceof z.ZodObject && { headers: request.headers }),
        ...(request.body !== undefined && {
          body: {
            required: true,
            content: { 'application/json': { schema: nameOf(request.body) } },
          },
        }),
      },
      responses,
      'x-browserhive-scope': route.scope,
    });
  }
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'BrowserHive admin API',
      version,
      description: 'Admin REST API (`/api/v1`). Errors are RFC 9457 problem+json.',
    },
    servers: [{ url: '/' }],
  });
}
