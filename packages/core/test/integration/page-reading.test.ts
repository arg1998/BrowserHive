/// <reference lib="dom" />
/** @module test/integration/page-reading — get_text, the paging of get_content/snapshot, and get_cookies include_values against real Chromium (spec 02 §3.6, #60): the default cap and exact reassembly on a ~700 KB page, the text rules, selector scoping, disable_evaluate, and a page that rewrites DOM prototypes on both drivers. */

import { describe, expect, it } from 'bun:test';
import type { Page } from 'playwright';
import { createPlaywrightPageActions } from '../../src/infra/browsers/page-actions.ts';
import { PlaywrightBrowserDriver } from '../../src/infra/browsers/playwright-browser-driver.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createNanoidIdGenerator } from '../../src/infra/ids/nanoid-id-generator.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { type ToolHarness, textOf } from '../helpers/fake-transport.ts';
import { HOST } from './driver-fixture.ts';
import { createRealHarness, useMcpStack } from './mcp-fixture.ts';

/** The paging fields every reading tool returns. */
interface Paging {
  readonly total_chars: number;
  readonly truncated: boolean;
  readonly next_offset: number | null;
}

/** The live Playwright page of a session's active tab. */
function livePage(h: ToolHarness, sessionId: string): Page {
  const session = h.services.sessions.peek(sessionId);
  if (session === undefined) throw new Error(`no session ${sessionId}`);
  return h.services.sessions.page(session);
}

/** Reads every page of `field` from offset 0 until `next_offset` is null. */
async function readAll(
  h: ToolHarness,
  tool: string,
  field: string,
  args: Record<string, unknown>,
): Promise<{ text: string; calls: number; pages: (Paging & Record<string, unknown>)[] }> {
  const pages: (Paging & Record<string, unknown>)[] = [];
  let offset: number | null = 0;
  let text = '';
  while (offset !== null) {
    const page: Paging & Record<string, unknown> = await h.callJson(tool, { ...args, offset });
    pages.push(page);
    const chunk = page[field];
    if (typeof chunk !== 'string') throw new Error(`${tool} returned no ${field}`);
    text += chunk;
    offset = page.next_offset;
    if (pages.length > 100) throw new Error('paging made no progress');
  }
  return { text, calls: pages.length, pages };
}

describe('page reading (real Chromium)', () => {
  const { state } = useMcpStack();

  it('get_content caps a ~700 KB page at 60000 characters and pages back to page.content() exactly', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'big' });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/reading-big') });
    const expected = await livePage(h, id).content();
    expect(expected.length).toBeGreaterThan(650_000);

    const first = await h.callJson<{ html: string } & Paging>('get_content', { session_id: id });
    expect(first.html.length).toBeLessThanOrEqual(60_000);
    expect(first.truncated).toBe(true);
    expect(first.total_chars).toBe(expected.length);
    expect(first.next_offset).toBe(first.html.length);

    const all = await readAll(h, 'get_content', 'html', { session_id: id });
    expect(all.text).toBe(expected);
    expect(all.calls).toBe(Math.ceil(expected.length / 60_000));
    expect(all.pages.at(-1)).toMatchObject({ truncated: false, next_offset: null });
    for (const page of all.pages.slice(0, -1)) expect(page.truncated).toBe(true);
  });

  it('get_text keeps code and collapsed content, skips script/style/hidden, and drops page chrome', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'text' });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/reading') });
    const read = await h.callJson<{ text: string; url: string } & Paging>('get_text', {
      session_id: id,
    });
    const text = read.text;
    expect(read.url).toBe(state.fixture.url('/reading'));
    expect(read).toMatchObject({ truncated: false, next_offset: null, total_chars: text.length });
    expect(text.startsWith('Reading fixture\n')).toBe(true);
    // Inline code stays inline; white space collapses outside `pre`.
    expect(text).toContain('Call fetchData() then read the result.');
    // `pre` keeps its line breaks and indentation.
    expect(text).toContain('const a = 1;\n  return a;');
    // Collapsed <details> and the inactive tab panel are read.
    expect(text).toContain('Collapsed details body');
    expect(text).toContain('npm install pkg');
    expect(text).toContain('bun add pkg');
    expect(text).toContain('Party 🎉 time');
    for (const marker of [
      'SCRIPT_TEXT_MARKER',
      'STYLE_TEXT_MARKER',
      'NOSCRIPT_MARKER',
      'TEMPLATE_MARKER',
      'SVG_MARKER',
      'HIDDEN_DIV_MARKER',
      // Outside <main>: not read without a selector.
      'FOOTER_MARKER',
      'Home Docs',
    ]) {
      expect(text).not.toContain(marker);
    }
    // Blocks are separated by line breaks, paragraphs by a blank line.
    expect(text).toContain('Reading fixture\n\nCall fetchData()');
  });

  it('get_text honours selector, answers ELEMENT_NOT_FOUND for no match, and pages exactly', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'scoped' });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/reading') });
    const scoped = await h.callJson<{ text: string }>('get_text', {
      session_id: id,
      selector: '#scoped',
    });
    expect(scoped.text).toBe('Scoped\n\nOnly this section');
    // A Playwright-only selector resolves the same element.
    const byText = await h.callJson<{ text: string }>('get_text', {
      session_id: id,
      selector: 'section >> text=Only this section',
    });
    expect(byText.text).toBe('Only this section');
    const missing = await h.call('get_text', { session_id: id, selector: '#nope' });
    expect(textOf(missing)).toBe("[ELEMENT_NOT_FOUND] No element matched selector '#nope'.");

    const whole = await h.callJson<{ text: string }>('get_text', { session_id: id });
    const paged = await readAll(h, 'get_text', 'text', { session_id: id, max_chars: 7 });
    expect(paged.text).toBe(whole.text);
    expect(paged.calls).toBeGreaterThan(5);
    for (const page of paged.pages) {
      expect(page['text']).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
    }
  });

  it('get_text works in a disable_evaluate session', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'noeval', disable_evaluate: true });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/reading') });
    const refused = await h.call('evaluate', { session_id: id, expression: 'document.title' });
    expect(textOf(refused)).toStartWith('[EVALUATE_DISABLED]');
    const read = await h.callJson<{ text: string }>('get_text', { session_id: id });
    expect(read.text).toContain('Collapsed details body');
  });

  it('snapshot {selector} returns only that subtree; without it, the body tree as before', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'snap' });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/reading') });
    const scoped = await h.callJson<{ tree: string } & Paging>('snapshot', {
      session_id: id,
      selector: '#scoped',
    });
    expect(scoped.tree).toContain('heading "Scoped" [level=2]');
    expect(scoped.tree).toContain('Only this section');
    expect(scoped.tree).not.toContain('Reading fixture');
    expect(scoped.tree).not.toContain('fetchData');
    expect(scoped).toMatchObject({ truncated: false, next_offset: null });

    const full = await h.callJson<{ tree: string } & Paging>('snapshot', { session_id: id });
    expect(full.tree).toBe(await livePage(h, id).locator('body').ariaSnapshot());
    expect(full).toMatchObject({ truncated: false, total_chars: full.tree.length });
    // Spec 02 §3.6 finding (Playwright 1.63, Chromium): inline <code> is kept as a `code` node; the
    // line breaks of <pre> and the content of collapsed <details> are not in the tree.
    expect(full.tree).toContain('- code: fetchData()');
    expect(full.tree).not.toContain('Collapsed details body');
    expect(full.tree).not.toContain('const a = 1;\n');

    const missing = await h.call('snapshot', { session_id: id, selector: '#nope' });
    expect(textOf(missing)).toBe("[ELEMENT_NOT_FOUND] No element matched selector '#nope'.");
  });

  it('get_content without new params is the whole small page; {selector} is the first match outerHTML', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'content' });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/reading') });
    const whole = await h.callJson<{ html: string } & Paging>('get_content', { session_id: id });
    expect(whole.html).toBe(await livePage(h, id).content());
    expect(whole).toMatchObject({ truncated: false, next_offset: null });
    const one = await h.callJson<{ html: string }>('get_content', {
      session_id: id,
      selector: '[role=tabpanel]',
    });
    expect(one.html).toBe('<div role="tabpanel" id="panel-npm">npm install pkg</div>');
    const missing = await h.call('get_content', { session_id: id, selector: '#nope' });
    expect(textOf(missing)).toBe("[ELEMENT_NOT_FOUND] No element matched selector '#nope'.");
  });

  it('get_cookies {include_values: false} returns every cookie with an empty value', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'cookies' });
    await h.callJson('navigate', {
      session_id: id,
      url: state.fixture.url('/set-cookie?v=abc123'),
    });
    const full = await h.callJson<{ cookies: { name: string; value: string }[] }>('get_cookies', {
      session_id: id,
    });
    expect(full.cookies.find((c) => c.name === 'fixture')?.value).toBe('abc123');
    const names = await h.callJson<{ cookies: { name: string; value: string }[] }>('get_cookies', {
      session_id: id,
      include_values: false,
    });
    expect(names.cookies.map((c) => c.name)).toEqual(full.cookies.map((c) => c.name));
    expect(names.cookies).toEqual(full.cookies.map((c) => ({ ...c, value: '' })));
  });
});

describe('get_text against a page that rewrites DOM prototypes (both drivers)', () => {
  const { state } = useMcpStack();

  it('stock Playwright reads through a CDP isolated world: untouched by the page', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'tamper' });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/reading') });
    const clean = await h.callJson<{ text: string }>('get_text', { session_id: id });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/reading-tamper') });
    // The page's own reads are broken: proof the override is live in the main world.
    expect(await livePage(h, id).evaluate(() => document.body.textContent)).toBe('TAMPERED');
    const tampered = await h.callJson<{ text: string }>('get_text', { session_id: id });
    expect(tampered.text).toBe(clean.text);
    const scoped = await h.callJson<{ text: string }>('get_text', {
      session_id: id,
      selector: '#scoped',
    });
    expect(scoped.text).toBe('Scoped\n\nOnly this section');
    const html = await h.callJson<{ html: string }>('get_content', {
      session_id: id,
      selector: '#scoped',
    });
    expect(html.html).toContain('Only this section');
  });

  it('a stealth session (Patchright when installed) reads in its isolated world: untouched', async () => {
    const clock = createSystemClock();
    const h = await createRealHarness({
      driver: new PlaywrightBrowserDriver({
        logger: createCollectingLogger(),
        clock,
        host: HOST,
        stealthDriver: 'auto',
      }),
      pageActions: createPlaywrightPageActions({ clock }),
      clock,
      ids: createNanoidIdGenerator({ clock }),
      stealth: 'standard',
      stealthDriver: 'auto',
    });
    try {
      const id = await h.launch({ slug: 'stealthy', stealth: true });
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/reading') });
      const clean = await h.callJson<{ text: string }>('get_text', { session_id: id });
      await h.callJson('navigate', { session_id: id, url: state.fixture.url('/reading-tamper') });
      const tampered = await h.callJson<{ text: string }>('get_text', { session_id: id });
      expect(tampered.text).toBe(clean.text);
      expect(tampered.text).toContain('const a = 1;\n  return a;');
      // `auto` falls back to stock Playwright when Patchright is absent; both paths are isolated.
      const handle = h.services.sessions.peek(id)?.handle;
      expect(handle?.capabilities.isolatedEvaluate).toBe(handle?.driver === 'patchright');
    } finally {
      await h.close();
    }
  });
});
