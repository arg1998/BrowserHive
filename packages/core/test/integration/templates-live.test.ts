/// <reference lib="dom" />
/** @module test/integration/templates-live.test — three virtual sessions on one real template host, under Playwright and Patchright, on the HTTPS fixture sites (spec 13 §3.3–§3.8, §17 T1a acceptance): background windows, isolation of `list_tabs`, every site-opened page in its opener's session, parked pages, close, crash fan-out and restart, the sentinel, page caps and the self-origin guard. */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { Session } from '../../src/domain/session/session.ts';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import {
  clickClosing,
  type DriverName,
  HEADED,
  type TemplateWorld,
  tabUrls,
  templateWorld,
  until,
} from './template-fixture.ts';

const DRIVERS: readonly DriverName[] = ['playwright', 'patchright'];

/** The X window with the input focus (`xdotool`), or `null` where it cannot be read. */
function focusedWindow(): string | null {
  if (!HEADED || process.platform !== 'linux') return null;
  const out = spawnSync('xdotool', ['getwindowfocus'], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : null;
}

/**
 * The operator's window: a tiny X client (`xmessage`) given the input focus before the host starts,
 * so a start that took the focus would be seen (headed Linux CI only; `null` elsewhere).
 */
function operatorWindow(): { readonly id: string; close(): void } | null {
  if (!HEADED || process.platform !== 'linux') return null;
  const child = Bun.spawn(['xmessage', '-name', 'bh-operator', 'operator window']);
  const found = spawnSync('xdotool', ['search', '--sync', '--classname', 'bh-operator'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const id = found.stdout.trim().split('\n')[0] ?? '';
  if (found.status !== 0 || id === '') {
    child.kill();
    throw new Error('xmessage/xdotool unavailable on the headed leg');
  }
  spawnSync('xdotool', ['windowfocus', '--sync', id], { timeout: 10_000 });
  return { id, close: () => child.kill() };
}

function pageOf(session: Session) {
  const view = session.view;
  if (view === null) throw new Error(`${session.id} has no view`);
  return view.page;
}

let world: TemplateWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

for (const driver of DRIVERS) {
  describe(`template host (${driver}${HEADED ? ', headed' : ''})`, () => {
    it('three sessions get their own background windows and see only their own pages', async () => {
      world = await templateWorld(driver);
      // The operator works in another window: neither the host's start (the first launch) nor any
      // session window may take the focus from it (no-op headless).
      const operator = operatorWindow();
      try {
        const before = focusedWindow();
        if (operator !== null) expect(before).toBe(operator.id);
        await world.launch('alpha');
        expect(focusedWindow()).toBe(before);
        await world.launch('bravo');
        expect(focusedWindow()).toBe(before);
        await world.launch('charlie');
        expect(focusedWindow()).toBe(before);
      } finally {
        operator?.close();
      }
      const [a, b, c] = world.sessions.listAll();
      if (a === undefined || b === undefined || c === undefined) throw new Error('three sessions');
      const host = world.host();
      expect(world.hosts).toHaveLength(1);
      const browser = host.context.browser();
      if (browser === null) throw new Error('no browser');
      const cdp = await browser.newBrowserCDPSession();
      const windows = new Set<number>();
      for (const session of [a, b, c]) {
        const targetId = host.dispatcher.targetIdOf(pageOf(session));
        if (targetId === undefined) throw new Error('first page not placed');
        windows.add((await cdp.send('Browser.getWindowForTarget', { targetId })).windowId);
      }
      await cdp.detach();
      expect(windows.size).toBe(3);
      for (const [i, session] of [a, b, c].entries()) {
        await pageOf(session).goto(world.sites.url(i === 1 ? 'site-b.test' : 'site-a.test'));
      }
      // Focus emulation keeps every agent page visible and focused (spec 13 §3.10).
      for (const session of [a, b, c]) {
        const state = await pageOf(session).evaluate(() => [
          document.visibilityState,
          document.hasFocus(),
        ]);
        expect(state).toEqual(['visible', true]);
        expect(await world.sessions.listTabs(session)).toHaveLength(1);
      }
      expect(tabUrls(b)).toEqual(['https://site-b.test/']);
      expect(world.supervisor.host(world.template.templateId)).toMatchObject({
        state: 'running',
        liveAgentSessions: 3,
        pages: 3,
      });
    });

    it('every site-opened page lands in its opener session, wherever its window is', async () => {
      world = await templateWorld(driver);
      const a = await world.launch('alpha');
      const b = await world.launch('bravo');
      const page = pageOf(a);
      await page.goto(world.sites.url('site-a.test'));
      await page.click('#blank');
      await page.click('#open');
      await page.click('#noopener');
      await until(() => a.tabs.size() === 4, 5_000, 'popups of alpha');
      // A popup whose opener closes at once (OAuth): its child is still alpha's.
      await page.click('#opener-closes');
      await until(() => tabUrls(a).some((u) => u.endsWith('/closer')), 5_000, 'closer');
      const closer = a.tabs.entries().find(([, p]) => p.url().endsWith('/closer'))?.[1];
      if (closer === undefined) throw new Error('no closer');
      await clickClosing(closer, '#go');
      await until(() => tabUrls(a).includes('https://idp.test/landing'), 5_000, 'idp page');
      // A tab opened from bravo's popup window lands in a normal window, maybe alpha's: still bravo's.
      await pageOf(b).goto(world.sites.url('site-a.test'));
      await pageOf(b).click('#popup-window');
      await until(() => tabUrls(b).some((u) => u.endsWith('/popup')), 5_000, 'popup window');
      const popup = b.tabs.entries().find(([, p]) => p.url().endsWith('/popup'))?.[1];
      if (popup === undefined) throw new Error('no popup');
      await popup.click('#tab');
      await until(
        () => tabUrls(b).includes('https://site-b.test/from-popup'),
        5_000,
        'tab from popup',
      );
      expect(tabUrls(a).sort()).toEqual(
        [
          'https://idp.test/landing',
          'https://site-a.test/',
          'https://site-b.test/landing',
          'https://site-b.test/landing',
          'https://site-b.test/landing',
        ].sort(),
      );
      expect(tabUrls(b).sort()).toEqual(
        [
          'https://site-a.test/',
          'https://site-a.test/popup',
          'https://site-b.test/from-popup',
        ].sort(),
      );
      for (const [, p] of a.tabs.entries()) expect(b.view?.owns(p)).toBe(false);
    });

    it('pages no session opened are parked: test-code newPage, and a refused service-worker window', async () => {
      world = await templateWorld(driver);
      const a = await world.launch('alpha');
      const host = world.host();
      // Stands in for the operator's Ctrl+T (spec 13 §17 T1a acceptance).
      const manual = await host.context.newPage();
      await manual.goto(world.sites.url('site-b.test', '/landing'));
      await until(() => host.parkedPages().length === 1, 5_000, 'parked page');
      expect(a.view?.owns(manual)).toBe(false);
      expect(a.tabs.size()).toBe(1);
      expect(host.parkedPages()[0]?.url).toBe('https://site-b.test/landing');
      // Chromium refuses `clients.openWindow` without a notification click, so a service-worker
      // window can only be asserted as refused here; the parked path it would take is the same one.
      await pageOf(a).goto(world.sites.url('site-a.test', '/sw-page'));
      const outcome = await pageOf(a)
        .evaluate(async () => {
          const w = window as unknown as { swReady: Promise<ServiceWorkerRegistration> };
          const registration = await w.swReady;
          return new Promise<string>((resolve) => {
            navigator.serviceWorker.onmessage = (event) => resolve(String(event.data));
            registration.active?.postMessage('open');
            setTimeout(() => resolve('timeout'), 3_000);
          });
        })
        .catch((err: unknown) => `evaluate failed: ${String(err)}`);
      expect(outcome).not.toBe('opened');
      expect(a.tabs.size()).toBe(1);
    });

    it('close_session closes only its own windows; the host and the other sessions live on', async () => {
      world = await templateWorld(driver);
      const a = await world.launch('alpha');
      const b = await world.launch('bravo');
      await pageOf(a).goto(world.sites.url('site-a.test'));
      await pageOf(a).click('#popup-window');
      await until(() => a.tabs.size() === 2, 5_000, 'alpha popup');
      const alphaPages = [...(a.view?.pages() ?? [])];
      await world.sessions.close(a.id);
      expect(alphaPages.every((p) => p.isClosed())).toBe(true);
      await pageOf(b).goto(world.sites.url('site-b.test'));
      expect(await pageOf(b).textContent('#site')).toBe('site-b.test');
      expect(world.supervisor.host(world.template.templateId)).toMatchObject({
        state: 'running',
        liveAgentSessions: 1,
      });
      // A third session still starts on the same host.
      await world.launch('charlie');
      expect(world.hosts).toHaveLength(1);
    });

    it('new_tab opens a tab in the session window and stops at the per-session page cap', async () => {
      world = await templateWorld(driver, { maxPagesPerHost: 10 });
      const a = await world.launch('alpha');
      await pageOf(a).goto(world.sites.url('site-a.test'));
      const { page } = await world.sessions.newTab(a);
      expect(a.view?.owns(page)).toBe(true);
      // max(2, floor(10 / 5)) = 2 pages per session.
      let refusal: unknown;
      try {
        await world.sessions.newTab(a);
      } catch (err) {
        refusal = err;
      }
      expect(isAppError(refusal) && refusal.code).toBe('TEMPLATE_BUSY');
      expect(isAppError(refusal) && refusal.details).toMatchObject({ limit_kind: 'tabs' });
    });

    it('the self-origin guard aborts every request to BrowserHive origins', async () => {
      world = await templateWorld(driver, { selfOrigins: ['https://cdn-a.test'] });
      const a = await world.launch('alpha');
      const error = await pageOf(a)
        .goto('https://cdn-a.test/landing')
        .then(
          () => null,
          (err: unknown) => String(err),
        );
      expect(error).toContain('ERR_BLOCKED_BY_CLIENT');
      expect(world.sites.requests.some((r) => r.host.startsWith('cdn-a.test'))).toBe(false);
    });

    it('closing the sentinel by hand recreates it; the host survives', async () => {
      world = await templateWorld(driver);
      const a = await world.launch('alpha');
      const host = world.host();
      const own = new Set(a.view?.pages() ?? []);
      const sentinel = host.context.pages().find((p) => !own.has(p));
      if (sentinel === undefined) throw new Error('no sentinel');
      await sentinel.close();
      await until(
        () => host.context.pages().some((p) => p !== sentinel && !own.has(p)),
        5_000,
        'a new sentinel',
      );
      expect(host.parkedPages()).toEqual([]);
      await pageOf(a).goto(world.sites.url('site-a.test'));
      expect(world.supervisor.host(world.template.templateId).state).toBe('running');
    });

    it('killing the browser fails all three sessions and the host restarts', async () => {
      world = await templateWorld(driver);
      const sessions = [
        await world.launch('alpha'),
        await world.launch('bravo'),
        await world.launch('charlie'),
      ];
      const pid = await world.host().browserPid();
      if (pid === null) throw new Error('no browser pid');
      process.kill(pid, 'SIGKILL');
      await until(() => sessions.every((s) => s.closedReason === 'crash'), 10_000, 'crash fan-out');
      for (const session of sessions) {
        let code = '';
        try {
          world.sessions.get(session.id, { subject: 'agent' });
        } catch (err) {
          code = isAppError(err) ? err.code : String(err);
        }
        expect(['SESSION_DEAD', 'SESSION_NOT_FOUND']).toContain(code);
      }
      const id = world.template.templateId;
      expect(['crashed', 'starting', 'running']).toContain(world.supervisor.host(id).state);
      await until(() => world?.supervisor.host(id).state === 'running', 20_000, 'restart');
      expect(world.hosts).toHaveLength(2);
      expect(world.supervisor.host(id).restarts).toBe(1);
      await world.launch('delta');
    }, 40_000);
  });
}
