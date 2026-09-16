/** @module app/providers/auth-machine.test — 401 → login, must_change → change, transient failures keep the known shell and back off honouring retry-after; the sign-in page skips the probe (spec 04 §4.1) */

import { describe, expect, it } from 'bun:test';
import type { MeResponse } from '@browserhive/contracts/http';
import { AppError } from '@/lib/api/errors.ts';
import {
  authRetryCopy,
  INITIAL_AUTH_STATE,
  initialAuthState,
  isTransientAuthError,
  probeRetryDelayMs,
  reduceAuth,
  retryDelayMs,
} from './auth-machine.ts';

const me = (must = false): MeResponse => ({
  principal: {
    subject: 'p',
    kind: 'operator',
    display: 'admin',
    scopes: [],
    must_change_password: must,
  },
});
const err = (code: 'NETWORK_ERROR' | 'INTERNAL_ERROR') =>
  new AppError({
    code,
    status: code === 'NETWORK_ERROR' ? 0 : 500,
    title: code,
    retryable: 'backoff',
  });

const failed = (error: AppError, delayMs = 1000) =>
  ({ type: 'probe.failed', error, delayMs, at: 0 }) as const;
const rateLimited = new AppError({
  code: 'RATE_LIMITED',
  status: 429,
  title: 'Too many requests',
  retryable: 'backoff',
  retryAfterMs: 5000,
});
const malformed = new AppError({
  code: 'MALFORMED_RESPONSE',
  status: 0,
  title: 'Unexpected response shape',
  retryable: 'never',
});

describe('auth machine', () => {
  it('routes probe results', () => {
    expect(reduceAuth(INITIAL_AUTH_STATE, { type: 'probe.ok', me: me() }).status).toBe('ready');
    expect(reduceAuth(INITIAL_AUTH_STATE, { type: 'probe.ok', me: me(true) }).status).toBe(
      'change',
    );
    expect(reduceAuth(INITIAL_AUTH_STATE, { type: 'probe.unauthorized' }).status).toBe('login');
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(3)).toBe(4000);
    expect(retryDelayMs(10)).toBe(30_000);
  });

  it('keeps checking (no error card) on transient failures while nobody is known', () => {
    const offline = reduceAuth(INITIAL_AUTH_STATE, failed(err('NETWORK_ERROR')));
    expect(offline).toMatchObject({ status: 'loading', attempt: 1, pending: false });
    expect(offline.retry?.error.code).toBe('NETWORK_ERROR');
    const retrying = reduceAuth(offline, { type: 'retry' });
    expect(retrying.pending).toBe(true);
    const again = reduceAuth(
      reduceAuth(retrying, { type: 'probe.start' }),
      failed(err('INTERNAL_ERROR')),
    );
    expect(again).toMatchObject({ status: 'loading', attempt: 2 });
    expect(reduceAuth(again, { type: 'probe.ok', me: me() })).toMatchObject({
      status: 'ready',
      attempt: 0,
      retry: null,
    });
    // A non-transient failure with nobody known is a real error.
    expect(reduceAuth(INITIAL_AUTH_STATE, failed(malformed)).status).toBe('error');
  });

  it('never replaces a known shell on a failed probe', () => {
    const ready = reduceAuth(INITIAL_AUTH_STATE, { type: 'probe.ok', me: me() });
    for (const error of [rateLimited, err('NETWORK_ERROR'), err('INTERNAL_ERROR'), malformed]) {
      const next = reduceAuth(ready, failed(error));
      expect(next.status).toBe('ready');
      expect(next.principal).not.toBeNull();
      expect(next.retry?.error).toBe(error);
    }
    // A principal cached from the last visit renders the shell when the first probe is rate limited.
    const cached = initialAuthState(me().principal);
    expect(cached).toMatchObject({ status: 'loading', pending: true });
    expect(reduceAuth(cached, failed(rateLimited)).status).toBe('ready');
    expect(reduceAuth(initialAuthState(me(true).principal), failed(rateLimited)).status).toBe(
      'change',
    );
    // Only a 401 signs out.
    expect(reduceAuth(cached, { type: 'probe.unauthorized' })).toMatchObject({
      status: 'login',
      principal: null,
    });
  });

  it('skips the probe on the sign-in page when nobody is cached', () => {
    expect(initialAuthState(null, { skipProbe: true })).toMatchObject({
      status: 'login',
      pending: false,
    });
    expect(initialAuthState(me().principal, { skipProbe: true })).toMatchObject({
      status: 'loading',
      pending: true,
    });
  });

  it('honours retry-after with jitter and classifies transient errors', () => {
    expect(probeRetryDelayMs(rateLimited, 1, () => 0.5)).toBe(5000);
    expect(probeRetryDelayMs(err('NETWORK_ERROR'), 3, () => 0)).toBe(3600);
    expect(probeRetryDelayMs(err('NETWORK_ERROR'), 3, () => 1)).toBe(4400);
    expect(isTransientAuthError(rateLimited)).toBe(true);
    expect(isTransientAuthError(err('INTERNAL_ERROR'))).toBe(true);
    expect(isTransientAuthError(malformed)).toBe(false);
    expect(authRetryCopy(rateLimited).title).toBe('The daemon is rate limiting this browser');
    expect(JSON.stringify(authRetryCopy(rateLimited))).not.toContain('RATE_LIMITED');
  });

  it('never drops to login on transport failures, only on 401/logout', () => {
    const ready = reduceAuth(INITIAL_AUTH_STATE, { type: 'probe.ok', me: me() });
    expect(reduceAuth(ready, failed(err('NETWORK_ERROR'))).principal).not.toBeNull();
    expect(reduceAuth(ready, { type: 'unauthorized' })).toMatchObject({
      status: 'login',
      principal: null,
    });
    expect(reduceAuth(ready, { type: 'password_change_required' }).status).toBe('change');
    expect(reduceAuth(ready, { type: 'logged_out' }).status).toBe('login');
    const login = reduceAuth(INITIAL_AUTH_STATE, { type: 'probe.unauthorized' });
    expect(reduceAuth(login, { type: 'logged_in', mustChange: true }).status).toBe('change');
    expect(reduceAuth(login, { type: 'logged_in', mustChange: false })).toMatchObject({
      status: 'loading',
      pending: true,
    });
    expect(reduceAuth(login, { type: 'password_change_required' }).status).toBe('login');
  });
});
