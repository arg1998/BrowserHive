/** @module interface/http/routes/routes.test — every `/api/v1` route: one success (body parsed with its contracts schema) and one 400 problem+json with field errors; route ↔ manifest correspondence. */

import { describe, expect, it } from 'bun:test';
import { ProblemDetails } from '@browserhive/contracts/errors';
import { HTTP_ENDPOINTS } from '@browserhive/contracts/http';
import { createHttpKit } from '../../../../test/helpers/http-kit.ts';
import {
  type CaseContext,
  type CaseRequest,
  ROUTE_CASES,
} from '../../../../test/helpers/http-route-cases.ts';

async function send(ctx: CaseContext, request: CaseRequest): Promise<Response> {
  const path = typeof request.path === 'function' ? request.path(ctx) : request.path;
  return ctx.kit.request(request.method ?? 'GET', path, {
    ...(request.anonymous !== true && { cookie: ctx.cookie }),
    ...(request.body !== undefined && { body: request.body }),
    ...(request.headers !== undefined && { headers: request.headers }),
  });
}

async function context(setup?: (ctx: CaseContext) => Promise<void>): Promise<CaseContext> {
  const kit = await createHttpKit();
  const cookie = await kit.login();
  const ctx: CaseContext = { kit, cookie, state: {} };
  await setup?.(ctx);
  return ctx;
}

describe('route table matches the endpoint manifest', () => {
  it('every HTTP_ENDPOINTS entry has exactly one route descriptor and vice versa', async () => {
    const kit = await createHttpKit({ seed: false });
    const routes = kit.http.routes;
    const ids = routes.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(HTTP_ENDPOINTS.map((e) => e.operationId).sort());
    for (const endpoint of HTTP_ENDPOINTS) {
      const route = routes.find((r) => r.operationId === endpoint.operationId);
      expect(route?.method).toBe(endpoint.method);
      expect(route?.path).toBe(endpoint.path);
      expect(route?.scope).toBe(endpoint.scope);
    }
  });

  it('every route except the WS upgrade has cases', () => {
    const covered = new Set(ROUTE_CASES.map((c) => c.operationId));
    const missing = HTTP_ENDPOINTS.map((e) => e.operationId).filter(
      (id) => id !== 'wsUpgrade' && !covered.has(id),
    );
    expect(missing).toEqual([]);
  });
});

describe('route success', () => {
  for (const routeCase of ROUTE_CASES) {
    it(`${routeCase.operationId} succeeds`, async () => {
      const ctx = await context(routeCase.setup);
      const response = await send(ctx, routeCase.success);
      const text = await response.text();
      if (response.status !== routeCase.success.status) {
        throw new Error(`${routeCase.operationId}: ${response.status} ${text}`);
      }
      const route = ctx.kit.http.routes.find((r) => r.operationId === routeCase.operationId);
      const schema = route?.responses[response.status];
      if (schema !== undefined) expect(schema.safeParse(JSON.parse(text)).success).toBe(true);
    });
  }
});

describe('route validation failures', () => {
  for (const routeCase of ROUTE_CASES) {
    const invalid = routeCase.invalid;
    if (invalid === null) {
      it(`${routeCase.operationId} declares no request schema`, async () => {
        const kit = await createHttpKit({ seed: false });
        const route = kit.http.routes.find((r) => r.operationId === routeCase.operationId);
        expect(route?.request).toEqual({});
      });
      continue;
    }
    it(`${routeCase.operationId} answers 400 problem+json with field errors`, async () => {
      const ctx = await context(routeCase.setup);
      const response = await send(ctx, invalid);
      expect(response.status).toBe(400);
      if (invalid.method === 'HEAD') return;
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      const problem = ProblemDetails.parse(await response.json());
      expect(problem.code).toBe('VALIDATION_FAILED');
      const issues = problem.details?.['issues'];
      expect(Array.isArray(issues) && issues.length > 0).toBe(true);
    });
  }
});
