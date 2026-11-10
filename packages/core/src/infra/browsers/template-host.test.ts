/** @module infra/browsers/template-host.test — `PlaywrightTemplateHost` and `TemplateSessionView` over fakes (PR #76 F9): claims around `createTarget`, released sessions, CDP scoping, the parked bound, restored pages, maintenance pages, the new-tab path. */

import { describe, expect, it } from 'bun:test';
import type { Page } from 'playwright';
import { FakeCdp, fakeTemplateHost } from '../../../test/helpers/fake-host-targets.ts';
import { asPage } from '../../../test/helpers/fake-page.ts';
import { MAX_PARKED_PAGES } from './template-host.ts';

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('PlaywrightTemplateHost over fakes', () => {
  it('closes restored pages at start and keeps the first as the parked sentinel', async () => {
    const { host, context } = fakeTemplateHost({ startPages: 3 });
    await host.adoptStartPages();
    expect(context.fakePages.map((p) => p.isClosed())).toEqual([false, true, true]);
    expect(host.parkedPages()).toEqual([]);
  });

  it('a window adopted before createTarget answers is still claimed (the create hold)', async () => {
    const { host, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    targets.timing = 'adoptFirst';
    const view = await host.openView('alpha', { windowState: 'normal' });
    expect(view.owns(view.page)).toBe(true);
    expect(host.parkedPages()).toEqual([]);
  });

  it('newCDPSession refuses a sibling page and a parked page', async () => {
    const { host, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const a = await host.openView('alpha', { windowState: 'normal' });
    const b = await host.openView('bravo', { windowState: 'normal' });
    const parked = asPage(targets.page('P1'));
    await settle();
    await expect(a.newCDPSession(b.page)).rejects.toThrow(/not attributed/);
    await expect(a.newCDPSession(parked)).rejects.toThrow(/not attributed/);
    await expect(a.newCDPSession(a.page)).resolves.toBeInstanceOf(FakeCdp);
  });

  it('a page arriving for a closed session is closed by the host, never delivered', async () => {
    const { host, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const view = await host.openView('alpha', { windowState: 'normal' });
    const seen: Page[] = [];
    view.onPage((page) => seen.push(page));
    const firstTarget = host.dispatcher.targetIdOf(view.page) ?? '';
    await view.close(1_000);
    const late = targets.page('L1', firstTarget);
    await settle();
    expect(late.isClosed()).toBe(true);
    expect(seen).toEqual([]);
    expect(host.viewIds()).toEqual([]);
  });

  it('keeps at most 10 parked pages, closing the oldest', async () => {
    const { host, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const parked = Array.from({ length: MAX_PARKED_PAGES + 2 }, (_, i) => targets.page(`P${i}`));
    await settle();
    expect(host.parkedPages()).toHaveLength(MAX_PARKED_PAGES);
    expect(parked.slice(0, 2).every((p) => p.isClosed())).toBe(true);
  });

  it('maintenance pages are not agent pages', async () => {
    const { host } = fakeTemplateHost();
    await host.adoptStartPages();
    await host.openView('maint', { windowState: 'normal', maintenance: true });
    await host.openView('alpha', { windowState: 'normal' });
    expect(host.agentPageCount()).toBe(1);
    expect(host.sessionPageCount('maint')).toBe(1);
  });

  it('new_tab opens a window when the active page sits in a popup window (no toolbar)', async () => {
    const { host, context, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const view = await host.openView('alpha', { windowState: 'normal' });
    context.cdpAnswers = {
      'Page.getFrameTree': { frameTree: { frame: { id: 'F' } } },
      'Page.createIsolatedWorld': { executionContextId: 1 },
      'Runtime.evaluate': { result: { value: false } },
    };
    const before = targets.created.length;
    const page = await view.newPage(view.page);
    expect(targets.created.length).toBe(before + 1);
    expect(view.owns(page)).toBe(true);
  });

  it('new_tab takes the tab its window.open opened, not another page of the session', async () => {
    const { host, context, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const view = await host.openView('alpha', { windowState: 'normal' });
    const opener = host.dispatcher.targetIdOf(view.page) ?? '';
    const other = targets.page('O1', opener);
    await settle();
    context.cdpAnswers = {
      'Page.getFrameTree': { frameTree: { frame: { id: 'F' } } },
      'Page.createIsolatedWorld': { executionContextId: 1 },
      'Runtime.evaluate': { result: { value: true } },
    };
    // While the tab is awaited, a popup of the session's other page arrives first, then the tab.
    const created = targets.created.length;
    const opening = view.newPage(view.page);
    await settle();
    const otherOpener = host.dispatcher.targetIdOf(asPage(other)) ?? '';
    targets.page('X1', otherOpener);
    const tab = targets.page('T1', opener);
    const page = await opening;
    expect(page).toBe(asPage(tab));
    expect(targets.created.length).toBe(created);
  });

  it('a view owns and lists only its own pages, and checks its cap before opening one', async () => {
    const { host } = fakeTemplateHost();
    await host.adoptStartPages();
    let refuse = false;
    const a = await host.openView('alpha', {
      windowState: 'normal',
      beforeNewPage: () => {
        if (refuse) throw new Error('cap');
      },
    });
    const b = await host.openView('bravo', { windowState: 'normal' });
    expect(a.owns(b.page)).toBe(false);
    expect(a.pages()).toEqual([a.page]);
    refuse = true;
    await expect(a.newPage(null)).rejects.toThrow('cap');
  });

  it('recreates the sentinel when Chromium reports it closed in the browser', async () => {
    const { host, targets } = fakeTemplateHost({ startPages: 1 });
    await host.adoptStartPages();
    await host.openView('alpha', { windowState: 'normal' });
    const before = targets.created.length;
    targets.destroyed?.('S0');
    await settle();
    expect(targets.created.length).toBe(before + 1);
  });
});
