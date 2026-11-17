/** @module test/integration/template-health — spec 13 §17 T2 acceptance against real Chromium and the HTTPS fixture sites: the generic probe's three outcomes, one sign-out notification per identity provider that resolves after a re-login, the queued act and **Show window**, agents paused during the window (D-60), vault auto-relogin through every gate, and `TEMPLATE_NEEDS_LOGIN` only when every site is out. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Page } from 'playwright';
import { InProcessEventBus } from '../../src/app/events/bus.ts';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { NotificationService } from '../../src/app/notifications/notification-service.ts';
import { TemplateHostOperations } from '../../src/app/templates/host-operations.ts';
import { TemplateHealthService } from '../../src/app/templates/template-health.ts';
import { PrelaunchCheck } from '../../src/app/templates/template-prelaunch.ts';
import { TemplateReloginService } from '../../src/app/templates/template-relogin.ts';
import { createVaultHarness, type VaultHarness } from '../../src/domain/vault/test-support.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import type { TemplateSiteRecord } from '../../src/ports/persistence/index.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import {
  InMemoryNotificationRepository,
  InMemoryRepositories,
} from '../helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../helpers/in-memory-vault-repos.ts';
import { templateSiteRecord } from '../persistence/helpers.ts';
import { HEADED, type TemplateWorld, templateWorld, until } from './template-fixture.ts';

const MACHINE = 'hive-box';
const SITE_A = 'site-a.test';
const SITE_B = 'site-b.test';
const LEARNED = ['sid', 'user'];

let world: TemplateWorld | null = null;
let vault: VaultHarness | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
  vault = null;
});

/** The T2 services over a real template host, with in-memory rows. */
async function setup(options: { readonly vault?: boolean } = {}) {
  const w = await templateWorld('patchright');
  world = w;
  const clock = createSystemClock();
  const logger = createCollectingLogger();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });
  const repos = new InMemoryRepositories();
  const operatorActions = new InMemoryOperatorActionRepository();
  const bundle = { ...repos, operatorActions };
  const template = { ...w.template, status: 'ready' as const };
  await repos.templates.insert(template);
  for (const siteId of [SITE_A, SITE_B]) {
    await repos.templateSites.upsert(
      templateSiteRecord({ templateId: template.templateId, siteId, learnedCookieNames: LEARNED }),
    );
  }
  const ops = new TemplateHostOperations({
    supervisor: w.supervisor,
    sessions: w.sessions,
    launcher: {},
    dataDir: w.dataDir,
    logger,
    clock,
    drainTimeoutMs: 10_000,
  });
  const health = new TemplateHealthService({
    repos: bundle,
    hosts: {
      runningHost: (id) => w.supervisor.runningHost(id),
      withHost: (t, fn) => ops.withHost(t, fn),
      slotFree: () => true,
    },
    clock,
    logger,
    bus,
    machine: MACHINE,
  });
  if (options.vault === true) vault = createVaultHarness();
  const v = vault;
  const relogin = new TemplateReloginService({
    repos: bundle,
    supervisor: w.supervisor,
    ops,
    sessions: w.sessions,
    health,
    ...(v !== null && {
      vault: { configured: true, fill: (request, ctx) => v.broker().fill(request, ctx) },
    }),
    ids: new FakeIdGenerator(),
    clock,
    logger,
    bus,
    machine: MACHINE,
  });
  health.attach({ signedOut: (t, site) => relogin.signedOut(t, site) });
  const notifications = new NotificationService({
    repo: new InMemoryNotificationRepository(),
    bus,
    clock,
    ids: new FakeIdGenerator(),
    logger,
  });
  notifications.start();
  const prelaunch = new PrelaunchCheck({ repos: bundle, health, clock });
  w.supervisor.attachHealth({ prelaunch: (t, signal) => prelaunch.check(t, signal) });
  return { w, repos, health, relogin, notifications, template, bus, ops, operatorActions };
}

type World = Awaited<ReturnType<typeof setup>>;

/** Signs in on a fixture site's password form in `page`. */
async function signIn(page: Page, site: string): Promise<void> {
  await page.goto(`https://${site}/login`);
  await page.fill('#username', 'operator');
  await page.fill('#password', 'correct horse battery staple');
  await Promise.all([page.waitForURL(/\/login$/), page.click('#submit')]);
  await page.waitForSelector('#signed-in');
}

/** Signs the template's browser in to `site` through a session of BrowserHive's own. */
async function signInHost(t: World, site: string): Promise<void> {
  const session = await t.w.supervisor.launchMaintenance({
    template: t.template,
    sites: [],
    slug: 'maintenance',
    principal: { subject: 'browserhive' },
  });
  const page = session.view?.page;
  if (page === undefined) throw new Error('no page');
  await signIn(page, site);
  await t.w.sessions.close(session.id, 'operator');
}

async function siteOf(t: World, siteId: string): Promise<TemplateSiteRecord> {
  const site = (await t.repos.templateSites.list(t.template.templateId)).find(
    (s) => s.siteId === siteId,
  );
  if (site === undefined) throw new Error(`no site ${siteId}`);
  return site;
}

async function probe(t: World, siteId: string) {
  const run = await t.health.probe(t.template.templateId, {
    trigger: 'manual',
    siteIds: [siteId],
    start: 'always',
  });
  return run?.[0];
}

async function clearCookies(t: World, site: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await t.w
      .host()
      .context.clearCookies({ name, domain: new RegExp(`${site.replace('.', '\\.')}$`) });
  }
}

async function notificationsOf(t: World) {
  await t.notifications.idle();
  return (await t.notifications.list({ principalId: null, limit: 100 })).items;
}

describe('template health (spec 13 §8, T2)', () => {
  it('a learned sign-in cookie decides: all present, some missing, all missing', async () => {
    const t = await setup();
    await signInHost(t, SITE_A);
    expect(await probe(t, SITE_A)).toMatchObject({
      outcome: 'signed_in',
      reason: 'learned_cookies',
    });
    await clearCookies(t, SITE_A, ['user']);
    expect(await probe(t, SITE_A)).toMatchObject({
      outcome: 'inconclusive',
      reason: 'partial_cookies',
    });
    await clearCookies(t, SITE_A, ['sid']);
    expect(await probe(t, SITE_A)).toMatchObject({
      outcome: 'signed_out',
      reason: 'cookies_absent',
    });
    const rows = await t.repos.templateProbes.list(t.template.templateId, { limit: 10 });
    expect(rows.items.map((r) => r.outcome)).toEqual(['signed_out', 'inconclusive', 'signed_in']);
    // No cookie value is ever read into a probe row or the site's health.
    expect(JSON.stringify([rows, await siteOf(t, SITE_A)])).not.toContain('sid-site-a');
  }, 60_000);

  it('a sign-out notifies once per identity provider and resolves after a window re-login', async () => {
    const t = await setup();
    await signInHost(t, SITE_A);
    await probe(t, SITE_A);
    await clearCookies(t, SITE_A, LEARNED);
    await probe(t, SITE_A);
    await probe(t, SITE_A); // still signed out: no second notification
    let rows = (await notificationsOf(t)).filter((n) => n.kind === 'template.signed_out');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'open',
      thread: `template:${t.template.templateId}:${SITE_A}`,
    });

    // The act button only queues; Show window opens it, and agents wait meanwhile (D-60).
    const queued = await t.relogin.queue(t.template.templateId, SITE_A, 'telegram:42');
    expect(queued.state).toBe('queued');
    expect(t.w.supervisor.pause.paused(t.template.templateId)).toBe(false);
    const shown = await t.relogin.show(t.template.templateId, { subject: 'admin' });
    expect(shown.window).toBe('relogin');
    const view = t.relogin.view(t.template.templateId);
    expect(view?.state).toBe('open');
    // A headless browser (CI off the Xvfb leg) has no window: the operator signs in through the
    // live view, and agents wait from the first input on (review #81 M-2).
    expect(view?.sign_in_via).toBe(HEADED ? 'window' : 'live_view');
    if (view?.sign_in_via === 'live_view') {
      expect(t.w.supervisor.pause.paused(t.template.templateId)).toBe(false);
      expect(t.relogin.liveInput(shown.sessionId)).toBe(true);
    }
    expect(t.w.supervisor.pause.paused(t.template.templateId)).toBe(true);
    const paused = await t.w.supervisor.pause
      .wait(t.template.templateId, t.template.name, undefined, 300)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(isAppError(paused, 'TEMPLATE_UNAVAILABLE')).toBe(true);

    // The operator signs in in the window; the watch sees the cookies and finishes the re-login.
    const session = t.w.sessions.peek(shown.sessionId);
    const page = session?.tabs.entries().find(([, p]) => p.url().includes(SITE_A))?.[1];
    if (page === undefined) throw new Error('no site tab in the re-login window');
    await signIn(page, SITE_A);
    await until(
      () => t.relogin.view(t.template.templateId)?.state === 'signed_in',
      20_000,
      'signed in',
    );
    expect(t.w.supervisor.pause.paused(t.template.templateId)).toBe(false);
    expect((await siteOf(t, SITE_A)).health.state).toBe('signed_in');
    rows = (await notificationsOf(t)).filter((n) => n.kind === 'template.signed_out');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('resolved');
    expect(t.operatorActions.rows.map((r) => r.action)).toContain('template.host.show');
  }, 90_000);

  it('an auto-relogin fills once through every vault gate and is not retried within 24 h', async () => {
    const t = await setup({ vault: true });
    const h = vault;
    if (h === null) throw new Error('no vault');
    const principal = `template:${t.template.templateId}`;
    await h.bind('site-a', {
      itemName: 'linkedin',
      itemId: 'i1',
      allowedOrigins: [SITE_A],
      authorizedSessionSlugs: ['relogin'],
      authorizedPrincipals: [principal],
    });
    const site = await siteOf(t, SITE_A);
    await t.repos.templateSites.upsert({
      ...site,
      vaultHandle: 'site-a',
      autoRelogin: true,
      vaultLinkedBy: 'admin',
      form: { username: '#username', password: '#password', submit: '#submit', path: '/login' },
    });
    await signInHost(t, SITE_A);
    await probe(t, SITE_A);
    await clearCookies(t, SITE_A, LEARNED);
    await probe(t, SITE_A); // signed out → the automatic try
    await until(() => t.relogin.view(t.template.templateId)?.state !== 'filling', 40_000, 'fill');
    expect(t.relogin.view(t.template.templateId)?.state).toBe('signed_in');
    expect(h.repos.audit.rows).toHaveLength(1);
    const row = h.repos.audit.rows[0];
    expect(row).toMatchObject({
      result: 'success',
      principalId: principal,
      details: { trigger: 'auto_relogin', linked_by: 'admin' },
    });
    expect(row?.sessionId.startsWith('relogin-')).toBe(true);

    // Signed out again within 24 h: no second fill, a failed re-login instead.
    await clearCookies(t, SITE_A, LEARNED);
    await probe(t, SITE_A);
    await until(() => t.relogin.view(t.template.templateId)?.state === 'failed', 10_000, 'failed');
    expect(t.relogin.view(t.template.templateId)?.error).toBe('retry_window');
    expect(h.repos.audit.rows).toHaveLength(1);
    const failed = (await notificationsOf(t)).filter((n) => n.kind === 'template.relogin_failed');
    expect(failed).toHaveLength(1);
  }, 120_000);

  it('an auto-relogin is refused for a binding that does not list template:<id>', async () => {
    const t = await setup({ vault: true });
    const h = vault;
    if (h === null) throw new Error('no vault');
    await h.bind('site-a', {
      itemName: 'linkedin',
      itemId: 'i1',
      allowedOrigins: [SITE_A],
      authorizedSessionSlugs: ['relogin'],
      authorizedPrincipals: ['agent-a'],
    });
    const site = await siteOf(t, SITE_A);
    await t.repos.templateSites.upsert({
      ...site,
      vaultHandle: 'site-a',
      autoRelogin: true,
      form: { username: '#username', password: '#password', submit: '#submit', path: '/login' },
    });
    await signInHost(t, SITE_A);
    await probe(t, SITE_A);
    await clearCookies(t, SITE_A, LEARNED);
    await probe(t, SITE_A);
    await until(() => t.relogin.view(t.template.templateId)?.state === 'failed', 40_000, 'refused');
    expect(t.relogin.view(t.template.templateId)?.error).toBe('not_authorized');
    expect(h.repos.audit.rows).toHaveLength(1);
    expect(h.repos.audit.rows[0]).toMatchObject({
      result: 'blocked',
      details: { trigger: 'auto_relogin' },
    });
    expect(h.backend.calls).toEqual([]);
  }, 90_000);

  it('TEMPLATE_NEEDS_LOGIN only when every enabled site is out', async () => {
    const t = await setup();
    await signInHost(t, SITE_A);
    await probe(t, SITE_A);
    await probe(t, SITE_B); // never signed in: out
    // One site still in: the launch goes ahead with the warning.
    const session = await t.w.launch('agent-one');
    expect(session.warnings.map((w) => w.code)).toContain('TEMPLATE_SITE_SIGNED_OUT');
    await t.w.sessions.close(session.id, 'user');
    await clearCookies(t, SITE_A, LEARNED);
    await probe(t, SITE_A);
    const refused = await t.w.launch('agent-two').catch((err: unknown) => err);
    expect(isAppError(refused, 'TEMPLATE_NEEDS_LOGIN')).toBe(true);
  }, 90_000);
});
