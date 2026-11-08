/** @module interface/mcp/tools/operator.test — auth-state, attention and vault tools through the real services. */

import { afterEach, describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../../test/helpers/fake-clock.ts';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../../test/helpers/fake-transport.ts';
import { posixPath } from '../../../../test/helpers/posix-paths.ts';
import { executeTool } from '../../../../test/helpers/tool-run.ts';
import { agentPrincipal } from '../../../domain/auth/principal.ts';

let h: ToolHarness;
afterEach(async () => h.close());

describe('auth-state tools', () => {
  it('save_storage_state, save_full_profile, list_saved_auths (newest first, owner-scoped)', async () => {
    const clock = new FakeClock();
    h = await createToolHarness({ clock });
    const mem = await h.launch();
    const storage = await executeTool(h, 'save_storage_state', {
      session_id: mem,
      name: 'my-login',
    });
    expect(storage.value).toMatchObject({ name: 'my-login' });
    await clock.advance(1000);
    const persistent = await h.launch({ slug: 'prof', persistence_mode: 'persistent' });
    const profile = await executeTool(h, 'save_full_profile', {
      session_id: persistent,
      name: 'work',
    });
    expect(posixPath((profile.value as { path: string }).path)).toEndWith(
      'auth-states/work.profile.zip',
    );
    const listed = await executeTool(h, 'list_saved_auths');
    expect((listed.value as { name: string; kind: string }[]).map((e) => [e.name, e.kind])).toEqual(
      [
        ['work', 'profile'],
        ['my-login', 'storage'],
      ],
    );
    const alice = await h.connect(agentPrincipal('alice', {}));
    expect((await executeTool(h, 'list_saved_auths', {}, alice)).value).toEqual([]);
  });

  it('save_full_profile refuses non-persistent sessions; bad names are PATH_NOT_ALLOWED', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    expect(textOf(await h.call('save_full_profile', { session_id: id, name: 'x' }))).toBe(
      '[INVALID_PERSISTENCE_CONFIG] Invalid persistence config: save_full_profile is only valid for a session in persistent mode',
    );
    expect(
      textOf(await h.call('save_storage_state', { session_id: id, name: '../evil' })),
    ).toStartWith('[PATH_NOT_ALLOWED]');
  });

  it('delete_saved_auth removes the snapshot: the list drops it and a restore is AUTH_STATE_NOT_FOUND', async () => {
    h = await createToolHarness();
    const mem = await h.launch();
    await executeTool(h, 'save_storage_state', { session_id: mem, name: 'my-login' });
    const deleted = await executeTool(h, 'delete_saved_auth', { name: 'my-login' });
    expect(deleted.value).toEqual({ name: 'my-login', deleted: true });
    expect((await executeTool(h, 'list_saved_auths')).value).toEqual([]);
    const restore = await h.call('launch_session', {
      slug: 'again',
      persistence_mode: 'storage-state',
      context_options: { storageState: 'my-login' },
    });
    expect(textOf(restore)).toBe(
      "[AUTH_STATE_NOT_FOUND] No saved storage-state snapshot named 'my-login'. Use list_saved_auths to see what is available.",
    );
    expect(textOf(await h.call('delete_saved_auth', { name: 'my-login' }))).toBe(
      "[AUTH_STATE_NOT_FOUND] No saved auth snapshot named 'my-login'. Use list_saved_auths to see what is available.",
    );
    expect(textOf(await h.call('delete_saved_auth', { name: '../evil' }))).toStartWith(
      '[PATH_NOT_ALLOWED]',
    );
  });

  it("delete_saved_auth on another principal's name answers not-found and deletes nothing", async () => {
    h = await createToolHarness();
    const alice = await h.connect(agentPrincipal('alice', {}));
    const id = await h.launch({ slug: 'alice' }, alice);
    await executeTool(h, 'save_storage_state', { session_id: id, name: 'work' }, alice);
    const foreign = textOf(await h.call('delete_saved_auth', { name: 'work' }));
    const missing = textOf(await h.call('delete_saved_auth', { name: 'nothing-here' }));
    expect(foreign).toBe(
      "[AUTH_STATE_NOT_FOUND] No saved auth snapshot named 'work'. Use list_saved_auths to see what is available.",
    );
    // The same answer as for a name nobody saved: no oracle.
    expect(missing.replace('nothing-here', 'work')).toBe(foreign);
    expect(
      ((await executeTool(h, 'list_saved_auths', {}, alice)).value as { name: string }[]).map(
        (e) => e.name,
      ),
    ).toEqual(['work']);
    const bob = await h.connect(agentPrincipal('bob', {}));
    expect(textOf(await h.call('delete_saved_auth', { name: 'work' }, bob))).toBe(foreign);
    expect(
      (
        (await executeTool(h, 'delete_saved_auth', { name: 'work' }, alice)).value as {
          deleted: boolean;
        }
      ).deleted,
    ).toBe(true);
  });
});

describe('attention tools', () => {
  it('request_attention blocks until resolved; get_attention_result re-attaches', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    h.bus.subscribe('attention.created', (event) => {
      setTimeout(() => {
        void h.attentionBroker.resolve(
          event.payload.request.request_id,
          { status: 'resolved', message: 'done' },
          'operator',
        );
      }, 1);
    });
    const { value } = await executeTool(h, 'request_attention', {
      session_id: id,
      reason: 'captcha',
    });
    expect(value).toMatchObject({ status: 'resolved', message: 'done', resolved_by: 'operator' });
    const requestId = (value as { request_id: string }).request_id;
    const again = await executeTool(h, 'get_attention_result', { request_id: requestId });
    expect(again.value).toMatchObject({ status: 'resolved', request_id: requestId });
    const alice = await h.connect(agentPrincipal('alice', {}));
    const foreign = await executeTool(h, 'get_attention_result', { request_id: requestId }, alice);
    expect(foreign.value).toMatchObject({
      status: 'rejected',
      message: `Unknown attention request '${requestId}'.`,
    });
    expect(h.observations().at(-1)?.errorCode).toBe('ATTENTION_REJECTED');
  });

  it('both tools refuse under stdio before the session lookup', async () => {
    h = await createToolHarness({ transport: 'stdio' });
    const text =
      "[ATTENTION_REQUIRES_HTTP] 'request_attention' requires the http transport; human-in-the-loop attention is not available under stdio.";
    expect(
      textOf(await h.call('request_attention', { session_id: 'ghost-12345678', reason: 'x' })),
    ).toBe(text);
    expect(
      textOf(await h.call('get_attention_result', { request_id: 'a-000000000001' })),
    ).toStartWith('[ATTENTION_REQUIRES_HTTP]');
  });

  it('the description renders the operator floor', async () => {
    h = await createToolHarness({ minAttentionWaitMs: 1_800_000 });
    const tools = await h.client.listTools();
    const tool = tools.tools.find((t) => t.name === 'request_attention');
    expect(tool?.description).toContain('The operator requires a minimum wait of 1800s');
  });
});

describe('vault tools', () => {
  it('VAULT_NOT_CONFIGURED before the session lookup when no backend is configured', async () => {
    h = await createToolHarness();
    const text =
      '[VAULT_NOT_CONFIGURED] No vault backend is configured. Start the server with --vault <backend>.';
    expect(textOf(await h.call('vault_list_available', { session_id: 'ghost-12345678' }))).toBe(
      text,
    );
    expect(
      textOf(
        await h.call('vault_fill', {
          session_id: 'ghost-12345678',
          entry_name: 'x',
          username_selector: '#u',
          password_selector: '#p',
        }),
      ),
    ).toBe(text);
  });

  it('vault_list_available scopes to the page; vault_fill returns a status (never throws)', async () => {
    h = await createToolHarness({ vault: true });
    const id = await h.launch();
    const listed = await executeTool(h, 'vault_list_available', { session_id: id });
    expect(listed.value).toMatchObject({ entries: [], scope: 'no_page', scoped_to: null });
    const filled = await executeTool(h, 'vault_fill', {
      session_id: id,
      entry_name: 'linkedin',
      username_selector: '#u',
      password_selector: '#p',
    });
    expect(filled.value).toMatchObject({ status: 'blocked', redacted: true });
    expect(h.observations().at(-1)?.errorCode).toBe('VAULT_FILL_BLOCKED');
  });
});
