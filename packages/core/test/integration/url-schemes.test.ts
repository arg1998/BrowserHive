/** @module test/integration/url-schemes — agent-requested URLs are limited to web schemes (spec 13 T0d, D-57) and the main-frame backstop, against real Chromium. */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from 'playwright';
import type { ToolHarness } from '../helpers/fake-transport.ts';
import { textOf } from '../helpers/fake-transport.ts';
import { useMcpStack } from './mcp-fixture.ts';

/** Every input refused before the browser is touched, with the scheme its refusal names. */
const REFUSED: ReadonlyArray<readonly [string, string]> = [
  ['file:///etc/hostname', 'file'],
  ['FILE:///etc/hostname', 'file'],
  ['chrome://version', 'chrome'],
  ['chrome://settings/passwords', 'chrome'],
  ['chrome-untrusted://terminal/', 'chrome-untrusted'],
  ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.html', 'chrome-extension'],
  ['devtools://devtools/bundled/inspector.html', 'devtools'],
  ['view-source:http://127.0.0.1/', 'view-source'],
  ['view-source:file:///etc/hostname', 'view-source'],
  ["javascript:document.title='PWNED'", 'javascript'],
  ["JavaScript:document.title='PWNED'", 'javascript'],
  ["JAVA\tSCRIPT:document.title='PWNED'", 'javascript'],
  ["java\nscript:document.title='PWNED'", 'javascript'],
  ["  javascript:document.title='PWNED'", 'javascript'],
  ['blob:http://127.0.0.1/00000000-0000-0000-0000-000000000000', 'blob'],
  ['filesystem:http://127.0.0.1/temporary/x', 'filesystem'],
  ['mailto:someone@example.com', 'mailto'],
  ['about:version', 'about'],
  ['about:blank#x', 'about'],
  ['localhost:3000', 'localhost'],
  ['slack://open', 'slack'],
  ['example.com', ''],
  ['', ''],
];

function errorOf(result: CallToolResult): { code?: string; details?: Record<string, unknown> } {
  const meta = result._meta?.['browserhive.ai/error'];
  return typeof meta === 'object' && meta !== null ? meta : {};
}

function livePage(h: ToolHarness, sessionId: string, tabId?: string): Page {
  const session = h.services.sessions.peek(sessionId);
  if (session === undefined) throw new Error(`no session ${sessionId}`);
  return session.tabs.resolve(tabId);
}

async function tabs(h: ToolHarness, sessionId: string): Promise<{ tab_id: string; url: string }[]> {
  return h.callJson('list_tabs', { session_id: sessionId });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

describe('URL schemes (real Chromium)', () => {
  const { state } = useMcpStack();

  it('navigate and new_tab refuse every non-web scheme and leave the page alone', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'schemes' });
    const home = state.fixture.url('/');
    await h.callJson('navigate', { session_id: id, url: home });
    for (const [url, scheme] of REFUSED) {
      const nav = await h.call('navigate', { session_id: id, url, timeout: 5_000 });
      expect({ url, code: textOf(nav).split(' ')[0] }).toEqual({
        url,
        code: '[URL_SCHEME_NOT_ALLOWED]',
      });
      expect(errorOf(nav)).toMatchObject({
        code: 'URL_SCHEME_NOT_ALLOWED',
        details: { scheme },
      });
      expect(livePage(h, id).url()).toBe(home);
      expect(await livePage(h, id).title()).not.toBe('PWNED');

      const tab = await h.call('new_tab', { session_id: id, url, timeout: 5_000 });
      expect({ url, code: textOf(tab).split(' ')[0] }).toEqual({
        url,
        code: '[URL_SCHEME_NOT_ALLOWED]',
      });
      const open = await tabs(h, id);
      expect(open.map((t) => t.url)).toEqual([home]);
    }
  });

  it('a javascript: URL cannot rewrite the DOM of a disable_evaluate session', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'jsurl', disable_evaluate: true });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
    const before = await h.callJson<{ html: string }>('get_content', { session_id: id });
    expect(before.html).toContain('<h1 id="title">fixture</h1>');

    const exploit = await h.call('navigate', {
      session_id: id,
      url: "javascript:document.body.innerHTML='PWNED'",
    });
    expect(textOf(exploit)).toStartWith('[URL_SCHEME_NOT_ALLOWED]');
    // A javascript: URL runs asynchronously; give it the chance it had before the fix.
    await Bun.sleep(300);
    const after = await h.callJson<{ html: string }>('get_content', { session_id: id });
    expect(after.html).not.toContain('PWNED');
    expect(after.html).toBe(before.html);

    const cookieTitle = await h.call('navigate', {
      session_id: id,
      url: 'javascript:document.title=document.cookie',
    });
    expect(textOf(cookieTitle)).toStartWith('[URL_SCHEME_NOT_ALLOWED]');
    await Bun.sleep(300);
    expect(await livePage(h, id).title()).toBe('');
    const last = await h.callJson<{ html: string }>('get_content', { session_id: id });
    expect(last.html).toBe(before.html);
  });

  it('file:///etc/hostname is never loaded, by either tool', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'file' });
    let hostname = '';
    try {
      hostname = readFileSync('/etc/hostname', 'utf8').trim();
    } catch {
      hostname = '';
    }
    const nav = await h.call('navigate', { session_id: id, url: 'file:///etc/hostname' });
    expect(textOf(nav)).toStartWith('[URL_SCHEME_NOT_ALLOWED]');
    const tab = await h.call('new_tab', { session_id: id, url: 'file:///etc/hostname' });
    expect(textOf(tab)).toStartWith('[URL_SCHEME_NOT_ALLOWED]');
    const open = await tabs(h, id);
    expect(open.map((t) => t.url)).toEqual(['about:blank']);
    if (hostname.length > 0) {
      const content = await h.callJson<{ html: string }>('get_content', { session_id: id });
      expect(content.html).not.toContain(hostname);
    }
  });

  it('data: URLs still open in an exclusive session, through both tools', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'data' });
    await h.callJson('navigate', {
      session_id: id,
      url: 'data:text/html,<p id="d">data works</p>',
    });
    const content = await h.callJson<{ html: string }>('get_content', { session_id: id });
    expect(content.html).toContain('data works');
    const tab = await h.callJson<{ tab_id: string; url: string }>('new_tab', {
      session_id: id,
      url: 'DATA:text/html,<p>second</p>',
    });
    expect(tab.url).toBe('data:text/html,<p>second</p>');
  });

  it('about:blank tabs and http navigation work; the tool navigates to the normalized href', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'web' });
    const blank = await h.callJson<{ url: string }>('new_tab', {
      session_id: id,
      url: 'about:blank',
    });
    expect(blank.url).toBe('about:blank');
    const bare = await h.callJson<{ url: string }>('new_tab', { session_id: id });
    expect(bare.url).toBe('about:blank');
    const raw = ` HTTP://127.0.0.1:${state.fixture.port}/elements `;
    const nav = await h.callJson<{ url: string; status: number }>('navigate', {
      session_id: id,
      url: raw,
    });
    expect(nav).toMatchObject({ url: state.fixture.url('/elements'), status: 200 });
    expect(state.fixture.requests.some((r) => r.path === '/elements')).toBe(true);
  });
});

describe('URL schemes with a blocklist (real Chromium)', () => {
  const { state } = useMcpStack({ blocklist: '*/blocked*\n' });

  it('web URLs still pass, the blocklist still refuses its patterns, and schemes are checked first', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'blocklist' });
    const ok = await h.callJson<{ status: number }>('navigate', {
      session_id: id,
      url: state.fixture.url('/'),
    });
    expect(ok.status).toBe(200);
    const tab = await h.callJson<{ url: string }>('new_tab', {
      session_id: id,
      url: 'about:blank',
    });
    expect(tab.url).toBe('about:blank');
    const blocked = await h.call('navigate', {
      session_id: id,
      url: `http://127.0.0.1:${state.fixture.port}/blocked`,
    });
    expect(textOf(blocked)).toStartWith('[URL_BLOCKED]');
    const scheme = await h.call('navigate', {
      session_id: id,
      url: 'view-source:http://127.0.0.1/blocked',
    });
    expect(textOf(scheme)).toStartWith('[URL_SCHEME_NOT_ALLOWED]');
  });
});

describe('non-web scheme backstop (real Chromium)', () => {
  const { state } = useMcpStack();

  it("a page's own location = 'file:///etc/hosts' never commits a file: URL", async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'tofile' });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/to-file') });
    await Bun.sleep(500);
    for (const tab of await tabs(h, id)) expect(tab.url).not.toStartWith('file:');
    expect(livePage(h, id).url()).toBe(state.fixture.url('/to-file'));
  });

  it('closes the first page when its main frame commits a file: URL no tool requested', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'backstop' });
    const page = livePage(h, id);
    await page.goto('file:///etc/hostname').catch(() => undefined);
    expect(await waitFor(() => page.isClosed())).toBe(true);
    expect(await tabs(h, id)).toEqual([]);
    const logged = h.logger.find('non-web scheme page closed');
    expect(logged.at(-1)?.all).toMatchObject({ sessionId: id, scheme: 'file' });
  });

  it('closes a later tab that commits a file: URL and keeps the others', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'backstop2' });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
    const first = (await tabs(h, id))[0]?.tab_id ?? '';
    const second = await h.callJson<{ tab_id: string }>('new_tab', { session_id: id });
    const page = livePage(h, id, second.tab_id);
    await page.goto('file:///etc/hostname').catch(() => undefined);
    expect(await waitFor(() => page.isClosed())).toBe(true);
    const open = await tabs(h, id);
    expect(open.map((t) => t.tab_id)).toEqual([first]);
    expect(open[0]?.url).toBe(state.fixture.url('/'));
  });

  it('closes a popup the site opened once it commits a non-web URL', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'backstop3' });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/popup') });
    const opener = livePage(h, id);
    const popupPromise = opener.waitForEvent('popup');
    await h.callJson('click', { session_id: id, selector: '#open' });
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect((await tabs(h, id)).length).toBe(2);
    await popup.goto('file:///etc/hostname').catch(() => undefined);
    expect(await waitFor(() => popup.isClosed())).toBe(true);
    expect((await tabs(h, id)).map((t) => t.url)).toEqual([state.fixture.url('/popup')]);
  });

  it('leaves site-initiated data: and blob: navigations alone', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'backstop4' });
    const page = livePage(h, id);
    await page.goto('data:text/html,<p>direct data</p>');
    await page.goto(state.fixture.url('/'));
    const blobUrl = await page.evaluate(() =>
      URL.createObjectURL(new Blob(['<p>blob page</p>'], { type: 'text/html' })),
    );
    await page.goto(blobUrl);
    await Bun.sleep(200);
    expect(page.isClosed()).toBe(false);
    expect(page.url()).toStartWith('blob:');
  });
});
