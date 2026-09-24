/** @module test/composition/stdio-identity.test — under `transport=stdio` the connection's identity comes from the process environment (`CLAUDECODE`, `BROWSERHIVE_HARNESS/MODEL/WORKSPACE`) and `initialize` (spec 02 §1.4, D-30). */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { bootServer } from '../../src/composition/index.ts';
import { bootInputFor, tempDir } from './support.ts';

interface Row {
  harness: string | null;
  harness_source: string | null;
  model: string | null;
  model_source: string | null;
  workspace: string | null;
  agent_name: string | null;
  client_name: string | null;
  protocol_version: string | null;
}

async function handshake(env: Record<string, string>, dataDir: string): Promise<Row | undefined> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const replies: string[] = [];
  stdout.on('data', (chunk: Buffer) => replies.push(chunk.toString('utf8')));
  const base = bootInputFor(dataDir, { transport: 'stdio' });
  const server = await bootServer({ ...base, env, stdio: { stdin, stdout } });
  stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '2.1.281' },
      },
    })}\n`,
  );
  for (let i = 0; i < 100 && !replies.join('').includes('"id":1'); i++) {
    await Bun.sleep(10);
  }
  await Bun.sleep(50);
  await server.stop();
  const db = new Database(join(dataDir, 'browserhive.db'), { readonly: true });
  try {
    return (
      db
        .query<Row, []>(
          'SELECT harness, harness_source, model, model_source, workspace, agent_name, client_name, protocol_version FROM mcp_connections',
        )
        .get() ?? undefined
    );
  } finally {
    db.close();
  }
}

describe('stdio client identity', () => {
  let dir = tempDir();
  afterEach(() => {
    dir.cleanup();
    dir = tempDir();
  });

  it('recognises Claude Code from CLAUDECODE with no configuration', async () => {
    const row = await handshake({ CLAUDECODE: '1' }, dir.path);
    expect(row).toMatchObject({
      harness: 'claude-code',
      harness_source: 'injected_env',
      model: null,
      workspace: null,
      client_name: 'claude-code',
      protocol_version: '2025-06-18',
    });
  });

  it('prefers BROWSERHIVE_HARNESS and records the declared model and workspace', async () => {
    const row = await handshake(
      {
        CLAUDECODE: '1',
        BROWSERHIVE_HARNESS: 'Nightly Scraper',
        BROWSERHIVE_MODEL: 'claude-opus-5',
        BROWSERHIVE_WORKSPACE: 'shop',
      },
      dir.path,
    );
    expect(row).toMatchObject({
      harness: 'nightly-scraper',
      harness_source: 'env',
      model: 'claude-opus-5',
      model_source: 'env',
      workspace: 'shop',
      agent_name: 'shop',
    });
  });

  it('falls back to clientInfo when the environment says nothing', async () => {
    const row = await handshake({}, dir.path);
    expect(row).toMatchObject({ harness: 'claude-code', harness_source: 'client_info' });
  });
});
