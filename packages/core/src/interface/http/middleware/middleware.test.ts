/** @module interface/http/middleware/middleware.test — request id/traceparent, host and origin guards, body limit, token buckets, client IP, byte ranges. */

import { describe, expect, it } from 'bun:test';
import { createHttpKit } from '../../../../test/helpers/http-kit.ts';
import { parseByteRange } from '../byte-range.ts';
import { accessLogLevel } from './access-log.ts';
import { createClientResolver, ipInCidr, parseCidr } from './client-ip.ts';
import { hostnameOf, isHostAllowed } from './host-guard.ts';
import { isSameOrigin } from './origin-guard.ts';
import { DEFAULT_RATE, OPERATOR_READ_RATE, Semaphore, TokenBuckets } from './rate-limit.ts';
import { parseTraceparent } from './trace-ids.ts';

describe('request id and trace context', () => {
  it('echoes a valid X-Request-Id and adopts an inbound traceparent', async () => {
    const kit = await createHttpKit({ seed: false });
    const response = await kit.request('GET', '/health', {
      headers: {
        'x-request-id': 'client-abc_1',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      },
    });
    expect(response.headers.get('x-request-id')).toBe('client-abc_1');
    const echoed = parseTraceparent(response.headers.get('traceparent') ?? undefined);
    expect(echoed?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('mints a request id when the header is invalid', async () => {
    const kit = await createHttpKit({ seed: false });
    const response = await kit.request('GET', '/health', {
      headers: { 'x-request-id': 'bad id!' },
    });
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9A-Z]{26}$/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('logs dashboard polling, static files and health at debug; the rest at info', async () => {
    const at = (path: string, method: string, status: number, authMethod?: string) =>
      accessLogLevel({ path, method, status, authMethod });
    expect(at('/health', 'GET', 200)).toBe('debug');
    expect(at('/assets/index-abc.js', 'GET', 200)).toBe('debug');
    expect(at('/sessions/x', 'GET', 200)).toBe('debug');
    expect(at('/api/v1/logs', 'GET', 200, 'password-session')).toBe('debug');
    expect(at('/api/v1/logs', 'GET', 304, 'password-session')).toBe('debug');
    expect(at('/api/v1/logs', 'GET', 429, 'password-session')).toBe('info');
    expect(at('/api/v1/sessions/bulk', 'POST', 200, 'password-session')).toBe('info');
    expect(at('/api/v1/sessions', 'GET', 200, 'bearer')).toBe('info');
    expect(at('/api/v1/auth/login', 'POST', 200)).toBe('info');
    expect(at('/mcp', 'POST', 200, 'bearer')).toBe('info');
    const kit = await createHttpKit({ seed: false });
    const cookie = await kit.login();
    await kit.request('GET', '/api/v1/auth/me', { cookie });
    const line = kit.logger.records.find(
      (r) => r.msg === 'request completed' && r.fields['route_pattern'] === 'getMe',
    );
    expect(line?.level).toBe('debug');
  });

  it('logs one access line per request', async () => {
    const kit = await createHttpKit({ seed: false });
    await kit.request('GET', '/api/v1/openapi.json');
    expect(
      kit.logger.records.some((r) => r.msg === 'request completed' && r.fields['status'] === 200),
    ).toBe(true);
  });
});

describe('host guard', () => {
  it('parses host headers', () => {
    expect(hostnameOf('LocalHost:9876')).toBe('localhost');
    expect(hostnameOf('[::1]:80')).toBe('::1');
  });

  it('allows loopback, the bound host and allowedHosts; IP literals only on wildcard binds', () => {
    expect(isHostAllowed('127.0.0.1', { host: '127.0.0.1' })).toBe(true);
    expect(isHostAllowed('evil.test', { host: '127.0.0.1' })).toBe(false);
    expect(isHostAllowed('hive.lan', { host: '0.0.0.0', allowedHosts: ['hive.lan:9876'] })).toBe(
      true,
    );
    expect(isHostAllowed('10.0.0.5', { host: '0.0.0.0' })).toBe(true);
    expect(isHostAllowed('10.0.0.5', { host: '127.0.0.1' })).toBe(false);
  });

  it('answers 421 HOST_NOT_ALLOWED to a rebound host', async () => {
    const kit = await createHttpKit({ seed: false });
    const response = await kit.request('GET', '/health', { headers: { host: 'attacker.example' } });
    expect(response.status).toBe(421);
  });
});

describe('origin guard', () => {
  it('matches same origin with loopback aliases', () => {
    expect(isSameOrigin('http://localhost:9876', '127.0.0.1:9876')).toBe(true);
    expect(isSameOrigin('http://localhost:1', '127.0.0.1:9876')).toBe(false);
    expect(isSameOrigin('https://evil.example', 'localhost')).toBe(false);
    expect(isSameOrigin('null', 'localhost')).toBe(false);
  });

  it('refuses cross-origin mutations with 403 ORIGIN_NOT_ALLOWED', async () => {
    const kit = await createHttpKit({ seed: false });
    const cookie = await kit.login();
    const response = await kit.request('POST', '/api/v1/vault/lock', {
      cookie,
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('refuses a cookie-carrying mutation with neither Origin nor Sec-Fetch-Site', async () => {
    const kit = await createHttpKit({ seed: false });
    const cookie = await kit.login();
    const response = await kit.http.app.request('http://localhost/api/v1/vault/lock', {
      method: 'POST',
      headers: { cookie, host: 'localhost' },
    });
    expect(response.status).toBe(403);
  });
});

describe('body limit', () => {
  it('answers 413 above the login cap', async () => {
    const kit = await createHttpKit({ seed: false });
    const response = await kit.request('POST', '/api/v1/auth/login', {
      body: { password: 'x'.repeat(70_000) },
    });
    expect(response.status).toBe(413);
  });
});

describe('rate limiting', () => {
  it('refills continuously and refuses when empty', () => {
    let now = 0;
    const buckets = new TokenBuckets(() => now);
    expect(buckets.take('k', 2, 1000).allowed).toBe(true);
    expect(buckets.take('k', 2, 1000).allowed).toBe(true);
    const refused = buckets.take('k', 2, 1000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(500);
    now = 500;
    expect(buckets.take('k', 2, 1000).allowed).toBe(true);
  });

  it('client errors are limited to 30 per minute with RateLimit headers', async () => {
    const kit = await createHttpKit({ seed: false });
    const cookie = await kit.login();
    const body = { message: 'boom', route: '/', user_agent: 'x', build: 'dev' };
    let last: Response | undefined;
    for (let i = 0; i < 31; i += 1)
      last = await kit.request('POST', '/api/v1/client-errors', { cookie, body });
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).not.toBeNull();
  });

  it('dashboard reads get their own larger budget; mutations keep the default', async () => {
    const kit = await createHttpKit({ seed: false });
    const cookie = await kit.login();
    let last: Response | undefined;
    for (let i = 0; i < 700; i += 1) last = await kit.request('GET', '/api/v1/auth/me', { cookie });
    expect(last?.status).toBe(200);
    expect(last?.headers.get('ratelimit-limit')).toBe(String(OPERATOR_READ_RATE.limit));
    expect(Number(last?.headers.get('ratelimit-remaining'))).toBe(OPERATOR_READ_RATE.limit - 700);
    const write = await kit.request('POST', '/api/v1/notifications/read-all', { cookie });
    expect(write.status).toBe(200);
    expect(write.headers.get('ratelimit-limit')).toBe(String(DEFAULT_RATE.limit));
    expect(write.headers.get('ratelimit-remaining')).toBe(String(DEFAULT_RATE.limit - 1));
  });

  it('the dashboard read budget refuses with 429 and Retry-After once spent', async () => {
    const kit = await createHttpKit({ seed: false });
    const cookie = await kit.login();
    let last: Response | undefined;
    for (let i = 0; i <= OPERATOR_READ_RATE.limit; i += 1)
      last = await kit.request('GET', '/api/v1/auth/me', { cookie });
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBe('1');
  });

  it('the login semaphore refuses excess concurrency', async () => {
    const semaphore = new Semaphore(1);
    let release: () => void = () => undefined;
    const held = semaphore.run(() => new Promise<void>((r) => (release = () => r())));
    await expect(semaphore.run(async () => 1)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    release();
    await held;
  });
});

describe('client IP', () => {
  it('parses CIDRs and matches addresses', () => {
    const cidr = parseCidr('10.0.0.0/8');
    expect(cidr !== null && ipInCidr('10.1.2.3', cidr)).toBe(true);
    const v6 = parseCidr('::1/128');
    expect(v6 !== null && ipInCidr('::1', v6)).toBe(true);
  });

  it('uses the right-most untrusted X-Forwarded-For hop only behind a trusted proxy', () => {
    const resolver = createClientResolver(['10.0.0.0/8']);
    expect(resolver.resolve('203.0.113.9', '1.2.3.4', undefined).ip).toBe('203.0.113.9');
    const proxied = resolver.resolve('10.0.0.2', '1.2.3.4, 198.51.100.7, 10.0.0.3', 'https');
    expect(proxied.ip).toBe('198.51.100.7');
    expect(proxied.secure).toBe(true);
    expect(resolver.resolve('127.0.0.1', undefined, undefined).loopback).toBe(true);
  });
});

describe('byte ranges', () => {
  it('parses single, open and suffix ranges', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseByteRange(undefined, 100)).toBeNull();
  });
});
