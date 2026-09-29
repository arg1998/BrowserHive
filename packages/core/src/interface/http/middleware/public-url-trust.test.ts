/** @module interface/http/middleware/public-url-trust.test — `publicUrl` is trusted by the host guard and the origin guard (spec 03 §2, D-37): a reverse proxy that rewrites `Host` to the upstream address still passes the CSRF check. */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { CollectingLogger } from '../../../../test/helpers/collecting-logger.ts';
import type { HttpEnv } from '../env.ts';
import { errorHandler } from './error-handler.ts';
import { hostGuard } from './host-guard.ts';
import { originGuard } from './origin-guard.ts';

function app(trusted: readonly string[], allowedHosts: readonly string[]) {
  const hono = new Hono<HttpEnv>();
  hono.use('*', hostGuard({ host: '127.0.0.1', allowedHosts }));
  hono.use('*', originGuard({ trustedOrigins: trusted }));
  hono.onError(errorHandler(new CollectingLogger()));
  hono.post('/x', (c) => c.json({ ok: true }));
  return hono;
}

const post = (hono: Hono<HttpEnv>, headers: Record<string, string>) =>
  hono.request('http://127.0.0.1:9876/x', { method: 'POST', headers });

describe('publicUrl trust', () => {
  it('accepts the public origin on a proxied request whose Host is the upstream address', async () => {
    const hono = app(['https://bh.example.net'], ['bh.example.net']);
    const res = await post(hono, {
      host: '127.0.0.1:9876',
      origin: 'https://bh.example.net',
      cookie: 'x=1',
    });
    expect(res.status).toBe(200);
  });

  it('accepts the public host itself and still refuses other origins', async () => {
    const hono = app(['https://bh.example.net'], ['bh.example.net']);
    expect(
      (await post(hono, { host: 'bh.example.net', origin: 'https://bh.example.net' })).status,
    ).toBe(200);
    expect(
      (await post(hono, { host: '127.0.0.1:9876', origin: 'https://evil.example', cookie: 'x=1' }))
        .status,
    ).toBe(403);
  });

  it('without publicUrl the proxied origin is refused', async () => {
    const hono = app([], []);
    expect(
      (
        await post(hono, {
          host: '127.0.0.1:9876',
          origin: 'https://bh.example.net',
          cookie: 'x=1',
        })
      ).status,
    ).toBe(403);
    expect(
      (await post(hono, { host: 'bh.example.net', origin: 'https://bh.example.net' })).status,
    ).toBe(421);
  });
});
