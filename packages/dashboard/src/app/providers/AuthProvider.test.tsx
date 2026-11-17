/** @module app/providers/AuthProvider.test — provider wiring: probe on mount, 401 interceptor clears the cache, a 401 or Log out forgets the tab's work in progress (the template wizard's draft), transient failures keep checking with backoff, a cached operator survives a rate-limited reload */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { FetchLike } from '@/lib/api/http.ts';
import { act, fireEvent, render, screen, waitFor } from '../../../test/helpers/render.tsx';
import { AuthProvider, PRINCIPAL_CACHE_KEY, useApi, useAuth } from './AuthProvider.tsx';

const PRINCIPAL = {
  subject: 'p',
  kind: 'operator',
  display: 'admin',
  scopes: [],
  must_change_password: false,
};

function Probe() {
  const { state, logout } = useAuth();
  const api = useApi();
  return (
    <>
      <output data-testid="status">
        {state.status}:{state.attempt}
      </output>
      <button type="button" onClick={() => void api.getSystem().catch(() => undefined)}>
        call
      </button>
      <button type="button" onClick={() => void logout().catch(() => undefined)}>
        log out
      </button>
    </>
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

describe('AuthProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('goes ready after a successful probe and back to login when any call answers 401', async () => {
    let status = 200;
    const fetchImpl: FetchLike = async () =>
      status === 200
        ? jsonResponse(200, {
            principal: {
              subject: 'p',
              kind: 'operator',
              display: 'admin',
              scopes: [],
              must_change_password: false,
            },
          })
        : jsonResponse(401, {
            type: 'x',
            title: 'Unauthorized',
            status: 401,
            code: 'UNAUTHORIZED',
            retryable: 'never',
          });
    render(
      <AuthProvider fetch={fetchImpl}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready:0'));
    status = 401;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'call' }));
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('login:0'));
  });

  it('forgets the tab’s work in progress when a call answers 401 or the operator logs out', async () => {
    let status = 200;
    const fetchImpl: FetchLike = async (input) => {
      if (String(input).endsWith('/auth/logout')) return jsonResponse(200, { ok: true });
      return status === 200
        ? jsonResponse(200, { principal: PRINCIPAL })
        : jsonResponse(401, {
            type: 'x',
            title: 'Unauthorized',
            status: 401,
            code: 'UNAUTHORIZED',
            retryable: 'never',
          });
    };
    const seed = () => {
      sessionStorage.setItem('bh.templateDraft', JSON.stringify({ name: 'half-done' }));
      sessionStorage.setItem('other.key', 'kept');
    };
    const view = render(
      <AuthProvider fetch={fetchImpl}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready:0'));
    seed();
    status = 401;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'call' }));
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('login:0'));
    expect(sessionStorage.getItem('bh.templateDraft')).toBeNull();
    expect(sessionStorage.getItem('other.key')).toBe('kept');
    view.unmount();

    // Log out.
    status = 200;
    render(
      <AuthProvider fetch={fetchImpl}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready:0'));
    seed();
    expect(sessionStorage.getItem('bh.templateDraft')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'log out' }));
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('login:0'));
    expect(sessionStorage.getItem('bh.templateDraft')).toBeNull();
  });

  it('goes to change when a call answers 403 PASSWORD_CHANGE_REQUIRED', async () => {
    let first = true;
    const fetchImpl: FetchLike = async () => {
      if (first) {
        first = false;
        return jsonResponse(200, {
          principal: {
            subject: 'p',
            kind: 'operator',
            display: 'admin',
            scopes: [],
            must_change_password: false,
          },
        });
      }
      return jsonResponse(403, {
        type: 'x',
        title: 'Change',
        status: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
        retryable: 'after_operator',
      });
    };
    render(
      <AuthProvider fetch={fetchImpl}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready:0'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'call' }));
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('change:0'));
  });

  it('keeps checking with a growing attempt count when the daemon is unreachable', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      throw new TypeError('offline');
    };
    render(
      <AuthProvider fetch={fetchImpl} probeTimeoutMs={50}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('loading:1'));
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('loading:2'), {
      timeout: 3000,
    });
  });

  it('keeps the last known operator when a reload is rate limited', async () => {
    localStorage.setItem(PRINCIPAL_CACHE_KEY, JSON.stringify(PRINCIPAL));
    const fetchImpl: FetchLike = async () =>
      jsonResponse(429, {
        type: 'x',
        title: 'Too many requests',
        status: 429,
        code: 'RATE_LIMITED',
        retryable: 'backoff',
        details: { retry_after_ms: 60_000 },
      });
    render(
      <AuthProvider fetch={fetchImpl}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready:1'));
  });
});
