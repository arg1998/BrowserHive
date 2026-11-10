/// <reference lib="dom" />
/** @module test/integration/template-recording.test — recording a template on a real host (spec 13 §7.1 step 5, §3.1, §3.3, §2.2; §17 T1a acceptance): the marked sign-in window with one tab per site, agent windows stepping aside, a pack-less site confirmed by **I'm signed in** with learned cookie names, an unlisted sign-in listed and removed at Finish, no saved password after a password form, and the pinned identity surviving restarts and a changed `TZ`. */

import { afterEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { TemplateHostOperations } from '../../src/app/templates/host-operations.ts';
import { RECORDING_TITLE_PREFIX } from '../../src/app/templates/recording-page.ts';
import { TemplateRecordingService } from '../../src/app/templates/template-recording.ts';
import type { Session } from '../../src/domain/session/session.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { profileHasSecrets } from '../../src/infra/persistence/profile-secrets.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../helpers/in-memory-vault-repos.ts';
import { templateSiteRecord } from '../persistence/helpers.ts';
import {
  type DriverName,
  HEADED,
  type TemplateWorld,
  tabUrls,
  templateWorld,
  until,
} from './template-fixture.ts';

const DRIVERS: readonly DriverName[] = ['playwright', 'patchright'];

let world: TemplateWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

/** The recording service over the world's real host supervisor, with in-memory rows. */
async function recorder(w: TemplateWorld) {
  const repos = new InMemoryRepositories();
  const actions = new InMemoryOperatorActionRepository();
  const bundle = { ...repos, operatorActions: actions };
  await repos.templates.insert({ ...w.template, status: 'recording' });
  await repos.templateSites.upsert(
    templateSiteRecord({ templateId: w.template.templateId, siteId: 'site-a.test' }),
  );
  const ops = new TemplateHostOperations({
    supervisor: w.supervisor,
    sessions: w.sessions,
    launcher: {},
    dataDir: w.dataDir,
    logger: createCollectingLogger(),
  });
  const service = new TemplateRecordingService({
    repos: bundle,
    uow: new InMemoryUnitOfWork(bundle),
    runtime: w.supervisor,
    ops,
    ids: new FakeIdGenerator(),
    clock: createSystemClock(),
    logger: createCollectingLogger(),
  });
  return { service, ops, repos };
}

/** The tab of `session` whose URL is on `host`. */
function tabOn(session: Session, host: string): Page {
  const page = session.tabs.entries().find(([, p]) => new URL(p.url()).host === host)?.[1];
  if (page === undefined) throw new Error(`no tab on ${host}: ${tabUrls(session).join(', ')}`);
  return page;
}

/** Signs in on the fixture's password form, as the operator would in the window. */
async function signIn(page: Page, user: string): Promise<void> {
  await page.goto(`https://${new URL(page.url()).host}/login`);
  await page.fill('#username', user);
  await page.fill('#password', 'correct horse battery staple');
  await Promise.all([page.waitForURL(/\/login$/), page.click('#submit')]);
  await page.waitForSelector('#signed-in');
}

/** The window state of `page`'s window (`normal`, `minimized`, …). */
async function windowState(w: TemplateWorld, page: Page): Promise<string | undefined> {
  const browser = w.host().context.browser();
  const targetId = w.host().dispatcher.targetIdOf(page);
  if (browser === null || targetId === undefined) return undefined;
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
    return (await cdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState;
  } finally {
    await cdp.detach();
  }
}

for (const driver of DRIVERS) {
  describe(`recording a template (${driver}${HEADED ? ', headed' : ''})`, () => {
    it("records a pack-less site with I'm signed in, removes an unlisted sign-in and saves no password", async () => {
      world = await templateWorld(driver);
      const w = world;
      const agent = await w.launch('alpha');
      // Which windows BrowserHive asks to minimize (a bare Xvfb has no window manager to obey).
      const minimized: string[] = [];
      const targets = w.host().targets;
      const minimize = targets.minimize.bind(targets);
      targets.minimize = async (targetId: string) => {
        minimized.push(targetId);
        await minimize(targetId);
      };
      const { service, ops, repos } = await recorder(w);
      const started = await service.start(w.template.templateId, {}, { subject: 'operator' });
      const recording = w.sessions.peek(started.session_id);
      if (recording === undefined || recording.view === null) throw new Error('no recording');
      // The marked first tab, then one tab per site; the live view follows the site's tab.
      expect(await recording.view.page.title()).toStartWith(
        `${RECORDING_TITLE_PREFIX} site-a.test`,
      );
      await until(
        () => tabUrls(recording).some((u) => u.startsWith('https://site-a.test/')),
        10_000,
      );
      expect(recording.tabs.activePage()?.url()).toStartWith('https://site-a.test/');
      // Agents' windows step aside while the operator signs in (headed only: a headless host has
      // none). Without a window manager the request is all Chromium can do (spec 13 §3.10).
      if (HEADED && agent.view !== null) {
        expect(minimized).toContain(w.host().dispatcher.targetIdOf(agent.view.page) ?? '');
        expect(['minimized', 'normal']).toContain((await windowState(w, agent.view.page)) ?? '');
      }
      expect(ops.recordingOf(w.template.templateId)?.id).toBe(recording.id);
      // The operator signs in to the site, and to an identity provider that is not a site.
      await signIn(tabOn(recording, 'site-a.test'), 'operator@example.test');
      const idp = await w.sessions.newTab(recording);
      await idp.page.goto('https://idp.test/');
      await signIn(idp.page, 'operator');
      const site = await service.confirm(w.template.templateId, 'site-a.test', 'operator');
      expect(site.learned_cookie_names).toContain('sid');
      expect(site.learned_cookie_names).not.toContain('_ga');
      expect(site.health.state).toBe('signed_in');
      expect(
        await service.unlisted(
          w.template.templateId,
          await repos.templateSites.list(w.template.templateId),
        ),
      ).toEqual(['idp.test']);
      const done = await service.finish(
        w.template.templateId,
        { removeSignIns: ['idp.test'] },
        'operator',
      );
      expect(done.template.status).toBe('ready');
      expect(done.version).toBeNull();
      expect(w.sessions.peek(recording.id)).toBeUndefined();
      const jar = await w.host().jar();
      expect(jar.some((c) => c.domain.endsWith('idp.test'))).toBe(false);
      expect(jar.some((c) => c.name === 'sid' && c.domain.endsWith('site-a.test'))).toBe(true);
      // The agent's session sees the sign-in (one jar).
      if (agent.view === null) throw new Error('agent has no view');
      await agent.view.page.goto('https://site-a.test/account');
      expect(await agent.view.page.textContent('#account')).toContain('Signed in to site-a.test');
      // No password was saved: the preferences turn the manager off and `Login Data` stays empty.
      const userdata = join(w.dataDir, 'templates', w.template.templateId, 'userdata');
      const prefs = JSON.parse(
        await readFile(join(userdata, 'Default', 'Preferences'), 'utf8'),
      ) as {
        credentials_enable_service?: boolean;
        profile?: { password_manager_enabled?: boolean };
      };
      expect(prefs.credentials_enable_service).toBe(false);
      expect(prefs.profile?.password_manager_enabled).toBe(false);
      await w.supervisor.stopAll(10_000);
      expect(profileHasSecrets(userdata)).toBe(false);
    });

    it('keeps the pinned locale, timezone and identity across restarts and a changed TZ', async () => {
      const before = process.env['TZ'];
      world = await templateWorld(driver);
      const w = world;
      const read = async () => {
        const session = await w.launch('identity');
        const page = session.view?.page;
        if (page === undefined) throw new Error('no page');
        await page.goto('https://site-a.test/landing');
        const facts = await page.evaluate(() => ({
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          language: navigator.language,
          userAgent: navigator.userAgent,
        }));
        await w.sessions.close(session.id, 'user');
        return facts;
      };
      try {
        const first = await read();
        expect(first.timeZone).toBe(w.template.identity.timezoneId);
        expect(first.language).toBe(w.template.identity.locale);
        // The first start recorded the observed identity (Chrome major at least).
        await until(() => w.updates.length > 0, 5_000, 'observed identity');
        expect(w.updates[0]?.identityObserved?.chromeMajor).toMatch(/^\d+$/);
        await w.supervisor.stopAll(10_000);
        process.env['TZ'] = 'Asia/Tokyo';
        const second = await read();
        expect(second).toEqual(first);
        expect(w.hosts).toHaveLength(2);
      } finally {
        if (before === undefined) delete process.env['TZ'];
        else process.env['TZ'] = before;
      }
    });
  });
}
