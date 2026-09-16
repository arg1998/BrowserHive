/// <reference types="bun-types" />
/** @module contracts/test/goldens/ws/transcript.test — fixed client/server exchange validated against the schemas and blessed as JSON */
import { describe, expect, it } from 'bun:test';
import { WS_SUBPROTOCOL, WsClientCommand, WsServerMessage } from '../../../src/ws/index.ts';
import * as fx from '../../http/fixtures.ts';

const GOLDEN = new URL('./transcript.json', import.meta.url).pathname;
const UPDATE = Bun.env['UPDATE_GOLDENS'] === '1';

interface Frame {
  readonly dir: 'in' | 'out';
  readonly frame: unknown;
}

const out = (kind: string, seq: number, rest: Record<string, unknown>): Frame => ({
  dir: 'out',
  frame: { v: 1, kind, seq, ts: fx.NOW + seq, ...rest },
});
const inp = (frame: Record<string, unknown>): Frame => ({ dir: 'in', frame });

/** The canonical exchange: hello, subscribe with replay, feed events, screencast, input gate, ping. */
function buildTranscript(): readonly Frame[] {
  const session = `session:${fx.SESSION_ID}`;
  const screencast = `screencast:${fx.SESSION_ID}`;
  return [
    out('reply', 0, {
      payload: {
        type: 'hello',
        protocol: WS_SUBPROTOCOL,
        protocol_version: 1,
        epoch: '01J8XW3N5Q4R6T8V0Y2Z4A6C8E',
        cursor: 41,
        server_version: '1.0.0',
        now: fx.NOW,
      },
    }),
    inp({ type: 'subscribe', topic: 'sessions', cursor: 40, corr: 'c1' }),
    out('event', 41, {
      topic: 'sessions',
      payload: { type: 'session.opened', session: fx.sessionSummary() },
    }),
    out('reply', 42, {
      corr: 'c1',
      payload: { type: 'subscribed', topic: 'sessions', from: 41, to: 41, complete: true },
    }),
    inp({ type: 'subscribe', topic: session, cursor: 3, corr: 'c2' }),
    out('reply', 43, {
      corr: 'c2',
      payload: { type: 'resync_required', topic: session, reason: 'cursor_expired' },
    }),
    out('event', 44, {
      topic: session,
      payload: { type: 'tool.called', row: fx.toolCallRow(), has_detail: true },
    }),
    out('event', 45, { topic: session, payload: { type: 'page.visited', row: fx.pageRow() } }),
    out('event', 46, {
      topic: 'attention',
      payload: { type: 'attention.created', request: fx.operatorRequestRow() },
    }),
    out('event', 47, {
      topic: 'notifications',
      payload: { type: 'notification.created', notification: fx.notification() },
    }),
    inp({
      type: 'screencast.start',
      session_id: fx.SESSION_ID,
      max_width: 1280,
      max_height: 720,
      quality: 70,
      corr: 'c3',
    }),
    out('reply', 48, {
      corr: 'c3',
      payload: { type: 'screencast.started', topic: screencast, ordinal: 1 },
    }),
    out('stream', 49, {
      topic: screencast,
      payload: { type: 'started', session_id: fx.SESSION_ID, ordinal: 1 },
    }),
    out('stream', 50, {
      topic: screencast,
      payload: {
        type: 'meta',
        session_id: fx.SESSION_ID,
        ordinal: 1,
        device_width: 1280,
        device_height: 720,
        page_scale: 1,
        offset_top: 0,
      },
    }),
    inp({
      type: 'input',
      session_id: fx.SESSION_ID,
      input: { type: 'mouse', action: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 },
      corr: 'c4',
    }),
    out('reply', 51, { corr: 'c4', payload: { type: 'ok' } }),
    inp({
      type: 'input',
      session_id: fx.SESSION_ID,
      input: { type: 'key', action: 'keyDown', key: 'Enter', code: 'Enter' },
      corr: 'c5',
    }),
    out('error', 52, {
      corr: 'c5',
      payload: {
        code: 'INPUT_NOT_PERMITTED',
        title: 'Input not permitted',
        details: { session_id: fx.SESSION_ID },
      },
    }),
    inp({
      type: 'session.set_viewport',
      session_id: fx.SESSION_ID,
      width: 1366,
      height: 768,
      corr: 'c6',
    }),
    out('reply', 53, { corr: 'c6', payload: { type: 'ok', result: { width: 1366, height: 768 } } }),
    inp({
      type: 'screencast.set_size',
      session_id: fx.SESSION_ID,
      max_width: 1920,
      max_height: 1080,
    }),
    inp({ type: 'screencast.stop', session_id: fx.SESSION_ID }),
    out('stream', 54, {
      topic: screencast,
      payload: { type: 'stopped', session_id: fx.SESSION_ID, reason: 'stopped' },
    }),
    inp({ type: 'logs.tail', level: 'debug', module: 'sessions', corr: 'c7' }),
    out('reply', 55, {
      corr: 'c7',
      payload: { type: 'subscribed', topic: 'logs', from: 56, to: 56, complete: true },
    }),
    out('event', 56, { topic: 'logs', payload: { type: 'log.record', record: fx.logRecord() } }),
    out('event', 57, { topic: 'system', payload: { type: 'system.tick', now: fx.NOW + 57 } }),
    out('event', 58, {
      topic: 'system',
      payload: { type: 'system.degraded', event: fx.systemEvent() },
    }),
    out('event', 59, {
      topic: 'sessions',
      payload: {
        type: 'session.closed',
        session_id: fx.SESSION_ID,
        closed_at: fx.NOW + 59,
        reason: 'user',
      },
    }),
    inp({ type: 'ping' }),
    out('reply', 60, { payload: { type: 'pong', ts: fx.NOW + 60 } }),
    inp({ type: 'unsubscribe', topic: 'sessions', corr: 'c8' }),
    out('reply', 61, {
      corr: 'c8',
      payload: { type: 'unsubscribed', topic: 'sessions', ok: true },
    }),
  ];
}

describe('ws golden transcript', () => {
  const transcript = buildTranscript();

  it('every frame validates against the protocol schemas and survives parsing unchanged', () => {
    for (const { dir, frame } of transcript) {
      const r = dir === 'in' ? WsClientCommand.safeParse(frame) : WsServerMessage.safeParse(frame);
      if (!r.success)
        throw new Error(`${dir} frame invalid: ${JSON.stringify(frame)}\n${r.error.message}`);
      expect<unknown>(r.data).toEqual(frame);
    }
  });

  it('exercises every command type and every server kind', () => {
    const inTypes = new Set(
      transcript.filter((f) => f.dir === 'in').map((f) => WsClientCommand.parse(f.frame).type),
    );
    for (const option of WsClientCommand.options)
      expect(inTypes.has(option.shape.type.value)).toBe(true);
    const kinds = new Set(
      transcript.filter((f) => f.dir === 'out').map((f) => WsServerMessage.parse(f.frame).kind),
    );
    expect([...kinds].sort()).toEqual(['error', 'event', 'reply', 'stream']);
  });

  it('matches the committed golden (UPDATE_GOLDENS=1 to bless)', async () => {
    const rendered = `${JSON.stringify({ protocol: WS_SUBPROTOCOL, frames: transcript }, null, 2)}\n`;
    if (UPDATE) {
      await Bun.write(GOLDEN, rendered);
      return;
    }
    const committed = await Bun.file(GOLDEN).text();
    expect(JSON.parse(committed)).toEqual(JSON.parse(rendered));
  });
});
