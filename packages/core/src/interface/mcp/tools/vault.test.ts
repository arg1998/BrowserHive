/** @module interface/mcp/tools/vault.test — the vault tools read the session's launch harness, never the per-call identity (D-48): a client that renames itself mid-session meets the rules as the harness that launched it. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../../test/helpers/fake-transport.ts';
import type { VaultService } from '../../../app/vault/vault-service.ts';

let h: ToolHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** A tool call that declares `harness` in its `_meta` (spec 02 §1.4, step 4). */
async function callAs(
  harness: ToolHarness,
  declared: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = (await harness.client.callTool({
    name,
    arguments: args,
    _meta: { 'ai.browserhive/harness': declared },
  })) as CallToolResult;
  if (result.isError === true) throw new Error(textOf(result));
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** The harness wires the real `VaultService` behind the tools' narrow `VaultLike` port. */
function vaultOf(harness: ToolHarness): VaultService {
  return harness.services.vault as unknown as VaultService;
}

const FILL = { entry_name: 'deploy', username_selector: '#u', password_selector: '#p' };

describe('vault tools: the launch harness decides (D-48)', () => {
  async function setup(harnesses: readonly string[]): Promise<ToolHarness> {
    const harness = await createToolHarness({ vault: true, identityEnv: {} });
    await vaultOf(harness).admin.putBinding('deploy', {
      itemName: 'Deploy',
      allowedOrigins: ['deploy.example'],
      allowAllSessions: true,
      harnesses,
    });
    return harness;
  }

  it('a session launched as an allowed harness keeps passing after the client renames itself', async () => {
    h = await setup(['opencode']);
    const launched = await callAs(h, 'OpenCode', 'launch_session', { slug: 'deploy' });
    const sessionId = String(launched['session_id']);
    const session = h.services.sessions.peek(sessionId);
    expect(session?.request.client?.harness).toBe('opencode');
    expect(session?.request.client?.harnessDeclared).toBe('OpenCode');

    const fill = await callAs(h, 'Claude Code', 'vault_fill', { session_id: sessionId, ...FILL });
    // Past the harness gate: the fake page is not on the entry's origin.
    expect(fill['status']).toBe('origin_mismatch');
    const listed = await callAs(h, 'Claude Code', 'vault_list_available', {
      session_id: sessionId,
    });
    expect(listed['scope']).not.toBe('rejected');
  });

  it('a session launched as another harness stays refused when the client claims an allowed one', async () => {
    h = await setup(['opencode']);
    const launched = await callAs(h, 'Claude Code', 'launch_session', { slug: 'deploy' });
    const sessionId = String(launched['session_id']);
    const refused = await callAs(h, 'opencode', 'vault_fill', { session_id: sessionId, ...FILL });
    expect(refused).toEqual({ status: 'blocked', redacted: true, reason: 'not_authorized' });

    const log = await vaultOf(h).accessLog({ limit: 10 });
    expect(log.items.map((row) => [row.reason, row.details])).toEqual([
      [
        'harness_not_allowed',
        expect.objectContaining({
          harness: 'claude-code',
          harness_declared: 'Claude Code',
          rule: 'binding',
        }),
      ],
    ]);
    expect(
      textOf((await h.call('vault_fill', { session_id: sessionId, ...FILL })) as CallToolResult),
    ).not.toContain('harness');
  });

  it('a custom name matches the launch declared name exactly', async () => {
    h = await setup(['Nightly Scraper']);
    const exact = String(
      (await callAs(h, 'Nightly Scraper', 'launch_session', { slug: 'deploy' }))['session_id'],
    );
    const lower = String(
      (await callAs(h, 'nightly scraper', 'launch_session', { slug: 'deploy' }))['session_id'],
    );
    expect((await callAs(h, 'x', 'vault_fill', { session_id: exact, ...FILL }))['status']).toBe(
      'origin_mismatch',
    );
    expect(
      (await callAs(h, 'Nightly Scraper', 'vault_fill', { session_id: lower, ...FILL }))['reason'],
    ).toBe('not_authorized');
  });
});
