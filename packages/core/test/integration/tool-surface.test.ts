/** @module test/integration/tool-surface — introspection, tabs, cookies, viewport/headers, scroll, wait_for_url, screenshot (image + sandbox), dialogs, downloads, uploads and the evaluate gate against real Chromium. */

import { describe, expect, it } from 'bun:test';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { textOf } from '../helpers/fake-transport.ts';
import { useMcpStack } from './mcp-fixture.ts';

describe('tool surface end-to-end (real Chromium)', () => {
  const { state } = useMcpStack();

  it('server_status and session_info', async () => {
    const h = state.harness;
    const status = await h.callJson<{
      sessions: { limit: number | null };
      persistence_mode: string;
      vault: { enabled: boolean };
    }>('server_status');
    expect(status.sessions.limit).toBe(8);
    expect(status.vault.enabled).toBe(false);
    expect(status.persistence_mode).toBe('memory');
    const id = await h.launch();
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
    const info = await h.callJson<{
      page_count: number;
      current_url: string;
      navigation_count: number;
      config: { owner: string };
    }>('session_info', { session_id: id });
    expect(info.page_count).toBe(1);
    expect(info.current_url).toContain('127.0.0.1');
    expect(info.navigation_count).toBe(1);
    expect(info.config.owner).toBe('local');
  });

  it('tabs: new_tab / list_tabs / switch_tab / close_tab, and popups auto-register', async () => {
    const h = state.harness;
    const id = await h.launch();
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/popup') });
    const opened = await h.callJson<{ tab_id: string }>('new_tab', {
      session_id: id,
      url: state.fixture.url('/'),
    });
    let tabs = await h.callJson<{ tab_id: string; active: boolean; title: string }[]>('list_tabs', {
      session_id: id,
    });
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.tab_id === opened.tab_id)?.active).toBe(true);
    const first = tabs.find((t) => t.tab_id !== opened.tab_id)?.tab_id ?? '';
    await h.callJson('switch_tab', { session_id: id, tab_id: first });
    await h.callJson('click', { session_id: id, selector: '#open' });
    await h.callJson('wait_for_load_state', { session_id: id });
    await Bun.sleep(300);
    tabs = await h.callJson('list_tabs', { session_id: id });
    expect(tabs.length).toBe(3);
    expect(
      (
        await h.callJson<{ closed: boolean }>('close_tab', {
          session_id: id,
          tab_id: opened.tab_id,
        })
      ).closed,
    ).toBe(true);
    expect(await h.callJson<unknown[]>('list_tabs', { session_id: id })).toHaveLength(2);
  });

  it('cookies round-trip; viewport and headers', async () => {
    const h = state.harness;
    const id = await h.launch();
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
    const origin = state.fixture.origin;
    expect(
      await h.callJson<unknown>('set_cookies', {
        session_id: id,
        cookies: [{ name: 'sid', value: 'abc123', url: origin }],
      }),
    ).toEqual({ added: 1 });
    const got = await h.callJson<{ cookies: { name: string; value: string }[] }>('get_cookies', {
      session_id: id,
      urls: [origin],
    });
    expect(got.cookies.find((c) => c.name === 'sid')?.value).toBe('abc123');
    const bad = await h.call('set_cookies', {
      session_id: id,
      cookies: [{ name: 'x', value: 'y' }],
    });
    expect(textOf(bad)).toStartWith('[INVALID_ARGUMENTS] cookies:');
    await h.callJson('set_viewport', { session_id: id, width: 800, height: 640 });
    const dims = await h.callJson<{ result: { w: number } }>('evaluate', {
      session_id: id,
      expression: '() => ({ w: window.innerWidth })',
    });
    expect(dims.result.w).toBe(800);
    const headers = await h.callJson<{ applied: number; rejected: string[] }>(
      'set_extra_http_headers',
      { session_id: id, headers: { 'x-test': '1', 'x-other': '2' } },
    );
    expect(headers).toMatchObject({ applied: 2, rejected: [] });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/echo-headers') });
    expect(state.fixture.requests.at(-1)?.headers['x-test']).toBe('1');
  });

  it('scroll by a delta and wait_for_url with a regex', async () => {
    const h = state.harness;
    const id = await h.launch();
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/elements') });
    const res = await h.callJson<{ y: number }>('scroll', { session_id: id, mode: 'by', dy: 500 });
    expect(res.y).toBeGreaterThan(0);
    const to = await h.callJson<{ y: number }>('scroll', {
      session_id: id,
      mode: 'to',
      x: 0,
      y: 0,
    });
    expect(to.y).toBe(0);
    await h.callJson('scroll', { session_id: id, mode: 'selector', selector: '#bottom' });
    const url = await h.callJson<{ url: string }>('wait_for_url', {
      session_id: id,
      url: { pattern: '127\\.0\\.0\\.1' },
    });
    expect(url.url).toContain('127.0.0.1');
    const timeout = await h.call('wait_for_selector', {
      session_id: id,
      selector: '#never',
      timeout: 300,
    });
    expect(textOf(timeout)).toStartWith('[WAIT_TIMEOUT]');
  });

  it('screenshot returns an image block, saves under the sandbox and refuses outside paths', async () => {
    const h = state.harness;
    const id = await h.launch();
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
    const shot = await h.call('screenshot', { session_id: id, save_path: 'page.png' });
    expect(shot.content.find((c) => c.type === 'image')).toBeDefined();
    const meta = shot.content.find((c) => c.type === 'text');
    const savedTo: string = JSON.parse(meta?.type === 'text' ? meta.text : '{}').saved_to;
    expect((await stat(savedTo)).size).toBeGreaterThan(100);
    const refused = await h.call('screenshot', { session_id: id, save_path: '/tmp/evil.png' });
    expect(textOf(refused)).toStartWith('[PATH_NOT_ALLOWED]');
  });

  it('accept_next_dialog auto-accepts a confirm()', async () => {
    const h = state.harness;
    const id = await h.launch();
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
    await h.callJson('accept_next_dialog', { session_id: id });
    const res = await h.callJson<{ result: boolean }>('evaluate', {
      session_id: id,
      expression: "() => confirm('proceed?')",
    });
    expect(res.result).toBe(true);
  });

  it('downloads land in the managed dir; uploads come from the sandbox', async () => {
    const h = state.harness;
    const id = await h.launch();
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/download-page') });
    const dl = await h.callJson<{ saved_to: string; suggested_name: string; size: number }>(
      'download_file',
      { session_id: id, trigger_selector: '#download' },
    );
    expect(dl.suggested_name).toBe('fixture.txt');
    expect(dl.saved_to).toBe(join(h.dataDir, 'sessions', id, 'downloads', 'fixture.txt'));
    expect(dl.size).toBe('fixture download body\n'.length);
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/elements') });
    const file = join(h.dataDir, 'uploads', 'up.txt');
    await writeFile(file, 'upload');
    await h.callJson('upload_file', { session_id: id, selector: '#file', paths: [file] });
    const name = await h.callJson<{ result: string }>('evaluate', {
      session_id: id,
      expression: "() => document.getElementById('file').files[0].name",
    });
    expect(name.result).toBe('up.txt');
    expect(
      textOf(
        await h.call('upload_file', { session_id: id, selector: '#file', paths: ['/etc/hosts'] }),
      ),
    ).toStartWith('[PATH_NOT_ALLOWED]');
  });

  it('disable_evaluate makes evaluate a hard error', async () => {
    const h = state.harness;
    const id = await h.launch({ disable_evaluate: true });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
    expect(textOf(await h.call('evaluate', { session_id: id, expression: '() => 1' }))).toStartWith(
      '[EVALUATE_DISABLED]',
    );
    const snap = await h.callJson<{ tree: string }>('snapshot', { session_id: id });
    expect(snap.tree).toContain('fixture');
  });
});
