/** @module interface/mcp/ownership.test — ownership is enforced for every tool that names a session (table over the catalog, D-09/D-12). */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ALL_TOOL_NAMES, TOOL_CONTRACTS, type ToolName } from '@browserhive/contracts/tools';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../test/helpers/fake-transport.ts';
import { agentPrincipal } from '../../domain/auth/principal.ts';

/** Minimal schema-valid arguments besides `session_id`. */
const ARGS: Partial<Record<ToolName, Record<string, unknown>>> = {
  session_info: {},
  navigate: { url: 'http://127.0.0.1/' },
  go_back: {},
  go_forward: {},
  reload: {},
  wait_for_url: { url: 'x' },
  new_tab: {},
  close_tab: { tab_id: 't-000001' },
  switch_tab: { tab_id: 't-000001' },
  list_tabs: {},
  click: { selector: '#a' },
  type_text: { selector: '#a', text: 'x' },
  fill: { selector: '#a', value: 'x' },
  press_key: { key: 'a' },
  hover: { selector: '#a' },
  select_option: { selector: '#a', values: ['x'] },
  scroll: { mode: 'by' },
  drag_and_drop: { source_selector: '#a', target_selector: '#b' },
  screenshot: {},
  snapshot: {},
  get_content: {},
  evaluate: { expression: '1' },
  wait_for_selector: { selector: '#a' },
  wait_for_load_state: {},
  accept_next_dialog: {},
  dismiss_next_dialog: {},
  get_cookies: {},
  set_cookies: { cookies: [{ name: 'a', value: 'b' }] },
  set_viewport: { width: 10, height: 10 },
  set_extra_http_headers: { headers: {} },
  upload_file: { selector: '#a', paths: ['a.txt'] },
  download_file: { trigger_selector: '#a' },
  save_storage_state: { name: 'n' },
  save_full_profile: { name: 'n' },
  request_attention: { reason: 'r' },
  vault_list_available: {},
  vault_fill: { entry_name: 'e', username_selector: '#u', password_selector: '#p' },
};

function namesSession(name: ToolName): boolean {
  const contract = TOOL_CONTRACTS[name];
  return (
    'input' in contract &&
    contract.input !== undefined &&
    Object.hasOwn(contract.input.shape, 'session_id')
  );
}

let h: ToolHarness;
let alice: Client;
let id: string;
beforeAll(async () => {
  h = await createToolHarness({ vault: true });
  id = await h.launch();
  alice = await h.connect(agentPrincipal('alice', {}));
});
afterAll(async () => h.close());

describe('ownership table', () => {
  it('covers every session-naming tool except close_session', () => {
    const naming = ALL_TOOL_NAMES.filter(namesSession).filter((n) => n !== 'close_session');
    expect(Object.keys(ARGS).sort()).toEqual([...naming].sort());
  });

  for (const name of ALL_TOOL_NAMES.filter(namesSession).filter((n) => n !== 'close_session')) {
    it(`${name}: a foreign session answers exactly like an unknown one`, async () => {
      const denied = await h.call(name, { session_id: id, ...ARGS[name] }, alice);
      expect(textOf(denied)).toBe(`[SESSION_ACCESS_DENIED] No browser session with id '${id}'`);
      const unknown = await h.call(name, { session_id: 'ghost-12345678', ...ARGS[name] }, alice);
      expect(textOf(unknown)).toBe(
        "[SESSION_NOT_FOUND] No browser session with id 'ghost-12345678'",
      );
    });
  }

  it('close_session / list_sessions / list_saved_auths / get_attention_result never leak another principal’s resources', async () => {
    expect(JSON.parse(textOf(await h.call('close_session', { session_id: id }, alice)))).toEqual({
      session_id: id,
      closed: false,
    });
    expect(JSON.parse(textOf(await h.call('list_sessions', {}, alice)))).toEqual([]);
    expect(JSON.parse(textOf(await h.call('list_saved_auths', {}, alice)))).toEqual([]);
    const result = JSON.parse(
      textOf(await h.call('get_attention_result', { request_id: 'a-000000000009' }, alice)),
    );
    expect(result.status).toBe('rejected');
  });
});
