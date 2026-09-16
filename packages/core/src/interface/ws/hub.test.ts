/** @module interface/ws/hub.test — envelope, hello, replay and resync, bounds, latest-wins screencast with backpressure drops (feed never dropped), 4401/4400/1001/1013, scopes, input gate, set_viewport ungated (spec 09 §3.2). */

import { beforeEach, describe, expect, it } from 'bun:test';
import { readScreencastHeader, WS_CLOSE } from '@browserhive/contracts/ws';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { FakeSocket } from '../../../test/helpers/fake-socket.ts';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { LiveViewPort } from './commands/host.ts';
import { RealtimeHub } from './hub.ts';
import type { ScreencastViewer } from './live-view.ts';

const OPERATOR: RequestPrincipal = {
  subject: 'admin',
  kind: 'operator',
  display: 'admin',
  auth: { method: 'password-session', sessionId: 'as-1' },
  scopes: [],
  tenantId: null,
  mustChangePassword: false,
};
const AGENT: RequestPrincipal = {
  ...OPERATOR,
  subject: 'bot',
  kind: 'agent',
  auth: { method: 'bearer' },
  scopes: ['mcp:tools'],
};
const SID = 'shop-00000001';

class FakeLive implements LiveViewPort {
  readonly viewers = new Map<string, ScreencastViewer>();
  /** `add:<id>` / `remove:<id>` in the order live view saw them complete. */
  readonly ops: string[] = [];
  /** Runs inside `addViewer` after registration (deliver early frames, delay, throw). */
  onAdd: ((viewer: ScreencastViewer) => Promise<void> | void) | undefined;
  readonly inputs: unknown[] = [];
  readonly viewports: { width: number; height: number }[] = [];
  readonly sizes: { width: number; height: number }[] = [];
  activeCount = 0;
  async addViewer(_s: string, viewer: ScreencastViewer) {
    this.viewers.set(viewer.id, viewer);
    this.activeCount = 1;
    await this.onAdd?.(viewer);
    this.ops.push(`add:${viewer.id}`);
  }
  async removeViewer(_s: string, id: string) {
    this.viewers.delete(id);
    this.ops.push(`remove:${id}`);
  }
  async setViewerSize(_s: string, _id: string, width: number, height: number) {
    this.sizes.push({ width, height });
  }
  async sendInput(_s: string, input: unknown) {
    this.inputs.push(input);
  }
  async setViewport(_s: string, width: number, height: number) {
    this.viewports.push({ width, height });
    return { width, height };
  }
  hasViewers() {
    return this.viewers.size > 0;
  }
}

let clock: FakeClock;
let logger: CollectingLogger;
let live: FakeLive;
let permitted: boolean;
let touch: boolean;
let hub: RealtimeHub;

function makeHub(limits = {}) {
  return new RealtimeHub({
    clock,
    ids: new FakeIdGenerator(),
    logger,
    auth: { touchSession: async () => touch },
    attention: { isInputPermitted: () => permitted },
    liveView: live,
    serverVersion: '0.1.0',
    epoch: 'epoch-1',
    limits,
  });
}

beforeEach(() => {
  clock = new FakeClock();
  logger = new CollectingLogger();
  live = new FakeLive();
  permitted = false;
  touch = true;
  hub = makeHub();
});

const send = (conn: Parameters<RealtimeHub['message']>[0], frame: object) =>
  hub.message(conn, JSON.stringify(frame));
const event = (now: number) => ({ type: 'system.tick' as const, now });

describe('handshake and envelope', () => {
  it('sends hello with protocol, epoch and cursor; every frame is a valid v1 envelope', async () => {
    const socket = new FakeSocket();
    hub.publish('system', event(1));
    const conn = hub.open(socket, OPERATOR);
    const hello = socket.last();
    expect(hello).toMatchObject({
      v: 1,
      kind: 'reply',
      payload: { type: 'hello', protocol: 'browserhive.v1', epoch: 'epoch-1', cursor: 1 },
    });
    await send(conn, { type: 'ping', corr: 'p1' });
    expect(socket.last()).toMatchObject({ kind: 'reply', corr: 'p1', payload: { type: 'pong' } });
  });
});

describe('feed', () => {
  it('delivers events on subscribed topics only, ordered by seq', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, { type: 'subscribe', topic: 'system' });
    socket.clear();
    hub.publish('system', event(1));
    hub.publish('logs', {
      type: 'log.record',
      record: { seq: 1, ts: 1, level: 'info', msg: 'm', module: 'x' },
    });
    hub.publish('system', event(2));
    expect(socket.messages().map((m) => [m.kind, m.seq])).toEqual([
      ['event', 1],
      ['event', 3],
    ]);
  });

  it('replays buffered events after the cursor, then replies subscribed complete', async () => {
    for (let i = 0; i < 3; i += 1) hub.publish('system', event(i));
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    socket.clear();
    await send(conn, { type: 'subscribe', topic: 'system', cursor: 1, corr: 's' });
    const messages = socket.messages();
    expect(messages.map((m) => m.kind)).toEqual(['event', 'event', 'reply']);
    expect(messages.slice(0, 2).map((m) => m.seq)).toEqual([2, 3]);
    expect(messages[2]).toMatchObject({
      corr: 's',
      payload: { type: 'subscribed', from: 1, to: 3, complete: true },
    });
  });

  it('answers resync_required when the cursor fell out of the bounded buffer', async () => {
    hub = makeHub({ count: 2 });
    for (let i = 0; i < 5; i += 1) hub.publish('system', event(i));
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    socket.clear();
    await send(conn, { type: 'subscribe', topic: 'system', cursor: 1 });
    expect(socket.messages().map((m) => m.payload)).toEqual([
      expect.objectContaining({ type: 'subscribed', complete: false }),
      { type: 'resync_required', topic: 'system', reason: 'cursor_expired' },
    ]);
  });

  it('checks topic scopes: an agent principal cannot subscribe to sessions', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, AGENT);
    await send(conn, { type: 'subscribe', topic: 'sessions', corr: 'x' });
    expect(socket.last()).toMatchObject({
      kind: 'error',
      corr: 'x',
      payload: { code: 'FORBIDDEN' },
    });
  });

  it('feed events are never dropped under backpressure; a dropped send closes 1013 for replay', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, { type: 'subscribe', topic: 'system' });
    socket.clear();
    socket.sendResults.push(-1);
    hub.publish('system', event(1));
    expect(socket.texts).toHaveLength(1);
    socket.sendResults.push(0);
    hub.publish('system', event(2));
    expect(socket.closed?.code).toBe(WS_CLOSE.OVERLOADED);
  });

  it('closes 1013 when bufferedAmount stays above the overload bound past the grace', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    socket.buffered = 5 * 1024 * 1024;
    hub.sweep();
    expect(socket.closed).toBeNull();
    await clock.advance(10_000);
    void conn;
    hub.sweep();
    expect(socket.closed?.code).toBe(WS_CLOSE.OVERLOADED);
  });
});

describe('screencast', () => {
  async function watching() {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, {
      type: 'screencast.start',
      session_id: SID,
      max_width: 800,
      max_height: 600,
      corr: 'c',
    });
    const viewer = [...live.viewers.values()][0];
    if (viewer === undefined) throw new Error('no viewer');
    return { socket, conn, viewer };
  }
  const jpeg = (b: number) => new Uint8Array([b]);

  it('replies with the ordinal and sends binary frames with the 16-byte header', async () => {
    const { socket, viewer } = await watching();
    expect(
      socket.messages().find((m) => m.kind === 'reply' && m.payload.type === 'screencast.started'),
    ).toBeDefined();
    viewer.frame({ jpeg: jpeg(7), width: 800, height: 600 });
    const header = readScreencastHeader(socket.binaries[0] ?? new Uint8Array());
    expect(header).toEqual({ magic: 'BHSC', ordinal: 1, seq: 1, width: 800, height: 600 });
    expect(socket.binaries[0]?.[16]).toBe(7);
  });

  it('is latest-wins: under backpressure only the newest frame is kept and flushed on drain', async () => {
    const { socket, conn, viewer } = await watching();
    socket.sendResults.push(-1);
    viewer.frame({ jpeg: jpeg(1), width: 1, height: 1 });
    viewer.frame({ jpeg: jpeg(2), width: 1, height: 1 });
    viewer.frame({ jpeg: jpeg(3), width: 1, height: 1 });
    expect(socket.binaries).toHaveLength(1);
    expect(conn.droppedFrames).toBe(1);
    hub.drain(conn);
    expect(socket.binaries.map((b) => b[16])).toEqual([1, 3]);
  });

  it('drops frames while bufferedAmount exceeds the screencast bound', async () => {
    const { socket, viewer } = await watching();
    socket.buffered = 2 * 1024 * 1024;
    viewer.frame({ jpeg: jpeg(1), width: 1, height: 1 });
    expect(socket.binaries).toHaveLength(0);
  });

  it('set_size re-issues the size; stop removes the viewer', async () => {
    const { socket, conn } = await watching();
    await send(conn, {
      type: 'screencast.set_size',
      session_id: SID,
      max_width: 1920,
      max_height: 1080,
    });
    expect(live.sizes).toEqual([{ width: 1920, height: 1080 }]);
    await send(conn, { type: 'screencast.stop', session_id: SID });
    expect(live.viewers.size).toBe(0);
    expect(socket.messages().some((m) => m.kind === 'stream' && m.payload.type === 'stopped')).toBe(
      true,
    );
  });
});

describe('screencast ordering, serialisation and error logging', () => {
  it('sends the reply and `started` before any meta or frame of the new ordinal', async () => {
    live.onAdd = (viewer) => {
      viewer.meta({ deviceWidth: 800, deviceHeight: 600, pageScale: 1, offsetTop: 0 });
      viewer.frame({ jpeg: new Uint8Array([5]), width: 800, height: 600 });
    };
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    socket.clear();
    await send(conn, { type: 'screencast.start', session_id: SID, corr: 'c' });
    const order = socket
      .messages()
      .map((m) =>
        m.kind === 'reply' ? m.payload.type : m.kind === 'stream' ? m.payload.type : m.kind,
      );
    expect(order).toEqual(['screencast.started', 'started', 'meta']);
    expect(socket.binaries).toHaveLength(1);
    expect(readScreencastHeader(socket.binaries[0] ?? new Uint8Array())).toMatchObject({
      ordinal: 1,
      seq: 1,
      width: 800,
      height: 600,
    });
  });

  it('applies stop → start of one session in arrival order even when start is slow', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    let release: (() => void) | undefined;
    live.onAdd = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const first = send(conn, { type: 'screencast.start', session_id: SID, corr: 's1' });
    const stop = send(conn, { type: 'screencast.stop', session_id: SID, corr: 'x1' });
    const second = send(conn, { type: 'screencast.start', session_id: SID, corr: 's2' });
    await Bun.sleep(0);
    expect(live.ops).toEqual([]);
    release?.();
    await Bun.sleep(0);
    release?.();
    await Promise.all([first, stop, second]);
    expect(live.ops).toEqual([`add:${conn.id}`, `remove:${conn.id}`, `add:${conn.id}`]);
    expect(conn.screencasts.get(SID)?.ordinal).toBe(2);
    const replies = socket.messages().filter((m) => m.kind === 'reply' || m.kind === 'error');
    expect(replies.map((m) => [m.kind, m.corr])).toEqual([
      ['reply', undefined],
      ['reply', 's1'],
      ['reply', 'x1'],
      ['reply', 's2'],
    ]);
  });

  it('logs an unexpected command failure with command, session and the ref the client got', async () => {
    live.onAdd = () => {
      throw new Error('Protocol error (Page.startScreencast): Screencast is already active');
    };
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, { type: 'screencast.start', session_id: SID, corr: 'c' });
    const error = socket.last();
    expect(error).toMatchObject({ kind: 'error', corr: 'c', payload: { code: 'INTERNAL_ERROR' } });
    const ref = error?.kind === 'error' ? error.payload.details : undefined;
    const record = logger.records.find((r) => r.msg === 'ws command failed');
    expect(record).toMatchObject({
      level: 'error',
      fields: {
        module: 'ws.hub',
        command: 'screencast.start',
        session_id: SID,
        connection_id: conn.id,
        ref: expect.any(String),
      },
    });
    expect(ref).toEqual({ ref: record?.fields['ref'] });
    expect(record?.fields['err']).toBeInstanceOf(Error);
    expect(conn.screencasts.size).toBe(0);
  });

  it('logs expected refusals at debug only', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, {
      type: 'input',
      session_id: SID,
      input: { type: 'key', action: 'char', text: 'a' },
    });
    expect(socket.last()).toMatchObject({
      kind: 'error',
      payload: { code: 'INPUT_NOT_PERMITTED' },
    });
    expect(logger.records.filter((r) => r.level === 'error')).toEqual([]);
    expect(logger.records.find((r) => r.msg === 'ws command refused')).toMatchObject({
      level: 'debug',
      fields: { command: 'input', code: 'INPUT_NOT_PERMITTED' },
    });
  });

  it('a `failed` from live view removes the subscription and streams `failed`', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, { type: 'screencast.start', session_id: SID });
    const viewer = live.viewers.get(conn.id);
    viewer?.failed(new AppError('SCREENCAST_FAILED', { session_id: SID, reason: 'gone' }));
    expect(conn.screencasts.size).toBe(0);
    expect(socket.last()).toMatchObject({
      kind: 'stream',
      payload: { type: 'failed', session_id: SID, code: 'SCREENCAST_FAILED' },
    });
  });
});

describe('input and viewport', () => {
  it('input without an open takeover is INPUT_NOT_PERMITTED and the socket stays up', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, {
      type: 'input',
      session_id: SID,
      input: { type: 'key', action: 'keyDown', key: 'a' },
      corr: 'i',
    });
    expect(socket.last()).toMatchObject({
      kind: 'error',
      corr: 'i',
      payload: { code: 'INPUT_NOT_PERMITTED' },
    });
    expect(socket.closed).toBeNull();
    permitted = true;
    await send(conn, {
      type: 'input',
      session_id: SID,
      input: { type: 'key', action: 'keyDown', key: 'a' },
    });
    expect(live.inputs).toHaveLength(1);
  });

  it('session.set_viewport is not attention-gated', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, {
      type: 'session.set_viewport',
      session_id: SID,
      width: 800,
      height: 600,
      corr: 'v',
    });
    expect(live.viewports).toEqual([{ width: 800, height: 600 }]);
    expect(socket.last()).toMatchObject({ kind: 'reply', corr: 'v', payload: { type: 'ok' } });
  });
});

describe('connection lifecycle', () => {
  it('five protocol violations close 4400', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    for (let i = 0; i < 4; i += 1) await hub.message(conn, '{not json');
    expect(socket.closed).toBeNull();
    await hub.message(conn, JSON.stringify({ type: 'teleport' }));
    expect(socket.closed?.code).toBe(WS_CLOSE.PROTOCOL_ERROR);
    expect(socket.messages().filter((m) => m.kind === 'error')).toHaveLength(5);
  });

  it('oversized frames are PAYLOAD_TOO_LARGE violations', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await hub.message(conn, 'x'.repeat(17 * 1024));
    expect(socket.last()).toMatchObject({ kind: 'error', payload: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('an expired operator session closes 4401 on the next command (including ping)', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    touch = false;
    await send(conn, { type: 'ping' });
    expect(socket.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  it("logout/revocation closes that session's sockets with 4401 only", () => {
    const mine = new FakeSocket();
    const other = new FakeSocket();
    hub.open(mine, OPERATOR);
    hub.open(other, { ...OPERATOR, auth: { method: 'password-session', sessionId: 'as-2' } });
    hub.closeAuthSession('as-1');
    expect(mine.closed?.code).toBe(4401);
    expect(other.closed).toBeNull();
    expect(hub.connections()).toHaveLength(1);
  });

  it('reaps sockets silent for 60 s with 1001 and releases their screencasts', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, { type: 'screencast.start', session_id: SID });
    await clock.advance(61_000);
    hub.sweep();
    expect(socket.closed?.code).toBe(WS_CLOSE.GOING_AWAY);
    expect(live.viewers.size).toBe(0);
  });

  it('reports realtime connections for /system/realtime', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, { type: 'subscribe', topic: 'sessions' });
    expect(hub.connections()[0]).toMatchObject({
      connection_id: conn.id,
      principal: 'admin',
      topics: ['sessions'],
    });
  });

  it('logs.tail filters log records by level and module', async () => {
    const socket = new FakeSocket();
    const conn = hub.open(socket, OPERATOR);
    await send(conn, { type: 'logs.tail', level: 'warn', module: 'auth' });
    socket.clear();
    hub.publishLog({ seq: 1, record: { ts: 1, level: 'info', msg: 'a', module: 'auth' } });
    hub.publishLog({ seq: 2, record: { ts: 1, level: 'error', msg: 'b', module: 'auth.chain' } });
    hub.publishLog({ seq: 3, record: { ts: 1, level: 'error', msg: 'c', module: 'http' } });
    expect(
      socket
        .messages()
        .map((m) =>
          m.kind === 'event' && m.payload.type === 'log.record' ? m.payload.record.msg : null,
        ),
    ).toEqual(['b']);
  });
});
