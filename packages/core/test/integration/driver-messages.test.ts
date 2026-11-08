/**
 * @module test/integration/driver-messages — the driver message contract (#55, #56): every failure the classifier maps is
 * provoked on real Chromium through both drivers (Playwright and Patchright), and the code the agent gets is asserted. A
 * driver upgrade that rewords a message fails here instead of turning into `INTERNAL_ERROR` in production.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from 'playwright';
import { classifyDriverError } from '../../src/infra/browsers/classify-error.ts';
import { textOf } from '../helpers/fake-transport.ts';
import { useMcpStack } from './mcp-fixture.ts';

const DRIVERS = ['playwright', 'patchright'] as const;

/** The typed error a failed call carries in `_meta` (code and details). */
function errorOf(result: CallToolResult): { code?: string; details?: Record<string, unknown> } {
  const meta = result._meta?.['browserhive.ai/error'];
  return typeof meta === 'object' && meta !== null ? meta : {};
}

/** `SavedDownload` as `navigate` and `new_tab` return it. */
interface Download {
  readonly saved_to: string;
  readonly suggested_name: string;
  readonly size: number;
}

for (const driver of DRIVERS) {
  describe(`driver message contract (${driver}, real Chromium)`, () => {
    const { state } = useMcpStack({ stealthDriver: driver });

    /** A session on `driver`: stealth sessions use the configured stealth driver, plain ones stock Playwright. */
    async function launch(): Promise<string> {
      const id = await state.harness.launch({ stealth: driver === 'patchright' });
      // The contract must really run on both drivers; a silent fallback would hide a rewording.
      expect(state.harness.services.sessions.peek(id)?.driver).toBe(driver);
      return id;
    }

    /** The session's active Playwright page, for provoking a failure below the tool layer. */
    function rawPage(id: string): Page {
      const session = state.harness.services.sessions.peek(id);
      if (session === undefined) throw new Error(`no session ${id}`);
      return state.harness.services.sessions.page(session);
    }

    /** What `run` rejects with (`null` when it resolves). */
    function rejection(run: () => Promise<unknown>): Promise<unknown> {
      return run().then(
        () => null,
        (err: unknown) => err,
      );
    }

    it('a page-side throw is SCRIPT_ERROR carrying the message', async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
      const result = await h.call('evaluate', { session_id: id, expression: 'null.x' });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: 'SCRIPT_ERROR',
        details: { message: "TypeError: Cannot read properties of null (reading 'x')" },
      });
      expect(textOf(result)).toContain("Cannot read properties of null (reading 'x')");
    });

    it('a rejected in-page fetch is SCRIPT_ERROR (Failed to fetch)', async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
      const result = await h.call('evaluate', {
        session_id: id,
        expression: "fetch('http://127.0.0.1:1/unreachable')",
      });
      expect(errorOf(result)).toMatchObject({
        code: 'SCRIPT_ERROR',
        details: { message: 'TypeError: Failed to fetch' },
      });
    });

    it('a syntax error is SCRIPT_ERROR with the page message, not a wrap misfire', async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
      const result = await h.call('evaluate', {
        session_id: id,
        expression: "(() => { const s = 'start('; return s.length; })(",
      });
      expect(errorOf(result).code).toBe('SCRIPT_ERROR');
      expect(String(errorOf(result).details?.['message'])).toStartWith('SyntaxError:');
    });

    it("an invoked IIFE containing '(' in a string returns its value; a bare arrow is called", async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
      const iife = await h.callJson<{ result: number }>('evaluate', {
        session_id: id,
        expression: "(() => { const s = 'start('; return s.length; })()",
      });
      expect(iife.result).toBe(6);
      const arrow = await h.callJson<{ result: number }>('evaluate', {
        session_id: id,
        expression: 'async () => { const s = ")"; return s.length + 1; }',
      });
      expect(arrow.result).toBe(2);
      const anonymous = await h.callJson<{ result: number }>('evaluate', {
        session_id: id,
        expression: 'function () { return 3; }',
      });
      expect(anonymous.result).toBe(3);
    });

    it('a goto timeout is NAVIGATION_TIMEOUT, and its prose alone classifies the same', async () => {
      const h = state.harness;
      const id = await launch();
      const url = state.fixture.url('/slow?ms=3000');
      // The row itself must match the real wording, not only the `TimeoutError` name.
      const err = await rejection(() => rawPage(id).goto(url, { timeout: 500 }));
      const proseOnly = new Error(err instanceof Error ? err.message : 'not an error');
      expect(classifyDriverError(proseOnly, { url })?.details).toEqual({ url, timeout_ms: 500 });
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
      const result = await h.call('navigate', { session_id: id, url, timeout: 500 });
      expect(errorOf(result)).toMatchObject({
        code: 'NAVIGATION_TIMEOUT',
        details: { url, timeout_ms: 500 },
      });
    });

    it('get_content right after a timed-out navigate returns HTML or WAIT_TIMEOUT, never INTERNAL_ERROR', async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
      const nav = await h.call('navigate', {
        session_id: id,
        url: state.fixture.url('/slow?ms=1500'),
        timeout: 300,
      });
      expect(errorOf(nav).code).toBe('NAVIGATION_TIMEOUT');
      const content = await h.call('get_content', { session_id: id });
      expect(errorOf(content).code).not.toBe('INTERNAL_ERROR');
      // The slow page arrives within the 5 s settle budget, so a refused read waits for it; a read
      // that Chromium still allows before the navigation commits returns the old page.
      expect(content.isError).not.toBe(true);
      expect(JSON.parse(textOf(content)).html).toMatch(/slept 1500|id="title">fixture/);
    });

    it('get_content answers WAIT_TIMEOUT while a navigation outlasts the settle budget', async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
      await h.call('navigate', {
        session_id: id,
        url: state.fixture.url('/slow?ms=9000'),
        timeout: 300,
      });
      const startedAt = Date.now();
      const content = await h.call('get_content', { session_id: id });
      if (content.isError === true) {
        expect(errorOf(content)).toMatchObject({
          code: 'WAIT_TIMEOUT',
          details: { what: 'the page to finish navigating', timeout_ms: 5000 },
        });
      } else {
        // A read Chromium still allows before the navigation commits returns the old page.
        expect(JSON.parse(textOf(content)).html).toContain('id="title">fixture');
      }
      // Bounded by the settle budget, not by the 9 s response.
      expect(Date.now() - startedAt).toBeLessThan(7_500);
    }, 20_000);

    it('the mid-navigation content() refusal itself classifies as WAIT_TIMEOUT', async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
      const page = rawPage(id);
      const pending = page.goto(state.fixture.url('/slow?ms=1500')).catch(() => null);
      await Bun.sleep(100);
      const err = await rejection(() => page.content());
      await pending;
      // Chromium does not always refuse (the read can land before the navigation starts).
      if (err !== null) {
        expect(classifyDriverError(err, { timeoutMs: 5000 })?.details).toEqual({
          what: 'the page to finish navigating',
          timeout_ms: 5000,
        });
      }
    });

    it('navigate to an attachment returns the download, and the file is in the downloads dir', async () => {
      const h = state.harness;
      const id = await launch();
      const home = state.fixture.url('/');
      await h.callJson('navigate', { session_id: id, url: home });
      const result = await h.callJson('navigate', {
        session_id: id,
        url: state.fixture.url('/download'),
      });
      const savedTo = join(h.dataDir, 'sessions', id, 'downloads', 'fixture.txt');
      expect(result).toEqual({
        session_id: id,
        url: home,
        status: null,
        download: { saved_to: savedTo, suggested_name: 'fixture.txt', size: 22 },
      });
      expect(existsSync(savedTo)).toBe(true);
      expect(readFileSync(savedTo, 'utf8')).toBe('fixture download body\n');
    });

    it('new_tab(url) to an attachment returns the download and keeps the tab', async () => {
      const h = state.harness;
      const id = await launch();
      const result = await h.callJson<{ tab_id: string; url: string; download: Download }>(
        'new_tab',
        { session_id: id, url: state.fixture.url('/download') },
      );
      expect(result.download.suggested_name).toBe('fixture.txt');
      expect(existsSync(result.download.saved_to)).toBe(true);
      const tabs = await h.callJson<{ tab_id: string }[]>('list_tabs', { session_id: id });
      expect(tabs.map((t) => t.tab_id)).toContain(result.tab_id);
    });

    it('a broken download transfer is DOWNLOAD_FAILED (navigate and download_file)', async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/download-page') });
      const nav = await h.call('navigate', {
        session_id: id,
        url: state.fixture.url('/download-broken'),
      });
      if (driver === 'playwright') {
        expect(errorOf(nav)).toMatchObject({ code: 'DOWNLOAD_FAILED' });
      } else {
        // Patchright fetches a document response itself (to inject its init scripts) and hands the
        // browser what arrived, so a transfer that breaks mid-way is saved truncated, not failed.
        expect(errorOf(nav).code ?? 'ok').toBeOneOf(['ok', 'DOWNLOAD_FAILED']);
      }
      // An `<a download>` click is not a document load, so both drivers see the real failure.
      const clicked = await h.call('download_file', {
        session_id: id,
        trigger_selector: '#download-broken',
      });
      expect(errorOf(clicked)).toMatchObject({ code: 'DOWNLOAD_FAILED' });
    });

    it('the real download failure message classifies as DOWNLOAD_FAILED', async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/download-page') });
      const page = rawPage(id);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#download-broken'),
      ]);
      const err = await rejection(() => download.saveAs(join(h.dataDir, 'broken.txt')));
      expect(classifyDriverError(err)?.details).toEqual({ reason: 'canceled' });
    });

    it("a download that outlives the call's timeout is DOWNLOAD_FAILED", async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
      const result = await h.call('navigate', {
        session_id: id,
        url: state.fixture.url('/download-stall?ms=8000'),
        timeout: 1500,
      });
      if (driver === 'playwright') {
        expect(errorOf(result)).toMatchObject({
          code: 'DOWNLOAD_FAILED',
          details: { reason: 'the download did not finish within 1500 ms' },
        });
      } else {
        // Patchright buffers the document response (see above): no download starts before the
        // body is complete, so the call times out as a navigation.
        expect(errorOf(result).code).toBeOneOf(['NAVIGATION_TIMEOUT', 'DOWNLOAD_FAILED']);
      }
    });

    it('an upload to a non-file input is UPLOAD_FAILED', async () => {
      const h = state.harness;
      const id = await launch();
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/elements') });
      const file = join(h.dataDir, 'uploads', 'up.txt');
      await writeFile(file, 'upload');
      const result = await h.call('upload_file', {
        session_id: id,
        selector: '#text',
        paths: [file],
        timeout: 500,
      });
      expect(errorOf(result).code).toBe('UPLOAD_FAILED');
      // An element that is not an <input> at all fails at once with the driver's own reason.
      const handle = await rawPage(id).$('#h');
      const err = await rejection(async () => handle?.setInputFiles(file));
      expect(classifyDriverError(err)?.code).toBe('UPLOAD_FAILED');
    });
  });
}
