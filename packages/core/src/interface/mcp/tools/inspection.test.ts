/** @module interface/mcp/tools/inspection.test — screenshot (image block, sandbox, archival), snapshot, get_content and get_text (selector, paging, redaction before paging, evaluate gate not applied), evaluate (gate both ways, SCRIPT_ERROR, IIFE wrap). */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeSessionHandle } from '../../../../test/helpers/fake-session-handle.ts';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../../test/helpers/fake-transport.ts';
import { executeTool } from '../../../../test/helpers/tool-run.ts';
import { wrapFunctionExpression } from './inspection/evaluate-wrap.ts';

let h: ToolHarness;
afterEach(async () => h.close());

function handle(): FakeSessionHandle {
  const found = h.fakeDriver?.handles[0];
  if (found === undefined) throw new Error('no handle');
  return found;
}

describe('screenshot', () => {
  it('returns an image block, saves under the session dir and archives by event id', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const { result, value } = await executeTool(h, 'screenshot', {
      session_id: id,
      save_path: 'shot.png',
    });
    const image = result.content.find((c) => c.type === 'image');
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
    // The sandbox reports the resolved path, and a temp dir is often not one: macOS `/var` is a
    // symlink to `/private/var`, a Windows runner's TEMP uses the 8.3 name `RUNNER~1`.
    const savedTo = join(realpathSync.native(h.dataDir), 'sessions', id, 'shot.png');
    expect(result.content.find((c) => c.type === 'text')).toEqual({
      type: 'text',
      text: JSON.stringify({ saved_to: savedTo }),
    });
    expect(value).toEqual({ saved_to: savedTo, width: 1280, height: 720, bytes: 8 });
    const shot = h.bus.published.find((p) => p.name === 'screenshot.captured');
    const obs = h.observations().at(-1);
    expect(shot).toBeDefined();
    expect(h.bus.names().indexOf('screenshot.captured')).toBeGreaterThan(
      h.bus.names().lastIndexOf('tool.called'),
    );
    expect(existsSync(join(h.dataDir, 'sessions', id, 'screenshots', `${obs?.eventId}.png`))).toBe(
      true,
    );
  });

  it('refuses a save_path outside the sandbox before touching the browser', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const result = await h.call('screenshot', { session_id: id, save_path: '/tmp/evil.png' });
    expect(textOf(result)).toBe(
      "[PATH_NOT_ALLOWED] Path '/tmp/evil.png' is outside the allowed sandbox roots.",
    );
    expect(handle().firstPage.methods()).not.toContain('screenshot');
  });
});

describe('snapshot / get_content', () => {
  it('return the tree and the html with the paging fields', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const snap = await executeTool(h, 'snapshot', { session_id: id });
    const aria = h.script.aria;
    expect(snap.value).toEqual({
      session_id: id,
      url: 'about:blank',
      tree: aria,
      total_chars: aria.length,
      truncated: false,
      next_offset: null,
    });
    handle().firstPage.script.html = '<p>clicked</p>';
    const content = await executeTool(h, 'get_content', { session_id: id });
    expect(content.value).toEqual({
      session_id: id,
      url: 'about:blank',
      html: '<p>clicked</p>',
      total_chars: 14,
      truncated: false,
      next_offset: null,
    });
  });

  it('get_content caps a large page at 60000 characters by default and pages with offset', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const html = `<html>${'x'.repeat(70_000)}</html>`;
    handle().firstPage.script.html = html;
    const first = await executeTool(h, 'get_content', { session_id: id });
    const page1 = first.value as { html: string; truncated: boolean; next_offset: number };
    expect(page1.html).toHaveLength(60_000);
    expect(page1).toMatchObject({ total_chars: html.length, truncated: true, next_offset: 60_000 });
    const second = await executeTool(h, 'get_content', {
      session_id: id,
      offset: page1.next_offset,
    });
    const page2 = second.value as { html: string; truncated: boolean; next_offset: null };
    expect(page2).toMatchObject({ truncated: false, next_offset: null });
    expect(page1.html + page2.html).toBe(html);
  });

  it('get_content {selector} returns the first match through the own read; no match is ELEMENT_NOT_FOUND', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    h.script.readHtml = '<article>one</article>';
    const { value } = await executeTool(h, 'get_content', { session_id: id, selector: 'article' });
    expect(value).toMatchObject({ html: '<article>one</article>', truncated: false });
    expect(handle().firstPage.methods()).not.toContain('content');
    h.script.counts['#missing'] = 0;
    const missing = await h.call('get_content', { session_id: id, selector: '#missing' });
    expect(textOf(missing)).toBe("[ELEMENT_NOT_FOUND] No element matched selector '#missing'.");
  });

  it('snapshot {selector} snapshots the first match only', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const { value } = await executeTool(h, 'snapshot', { session_id: id, selector: 'nav' });
    expect(value).toMatchObject({ tree: h.script.aria });
    const snaps = handle().firstPage.calls.filter((c) => c.method === 'ariaSnapshot');
    expect(snaps.map((c) => c.args[0])).toEqual(['nav']);
    h.script.counts['nav'] = 0;
    const missing = await h.call('snapshot', { session_id: id, selector: 'nav' });
    expect(textOf(missing)).toBe("[ELEMENT_NOT_FOUND] No element matched selector 'nav'.");
  });

  it('a selector the driver cannot parse is INVALID_ARGUMENTS, not INTERNAL_ERROR', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    handle().firstPage.failWith(
      'count',
      new Error('locator.count: Unexpected token "" while parsing css selector "[[[".'),
      true,
    );
    for (const tool of ['snapshot', 'get_content', 'get_text']) {
      const result = await h.call(tool, { session_id: id, selector: '[[[' });
      expect(textOf(result)).toBe(
        '[INVALID_ARGUMENTS] selector: Unexpected token "" while parsing css selector "[[[".',
      );
    }
  });
});

describe('get_text', () => {
  it('reads through the isolated-world read and pages at 20000 characters by default', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const text = `${'a'.repeat(20_000)}${'b'.repeat(5_000)}`;
    h.script.readText = text;
    const first = await executeTool(h, 'get_text', { session_id: id });
    expect(first.value).toEqual({
      session_id: id,
      url: 'about:blank',
      text: 'a'.repeat(20_000),
      total_chars: 25_000,
      truncated: true,
      next_offset: 20_000,
    });
    const second = await executeTool(h, 'get_text', { session_id: id, offset: 20_000 });
    expect(second.value).toMatchObject({ text: 'b'.repeat(5_000), next_offset: null });
    const methods = handle().firstPage.methods();
    expect(methods).toContain('cdp:Page.createIsolatedWorld');
    expect(methods).not.toContain('evaluate');
  });

  it('uses the driver element on Patchright (its evaluate is isolated by default)', async () => {
    h = await createToolHarness();
    if (h.fakeDriver !== null) {
      h.fakeDriver.handleOptions = () => ({ capabilities: { isolatedEvaluate: true } });
    }
    const id = await h.launch();
    h.script.readText = 'patched';
    const { value } = await executeTool(h, 'get_text', { session_id: id, selector: 'main' });
    expect(value).toMatchObject({ text: 'patched' });
    const read = handle().firstPage.calls.find((c) => c.method === 'locator.evaluate');
    expect(read?.args[0]).toBe('main');
    expect(handle().firstPage.methods()).not.toContain('cdp:Page.createIsolatedWorld');
  });

  it('works in a disable_evaluate session and under allowEvaluate=false', async () => {
    h = await createToolHarness();
    const id = await h.launch({ disable_evaluate: true });
    expect((await executeTool(h, 'get_text', { session_id: id })).value).toMatchObject({
      text: 'fixture text',
    });
    await h.close();
    h = await createToolHarness({ allowEvaluate: false });
    const other = await h.launch();
    expect((await executeTool(h, 'get_text', { session_id: other })).value).toMatchObject({
      text: 'fixture text',
    });
  });

  it('a selector that matches nothing is ELEMENT_NOT_FOUND', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    h.script.counts['#none'] = 0;
    const result = await h.call('get_text', { session_id: id, selector: '#none' });
    expect(textOf(result)).toBe("[ELEMENT_NOT_FOUND] No element matched selector '#none'.");
    expect(result._meta?.['browserhive.ai/error']).toMatchObject({
      details: { selector: '#none', count: 0 },
    });
  });

  it('redacts the whole text before paging, so a credential across a page boundary never leaks', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const token = `Bearer ${'a'.repeat(24)}`;
    h.script.readText = `${'x'.repeat(10)} ${token} tail`;
    // Unredacted, the first page would end inside the token ("…Bear") and neither half would match.
    const first = await executeTool(h, 'get_text', { session_id: id, max_chars: 15 });
    const page1 = first.value as { text: string; next_offset: number; total_chars: number };
    const second = await executeTool(h, 'get_text', {
      session_id: id,
      offset: page1.next_offset,
      max_chars: 1_000,
    });
    const page2 = second.value as { text: string };
    const redacted = `${'x'.repeat(10)} Bearer [REDACTED] tail`;
    expect(`${page1.text}${page2.text}`).toBe(redacted);
    expect(page1.total_chars).toBe(redacted.length);
    expect(page2.text).not.toContain('aaaaaaaa');
  });
});

describe('evaluate', () => {
  it('wraps function-shaped expressions and returns the result', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    handle().firstPage.script.evaluateResult = 'alice';
    const { value } = await executeTool(h, 'evaluate', { session_id: id, expression: '() => 1' });
    expect(value).toEqual({ session_id: id, result: 'alice' });
    expect(handle().firstPage.calls.find((c) => c.method === 'evaluate')?.args[0]).toBe(
      '(() => 1)()',
    );
  });

  it('an undefined page result drops from the text but is null in structured content', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const { result } = await executeTool(h, 'evaluate', { session_id: id, expression: 'void 0' });
    expect(textOf(result)).toBe(JSON.stringify({ session_id: id }));
    expect(result.structuredContent).toEqual({ session_id: id, result: null });
  });

  it('EVALUATE_DISABLED for a disable_evaluate session and for allowEvaluate=false', async () => {
    h = await createToolHarness();
    const id = await h.launch({ disable_evaluate: true });
    const text = `[EVALUATE_DISABLED] The 'evaluate' tool is disabled for session '${id}'.`;
    expect(textOf(await h.call('evaluate', { session_id: id, expression: '1' }))).toBe(text);
    await h.close();
    h = await createToolHarness({ allowEvaluate: false });
    const other = await h.launch();
    const result = await h.call('evaluate', { session_id: other, expression: '1' });
    expect(textOf(result)).toBe(
      `[EVALUATE_DISABLED] The 'evaluate' tool is disabled for session '${other}'.`,
    );
    expect(result._meta?.['browserhive.ai/error']).toMatchObject({ details: { scope: 'server' } });
    expect(handle().firstPage.methods()).not.toContain('evaluate');
  });

  it('a page-side throw is SCRIPT_ERROR', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    handle().firstPage.failWith(
      'evaluate',
      new Error('page.evaluate: ReferenceError: nope is not defined'),
    );
    expect(textOf(await h.call('evaluate', { session_id: id, expression: 'nope' }))).toStartWith(
      '[SCRIPT_ERROR]',
    );
  });

  it('wrapFunctionExpression keeps already-invoked IIFEs and plain expressions', () => {
    expect(wrapFunctionExpression('(() => 1)()')).toBe('(() => 1)()');
    expect(wrapFunctionExpression('x => x')).toBe('(x => x)()');
    expect(wrapFunctionExpression('async function f() {}')).toBe('(async function f() {})()');
    expect(wrapFunctionExpression('document.title')).toBe('document.title');
  });
});
