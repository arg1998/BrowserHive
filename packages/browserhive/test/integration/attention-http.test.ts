/** @module test/integration/attention-http.test — a blocked `request_attention` over real Streamable HTTP returns once an operator resolves it over REST, even after the SSE stream sat idle past Bun's idle timeout; session counts track the attention lifecycle. */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
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

/**
 * How long the blocked call sits idle before the resolve. Bun cuts an idle stream after 10 s and
 * the SDK client gives up after two resume attempts (~33 s), so 40 s would fail if the idle timeout were not disabled on `/mcp`.
 */
const IDLE_MS = Number(process.env['BH_ATTENTION_IDLE_MS'] ?? 40_000);

function seeded(pattern: RegExp): string {
  const match = pattern.exec(output.out.join('\n'));
  if (match?.[1] === undefined) throw new Error(`banner lacks ${pattern}`);
  return match[1];
}

async function mcpClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { 'x-bh-agent-model': 'test-model', 'x-bh-workspace': 'att-bot' } },
  });
  const client = new Client({ name: 'attention-http-test', version: '1.0.0' });
  await client.connect(transport as Transport);
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = Array.isArray(result.content) ? result.content : [];
  const first: unknown = content[0];
  const text =
    typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string'
      ? first.text
      : 'null';
  return JSON.parse(text);
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', origin: base, cookie, ...init.headers },
  });
}

async function json(path: string): Promise<Record<string, unknown>> {
  const res = await api(path);
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null) throw new Error('not an object');
  return { ...body };
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > until) throw new Error('condition not met in time');
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  pages = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response('<!doctype html><title>fixture</title><p>hello</p>', {
        headers: { 'content-type': 'text/html' },
      }),
  });
  dir = tempDir('bh-attention-http-');
  const input = bootInputFor(dir.path, {
    admin: true,
    auth: 'off',
    defaultHeadless: true,
    minAttentionWait: 0,
  });
  output = input.output;
  server = await bootServer(input);
  base = server.url ?? '';
  const password = seeded(/first-run password: (\S+)/);
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ password }),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  // First-run credentials must be rotated before any other admin route answers.
  const change = await api('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password: password, new_password: 'attention-password-42' }),
  });
  expect(change.status).toBe(200);
});

afterAll(async () => {
  await server.stop();
  pages?.stop(true);
  dir.cleanup();
});

describe('request_attention over Streamable HTTP', () => {
  it(
    'returns after a REST resolve that happens past the idle timeout; counts follow',
    async () => {
      const client = await mcpClient();
      const launched = textOf(
        await client.callTool({ name: 'launch_session', arguments: { slug: 'att-http' } }),
      );
      const sessionId =
        typeof launched === 'object' && launched !== null && 'session_id' in launched
          ? String(launched.session_id)
          : '';
      expect(sessionId).not.toBe('');

      await client.callTool({
        name: 'navigate',
        arguments: { session_id: sessionId, url: `http://127.0.0.1:${pages?.port}/one` },
      });
      await client.callTool({ name: 'list_tabs', arguments: { session_id: sessionId } });
      // A soft failure still counts as a call and as an error.
      await client.callTool({
        name: 'click',
        arguments: { session_id: sessionId, selector: '#missing', timeout: 500 },
      });
      const before = await json(`/sessions/${sessionId}`);
      // The launching client, from `initialize` plus the X-BH-* headers (spec 03 §4.2).
      const launchedBy = {
        name: 'attention-http-test',
        version: '1.0.0',
        agent_name: 'att-bot',
        model: 'test-model',
      };
      expect(before['session']).toMatchObject({ client: launchedBy });
      // launch_session + navigate + list_tabs + click
      const expected = { tool_calls: 4, errors: 1, pages: 1, attention_open: 0 };
      expect(before['counts']).toMatchObject(expected);
      expect(before['session']).toMatchObject({ counts: expected });
      // The failure lands in the operator inbox as one grouped row labelled with the slug.
      const inbox = await waitFor(async () => {
        const page = await json('/notifications?type=error');
        const rows = Array.isArray(page['data']) ? page['data'] : [];
        return rows.length > 0 ? rows : null;
      });
      expect(inbox).toEqual([
        expect.objectContaining({
          session_id: sessionId,
          session_slug: 'att-http',
          title: 'att-http · 1 tool error',
          count: 1,
          target: `/sessions/${sessionId}?kinds=tool&errors_only=1`,
        }),
      ]);
      const listed = await json('/sessions?view=live');
      expect(listed['data']).toEqual([
        expect.objectContaining({
          session_id: sessionId,
          counts: expect.objectContaining(expected),
        }),
      ]);

      const pending = client.callTool(
        {
          name: 'request_attention',
          arguments: { session_id: sessionId, reason: 'solve the captcha', mode: 'takeover' },
        },
        undefined,
        { timeout: 600_000 },
      );
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      const open = await waitFor(async () => {
        const page = await json(`/attention?status=pending&session_id=${sessionId}`);
        const rows = Array.isArray(page['data']) ? page['data'] : [];
        const row: unknown = rows[0];
        return typeof row === 'object' && row !== null && 'request_id' in row
          ? String(row.request_id)
          : null;
      });

      const detail = await json(`/sessions/${sessionId}`);
      expect(detail['counts']).toMatchObject({ attention_open: 1 });
      expect(detail['session']).toMatchObject({ counts: { attention_open: 1 } });

      // Takeover input over REST while the request is open lands in the operator audit as one
      // coalesced row, counts only (spec 03 §6.3).
      const typed = await api(`/sessions/${sessionId}/input`, {
        method: 'POST',
        body: JSON.stringify({
          inputs: [
            { type: 'mouse', action: 'mouseMoved', x: 10, y: 10 },
            { type: 'key', action: 'keyDown', key: 'a' },
            { type: 'key', action: 'keyUp', key: 'a' },
          ],
        }),
      });
      expect(await typed.json()).toEqual({ accepted: 3, rejected: [] });
      const audited = await waitFor(async () => {
        const db = new Database(join(dir.path, 'browserhive.db'), { readonly: true });
        try {
          const row = db
            .query(
              "SELECT principal_id, details_json FROM operator_actions WHERE action = 'input' AND resource_id = ?",
            )
            .get(sessionId) as { principal_id: string; details_json: string } | null;
          return row;
        } finally {
          db.close();
        }
      });
      expect(JSON.parse(audited.details_json)).toEqual({
        inputs: 3,
        mouse: 1,
        key: 2,
        touch: 0,
        via: ['rest'],
        window_ms: 1000,
      });
      expect(audited.principal_id).not.toBe('unknown');

      // Let the SSE response stream sit idle longer than Bun's default idle timeout (10 s).
      await Bun.sleep(IDLE_MS);
      expect(settled).toBe(false);

      const resolve = await api(`/attention/${open}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'resolve', message: 'done' }),
      });
      expect(resolve.status).toBe(200);

      const outcome = await Promise.race([
        pending.then(textOf),
        Bun.sleep(10_000).then(() => 'still blocked'),
      ]);
      expect(outcome).toMatchObject({ status: 'resolved', message: 'done', request_id: open });

      const after = await json(`/sessions/${sessionId}`);
      expect(after['counts']).toMatchObject({ attention_open: 0 });
      expect(after['session']).toMatchObject({ counts: { attention_open: 0 } });
      // request_attention itself is a completed call now.
      expect(after['counts']).toMatchObject({ tool_calls: 5 });
      expect(after['session']).toMatchObject({ counts: { tool_calls: 5, errors: 1, pages: 1 } });

      await client.callTool({ name: 'close_session', arguments: { session_id: sessionId } });
      await client.close();
      // Closed, the summary comes from the stored row: the client survives through the join.
      const closed = await waitFor(async () => {
        const page = await json(`/sessions/${sessionId}`);
        const session = page['session'];
        return typeof session === 'object' && session !== null && 'live' in session && !session.live
          ? session
          : null;
      });
      expect(closed).toMatchObject({ client: launchedBy });
    },
    { timeout: 180_000 },
  );
});
