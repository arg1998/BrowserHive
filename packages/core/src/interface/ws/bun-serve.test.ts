/** @module interface/ws/bun-serve.test — end-to-end over a real `Bun.serve` on port 0: cookie upgrade with `browserhive.v1`, hello, subscribe + event, and 4401 for an anonymous upgrade. */

import { afterEach, describe, expect, it } from 'bun:test';
import { WsServerMessage } from '@browserhive/contracts/ws';
import { createHttpKit } from '../../../test/helpers/http-kit.ts';
import { createRealtimeHub } from './index.ts';

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

async function serve() {
  const kit = await createHttpKit({ seed: false });
  const realtime = createRealtimeHub({
    clock: kit.clock,
    ids: kit.authKit.ids,
    logger: kit.logger,
    auth: kit.authService,
    attention: kit.attention,
    serverVersion: '0.1.0',
    epoch: 'test-epoch',
    bus: kit.bus,
    sessions: kit.sessions,
    pageOf: (s) => kit.sessions.page(s),
    bridges: async () => {
      throw new Error('no cdp in this test');
    },
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    every: () => () => undefined,
  });
  realtime.start();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, srv) => kit.http.fetch(request, srv),
    websocket: realtime.websocket,
  });
  servers.push(server);
  return {
    kit,
    realtime,
    url: `ws://127.0.0.1:${server.port}/api/v1/ws`,
    origin: `http://127.0.0.1:${server.port}`,
  };
}

function nextMessage(ws: WebSocket): Promise<ReturnType<typeof WsServerMessage.parse>> {
  return new Promise((resolve) => {
    ws.addEventListener(
      'message',
      (e) => resolve(WsServerMessage.parse(JSON.parse(String(e.data)))),
      { once: true },
    );
  });
}

describe('realtime over Bun.serve', () => {
  it('upgrades with the subprotocol, sends hello, and delivers subscribed events', async () => {
    const { kit, realtime, url, origin } = await serve();
    const login = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ password: 'correct horse battery' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const ws = new WebSocket(url, {
      headers: { cookie, origin },
      protocols: ['browserhive.v1'],
    } as unknown as string[]);
    const hello = await nextMessage(ws);
    expect(ws.protocol).toBe('browserhive.v1');
    expect(hello).toMatchObject({ kind: 'reply', payload: { type: 'hello', epoch: 'test-epoch' } });
    ws.send(JSON.stringify({ type: 'subscribe', topic: 'system', corr: 'a' }));
    expect((await nextMessage(ws)).kind).toBe('reply');
    const eventPromise = nextMessage(ws);
    kit.bus.publish('system.tick', { type: 'system.tick', now: 5 });
    expect(await eventPromise).toMatchObject({
      kind: 'event',
      topic: 'system',
      payload: { type: 'system.tick', now: 5 },
    });
    ws.close();
    await realtime.stop();
  });

  it('closes an anonymous upgrade with 4401', async () => {
    const { url, origin } = await serve();
    const ws = new WebSocket(url, {
      headers: { origin },
      protocols: ['browserhive.v1'],
    } as unknown as string[]);
    const code = await new Promise<number>((resolve) =>
      ws.addEventListener('close', (e) => resolve(e.code)),
    );
    expect(code).toBe(4401);
  });
});
