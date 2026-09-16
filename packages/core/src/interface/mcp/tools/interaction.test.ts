/** @module interface/mcp/tools/interaction.test — interaction tools: native vs humanized paths, actionability mapping, scroll modes. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { FakeSessionHandle } from '../../../../test/helpers/fake-session-handle.ts';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../../test/helpers/fake-transport.ts';
import { spyPageActions } from '../../../../test/helpers/tool-fakes.ts';
import { executeTool } from '../../../../test/helpers/tool-run.ts';

let h: ToolHarness;
afterEach(async () => h.close());

function handle(): FakeSessionHandle {
  const found = h.fakeDriver?.handles[0];
  if (found === undefined) throw new Error('no handle');
  return found;
}

describe('interaction tools (native)', () => {
  it('click / type_text / fill / press_key / hover / select_option / drag_and_drop', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const s = { session_id: id };
    expect((await executeTool(h, 'click', { ...s, selector: '#go' })).value).toEqual({
      ...s,
      selector: '#go',
      ok: true,
    });
    await executeTool(h, 'type_text', { ...s, selector: '#bio', text: 'hello' });
    await executeTool(h, 'fill', { ...s, selector: '#name', value: 'alice' });
    expect((await executeTool(h, 'press_key', { ...s, key: 'Enter' })).value).toEqual({
      ...s,
      key: 'Enter',
      ok: true,
    });
    await executeTool(h, 'press_key', { ...s, key: 'a', selector: '#name' });
    await executeTool(h, 'hover', { ...s, selector: '#go' });
    const selected = await executeTool(h, 'select_option', {
      ...s,
      selector: '#color',
      values: ['blue'],
    });
    expect(selected.value).toEqual({ ...s, selector: '#color', selected: ['blue'] });
    expect(
      (
        await executeTool(h, 'drag_and_drop', {
          ...s,
          source_selector: '#a',
          target_selector: '#b',
        })
      ).value,
    ).toEqual({ ...s, ok: true });
    const page = handle().firstPage;
    expect(page.methods()).toEqual(
      expect.arrayContaining([
        'click',
        'type',
        'fill',
        'keyboard.press',
        'press',
        'hover',
        'selectOption',
        'dragAndDrop',
      ]),
    );
    expect(page.calls.find((c) => c.method === 'click')?.args[1]).toEqual({
      button: 'left',
      clickCount: 1,
      timeout: 30_000,
    });
  });

  it('maps an actionability timeout to ELEMENT_NOT_ACTIONABLE with the selector', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const err = new Error('page.hover: Timeout 800ms exceeded.\nCall log: waiting for locator');
    err.name = 'TimeoutError';
    handle().firstPage.failWith('hover', err);
    const result = await h.call('hover', { session_id: id, selector: '#missing', timeout: 800 });
    expect(textOf(result)).toStartWith(
      "[ELEMENT_NOT_ACTIONABLE] Element '#missing' did not become actionable",
    );
    expect(textOf(result)).toEndWith('(page.hover: Timeout 800ms exceeded.)');
  });

  it('select_option requires at least one value (schema message)', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const result = await h.call('select_option', { session_id: id, selector: '#c', values: [] });
    expect(textOf(result)).toBe(
      '[INVALID_ARGUMENTS] values: values must include at least one option',
    );
  });

  it('scroll by / to / selector return the offset; superRefine enforces mode fields', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    handle().firstPage.script.evaluateResult = { x: 0, y: 500 };
    expect((await executeTool(h, 'scroll', { session_id: id, mode: 'by', dy: 500 })).value).toEqual(
      { session_id: id, x: 0, y: 500 },
    );
    await executeTool(h, 'scroll', { session_id: id, mode: 'to', x: 0, y: 10 });
    await executeTool(h, 'scroll', { session_id: id, mode: 'selector', selector: '#bottom' });
    const evaluated = handle()
      .firstPage.calls.filter((c) => c.method === 'evaluate')
      .map((c) => c.args[0]);
    expect(evaluated).toContain('window.scrollBy({ left: 0, top: 500, behavior: "auto" })');
    expect(evaluated).toContain('window.scrollTo({ left: 0, top: 10, behavior: "auto" })');
    const bad = await h.call('scroll', { session_id: id, mode: 'to', x: 1 });
    expect(textOf(bad)).toBe('[INVALID_ARGUMENTS] input: mode="to" requires x and y');
  });
});

describe('interaction tools (humanized)', () => {
  it('click / hover / type_text / scroll(by) take the humanized path; fill stays native', async () => {
    const spy = spyPageActions();
    h = await createToolHarness({ pageActions: spy.actions });
    const id = await h.launch({ stealth: true, humanize: true });
    const s = { session_id: id };
    await executeTool(h, 'click', { ...s, selector: '#go' });
    await executeTool(h, 'hover', { ...s, selector: '#go' });
    await executeTool(h, 'type_text', { ...s, selector: '#bio', text: 'hi', timeout: 1000 });
    await executeTool(h, 'fill', { ...s, selector: '#name', value: 'x' });
    await executeTool(h, 'scroll', { ...s, mode: 'by', dy: 100 });
    await executeTool(h, 'set_viewport', { ...s, width: 800, height: 600 });
    // typing budget = max(timeout, estimate(2 chars)=312 + 5000)
    expect(spy.calls).toEqual([
      'humanClick',
      'humanHover',
      'humanType:5312',
      'humanScroll',
      'invalidateCursor',
    ]);
  });
});
