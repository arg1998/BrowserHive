/** @module interface/mcp/identity.test — the per-request resolution ladder, conflicts, model/workspace sources, the meta bag and the connection cache (spec 02 §1.4, D-30). */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../test/helpers/fake-transport.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import type { McpConnectionPatch } from '../../ports/persistence/operations.ts';
import { identityAttributes } from './dispatcher.ts';
import {
  ConnectionIdentity,
  type ConnectionSignals,
  clientOfIdentity,
  headerBag,
  type RequestSignals,
  resolveIdentity,
} from './identity.ts';

function fail(id: string): never {
  throw new Error(`session ${id} is not live`);
}

const http = (
  headers: Record<string, string> = {},
  extra: Partial<ConnectionSignals> = {},
  url = 'http://127.0.0.1:9876/mcp',
): ConnectionSignals => ({
  transport: 'http',
  request: { headers: headerBag(headers), url },
  ...extra,
});

const withClient = (name: string, rest: Partial<ConnectionSignals> = {}): ConnectionSignals => ({
  ...http(),
  ...rest,
  initialize: { clientInfo: { name, version: '1.0.0' } },
});

describe('resolveIdentity: the ladder (02 §1.4)', () => {
  const rows: readonly (readonly [string, ConnectionSignals, RequestSignals, string, string])[] = [
    ['nothing at all', http(), {}, 'unknown', 'none'],
    ['generic SDK name', withClient('mcp'), {}, 'unknown', 'none'],
    ['clientInfo', withClient('codex-mcp-client'), {}, 'codex', 'client_info'],
    ['unrecognised clientInfo kept', withClient('Nightly Bot'), {}, 'nightly-bot', 'client_info'],
    [
      'User-Agent when clientInfo says nothing',
      http({ 'user-agent': 'codex-mcp-client/0.154.0' }),
      {},
      'codex',
      'user_agent',
    ],
    [
      'clientInfo over User-Agent',
      {
        ...withClient('opencode'),
        request: { headers: headerBag({ 'user-agent': 'Cursor/1.0' }) },
      },
      {},
      'opencode',
      'client_info',
    ],
    [
      'initialize _meta over clientInfo',
      {
        ...http(),
        initialize: {
          clientInfo: { name: 'claude-code' },
          meta: { 'ai.browserhive/harness': 'goose' },
        },
      },
      {},
      'goose',
      'meta',
    ],
    [
      'browserhive.ai/ prefix read as an alias',
      http(),
      { meta: { 'browserhive.ai/harness': 'Zed' } },
      'zed',
      'meta',
    ],
    [
      'call _meta over initialize _meta',
      { ...http(), initialize: { meta: { 'ai.browserhive/harness': 'goose' } } },
      { meta: { 'ai.browserhive/harness': 'cline' } },
      'cline',
      'meta',
    ],
    [
      '?harness= over _meta',
      http({}, {}, 'http://127.0.0.1:9876/mcp?harness=Claude%20Desktop'),
      { meta: { 'ai.browserhive/harness': 'cline' } },
      'claude-desktop',
      'url',
    ],
    [
      'X-BH-Agent-Harness over the URL',
      http({ 'x-bh-agent-harness': 'OpenCode' }, {}, 'http://h/mcp?harness=cursor'),
      {},
      'opencode',
      'header',
    ],
    ['X-BH-Harness alias', http({ 'x-bh-harness': 'codex' }), {}, 'codex', 'header'],
    [
      'a request header overrides the same initialize header',
      http({ 'x-bh-agent-harness': 'codex' }),
      { headers: headerBag({ 'x-bh-agent-harness': 'cursor' }) },
      'cursor',
      'header',
    ],
    [
      'CLAUDECODE under stdio',
      { transport: 'stdio', env: { CLAUDECODE: '1' } },
      {},
      'claude-code',
      'injected_env',
    ],
    [
      'GEMINI_CLI under stdio',
      { transport: 'stdio', env: { GEMINI_CLI: '1' } },
      {},
      'gemini-cli',
      'injected_env',
    ],
    [
      'CLAUDECODE=0 is no signal',
      { transport: 'stdio', env: { CLAUDECODE: '0' } },
      {},
      'unknown',
      'none',
    ],
    [
      'BROWSERHIVE_HARNESS over CLAUDECODE',
      { transport: 'stdio', env: { CLAUDECODE: '1', BROWSERHIVE_HARNESS: 'nightly scraper' } },
      {},
      'nightly-scraper',
      'env',
    ],
    [
      'injected env over _meta',
      { transport: 'stdio', env: { GEMINI_CLI: '1' } },
      { meta: { 'ai.browserhive/harness': 'codex' } },
      'gemini-cli',
      'injected_env',
    ],
    ['blank header is absent', http({ 'x-bh-agent-harness': '   ' }), {}, 'unknown', 'none'],
  ];
  for (const [name, connection, request, harness, source] of rows) {
    it(name, () => {
      const resolved = resolveIdentity(connection, request);
      expect([resolved.harness, resolved.harnessSource]).toEqual([harness, source]);
    });
  }
});

describe('resolveIdentity: conflicts, model, workspace, meta', () => {
  it('records lower signals that name another harness, once each', () => {
    const resolved = resolveIdentity(
      {
        transport: 'http',
        request: {
          headers: headerBag({ 'x-bh-agent-harness': 'opencode', 'user-agent': 'Cursor/1.2' }),
        },
        initialize: { clientInfo: { name: 'claude-code' } },
      },
      {},
    );
    expect(resolved.harness).toBe('opencode');
    expect(resolved.conflicts).toEqual([
      { source: 'client_info', value: 'claude-code', harness: 'claude-code' },
      { source: 'user_agent', value: 'Cursor/1.2', harness: 'cursor' },
    ]);
  });

  it('does not count agreeing signals as conflicts', () => {
    const resolved = resolveIdentity(
      withClient('codex-mcp-client', {
        request: { headers: headerBag({ 'user-agent': 'codex-mcp-client/1' }) },
      }),
    );
    expect(resolved.conflicts).toEqual([]);
  });

  it('declares the model and workspace with their sources, never a guess', () => {
    expect(resolveIdentity(http())).toMatchObject({
      model: null,
      modelSource: null,
      workspace: null,
    });
    expect(
      resolveIdentity(http({ 'x-bh-agent-model': 'claude-opus-5', 'x-bh-workspace': 'shop' })),
    ).toMatchObject({ model: 'claude-opus-5', modelSource: 'header', workspace: 'shop' });
    expect(resolveIdentity(http({ 'x-bh-model': 'gpt-6' })).model).toBe('gpt-6');
    expect(
      resolveIdentity({
        transport: 'stdio',
        env: { BROWSERHIVE_MODEL: 'm', BROWSERHIVE_WORKSPACE: 'w' },
      }),
    ).toMatchObject({ model: 'm', modelSource: 'env', workspace: 'w', workspaceSource: 'env' });
    expect(
      resolveIdentity(http(), {
        meta: { 'ai.browserhive/model': 'o5', 'ai.browserhive/workspace': 'ws' },
      }),
    ).toMatchObject({ model: 'o5', modelSource: 'meta', workspace: 'ws', workspaceSource: 'meta' });
  });

  it('builds the meta bag from _meta and X-BH-Meta-* headers, excluding named and tracing keys', () => {
    const resolved = resolveIdentity(
      {
        ...http({ 'x-bh-meta-team': 'growth', 'x-bh-meta-run': 'from-header' }),
        initialize: { meta: { 'ai.browserhive/run': 'from-init' } },
      },
      {
        meta: {
          'ai.browserhive/ticket': 'BH-42',
          'ai.browserhive/harness': 'codex',
          'browserhive.ai/traceId': '0'.repeat(32),
          traceparent: 'x',
          progressToken: 1,
        },
      },
    );
    expect(resolved.meta).toEqual({ ticket: 'BH-42', run: 'from-init', team: 'growth' });
  });

  it('caps the meta bag and counts what it dropped', () => {
    const meta = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`ai.browserhive/k${i}`, 'v']),
    );
    const resolved = resolveIdentity(http(), { meta });
    expect(Object.keys(resolved.meta)).toHaveLength(16);
    expect(resolved.metaDropped).toBe(4);
  });

  it('maps to the client info tools see and to span attributes', () => {
    const resolved = resolveIdentity(
      withClient('claude-code', { request: { headers: headerBag({ 'x-bh-agent-model': 'o5' }) } }),
    );
    expect(clientOfIdentity(resolved)).toMatchObject({
      name: 'claude-code',
      harness: 'claude-code',
      harnessSource: 'client_info',
      model: 'o5',
      modelSource: 'header',
    });
    expect(identityAttributes(resolved)).toEqual({
      'browserhive.harness': 'claude-code',
      'browserhive.harness_source': 'client_info',
      'browserhive.model': 'o5',
    });
    expect(identityAttributes(resolveIdentity(http()))).toEqual({
      'browserhive.harness': 'unknown',
      'browserhive.harness_source': 'none',
    });
  });
});

describe('ConnectionIdentity: the per-connection cache', () => {
  it('writes the row only when the resolution changes, and logs a conflict once', async () => {
    const logger = createCollectingLogger({ level: 'trace' });
    const writes: McpConnectionPatch[] = [];
    const identity = new ConnectionIdentity({
      connectionId: 'c-test000001',
      logger,
      signals: http({ 'user-agent': 'Cursor/1.0' }),
      persist: async (patch) => {
        writes.push(patch);
      },
    });
    expect(identity.current.harness).toBe('cursor');
    identity.initialize({ clientInfo: { name: 'claude-code' }, protocolVersion: '2025-06-18' });
    expect(identity.current.harness).toBe('claude-code');
    expect(writes).toHaveLength(1);
    identity.resolve({});
    identity.resolve({});
    expect(writes).toHaveLength(1);
    identity.resolve({ meta: { 'ai.browserhive/model': 'o5' } });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ model: 'o5', modelSource: 'meta', harness: 'claude-code' });
    await Promise.resolve();
    expect(logger.records.filter((r) => r.msg === 'harness signals disagree')).toHaveLength(1);
  });

  it('logs a capped meta bag once', () => {
    const logger = createCollectingLogger({ level: 'trace' });
    const identity = new ConnectionIdentity({
      connectionId: 'c-test000002',
      logger,
      signals: http(),
    });
    const meta = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`ai.browserhive/k${i}`, 'v']),
    );
    identity.resolve({ meta });
    identity.resolve({ meta });
    expect(logger.records.filter((r) => r.msg === 'meta bag capped')).toHaveLength(1);
  });
});

describe('identity is observability only (D-30)', () => {
  let a: ToolHarness | undefined;
  let b: ToolHarness | undefined;
  afterEach(async () => {
    await a?.close();
    await b?.close();
  });

  it('never changes a tool result; it only labels the observation and the session', async () => {
    a = await createToolHarness();
    b = await createToolHarness({
      identityEnv: {
        CLAUDECODE: '1',
        BROWSERHIVE_MODEL: 'claude-opus-5',
        BROWSERHIVE_WORKSPACE: 'shop',
      },
    });
    const run = async (h: ToolHarness) => {
      const launched = await h.call('launch_session', { slug: 'shop' });
      const id = (JSON.parse(textOf(launched)) as { session_id: string }).session_id;
      const content = await h.call('get_content', { session_id: id });
      const listed = await h.call('list_sessions');
      const bad = await h.call('navigate', { session_id: id });
      return { launched, content, listed, bad, id };
    };
    const plain = await run(a);
    const labelled = await run(b);
    expect(labelled.launched).toEqual(plain.launched);
    expect(labelled.content).toEqual(plain.content);
    expect(labelled.listed).toEqual(plain.listed);
    expect(labelled.bad).toEqual(plain.bad);
    expect(a.observations().map((o) => o.harness)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect(b.observations().map((o) => o.harness)).toEqual([
      'claude-code',
      'claude-code',
      'claude-code',
      'claude-code',
    ]);
    const summary = b.services.sessions.summary(
      b.services.sessions.peek(labelled.id) ?? fail(labelled.id),
    );
    expect(summary.harness).toBe('claude-code');
    expect(summary.client).toMatchObject({
      harness: 'claude-code',
      harness_source: 'injected_env',
      model: 'claude-opus-5',
      model_source: 'env',
      workspace: 'shop',
    });
  });
});
