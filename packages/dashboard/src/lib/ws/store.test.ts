/** @module lib/ws/store.test — handshake, resubscribe with cursors on reconnect, dedupe, bounded backoff, protocol/epoch mismatch, close codes, commands, drops */
import { describe, expect, it } from 'bun:test';
import { FakeSocket, FakeTimers } from '../../../test/helpers/fake-socket.ts';
import { type SocketHooks, SocketStore } from './store.ts';

function setup(
  hooks: SocketHooks = {},
  overrides: Partial<ConstructorParameters<typeof SocketStore>[0]> = {},
) {
  const sockets: FakeSocket[] = [];
  const timers = new FakeTimers();
  const store = new SocketStore({
    url: 'ws://test/api/v1/ws',
    createSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    timers,
    clock: () => timers.now,
    random: () => 0,
    hooks,
    ...overrides,
  });
  return { store, sockets, timers, latest: () => sockets[sockets.length - 1] as FakeSocket };
}

const event = (topic: string, seq: number, payload: unknown) => ({
  v: 1,
  kind: 'event',
  seq,
  ts: seq,
  topic,
  payload,
});

describe('SocketStore', () => {
  it('offers the subprotocol, completes the hello handshake and subscribes active topics', () => {
    const { store, latest } = setup();
    store.subscribe('sessions', () => undefined);
    store.connect();
    expect(latest().protocols).toEqual(['browserhive.v1']);
    expect(store.getState().status).toBe('connecting');
    latest().hello('e1');
    expect(store.getState().status).toBe('connected');
    expect(store.getState().epoch).toBe('e1');
    expect(latest().sentOfType('subscribe')).toEqual([{ type: 'subscribe', topic: 'sessions' }]);
  });

  it('delivers every log record although they share the feed-head seq, and never resumes logs by cursor', () => {
    const records: string[] = [];
    const { store, timers, latest } = setup();
    store.subscribe('logs', (payload) => {
      records.push((payload as unknown as { record: { msg: string } }).record.msg);
    });
    store.connect();
    latest().hello('e1');
    const log = (msg: string) => ({
      type: 'log.record',
      record: { seq: 1, ts: 1, level: 'info', module: 'http', msg },
    });
    latest().receive(event('logs', 350, log('a')));
    latest().receive(event('logs', 350, log('b')));
    latest().receive(event('logs', 351, log('c')));
    expect(records).toEqual(['a', 'b', 'c']);
    latest().serverClose(1006);
    timers.advance(500);
    latest().hello('e1');
    expect(latest().sentOfType('subscribe')).toEqual([{ type: 'subscribe', topic: 'logs' }]);
  });

  it('dedupes events per topic and resubscribes with the last cursor after a reconnect', () => {
    const seen: number[] = [];
    let reconnected = 0;
    const { store, timers, latest } = setup({ onReconnected: () => reconnected++ });
    store.subscribe('sessions', (_e, meta) => seen.push(meta.seq));
    store.connect();
    latest().hello('e1');
    const payload = { type: 'system.capacity', live: 1, max: 4 };
    latest().receive(event('sessions', 5, payload));
    latest().receive(event('sessions', 5, payload));
    latest().receive(event('sessions', 7, payload));
    expect(seen).toEqual([5, 7]);
    latest().serverClose(1006);
    expect(store.getState().status).toBe('connecting');
    timers.advance(500);
    latest().hello('e1');
    expect(reconnected).toBe(1);
    expect(latest().sentOfType('subscribe')).toEqual([
      { type: 'subscribe', topic: 'sessions', cursor: 7 },
    ]);
  });

  it('backs off 500·2ⁿ capped at 8 s and shows offline after the attempt threshold', () => {
    const { store, timers, sockets, latest } = setup({}, { offlineAfterAttempts: 2 });
    store.connect();
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      latest().serverClose(1006);
      const pending = timers.pending()[0] ?? 0;
      delays.push(pending);
      timers.advance(pending);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    expect(store.getState().status).toBe('offline');
    expect(store.getState().reason).toBe('network');
    expect(sockets.length).toBe(7);
    latest().hello('e1');
    expect(store.getState().status).toBe('connected');
    expect(store.getState().attempt).toBe(0);
  });

  it('stops on protocol mismatch and 4401/4403 close codes', () => {
    const hooks: string[] = [];
    const { store, latest, timers } = setup({
      onProtocolMismatch: () => hooks.push('protocol'),
      onUnauthorized: () => hooks.push('unauthorized'),
      onPasswordChangeRequired: () => hooks.push('change'),
    });
    store.connect();
    latest().open();
    latest().receive({
      v: 1,
      kind: 'reply',
      seq: 0,
      ts: 1,
      payload: {
        type: 'hello',
        protocol: 'browserhive.v1',
        protocol_version: 1,
        epoch: 'e',
        cursor: 0,
        server_version: '9',
        now: 1,
      },
    });
    expect(store.getState().status).toBe('connected');
    latest().serverClose(4401);
    expect(store.getState()).toMatchObject({ status: 'offline', reason: 'unauthorized' });
    expect(timers.pending()).toEqual([]);
    expect(hooks).toEqual(['unauthorized']);
    const second = setup({ onPasswordChangeRequired: () => hooks.push('change') });
    second.store.connect();
    second.latest().serverClose(4403);
    expect(second.store.getState().reason).toBe('password_change');
    const third = setup({ onProtocolMismatch: () => hooks.push('protocol') });
    third.store.connect();
    third.latest().serverClose(4406);
    expect(third.store.getState().protocolMismatch).toBe(true);
    expect(hooks).toEqual(['unauthorized', 'change', 'protocol']);
  });

  it('resyncs on epoch change and cursor expiry', () => {
    const resyncs: string[] = [];
    const { store, timers, latest } = setup({
      onResync: (reason, topic) => resyncs.push(`${reason}:${topic ?? '*'}`),
    });
    store.subscribe('attention', () => undefined);
    store.connect();
    latest().hello('e1');
    latest().receive(event('attention', 3, { type: 'system.tick', now: 1 }));
    latest().receive({
      v: 1,
      kind: 'reply',
      seq: 1,
      ts: 1,
      payload: { type: 'subscribed', topic: 'attention', from: 0, to: 3, complete: false },
    });
    latest().serverClose(1006);
    timers.advance(500);
    latest().hello('e2');
    expect(resyncs).toEqual(['cursor_expired:attention', 'epoch_changed:*']);
    expect(latest().sentOfType('subscribe')).toEqual([{ type: 'subscribe', topic: 'attention' }]);
  });

  it('correlates commands, rejects on error frames and drops when disconnected', async () => {
    const dropped: string[] = [];
    const { store, latest } = setup({ onDrop: (c) => dropped.push(c.type) });
    await expect(store.command('ping', {})).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(dropped).toEqual(['ping']);
    store.connect();
    latest().hello('e1');
    const reply = store.command('screencast.start', { session_id: 'shop-a1b2c3d4' as never });
    const sent = latest().sentOfType('screencast.start')[0];
    expect(typeof sent?.['corr']).toBe('string');
    latest().receive({
      v: 1,
      kind: 'reply',
      seq: 2,
      ts: 1,
      corr: sent?.['corr'],
      payload: { type: 'screencast.started', topic: 'screencast:shop-a1b2c3d4', ordinal: 1 },
    });
    await expect(reply).resolves.toMatchObject({ type: 'screencast.started', ordinal: 1 });
    const failing = store.command('ping', {});
    const corr = latest().sentOfType('ping')[0]?.['corr'];
    latest().receive({
      v: 1,
      kind: 'error',
      seq: 3,
      ts: 1,
      corr,
      payload: { code: 'INPUT_NOT_PERMITTED', title: 'Not permitted' },
    });
    await expect(failing).rejects.toMatchObject({ title: 'Not permitted' });
  });

  it('pings every 20 s and closes a stale socket after 45 s of silence', () => {
    const { store, timers, latest } = setup();
    store.connect();
    latest().hello('e1');
    timers.advance(20_000);
    expect(latest().sentOfType('ping').length).toBe(1);
    timers.advance(40_000);
    expect(latest().closedWith?.code).toBe(4000);
  });

  it('routes binary frames by ordinal to stream handlers, latest-wins', () => {
    const frames: number[] = [];
    const { store, latest } = setup();
    store.stream('screencast:shop-a1b2c3d4', { frame: (f) => frames.push(f.header.seq) });
    store.connect();
    latest().hello('e1');
    latest().receive({
      v: 1,
      kind: 'stream',
      seq: 4,
      ts: 1,
      topic: 'screencast:shop-a1b2c3d4',
      payload: { type: 'started', session_id: 'shop-a1b2c3d4', ordinal: 7 },
    });
    const frame = (seq: number) => {
      const bytes = new Uint8Array(20);
      bytes.set([66, 72, 83, 67]);
      new DataView(bytes.buffer).setUint32(4, 7);
      new DataView(bytes.buffer).setUint32(8, seq);
      return bytes;
    };
    latest().receiveBinary(frame(1));
    latest().receiveBinary(frame(3));
    latest().receiveBinary(frame(2));
    expect(frames).toEqual([1, 3]);
    store.dispose();
    expect(store.getState().status).toBe('idle');
  });
});
