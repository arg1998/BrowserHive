/// <reference lib="dom" />
/** @module test/integration/template-pages.test — pages a site or a modified click opens in a template session (PR #76 F5, F6): a session's site cannot take the shared browser's pages, and Ctrl/Cmd/Shift- and middle-click tabs, which Chromium opens without an opener, still belong to the clicking session. Both drivers, real Chromium. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Session } from '../../src/domain/session/session.ts';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import {
  type DriverName,
  type TemplateWorld,
  tabUrls,
  templateWorld,
  until,
} from './template-fixture.ts';

const DRIVERS: readonly DriverName[] = ['playwright', 'patchright'];

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

for (const driver of DRIVERS) {
  describe(`template pages (${driver})`, () => {
    it('a site opening many pages stays within its session cap; other sessions are unaffected', async () => {
      world = await templateWorld(driver, { maxPagesPerHost: 10 });
      const a = await world.launch('alpha');
      const b = await world.launch('bravo');
      await pageOf(a).goto(world.sites.url('site-a.test'));
      // Twelve popups from one click (Playwright allows them all; Patchright blocks after the first).
      await pageOf(a).click('#many');
      if (driver === 'playwright') {
        await pageOf(a).evaluate(() => {
          for (let i = 0; i < 12; i++) window.open(`/landing?script=${i}`);
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // max(2, floor(10 / 5)) = 2 pages for this session, whatever its site does.
      await until(() => (a.view?.pages().length ?? 0) <= 2, 5_000, 'over-cap pages closed');
      expect(world.host().agentPageCount()).toBeLessThanOrEqual(3);
      if (driver === 'playwright') {
        expect(a.warnings.some((w) => w.code === 'SESSION_PAGE_LIMIT')).toBe(true);
      }
      expect(await outcome(world.sessions.newTab(b))).toBe('ok');
      expect(await outcome(world.launch('charlie'))).toBe('ok');
    });

    it('modifier- and middle-click tabs belong to the clicking session, never parked', async () => {
      world = await templateWorld(driver);
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
      world = await templateWorld(driver);
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
