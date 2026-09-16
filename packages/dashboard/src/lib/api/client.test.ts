/** @module lib/api/client.test — path/query building, problem+json mapping, 401/403 interceptors, dev parse vs prod report */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { buildPath, buildQuery, createApiClient, parseWire } from './client.ts';
import { isAppError } from './errors.ts';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });
}

describe('api client', () => {
  it('builds paths and canonical query strings', () => {
    expect(
      buildPath(
        {
          operationId: 'x',
          method: 'get',
          path: '/sessions/{session_id}/tool-calls/{event_id}',
          scope: null,
          auth: [],
        },
        { session_id: 'a b', event_id: 'e-1' },
      ),
    ).toBe('/sessions/a%20b/tool-calls/e-1');
    expect(
      buildQuery({ state: ['live', 'paused'], q: undefined, limit: 25, total: true, empty: [] }),
    ).toBe('?limit=25&state=live%2Cpaused&total=true');
    expect(buildQuery(undefined)).toBe('');
  });

  it('calls the manifest route and parses the response', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const api = createApiClient({
      strict: true,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse(200, {
          status: 'ready',
          phase: 'ready',
          version: '0.1.0',
          uptime_ms: 5,
          checks: { db: 'ok', browser: 'ok', listeners: 'ok' },
        });
      },
    });
    const health = await api.getHealth();
    expect(health.status).toBe('ready');
    expect(calls[0]?.url).toBe('/api/v1/health');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });

  it('maps problem+json to AppError with retry_after and signals 401/403', async () => {
    const signals: string[] = [];
    let status = 429;
    let code401 = 'UNAUTHORIZED';
    const api = createApiClient({
      fetch: async () =>
        jsonResponse(status, {
          type: 'x',
          title: 'Rate limited',
          status,
          code:
            status === 429 ? 'RATE_LIMITED' : status === 401 ? code401 : 'PASSWORD_CHANGE_REQUIRED',
          retryable: 'backoff',
          details: status === 429 ? { retry_after_ms: 1500 } : {},
          request_id: 'r1',
        }),
      signals: {
        onUnauthorized: (op) => signals.push(`401:${op}`),
        onPasswordChangeRequired: (op) => signals.push(`403:${op}`),
      },
    });
    const rate = await api.login({ body: { password: 'x' } }).catch((e: unknown) => e);
    expect(
      isAppError(rate) &&
        rate.code === 'RATE_LIMITED' &&
        rate.retryAfterMs === 1500 &&
        rate.requestId === 'r1',
    ).toBe(true);
    status = 401;
    await api.getMe().catch(() => undefined);
    await api.login({ body: { password: 'x' } }).catch(() => undefined);
    // A rejected vault secret is a 401 about another credential: the operator stays signed in.
    code401 = 'VAULT_UNLOCK_FAILED';
    const unlock = await api
      .unlockVault({ body: { mode: 'session_token', secret: 'bad' } } as never)
      .catch((e: unknown) => e);
    expect(isAppError(unlock) && unlock.code === 'VAULT_UNLOCK_FAILED').toBe(true);
    status = 403;
    await api.getSystem().catch(() => undefined);
    expect(signals).toEqual(['401:getMe', '403:getSystem']);
  });

  it('turns fetch failures and timeouts into transport codes', async () => {
    const api = createApiClient({
      fetch: async () => {
        throw new TypeError('offline');
      },
    });
    const error = await api.getHealth().catch((e: unknown) => e);
    expect(isAppError(error) && error.code === 'NETWORK_ERROR').toBe(true);
    const slow = createApiClient({
      fetch: (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    });
    const timeout = await slow.getHealth({ timeoutMs: 5 }).catch((e: unknown) => e);
    expect(isAppError(timeout) && timeout.code === 'TIMEOUT').toBe(true);
  });

  it('parseWire throws in strict mode and reports in lenient mode', () => {
    const schema = z.object({ ok: z.literal(true) });
    expect(() => parseWire(schema, { ok: false }, 'op', { strict: true })).toThrow();
    const reports: string[] = [];
    const value = parseWire(schema, { ok: false }, 'op', {
      strict: false,
      report: (m) => reports.push(m.operationId),
    });
    expect(value as unknown).toEqual({ ok: false });
    expect(reports).toEqual(['op']);
  });
});
