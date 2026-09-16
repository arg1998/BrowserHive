/** @module interface/ws/upgrade.test — close-code verdicts at upgrade (4406, 4401, 4403) and the Bun websocket handler wiring. */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import type { Authenticator } from '../../app/auth/authenticate.ts';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { HttpEnv } from '../http/env.ts';
import { RealtimeHub } from './hub.ts';
import { type UpgradedSocket, upgradeVerdict, websocketHandler } from './upgrade.ts';

const OPERATOR: RequestPrincipal = {
  subject: 'admin',
  kind: 'operator',
  display: 'admin',
  auth: { method: 'password-session', sessionId: 's' },
  scopes: [],
  tenantId: null,
  mustChangePassword: false,
};

function authenticator(result: RequestPrincipal | null | 'throw'): Authenticator {
  return {
    authenticate: async () => {
      if (result === 'throw') throw new AppError('UNAUTHORIZED', {});
      return result;
    },
    require: async () => OPERATOR,
  };
}

async function verdict(auth: Authenticator, protocol?: string) {
  const app = new Hono<HttpEnv>();
  app.use('*', async (c, next) => {
    c.set('clientIp', '127.0.0.1');
    c.set('remoteLoopback', true);
    await next();
  });
  app.get('/ws', async (c) => c.json(await upgradeVerdict(c, auth)));
  const response = await app.request('http://localhost/ws', {
    headers: protocol === undefined ? {} : { 'sec-websocket-protocol': protocol },
  });
  return (await response.json()) as { closeCode: number | null };
}

describe('upgrade verdict', () => {
  it('4406 without the browserhive.v1 subprotocol', async () => {
    expect((await verdict(authenticator(OPERATOR))).closeCode).toBe(4406);
  });
  it('4401 for missing or invalid credentials', async () => {
    expect((await verdict(authenticator(null), 'browserhive.v1')).closeCode).toBe(4401);
    expect((await verdict(authenticator('throw'), 'x, browserhive.v1')).closeCode).toBe(4401);
  });
  it('4403 while the password must change', async () => {
    expect(
      (await verdict(authenticator({ ...OPERATOR, mustChangePassword: true }), 'browserhive.v1'))
        .closeCode,
    ).toBe(4403);
  });
  it('accepts an operator session', async () => {
    expect((await verdict(authenticator(OPERATOR), 'browserhive.v1')).closeCode).toBeNull();
  });
});

describe('websocket handler', () => {
  function socket(data: UpgradedSocket['data']) {
    const sent: unknown[] = [];
    const closes: number[] = [];
    const ws: UpgradedSocket = {
      data,
      send: (d) => {
        sent.push(d);
        return 1;
      },
      close: (code) => {
        closes.push(code ?? 0);
      },
    };
    return { ws, sent, closes };
  }
  const hub = () =>
    new RealtimeHub({
      clock: new FakeClock(),
      ids: new FakeIdGenerator(),
      logger: new CollectingLogger(),
      auth: { touchSession: async () => true },
      attention: { isInputPermitted: () => false },
      liveView: {
        addViewer: async () => undefined,
        removeViewer: async () => undefined,
        setViewerSize: async () => undefined,
        sendInput: async () => undefined,
        setViewport: async () => ({ width: 1, height: 1 }),
        hasViewers: () => false,
        activeCount: 0,
      },
      serverVersion: '0',
      epoch: 'e',
    });

  it('closes refused sockets right after the upgrade with the verdict code', () => {
    const handler = websocketHandler(hub(), new CollectingLogger());
    const s = socket({ principal: null, closeCode: 4401, connection: undefined });
    handler.open(s.ws);
    expect(s.closes).toEqual([4401]);
  });

  it('registers accepted sockets, sends hello and unregisters on close', () => {
    const h = hub();
    const handler = websocketHandler(h, new CollectingLogger());
    const s = socket({ principal: OPERATOR, closeCode: null, connection: undefined });
    handler.open(s.ws);
    expect(s.sent).toHaveLength(1);
    expect(h.connections()).toHaveLength(1);
    handler.close(s.ws, 1000, '');
    expect(h.connections()).toHaveLength(0);
  });
});
