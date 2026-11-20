/// <reference lib="dom" />
/** @module test/integration/template-pages.test — pages a site or a modified click opens in a template session (PR #76 F5, F6): a session's site cannot take the shared browser's pages, and Ctrl/Cmd/Shift- and middle-click tabs, which Chromium opens without an opener, still belong to the clicking session. Stealth off and standard on Patchright (D-65), real Chromium. */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  closeSessionTabs,
  HostMemoryGuard,
  MEMORY_BACKSTOP_AFTER_MS,
} from '../../src/app/templates/host-memory.ts';
import type { Session } from '../../src/domain/session/session.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import {
  STEALTH_LEGS,
  type TemplateWorld,
  tabUrls,
  templateWorld,
  until,
} from './template-fixture.ts';

function pageOf(session: Session) {
  const page = session.view?.page;
  if (page === undefined) throw new Error(`${session.id} has no page`);
  return page;
}

async function outcome(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => 'ok',
    (err: unknown) =>
      isAppError(err)
        ? `${err.code}:${String((err.details as { limit_kind?: string }).limit_kind)}`
        : String(err),
  );
}

let world: TemplateWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

for (const stealth of STEALTH_LEGS) {
  describe(`template pages (stealth ${stealth})`, () => {
    it('a site opening many pages stays within its session cap; other sessions are unaffected', async () => {
      world = await templateWorld(stealth, { maxPagesPerHost: 10 });
      const a = await world.launch('alpha');
      const b = await world.launch('bravo');
      await pageOf(a).goto(world.sites.url('site-a.test'));
      // Each click opens popups; Patchright keeps Chromium's popup blocker on (it drops
      // `--disable-popup-blocking`), so only the first popup of a click opens: click several times.
      for (let i = 0; i < 6; i++) await pageOf(a).click('#many');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // max(2, floor(10 / 5)) = 2 pages for this session, whatever its site does.
      await until(() => (a.view?.pages().length ?? 0) <= 2, 5_000, 'over-cap pages closed');
      expect(world.host().agentPageCount()).toBeLessThanOrEqual(3);
      expect(a.warnings.some((w) => w.code === 'SESSION_PAGE_LIMIT')).toBe(true);
      expect(await outcome(world.sessions.newTab(b))).toBe('ok');
      expect(await outcome(world.launch('charlie'))).toBe('ok');
    });

    it('the memory trim closes a background tab, never the active one (workload test B2)', async () => {
      world = await templateWorld(stealth);
      const a = await world.launch('alpha');
      await pageOf(a).goto(world.sites.url('site-a.test'));
      const warned: string[] = [];
      const sessions = world.sessions;
      const guard = () =>
        new HostMemoryGuard({
          limitBytes: 1,
          clock: createSystemClock(),
          logger: createCollectingLogger(),
          warn: (_id, _details, action) => void warned.push(action),
          activeOf: (id) => sessions.peek(id)?.tabs.activePage(),
        });
      // One tab only: it is the active one, so nothing is closed (the session keeps its page).
      expect(await guard().check(world.template.templateId, 2, world.host())).toBe('trimmed');
      expect(warned).toEqual(['none']);
      expect(a.tabs.size()).toBe(1);
      // A second tab in the background: that one goes, the active tab stays.
      const active = a.tabs.activeTabId();
      await world.sessions.newTab(a);
      if (active !== undefined) a.tabs.setActive(active);
      await until(() => a.tabs.size() === 2, 5_000, 'two tabs');
      expect(await guard().check(world.template.templateId, 2, world.host())).toBe('trimmed');
      await until(() => a.tabs.size() === 1, 5_000, 'the background tab closed');
      expect(warned).toEqual(['none', 'background']);
      expect(a.tabs.activeTabId()).toBe(active);
      expect(a.tabs.activePage()?.url()).toContain('site-a.test');
    });

    it('the memory backstop closes every tab of an active-only hog and says why (review #88 M2)', async () => {
      world = await templateWorld(stealth);
      const a = await world.launch('alpha');
      const b = await world.launch('bravo');
      await pageOf(a).goto(world.sites.url('site-a.test'));
      const sessions = world.sessions;
      const clock = new FakeClock();
      const actions: string[] = [];
      const guard = new HostMemoryGuard({
        limitBytes: 1,
        clock,
        logger: createCollectingLogger(),
        warn: (id, _details, action) => void actions.push(`${id === a.id ? 'a' : 'b'}:${action}`),
        activeOf: (id) => sessions.peek(id)?.tabs.activePage(),
        closeAll: (id) => closeSessionTabs(sessions, id),
      });
      // Make alpha the heaviest for sure.
      await pageOf(a).evaluate(() => {
        (globalThis as { hog?: unknown }).hog = Array.from({ length: 2e6 }, (_, i) => ({ i }));
      });
      expect(await guard.check(world.template.templateId, 2, world.host())).toBe('trimmed');
      expect(a.tabs.size()).toBe(1);
      await clock.advance(MEMORY_BACKSTOP_AFTER_MS);
      expect(await guard.check(world.template.templateId, 2, world.host())).toBe('trimmed');
      await until(() => a.tabs.size() === 0, 5_000, 'alpha has no tab');
      expect(actions).toEqual(['a:none', 'a:all']);
      expect(b.tabs.size()).toBe(1);
      let message = '';
      try {
        a.tabs.resolve();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain('Memory stayed too high');
      expect(message).toContain('open one with new_tab');
      // A new tab clears the note and works.
      await world.sessions.newTab(a);
      expect(a.tabs.size()).toBe(1);
    });

    it('modifier- and middle-click tabs belong to the clicking session, never parked', async () => {
      world = await templateWorld(stealth);
      const a = await world.launch('alpha');
      const b = await world.launch('bravo');
      const page = pageOf(a);
      await page.goto(world.sites.url('site-a.test'));
      await page.click('#plain', { modifiers: ['ControlOrMeta'] });
      await page.click('#plain', { button: 'middle' });
      await page.click('#plain', { modifiers: ['Shift'] });
      await page.click('#post', { modifiers: ['ControlOrMeta'] });
      await until(() => a.tabs.size() === 5, 8_000, 'four new tabs in alpha');
      expect(tabUrls(a).filter((u) => u.includes('plain'))).toHaveLength(3);
      expect(tabUrls(a).filter((u) => u.includes('posted'))).toHaveLength(1);
      expect(tabUrls(b)).toEqual(['about:blank']);
      expect(world.host().parkedPages()).toEqual([]);
    });

    it('a popup arriving after close_session is closed; the closed session cannot use the CDP of a sibling page', async () => {
      world = await templateWorld(stealth);
      const a = await world.launch('alpha');
      const b = await world.launch('bravo');
      const view = a.view;
      if (view === null) throw new Error('no view');
      await pageOf(a).goto(world.sites.url('site-a.test'));
      // The sibling's page is never alpha's to inspect.
      await expect(view.newCDPSession(pageOf(b))).rejects.toThrow(/not attributed/);
      // A popup opened in the same turn as the close lands after the session was released.
      await pageOf(a).evaluate(() => {
        setTimeout(() => window.open('/landing?late'), 0);
      });
      await world.sessions.close(a.id);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const host = world.host();
      expect(host.context.pages().some((p) => p.url().includes('late') && !p.isClosed())).toBe(
        false,
      );
      expect(host.parkedPages()).toEqual([]);
    });
  });
}
