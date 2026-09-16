/** @module interface/mcp/tools/inspection.test — screenshot (image block, sandbox, archival), snapshot, get_content, evaluate (gate both ways, SCRIPT_ERROR, IIFE wrap). */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
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
    const savedTo = join(h.dataDir, 'sessions', id, 'shot.png');
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
  it('return the tree and the html', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const snap = await executeTool(h, 'snapshot', { session_id: id });
    expect(snap.value).toEqual({ session_id: id, url: 'about:blank', tree: h.script.aria });
    handle().firstPage.script.html = '<p>clicked</p>';
    const content = await executeTool(h, 'get_content', { session_id: id });
    expect(content.value).toEqual({ session_id: id, url: 'about:blank', html: '<p>clicked</p>' });
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
