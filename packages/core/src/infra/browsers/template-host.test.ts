/** @module infra/browsers/template-host.test — `PlaywrightTemplateHost` and `TemplateSessionView` over fakes (PR #76 F9): claims around `createTarget`, released sessions, CDP scoping, the parked bound, pages present at start, maintenance pages, the new-tab path, and the operator quitting the browser (its last window closed in the browser, D-78). */

import { describe, expect, it } from 'bun:test';
import type { Page } from 'patchright';
import { FakeCdp, fakeTemplateHost } from '../../../test/helpers/fake-host-targets.ts';
import { asPage } from '../../../test/helpers/fake-page.ts';
import type { TemplateHostExit } from '../../ports/template-host.ts';
import { MAX_PARKED_PAGES, OPERATOR_CLOSE_WINDOW_MS } from './template-host.ts';

/** The exits a host reports, in order. */
function exitsOf(host: { onExit(listener: (exit: TemplateHostExit) => void): () => void }) {
  const exits: TemplateHostExit[] = [];
  host.onExit((exit) => exits.push(exit));
  return exits;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('PlaywrightTemplateHost over fakes', () => {
  it('starts with no window: any page present at start (a restored window) is closed', async () => {
    const { host, context } = fakeTemplateHost({ startPages: 2 });
    await host.adoptStartPages();
    expect(context.fakePages.map((p) => p.isClosed())).toEqual([true, true]);
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

  it("new_tab opens a window when the session's page sits in another session's window (PR #76 F11)", async () => {
    const { host, context, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    await host.openView('bravo', { windowState: 'normal' });
    const opener = host.dispatcher.targetIdOf(alpha.page) ?? '';
    // A tab alpha's site opened, placed by Chromium in bravo's window (W1).
    const placed = asPage(targets.page('T9', opener));
    targets.windows.set('T9', 1);
    await settle();
    context.cdpAnswers = {
      'Page.getFrameTree': { frameTree: { frame: { id: 'F' } } },
      'Page.createIsolatedWorld': { executionContextId: 1 },
      'Runtime.evaluate': { result: { value: true } },
    };
    const before = targets.created.length;
    const page = await alpha.newPage(placed);
    expect(targets.created.length).toBe(before + 1);
    expect(alpha.owns(page)).toBe(true);
  });

  it('a recording minimizes agent windows and opens new agent windows minimized (spec 13 §3.3)', async () => {
    const { host, targets } = fakeTemplateHost({ headless: false });
    await host.adoptStartPages();
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    const alphaTarget = host.dispatcher.targetIdOf(alpha.page) ?? '';
    targets.minimized.length = 0;
    await host.openView('recording-1', {
      windowState: 'normal',
      maintenance: true,
      recording: true,
    });
    expect(targets.minimized).toEqual([alphaTarget]);
    await host.openView('bravo', { windowState: 'normal' });
    expect(targets.created.at(-1)?.minimized).toBe(true);
  });

  it('closes a parked page that commits a data: document', async () => {
    const { host, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const parked = targets.page('P1');
    await settle();
    expect(host.parkedPages()).toHaveLength(1);
    parked.emit('framenavigated', { url: () => 'data:text/html,x', parentFrame: () => null });
    await settle();
    expect(parked.isClosed()).toBe(true);
  });

  it("lists windows shared by several sessions and removes a domain's sign-in", async () => {
    const { host, context, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    await host.openView('bravo', { windowState: 'normal' });
    const opener = host.dispatcher.targetIdOf(alpha.page) ?? '';
    targets.page('T9', opener);
    targets.windows.set('T9', 1);
    await settle();
    expect(await host.sharedWindows()).toEqual([{ windowId: 1, sessionIds: ['alpha', 'bravo'] }]);
    context.cookieJar = [
      { name: 'sid', domain: '.idp.test' },
      { name: 'x', domain: 'www.idp.test' },
      { name: 'keep', domain: 'site-a.test' },
    ];
    const removed = await host.clearSignIn('idp.test');
    expect(removed.cookiesRemoved).toBe(2);
    expect(removed.origins).toContain('https://www.idp.test');
    expect(removed.origins.some((o) => o.includes('site-a.test'))).toBe(false);
    expect(removed.unclearedOrigins).toEqual([]);
    // Cleared through a page-target session (a browser session has no storage partition).
    expect(
      context.cdps.at(-1)?.sent.filter((m) => m === 'Storage.clearDataForOrigin'),
    ).toHaveLength(removed.origins.length);
    expect(context.clearedCookies).toHaveLength(1);
  });

  it('reports the origins whose site data could not be cleared', async () => {
    const { host, context } = fakeTemplateHost();
    await host.adoptStartPages();
    context.cookieJar = [{ name: 'sid', domain: '.idp.test' }];
    context.cdpFailures = ['Storage.clearDataForOrigin'];
    const removed = await host.clearSignIn('idp.test');
    expect(removed.origins).toEqual([]);
    expect(removed.unclearedOrigins).toContain('https://idp.test');
  });

  it('a popup an agent site opens during a recording is minimized, or closed in the sign-in window (review M-1)', async () => {
    const { host, targets } = fakeTemplateHost({ headless: false });
    await host.adoptStartPages();
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    const recording = await host.openView('recording-1', {
      windowState: 'normal',
      maintenance: true,
      recording: true,
    });
    const signInWindow = await targets.windowOf(host.dispatcher.targetIdOf(recording.page) ?? '');
    const opener = host.dispatcher.targetIdOf(alpha.page) ?? '';
    targets.minimized.length = 0;
    targets.windows.set('P2', signInWindow ?? -1);
    targets.page('P1', opener);
    const landed = targets.page('P2', opener);
    await settle();
    await settle();
    expect(targets.minimized).toEqual(['P1']);
    expect(landed.isClosed()).toBe(true);
    // A viewport change never restores a minimized agent window meanwhile.
    const before = targets.created.length;
    await alpha.fitWindow?.(alpha.page, 640, 480);
    expect(targets.created.length).toBe(before);
  });

  it('agent_windows minimized: a popup or a tab that restored its window is minimized again (D-77)', async () => {
    const { host, targets } = fakeTemplateHost({ headless: false });
    await host.adoptStartPages();
    const alpha = await host.openView('alpha', { windowState: 'minimized' });
    expect(targets.created.at(-1)?.minimized).toBe(true);
    const alphaWindow = (await host.windowOf(alpha.page)) ?? -1;
    expect(targets.minimizedWindows).toEqual([]);
    const opener = host.dispatcher.targetIdOf(alpha.page) ?? '';
    // A popup in a window of its own (normal), and a tab a site opened in alpha's window (restored).
    targets.windows.set('P1', 41);
    targets.page('P1', opener);
    targets.windows.set('T1', alphaWindow);
    targets.states.set(alphaWindow, 'normal');
    targets.page('T1', opener);
    await settle();
    await settle();
    expect(targets.minimizedWindows.sort()).toEqual([41, alphaWindow].sort());
  });

  it('agent_windows normal: site-opened pages keep their windows (D-77 applies to minimized only)', async () => {
    const { host, targets } = fakeTemplateHost({ headless: false });
    await host.adoptStartPages();
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    const opener = host.dispatcher.targetIdOf(alpha.page) ?? '';
    targets.windows.set('P1', 41);
    targets.page('P1', opener);
    await settle();
    await settle();
    expect(targets.minimizedWindows).toEqual([]);
  });

  it('agent_windows minimized: new_tab opens a minimized window, never window.open (it restores the window, D-77)', async () => {
    const { host, context, targets } = fakeTemplateHost({ headless: false });
    await host.adoptStartPages();
    const view = await host.openView('alpha', { windowState: 'minimized' });
    context.cdpAnswers = {
      'Page.getFrameTree': { frameTree: { frame: { id: 'F' } } },
      'Page.createIsolatedWorld': { executionContextId: 1 },
      'Runtime.evaluate': { result: { value: true } },
    };
    const before = targets.created.length;
    const cdps = context.cdps.length;
    const page = await view.newPage(view.page);
    expect(targets.created.length).toBe(before + 1);
    expect(targets.created.at(-1)?.minimized).toBe(true);
    expect(context.cdps.slice(cdps).some((cdp) => cdp.sent.includes('Runtime.evaluate'))).toBe(
      false,
    );
    expect(view.owns(page)).toBe(true);
  });
  it("the operator closing the host's last window is an operator stop; the browser is left to the supervisor", async () => {
    const { host, targets, context } = fakeTemplateHost({ headless: false });
    await host.adoptStartPages();
    const exits = exitsOf(host);
    const view = await host.openView('alpha', { windowState: 'normal' });
    targets.destroy(host.dispatcher.targetIdOf(view.page) ?? '');
    expect(exits).toEqual([
      { reason: 'the last window was closed in the browser', operatorStop: true },
    ]);
    // The browser itself is not closed by the host: the supervisor stops it (checkpoint first).
    expect(context.closed).toBe(false);
    // Reported once, and the browser's exit afterwards is not a crash.
    context.emit('close', context);
    expect(exits).toHaveLength(1);
  });

  it('a window BrowserHive closes is never an operator stop (page.close or its own closeTarget)', async () => {
    const { host, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const exits = exitsOf(host);
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    const alphaTarget = host.dispatcher.targetIdOf(alpha.page) ?? '';
    await alpha.close(1_000);
    targets.destroy(alphaTarget);
    const bravo = await host.openView('bravo', { windowState: 'normal' });
    const bravoTarget = host.dispatcher.targetIdOf(bravo.page) ?? '';
    await targets.closeTarget(bravoTarget);
    targets.destroy(bravoTarget);
    expect(exits).toEqual([]);
  });

  it('a window closed by hand while another window is open is not a stop', async () => {
    const { host, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const exits = exitsOf(host);
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    await host.openView('bravo', { windowState: 'normal' });
    targets.destroy(host.dispatcher.targetIdOf(alpha.page) ?? '');
    expect(exits).toEqual([]);
  });

  it('the sign-in window closed by hand leaves the browser up; Exit closing it with an agent window stops', async () => {
    const { host, targets, clock } = fakeTemplateHost();
    await host.adoptStartPages();
    const exits = exitsOf(host);
    const signIn = await host.openView('recording-1', {
      windowState: 'normal',
      maintenance: true,
      recording: true,
    });
    targets.destroy(host.dispatcher.targetIdOf(signIn.page) ?? '');
    expect(exits).toEqual([]);
    // Later: an agent window and a new sign-in window close in one burst (the menu's Exit).
    await clock.advance(OPERATOR_CLOSE_WINDOW_MS + 1);
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    const again = await signIn.newPage(null);
    targets.destroy(host.dispatcher.targetIdOf(alpha.page) ?? '');
    targets.destroy(host.dispatcher.targetIdOf(again) ?? '');
    expect(exits.map((e) => e.operatorStop)).toEqual([true]);
  });

  it("a target no page was read for (Playwright's own storage page) is never an operator stop", async () => {
    const { host, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const exits = exitsOf(host);
    targets.destroy('storage-page');
    expect(exits).toEqual([]);
  });

  it('a browser that exits on its own is a crash', async () => {
    const { host, context } = fakeTemplateHost();
    await host.adoptStartPages();
    const exits = exitsOf(host);
    await host.openView('alpha', { windowState: 'normal' });
    context.emit('close', context);
    expect(exits).toEqual([{ reason: 'context closed', operatorStop: false }]);
  });

  it('removing a sign-in on a host with no window opens a parked window for it and closes it', async () => {
    const { host, context, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    context.cookieJar = [{ name: 'sid', domain: '.idp.test' }];
    const removed = await host.clearSignIn('idp.test');
    expect(removed.unclearedOrigins).toEqual([]);
    expect(targets.created).toHaveLength(1);
    expect(context.fakePages.every((p) => p.isClosed())).toBe(true);
  });
  it("a site's popup closing itself as the last window is never an operator stop (review #91 M1)", async () => {
    const { host, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const exits = exitsOf(host);
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    const alphaTarget = host.dispatcher.targetIdOf(alpha.page) ?? '';
    // The site opens a popup; the agent closes its first tab; the popup's script closes it.
    targets.page('P1', alphaTarget);
    await settle();
    await alpha.page.close();
    targets.destroy(alphaTarget);
    targets.destroy('P1');
    expect(exits).toEqual([]);
  });

  it("the operator closing the last window is a stop even when BrowserHive's close of another lands just after (review #91 L1)", async () => {
    const { host, targets } = fakeTemplateHost();
    await host.adoptStartPages();
    const exits = exitsOf(host);
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    const bravo = await host.openView('bravo', { windowState: 'normal' });
    targets.destroy(host.dispatcher.targetIdOf(bravo.page) ?? '');
    expect(exits).toEqual([]);
    const alphaTarget = host.dispatcher.targetIdOf(alpha.page) ?? '';
    await alpha.page.close();
    targets.destroy(alphaTarget);
    expect(exits.map((e) => e.operatorStop)).toEqual([true]);
  });

  it('an operator close followed by a new window is not a stop when that window later closes', async () => {
    const { host, targets, clock } = fakeTemplateHost();
    await host.adoptStartPages();
    const exits = exitsOf(host);
    const alpha = await host.openView('alpha', { windowState: 'normal' });
    const bravo = await host.openView('bravo', { windowState: 'normal' });
    targets.destroy(host.dispatcher.targetIdOf(bravo.page) ?? '');
    const charlie = await host.openView('charlie', { windowState: 'normal' });
    await clock.advance(1);
    for (const view of [alpha, charlie]) {
      const id = host.dispatcher.targetIdOf(view.page) ?? '';
      await view.page.close();
      targets.destroy(id);
    }
    expect(exits).toEqual([]);
  });
});
