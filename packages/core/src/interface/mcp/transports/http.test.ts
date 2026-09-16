/** @module interface/mcp/transports/http.test — Streamable HTTP session lifecycle with web-standard `Request`s: initialize → session header → tools/list → ownership → DELETE; DNS-rebinding protection; connection rows. */

import { afterEach, describe, expect, it } from 'bun:test';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createToolHarness, type ToolHarness } from '../../../../test/helpers/fake-transport.ts';
import { agentPrincipal, LOCAL_PRINCIPAL } from '../../../domain/auth/principal.ts';
import type { McpConnectionRepository } from '../../../ports/persistence/operations.ts';
import type { McpConnectionRecord } from '../../../ports/persistence/records-identity.ts';
import { InMemoryEventStore } from './event-store.ts';
import {
  allowedHostsFor,
  createMcpHttpHandler,
  type McpHttpHandler,
  type McpHttpOptions,
} from './http.ts';

let h: ToolHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

class RecordingConnections implements McpConnectionRepository {
  readonly rows = new Map<string, McpConnectionRecord>();
  async insert(record: McpConnectionRecord): Promise<void> {
    this.rows.set(record.connectionId, record);
  }
  async update(id: string, patch: Partial<McpConnectionRecord>): Promise<boolean> {
    const row = this.rows.get(id);
    if (row === undefined) return false;
    this.rows.set(id, { ...row, ...patch });
    return true;
  }
  async get(id: string): Promise<McpConnectionRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async listOpen(): Promise<readonly McpConnectionRecord[]> {
    return [...this.rows.values()].filter((r) => r.closedAt === null);
  }
  async closeAll(): Promise<number> {
    return 0;
  }
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:9876/mcp', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:9876',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function sseJson(
  response: Response,
): Promise<{ result?: { tools?: unknown[]; serverInfo?: unknown } }> {
  const text = await response.text();
  const data = text.split('\n').find((l) => l.startsWith('data: {'));
  return JSON.parse(data?.slice(6) ?? '{}');
}

async function setup(
  onSessionClosed?: McpHttpOptions['onSessionClosed'],
): Promise<{ handler: McpHttpHandler; connections: RecordingConnections }> {
  const harness = await createToolHarness();
  h = harness;
  const connections = new RecordingConnections();
  const handler = createMcpHttpHandler({
    runtime: harness.services.runtime,
    dispatcher: harness.dispatcher,
    ids: harness.services.ids,
    clock: harness.services.clock,
    logger: harness.logger,
    connections,
    host: '127.0.0.1',
    port: 9876,
    ...(onSessionClosed !== undefined && { onSessionClosed }),
  });
  return { handler, connections };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'probe', version: '9.9' },
  },
};

describe('MCP Streamable HTTP transport', () => {
  it('initialize → session id → tools/list → foreign principal 404 → DELETE', async () => {
    const closedHooks: { subject: string; remainingForSubject: number }[] = [];
    const { handler, connections } = await setup((c) => closedHooks.push(c));
    const init = await handler.handleMcpRequest(post(initialize), LOCAL_PRINCIPAL);
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id') ?? '';
    expect(sessionId).toMatch(/^m-[A-Za-z0-9_-]{16}$/);
    expect((await sseJson(init)).result?.serverInfo).toEqual({
      name: 'browserhive',
      version: '0.1.0',
    });
    expect(handler.sessionCount).toBe(1);
    const row = [...connections.rows.values()][0];
    expect(row).toMatchObject({
      mcpSessionId: sessionId,
      clientName: 'probe',
      clientVersion: '9.9',
      principalId: 'local',
      transport: 'http',
      closedAt: null,
    });
    expect(handler.connectionIdOf(sessionId)).toBe(row?.connectionId ?? '');

    const session = {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    };
    const initialized = await handler.handleMcpRequest(
      post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session),
      LOCAL_PRINCIPAL,
    );
    expect(initialized.status).toBe(202);
    const list = await handler.handleMcpRequest(
      post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session),
      LOCAL_PRINCIPAL,
    );
    expect((await sseJson(list)).result?.tools).toHaveLength(43);

    const foreign = await handler.handleMcpRequest(
      post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, session),
      agentPrincipal('alice', {}),
    );
    expect(foreign.status).toBe(404);

    const del = await handler.handleMcpRequest(
      new Request('http://127.0.0.1:9876/mcp', {
        method: 'DELETE',
        headers: { host: '127.0.0.1:9876', ...session },
      }),
      LOCAL_PRINCIPAL,
    );
    expect(del.status).toBe(200);
    expect(handler.sessionCount).toBe(0);
    expect(closedHooks).toMatchObject([{ subject: 'local', remainingForSubject: 0 }]);
    expect([...connections.rows.values()][0]?.closedAt).not.toBeNull();
    const after = await handler.handleMcpRequest(
      post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, session),
      LOCAL_PRINCIPAL,
    );
    expect(after.status).toBe(404);
  });

  it('refuses requests without a session that are not initialize, and malformed JSON', async () => {
    const { handler } = await setup();
    expect(
      (
        await handler.handleMcpRequest(
          post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          LOCAL_PRINCIPAL,
        )
      ).status,
    ).toBe(400);
    const bad = new Request('http://127.0.0.1:9876/mcp', {
      method: 'POST',
      headers: { host: '127.0.0.1:9876' },
      body: '{',
    });
    expect((await handler.handleMcpRequest(bad, LOCAL_PRINCIPAL)).status).toBe(400);
  });

  it('DNS-rebinding protection rejects a foreign Host header', async () => {
    const { handler } = await setup();
    const response = await handler.handleMcpRequest(
      post(initialize, { host: 'evil.example' }),
      LOCAL_PRINCIPAL,
    );
    expect(response.status).toBe(403);
  });

  it('allowedHostsFor covers the bound host and loopback with and without port', () => {
    expect(allowedHostsFor('127.0.0.1', 80, ['mcp.example'])).toEqual(
      expect.arrayContaining([
        '127.0.0.1',
        '127.0.0.1:80',
        'localhost:80',
        '[::1]:80',
        'mcp.example',
      ]),
    );
  });
});

describe('InMemoryEventStore', () => {
  it('replays after an event id and stays bounded', async () => {
    const store = new InMemoryEventStore({ maxEvents: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(await store.storeEvent('s1', { jsonrpc: '2.0', method: 'n', params: { i } }));
    expect(store.size('s1')).toBe(3);
    const replayed: string[] = [];
    const stream = await store.replayEventsAfter(ids[2] ?? '', {
      send: async (id) => void replayed.push(id),
    });
    expect(stream).toBe('s1');
    expect(replayed).toEqual(ids.slice(3));
  });
});
