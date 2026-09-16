/** @module test/integration/screencast-ws.test — live view over a real WS socket and Chromium: set_size, StrictMode start/stop/start, restart after the grace teardown, a first frame on a static page, following the agent's tab switch, and no internal errors in the log. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  readScreencastHeader,
  type ScreencastFrameHeader,
  WS_SUBPROTOCOL,
} from '@browserhive/contracts/ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { bootServer, type RunningServer } from '../../src/composition/index.ts';
import { bootInputFor, type CapturedOutput, tempDir } from '../composition/support.ts';

let dir: ReturnType<typeof tempDir>;
let server: RunningServer;
let output: CapturedOutput;
let base = '';
let cookie = '';
let pages: ReturnType<typeof Bun.serve> | undefined;
let client: Client;

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

/** A dashboard-like WS client that records every text and binary frame. */
class LiveSocket {
  readonly texts: Json[] = [];
  readonly frames: ScreencastFrameHeader[] = [];
  private readonly ws: WebSocket;
  private corr = 0;

  constructor() {
    this.ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/ws`, {
      protocols: [WS_SUBPROTOCOL],
      headers: { cookie, origin: base },
    });
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('message', (event) => {
      const data: unknown = event.data;
      if (typeof data === 'string') {
        this.texts.push(record(JSON.parse(data)));
        return;
      }
      if (data instanceof ArrayBuffer) {
        const header = readScreencastHeader(new Uint8Array(data));
        if (header !== null) this.frames.push(header);
      }
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('ws failed')));
    });
  }

  /** Sends a command with a fresh `corr` and returns that corr (does not wait). */
  send(command: Json): string {
    this.corr += 1;
    const corr = `k${this.corr}`;
    this.ws.send(JSON.stringify({ ...command, corr }));
    return corr;
  }

  /** The `reply` or `error` frame answering `corr`. */
  async answer(corr: string): Promise<Json> {
    return waitFor(async () => this.texts.find((t) => t['corr'] === corr) ?? null);
  }

  /** Index of the first text frame matching `predicate`, or -1. */
  indexOf(predicate: (payload: Json, frame: Json) => boolean): number {
    return this.texts.findIndex((t) => predicate(record(t['payload']), t));
  }

  close(): void {
    this.ws.close();
  }
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > until) throw new Error('condition not met in time');
    await Bun.sleep(25);
  }
}

async function tool(name: string, args: Json): Promise<Json> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const first = record(content[0]);
  return record(JSON.parse(typeof first['text'] === 'string' ? first['text'] : '{}'));
}

async function staticSession(slug: string): Promise<string> {
  const launched = await tool('launch_session', { slug });
  const sessionId = String(launched['session_id']);
  await tool('navigate', {
    session_id: sessionId,
    url: `http://127.0.0.1:${pages?.port}/red`,
  });
  return sessionId;
}

function ok(answer: Json): void {
  expect(answer['kind']).toBe('reply');
}

beforeAll(async () => {
  pages = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const color = new URL(request.url).pathname.slice(1) || 'white';
      return new Response(
        `<!doctype html><title>${color}</title><body style="margin:0;background:${color}"><h1>${color}</h1>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
  dir = tempDir('bh-screencast-ws-');
  const input = bootInputFor(dir.path, { admin: true, auth: 'off', defaultHeadless: true });
  output = input.output;
  server = await bootServer(input);
  base = server.url ?? '';
  const password = /first-run password: (\S+)/.exec(output.out.join('\n'))?.[1] ?? '';
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ password }),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const change = await fetch(`${base}/api/v1/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ current_password: password, new_password: 'screencast-password-42' }),
  });
  expect(change.status).toBe(200);
  client = new Client({ name: 'screencast-ws-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)) as Transport);
});

afterAll(async () => {
  await client.close();
  await server.stop();
  pages?.stop(true);
  dir.cleanup();
});

describe('screencast over WS against Chromium', () => {
  it(
    'a static page gets a first frame after `started`, with a real header and meta first',
    async () => {
      const sessionId = await staticSession('sc-static');
      const socket = new LiveSocket();
      await socket.opened();
      const start = socket.send({ type: 'screencast.start', session_id: sessionId });
      const reply = await socket.answer(start);
      ok(reply);
      const ordinal = Number(record(reply['payload'])['ordinal']);
      const frame = await waitFor(
        async () => socket.frames.find((f) => f.ordinal === ordinal) ?? null,
      );
      expect(frame.width).toBe(1280);
      expect(frame.height).toBe(720);
      const started = socket.indexOf((p) => p['type'] === 'started' && p['ordinal'] === ordinal);
      const meta = socket.indexOf((p) => p['type'] === 'meta' && p['ordinal'] === ordinal);
      expect(started).toBeGreaterThanOrEqual(0);
      expect(meta).toBeGreaterThan(started);
      expect(record(socket.texts[meta]?.['payload'])).toMatchObject({
        device_width: 1280,
        device_height: 720,
      });
      socket.close();
      await tool('close_session', { session_id: sessionId });
    },
    { timeout: 60_000 },
  );

  it(
    'set_size replies ok and pushes a fresh frame',
    async () => {
      const sessionId = await staticSession('sc-resize');
      const socket = new LiveSocket();
      await socket.opened();
      ok(await socket.answer(socket.send({ type: 'screencast.start', session_id: sessionId })));
      await waitFor(async () => (socket.frames.length > 0 ? true : null));
      const before = socket.frames.length;
      const resize = socket.send({
        type: 'screencast.set_size',
        session_id: sessionId,
        max_width: 640,
        max_height: 360,
      });
      const answer = await socket.answer(resize);
      expect(answer).toMatchObject({ kind: 'reply', payload: { type: 'ok' } });
      await waitFor(async () => (socket.frames.length > before ? true : null));
      socket.close();
      await tool('close_session', { session_id: sessionId });
    },
    { timeout: 60_000 },
  );

  it(
    'StrictMode start → stop → start, sent back to back, all succeed and the last start streams',
    async () => {
      const sessionId = await staticSession('sc-strict');
      const socket = new LiveSocket();
      await socket.opened();
      const cmd = { session_id: sessionId, max_width: 1280, max_height: 720 };
      const s1 = socket.send({ type: 'screencast.start', ...cmd });
      const x1 = socket.send({ type: 'screencast.stop', session_id: sessionId });
      const s2 = socket.send({ type: 'screencast.start', ...cmd });
      const x2 = socket.send({ type: 'screencast.stop', session_id: sessionId });
      const s3 = socket.send({ type: 'screencast.start', ...cmd });
      const answers = await Promise.all([s1, x1, s2, x2, s3].map((c) => socket.answer(c)));
      expect(answers.map((a) => a['kind'])).toEqual(['reply', 'reply', 'reply', 'reply', 'reply']);
      const ordinal = Number(record(answers[4]?.['payload'])['ordinal']);
      await waitFor(async () => socket.frames.find((f) => f.ordinal === ordinal) ?? null);
      socket.close();
      await tool('close_session', { session_id: sessionId });
    },
    { timeout: 60_000 },
  );

  it(
    'a start right after the grace teardown opens a fresh bridge that streams',
    async () => {
      const sessionId = await staticSession('sc-grace');
      const socket = new LiveSocket();
      await socket.opened();
      ok(await socket.answer(socket.send({ type: 'screencast.start', session_id: sessionId })));
      ok(await socket.answer(socket.send({ type: 'screencast.stop', session_id: sessionId })));
      await Bun.sleep(5_000);
      const again = await socket.answer(
        socket.send({ type: 'screencast.start', session_id: sessionId }),
      );
      ok(again);
      const ordinal = Number(record(again['payload'])['ordinal']);
      await waitFor(async () => socket.frames.find((f) => f.ordinal === ordinal) ?? null);
      socket.close();
      await tool('close_session', { session_id: sessionId });
    },
    { timeout: 60_000 },
  );

  it(
    "follows the agent's tab switch: meta and frames keep coming on the same ordinal",
    async () => {
      const sessionId = await staticSession('sc-tabs');
      const socket = new LiveSocket();
      await socket.opened();
      const reply = await socket.answer(
        socket.send({ type: 'screencast.start', session_id: sessionId }),
      );
      const ordinal = Number(record(reply['payload'])['ordinal']);
      await waitFor(async () => socket.frames.find((f) => f.ordinal === ordinal) ?? null);
      await Bun.sleep(300);
      const beforeNewTab = socket.frames.length;
      const metasBefore = socket.texts.length;
      const opened = await tool('new_tab', { session_id: sessionId });
      await tool('navigate', {
        session_id: sessionId,
        tab_id: String(opened['tab_id']),
        url: `http://127.0.0.1:${pages?.port}/blue`,
      });
      // The old tab is static, so frames after this point can only come from the new tab.
      await waitFor(async () => (socket.frames.length > beforeNewTab ? true : null));
      await waitFor(async () =>
        socket.texts.slice(metasBefore).some((t) => record(t['payload'])['type'] === 'meta')
          ? true
          : null,
      );
      expect(socket.frames.slice(beforeNewTab).every((f) => f.ordinal === ordinal)).toBe(true);
      socket.close();
      await tool('close_session', { session_id: sessionId });
    },
    { timeout: 60_000 },
  );

  it('logged no internal WS command failures', async () => {
    const res = await fetch(`${base}/api/v1/logs?level=error&limit=1000`, {
      headers: { origin: base, cookie },
    });
    expect(res.status).toBe(200);
    const body = record(await res.json());
    const rows = Array.isArray(body['data']) ? body['data'].map(record) : [];
    expect(rows.filter((r) => String(r['module']).startsWith('ws'))).toEqual([]);
  });
});
