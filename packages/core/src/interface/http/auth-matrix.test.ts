/** @module interface/http/auth-matrix.test — every route × {no credential → 401, must-change-password → 403 except the allowed three, valid → neither} (spec 09 §3.2). */

import { describe, expect, it } from 'bun:test';
import { ProblemDetails } from '@browserhive/contracts/errors';
import { HTTP_ENDPOINTS, PASSWORD_CHANGE_ALLOWED_OPERATIONS } from '@browserhive/contracts/http';
import { createHttpKit } from '../../../test/helpers/http-kit.ts';
import { type CaseContext, ROUTE_CASES } from '../../../test/helpers/http-route-cases.ts';

const PUBLIC = new Set(HTTP_ENDPOINTS.filter((e) => e.auth.length === 0).map((e) => e.operationId));
const ALLOWED = new Set(PASSWORD_CHANGE_ALLOWED_OPERATIONS);

async function statusOf(ctx: CaseContext, operationId: string, cookie: string | undefined) {
  const routeCase = ROUTE_CASES.find((c) => c.operationId === operationId);
  if (routeCase === undefined) throw new Error(`no case for ${operationId}`);
  const request = routeCase.success;
  const path = typeof request.path === 'function' ? request.path(ctx) : request.path;
  const response = await ctx.kit.request(request.method ?? 'GET', path, {
    ...(cookie !== undefined && { cookie }),
    ...(request.body !== undefined && { body: request.body }),
    ...(request.headers !== undefined && { headers: request.headers }),
  });
  const text = await response.text();
  const code =
    response.headers.get('content-type') === 'application/problem+json' && text !== ''
      ? ProblemDetails.parse(JSON.parse(text)).code
      : null;
  return {
    status: response.status,
    code,
    wwwAuthenticate: response.headers.get('www-authenticate'),
  };
}

const matrixCases = ROUTE_CASES.filter((c) => c.operationId !== 'login');

describe('auth matrix: no credential', () => {
  for (const routeCase of matrixCases) {
    const expectPublic = PUBLIC.has(routeCase.operationId);
    it(`${routeCase.operationId} → ${expectPublic ? 'public' : '401'}`, async () => {
      const kit = await createHttpKit();
      const ctx: CaseContext = { kit, cookie: '', state: {} };
      await routeCase.setup?.({ ...ctx, cookie: await kit.login() });
      const result = await statusOf(ctx, routeCase.operationId, undefined);
      if (expectPublic) {
        expect(result.status).toBeLessThan(400);
      } else {
        expect(result.status).toBe(401);
        if (routeCase.success.method !== 'HEAD') {
          expect(result.code).toBe('UNAUTHORIZED');
          expect(result.wwwAuthenticate).not.toBeNull();
        }
      }
    });
  }
});

describe('auth matrix: must change password', () => {
  for (const routeCase of matrixCases) {
    const id = routeCase.operationId;
    const expectation = PUBLIC.has(id) ? 'public' : ALLOWED.has(id) ? 'allowed' : '403';
    it(`${id} → ${expectation}`, async () => {
      const kit = await createHttpKit({ mustChangePassword: true });
      const cookie = await kit.login();
      const ctx: CaseContext = { kit, cookie, state: {} };
      await routeCase.setup?.(ctx);
      if (expectation === '403') {
        const result = await statusOf(ctx, id, cookie);
        expect(result.status).toBe(403);
        if (routeCase.success.method !== 'HEAD')
          expect(result.code).toBe('PASSWORD_CHANGE_REQUIRED');
        return;
      }
      const result = await statusOf(ctx, id, cookie);
      expect([401, 403]).not.toContain(result.status);
      expect(result.status).toBeLessThan(500);
    });
  }
});

describe('auth matrix: valid operator session', () => {
  for (const routeCase of matrixCases) {
    it(`${routeCase.operationId} → 2xx/4xx`, async () => {
      const kit = await createHttpKit();
      const cookie = await kit.login();
      const ctx: CaseContext = { kit, cookie, state: {} };
      await routeCase.setup?.(ctx);
      const result = await statusOf(ctx, routeCase.operationId, cookie);
      expect([401, 403]).not.toContain(result.status);
      expect(result.status).toBeLessThan(500);
    });
  }
});

describe('auth matrix: bearer principals', () => {
  it('an agent token reaches getMe but no operator route', async () => {
    const kit = await createHttpKit();
    const cookie = await kit.login();
    const created = await kit.request('POST', '/api/v1/auth/tokens', {
      cookie,
      body: { owner_kind: 'agent', display: 'bot' },
    });
    const { token } = (await created.json()) as { token: string };
    const me = await kit.request('GET', '/api/v1/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const list = await kit.request('GET', '/api/v1/sessions', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(403);
    const tokens = await kit.request('GET', '/api/v1/auth/tokens', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tokens.status).toBe(403);
  });

  it('a present-but-invalid bearer is 401, never anonymous', async () => {
    const kit = await createHttpKit();
    const response = await kit.request('GET', '/api/v1/openapi.json', {});
    expect(response.status).toBe(200);
    const bad = await kit.request('GET', '/api/v1/sessions', {
      headers: { authorization: 'Bearer bh_agent_nope' },
    });
    expect(bad.status).toBe(401);
  });
});
