/** @module test/integration/single-port.test — one port serves MCP, REST, WS and health (spec 09 §3.4): in-process `bootServer` on port 0 for the protocol checks, plus the real `bin.ts` process for startup output and SIGTERM. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { ALL_TOOL_NAMES } from '@browserhive/contracts/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { bootServer, type RunningServer } from '../../src/composition/index.ts';
import { bootInputFor, type CapturedOutput, tempDir } from '../composition/support.ts';

const NEW_PASSWORD = 'integration-password-42';

let dir: ReturnType<typeof tempDir>;
let server: RunningServer;
let output: CapturedOutput;
let base = '';

function seeded(pattern: RegExp): string {
  const match = pattern.exec(output.out.join('\n'));
  if (match?.[1] === undefined) throw new Error(`banner lacks ${pattern}`);
  return match[1];
}

async function mcpClient(token: string | null, origin: string = base): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: token === null ? {} : { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'single-port-test', version: '1.0.0' });
  // The SDK's own types disagree under exactOptionalPropertyTypes (`sessionId?: string`).
  await client.connect(transport as Transport);
  return client;
}

function firstMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (e) => resolve(JSON.parse(String(e.data))), { once: true });
    ws.addEventListener('close', (e) => reject(new Error(`closed ${e.code}`)), { once: true });
  });
}

beforeAll(async () => {
  dir = tempDir('bh-single-port-');
  const input = bootInputFor(dir.path, { admin: true, auth: 'token' });
  output = input.output;
  server = await bootServer(input);
  base = server.url ?? '';
});

afterAll(async () => {
  await server.stop();
  dir.cleanup();
});

describe('single port: MCP + REST + WS + health', () => {
  it('GET /health is ready', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ready', phase: 'ready' });
  });

  it('GET /api/v1/openapi.json parses as OpenAPI 3.1', async () => {
    const res = await fetch(`${base}/api/v1/openapi.json`);
    expect(res.status).toBe(200);
    const doc: unknown = await res.json();
    expect(doc).toMatchObject({ openapi: expect.stringMatching(/^3\.1/) });
    const paths = typeof doc === 'object' && doc !== null && 'paths' in doc ? doc.paths : null;
    expect(Object.keys(paths ?? {}).length).toBeGreaterThan(50);
  });

  it('MCP refuses a request without a bearer token (401)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('MCP initialize → tools/list equals the golden catalog → tools/call list_sessions', async () => {
    const token = seeded(/bearer token for principal agent-1: (bh_agent_\S+)/);
    const client = await mcpClient(token);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([...ALL_TOOL_NAMES]);
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = Array.isArray(result.content) ? result.content : [];
    const first: unknown = content[0];
    const text =
      typeof first === 'object' &&
      first !== null &&
      'text' in first &&
      typeof first.text === 'string'
        ? first.text
        : '';
    expect(JSON.parse(text)).toEqual([]);
    await client.close();
  });

  it('WS upgrade without a cookie closes 4401; with a login cookie receives hello', async () => {
    const wsUrl = `${base.replace('http', 'ws')}/api/v1/ws`;
    const origin = base;
    const anonymous = new WebSocket(wsUrl, {
      headers: { origin },
      protocols: ['browserhive.v1'],
    } as unknown as string[]);
    const code = await new Promise<number>((resolve) =>
      anonymous.addEventListener('close', (e) => resolve(e.code)),
    );
    expect(code).toBe(4401);

    const password = seeded(/first-run password: (\S+)/);
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ password }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const change = await fetch(`${base}/api/v1/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ current_password: password, new_password: NEW_PASSWORD }),
    });
    expect(change.status).toBe(200);

    const ws = new WebSocket(wsUrl, {
      headers: { origin, cookie },
      protocols: ['browserhive.v1'],
    } as unknown as string[]);
    const hello = await firstMessage(ws);
    expect(hello).toMatchObject({ kind: 'reply', payload: { type: 'hello' } });
    ws.close();

    // The runtime row reports the Chromium build the driver launches (patchright's or
    // playwright's bundled browser), in step with the browser health check.
    const system = await fetch(`${base}/api/v1/system`, { headers: { origin, cookie } });
    expect(system.status).toBe(200);
    const info = (await system.json()) as { runtime: { chromium: string | null } };
    const health = (await (await fetch(`${base}/health`)).json()) as {
      checks: { browser: string };
    };
    if (health.checks.browser === 'ok') expect(info.runtime.chromium).toMatch(/^\d+\.\d+\./);
    else expect(info.runtime.chromium).toBeNull();
  });

  it('serves the dashboard SPA at / when it has been built', async () => {
    const res = await fetch(`${base}/`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) expect(await res.text()).toContain('<html');
  });
});

describe('single port: shutdown', () => {
  it('stops cleanly within the listener + drain budget and resolves done with 0', async () => {
    const own = tempDir('bh-single-port-stop-');
    const running = await bootServer(bootInputFor(own.path, { admin: true }));
    const started = Date.now();
    await running.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await running.done).toBe(0);
    await expect(fetch(`${running.url}/health`)).rejects.toThrow();
    own.cleanup();
  });
});

describe('single port: the browserhive executable', () => {
  it('spawn bin --admin --auth token → banner → /health ready → MCP list_sessions → SIGTERM exits 0', async () => {
    const own = tempDir('bh-single-port-bin-');
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = probe.port ?? 0;
    probe.stop(true);
    const bin = join(import.meta.dir, '../../src/bin.ts');
    const child = Bun.spawn(
      ['bun', bin, '--admin', '--auth', 'token', '--port', String(port), '--dataDir', own.path],
      { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env['PATH'] ?? '', HOME: own.path } },
    );
    const decoder = new TextDecoder();
    let stdout = '';
    const reader = child.stdout.getReader();
    const deadline = Date.now() + 30_000;
    while (!stdout.includes('Press Ctrl-C to stop.') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stdout += decoder.decode(chunk.value);
    }
    reader.releaseLock();
    const origin = `http://127.0.0.1:${port}`;
    expect(stdout).toContain(`MCP        ${origin}/mcp`);
    const health = await fetch(`${origin}/health`);
    expect(await health.json()).toMatchObject({ status: 'ready' });
    const token = /bearer token for principal agent-1: (bh_agent_\S+)/.exec(stdout)?.[1] ?? '';
    const client = await mcpClient(token, origin);
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(result.isError).not.toBe(true);
    await client.close();

    const started = Date.now();
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    own.cleanup();
  }, 60_000);
});
