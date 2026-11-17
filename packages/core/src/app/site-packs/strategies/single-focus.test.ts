/** @module app/site-packs/strategies/single-focus.test — the `single-focus` arbiter (spec 13 §9.4): before any action every page keeps the driver's focus; the page acted on last keeps it and the site's other pages lose it, across sessions of one template; a page leaving the site, or a pack no longer selecting the strategy, gets it back; templates are independent. */

import { describe, expect, it } from 'bun:test';
import { createCollectingLogger } from '../../../../test/helpers/test-logger.ts';
import type { PageFocusControl } from '../../../ports/page-focus.ts';
import type { Page } from '../../../ports/page-types.ts';
import { SingleFocus } from './single-focus.ts';

class FakePage {
  closed = false;
  constructor(public href: string) {}
  url(): string {
    return this.href;
  }
  isClosed(): boolean {
    return this.closed;
  }
}

class FakeFocus implements PageFocusControl {
  readonly off = new Set<Page>();
  calls = 0;
  readonly headless: boolean[] = [];
  async setEmulated(page: Page, emulated: boolean, headless: boolean): Promise<void> {
    this.calls += 1;
    this.headless.push(headless);
    if (emulated) this.off.delete(page);
    else this.off.add(page);
  }
  isUnfocused(page: Page): boolean {
    return this.off.has(page);
  }
}

const asPage = (p: FakePage): Page => p as unknown as Page;

function world(singleFocusHosts = new Set(['site-a.test'])) {
  const pages = new Map<string, FakePage[]>();
  const focus = new FakeFocus();
  const arbiter = new SingleFocus({
    focus,
    pagesOf: (templateId) => (pages.get(templateId) ?? []).map(asPage),
    singleFocusPackOf: (url) => {
      const host = new URL(url).hostname;
      return singleFocusHosts.has(host) ? host : null;
    },
    logger: createCollectingLogger(),
  });
  const open = (templateId: string, href: string) => {
    const page = new FakePage(href);
    pages.set(templateId, [...(pages.get(templateId) ?? []), page]);
    return page;
  };
  const unfocused = (...list: FakePage[]) => list.map((p) => focus.isUnfocused(asPage(p)));
  return { arbiter, focus, open, unfocused, singleFocusHosts };
}

describe('SingleFocus', () => {
  it('leaves every page focused until a page of the site is acted on', async () => {
    const w = world();
    const a = w.open('tp-1', 'https://site-a.test/one');
    const b = w.open('tp-1', 'https://site-a.test/two');
    await w.arbiter.arbitrate('tp-1', null, true);
    expect(w.unfocused(a, b)).toEqual([false, false]);
  });

  it('keeps focus on the page acted on last, across the sessions of one template', async () => {
    const w = world();
    const a = w.open('tp-1', 'https://site-a.test/one');
    const b = w.open('tp-1', 'https://site-a.test/two');
    const other = w.open('tp-1', 'https://site-b.test/');
    await w.arbiter.arbitrate('tp-1', asPage(a), true);
    expect(w.unfocused(a, b, other)).toEqual([false, true, false]);
    await w.arbiter.arbitrate('tp-1', asPage(b), true);
    expect(w.unfocused(a, b, other)).toEqual([true, false, false]);
    // An action on another site changes nothing for site-a's pages.
    await w.arbiter.arbitrate('tp-1', asPage(other), true);
    expect(w.unfocused(a, b, other)).toEqual([true, false, false]);
  });

  it('gives focus back to a page that leaves the site, or when the pack drops the strategy', async () => {
    const w = world();
    const a = w.open('tp-1', 'https://site-a.test/one');
    const b = w.open('tp-1', 'https://site-a.test/two');
    const c = w.open('tp-1', 'https://site-a.test/three');
    await w.arbiter.arbitrate('tp-1', asPage(a), true);
    expect(w.unfocused(a, b, c)).toEqual([false, true, true]);
    b.href = 'https://site-b.test/away';
    await w.arbiter.arbitrate('tp-1', null, true);
    expect(w.unfocused(a, b, c)).toEqual([false, false, true]);
    w.singleFocusHosts.clear();
    await w.arbiter.arbitrate('tp-1', null, true);
    expect(w.unfocused(a, b, c)).toEqual([false, false, false]);
  });

  it('keeps templates apart and forgets closed pages and gone templates', async () => {
    const w = world();
    const a1 = w.open('tp-1', 'https://site-a.test/one');
    const a2 = w.open('tp-1', 'https://site-a.test/two');
    const b1 = w.open('tp-2', 'https://site-a.test/one');
    await w.arbiter.arbitrate('tp-1', asPage(a1), true);
    await w.arbiter.arbitrate('tp-2', asPage(b1), true);
    expect(w.unfocused(a1, a2, b1)).toEqual([false, true, false]);
    a1.closed = true;
    await w.arbiter.arbitrate('tp-1', null, true);
    // The last page is gone: the others stay unfocused until the next action.
    expect(w.unfocused(a2)).toEqual([true]);
    w.arbiter.retain(new Set(['tp-2']));
    await w.arbiter.arbitrate('tp-1', null, true);
    expect(w.unfocused(a2)).toEqual([false]);
  });

  it("passes the host's headless flag to the focus control", async () => {
    const w = world();
    const a = w.open('tp-1', 'https://site-a.test/one');
    w.open('tp-1', 'https://site-a.test/two');
    await w.arbiter.arbitrate('tp-1', asPage(a), false);
    await w.arbiter.arbitrate('tp-1', asPage(a), true);
    expect(w.focus.headless).toEqual([false, false, true, true]);
  });

  it('runs one arbitration of a template at a time, in order', async () => {
    const w = world();
    const a = w.open('tp-1', 'https://site-a.test/one');
    const b = w.open('tp-1', 'https://site-a.test/two');
    const first = w.arbiter.arbitrate('tp-1', asPage(a), true);
    const second = w.arbiter.arbitrate('tp-1', asPage(b), true);
    await Promise.all([first, second]);
    expect(w.unfocused(a, b)).toEqual([true, false]);
  });
});
