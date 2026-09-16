/** @module interface/mcp/tools/lifecycle.test — lifecycle + introspection tools executed through the real server, dispatcher and schemas. */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../../test/helpers/fake-transport.ts';
import { executeTool } from '../../../../test/helpers/tool-run.ts';
import { agentPrincipal } from '../../../domain/auth/principal.ts';

let h: ToolHarness;
afterEach(async () => h.close());

describe('lifecycle tools', () => {
  it('launch_session applies schema defaults and returns SessionMetadata', async () => {
    h = await createToolHarness({ defaultChannel: 'chrome', defaultHeadless: false });
    const { value } = await executeTool(h, 'launch_session', { slug: 'demo' });
    expect(value).toMatchObject({
      session_id: 'demo-00000001',
      slug: 'demo',
      channel: 'chrome',
      headless: false,
      incognito: false,
      persistence_mode: 'memory',
      owner: 'local',
      disable_evaluate: false,
      vault_enabled: true,
      proxy_label: null,
    });
    const spec = h.fakeDriver?.launches[0];
    expect(spec?.channel).toBe('chrome');
    expect(spec?.headless).toBe(false);
  });

  it('launch_session rejects an invalid slug with the schema message', async () => {
    h = await createToolHarness();
    const result = await h.call('launch_session', { slug: 'BadSlug' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      '[INVALID_ARGUMENTS] slug: slug must match /^[a-z][a-z0-9-]{1,31}$/',
    );
  });

  it('list_sessions returns only the caller’s sessions (bare array, text only)', async () => {
    h = await createToolHarness();
    const mine = await h.launch();
    const alice = await h.connect(agentPrincipal('alice', {}));
    await h.launch({ slug: 'other' }, alice);
    const { value, result } = await executeTool(h, 'list_sessions');
    expect(result.structuredContent).toBeUndefined();
    expect((value as { session_id: string }[]).map((s) => s.session_id)).toEqual([mine]);
  });

  it('close_session closes an owned session and answers closed:false otherwise', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const alice = await h.connect(agentPrincipal('alice', {}));
    const foreign = await executeTool(h, 'close_session', { session_id: id }, alice);
    expect(foreign.value).toEqual({ session_id: id, closed: false });
    const closed = await executeTool(h, 'close_session', { session_id: id });
    expect(closed.value).toEqual({ session_id: id, closed: true });
    const again = await executeTool(h, 'close_session', { session_id: 'ghost-12345678' });
    expect(again.value).toEqual({ session_id: 'ghost-12345678', closed: false });
  });
});

describe('introspection tools', () => {
  it('server_status reports the real limit, vault and persistence', async () => {
    h = await createToolHarness({ vault: true, allowEvaluate: true });
    await h.launch();
    const { value } = await executeTool(h, 'server_status');
    expect(value).toMatchObject({
      uptime_ms: 0,
      version: '0.1.0',
      transport: 'http',
      sessions: { count: 1, limit: 8 },
      vault: { enabled: true, backend: 'bitwarden', evaluate_warning: true },
      persistence_mode: 'memory',
      driver: 'playwright',
    });
  });

  it('session_info reports config and live counters', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    await executeTool(h, 'navigate', { session_id: id, url: 'http://127.0.0.1/a' });
    const { value } = await executeTool(h, 'session_info', { session_id: id });
    expect(value).toMatchObject({
      session_id: id,
      config: { slug: 'demo', owner: 'local', disable_evaluate: false },
      page_count: 1,
      current_url: 'http://127.0.0.1/a',
      navigation_count: 1,
    });
  });
});
