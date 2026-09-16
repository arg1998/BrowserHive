/** @module interface/mcp/tools/navigation.test — navigation, tabs, waits and dialogs tools against FakePage through the real pipeline. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { FakeSessionHandle } from '../../../../test/helpers/fake-session-handle.ts';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../../test/helpers/fake-transport.ts';
import { executeTool } from '../../../../test/helpers/tool-run.ts';

let h: ToolHarness;
afterEach(async () => h.close());

function handle(): FakeSessionHandle {
  const found = h.fakeDriver?.handles[0];
  if (found === undefined) throw new Error('no handle');
  return found;
}

function timeoutError(message: string): Error {
  const err = new Error(message);
  err.name = 'TimeoutError';
  return err;
}

describe('navigation tools', () => {
  it('navigate returns the status, bumps the count and publishes page.visited after tool.called', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    h.script.status = 404;
    const { value } = await executeTool(h, 'navigate', {
      session_id: id,
      url: 'http://127.0.0.1/missing?q=1',
    });
    expect(value).toEqual({ session_id: id, url: 'http://127.0.0.1/missing?q=1', status: 404 });
    const names = h.bus.names();
    expect(names.indexOf('page.visited')).toBeGreaterThan(names.lastIndexOf('tool.called'));
    const obs = h.observations().at(-1);
    expect(obs?.ok).toBe(true);
    expect(obs?.errorCode).toBe('HTTP_404');
    const goto = handle().firstPage.calls.find((c) => c.method === 'goto');
    expect(goto?.args[1]).toEqual({ waitUntil: 'load', timeout: 30_000 });
  });

  it('navigate refuses a blocklisted URL before touching the browser', async () => {
    h = await createToolHarness({ blocklist: 'blocked.example\n' });
    const id = await h.launch();
    const result = await h.call('navigate', { session_id: id, url: 'https://blocked.example/' });
    expect(textOf(result)).toStartWith('[URL_BLOCKED]');
    expect(handle().firstPage.methods()).not.toContain('goto');
  });

  it('navigate maps a goto timeout to NAVIGATION_TIMEOUT', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    handle().firstPage.failWith('goto', timeoutError('page.goto: Timeout 50ms exceeded.'));
    const result = await h.call('navigate', {
      session_id: id,
      url: 'http://127.0.0.1/slow',
      timeout: 50,
    });
    expect(textOf(result)).toStartWith('[NAVIGATION_TIMEOUT]');
  });

  it('go_back / go_forward / reload return the url and bump the count', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    await executeTool(h, 'go_back', { session_id: id });
    await executeTool(h, 'go_forward', { session_id: id });
    const { value } = await executeTool(h, 'reload', { session_id: id, wait_until: 'commit' });
    expect(value).toEqual({ session_id: id, url: 'about:blank' });
    const info = await h.callJson<{ navigation_count: number }>('session_info', { session_id: id });
    expect(info.navigation_count).toBe(3);
  });

  it('go_back maps a bare timeout to NAVIGATION_TIMEOUT', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    handle().firstPage.failWith('goBack', timeoutError('page.goBack: Timeout 10ms exceeded.'));
    expect(textOf(await h.call('go_back', { session_id: id, timeout: 10 }))).toStartWith(
      '[NAVIGATION_TIMEOUT]',
    );
  });

  it('wait_for_url accepts a regex object and maps timeouts to WAIT_TIMEOUT', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    await executeTool(h, 'wait_for_url', { session_id: id, url: { pattern: 'blank', flags: 'i' } });
    const call = handle().firstPage.calls.find((c) => c.method === 'waitForURL');
    expect(call?.args[0]).toBeInstanceOf(RegExp);
    handle().firstPage.failWith(
      'waitForURL',
      timeoutError('page.waitForURL: Timeout 5ms exceeded.'),
    );
    expect(
      textOf(await h.call('wait_for_url', { session_id: id, url: 'x', timeout: 5 })),
    ).toStartWith('[WAIT_TIMEOUT]');
  });
});

describe('tab tools', () => {
  it('new_tab / list_tabs / switch_tab / close_tab', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const opened = await executeTool(h, 'new_tab', {
      session_id: id,
      url: 'http://127.0.0.1/second',
    });
    const tabId = (opened.value as { tab_id: string }).tab_id;
    expect(opened.value).toEqual({ session_id: id, tab_id: tabId, url: 'http://127.0.0.1/second' });
    const listed = await executeTool(h, 'list_tabs', { session_id: id });
    const tabs = listed.value as { tab_id: string; active: boolean }[];
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.tab_id === tabId)?.active).toBe(true);
    const first = tabs.find((t) => t.tab_id !== tabId)?.tab_id ?? '';
    const switched = await executeTool(h, 'switch_tab', { session_id: id, tab_id: first });
    expect(switched.value).toEqual({ session_id: id, tab_id: first, url: 'about:blank' });
    const closed = await executeTool(h, 'close_tab', { session_id: id, tab_id: tabId });
    expect(closed.value).toEqual({ session_id: id, tab_id: tabId, closed: true });
    const missing = await h.call('switch_tab', { session_id: id, tab_id: tabId });
    expect(textOf(missing)).toBe(`[TAB_NOT_FOUND] Tab '${tabId}' not found in session '${id}'.`);
  });
});

describe('wait tools', () => {
  it('wait_for_selector / wait_for_load_state apply defaults', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const sel = await executeTool(h, 'wait_for_selector', { session_id: id, selector: '#x' });
    expect(sel.value).toEqual({ session_id: id, selector: '#x', state: 'visible' });
    const load = await executeTool(h, 'wait_for_load_state', { session_id: id });
    expect(load.value).toEqual({ session_id: id, state: 'load' });
  });

  it('a selector wait timeout is WAIT_TIMEOUT, not ELEMENT_NOT_ACTIONABLE', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    handle().firstPage.failWith(
      'waitForSelector',
      timeoutError('page.waitForSelector: Timeout 5ms exceeded.'),
    );
    const result = await h.call('wait_for_selector', {
      session_id: id,
      selector: '#x',
      timeout: 5,
    });
    expect(textOf(result)).toStartWith('[WAIT_TIMEOUT]');
  });
});

describe('dialog tools', () => {
  it('accept_next_dialog answers a prompt once; dismiss_next_dialog dismisses', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const accepted = await executeTool(h, 'accept_next_dialog', {
      session_id: id,
      prompt_text: 'yes',
    });
    expect(accepted.value).toEqual({ session_id: id, armed: true });
    const page = handle().firstPage;
    const dialog = page.emitDialog('prompt', 'name?');
    await Bun.sleep(0);
    expect(dialog.outcome).toEqual({ accepted: true, promptText: 'yes' });
    await executeTool(h, 'dismiss_next_dialog', { session_id: id });
    const second = page.emitDialog('confirm');
    await Bun.sleep(0);
    expect(second.outcome.accepted).toBe(false);
  });
});
