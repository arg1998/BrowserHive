/** @module app/templates/template-recording.test — the recording workflow over fake host operations (spec 13 §7.1 step 5, §11.1): the window opens once with the jar snapshot, **I'm signed in** learns the new cookie names, a pack site reads signed in from its pack's cookies while the window is open and at Finish (the owner's LinkedIn jar: signed in, nothing unlisted), Finish removes unlisted sign-ins, marks unconfirmed sites signed out and sets the template ready; Cancel and the host routes. */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeTemplateHostOps } from '../../../test/helpers/fake-host-ops.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { fakeCookie } from '../../../test/helpers/fake-template-host.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { FakeTemplateRuntime } from '../../../test/helpers/template-kit.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { ProbeVerdict } from '../../domain/templates/probe.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import { NO_PACKS, type TemplatePacks } from './template-packs.ts';
import { DETECTED_BY_PACK_COOKIES, TemplateRecordingService } from './template-recording.ts';

const ID = templateRecord().templateId;
const OPERATOR = { subject: 'operator' };

let ops: FakeTemplateHostOps;
let repos: InMemoryRepositories;
let actions: InMemoryOperatorActionRepository;
let service: TemplateRecordingService;

beforeEach(async () => {
  ops = new FakeTemplateHostOps();
  repos = new InMemoryRepositories();
  actions = new InMemoryOperatorActionRepository();
  const bundle = { ...repos, operatorActions: actions };
  service = new TemplateRecordingService({
    repos: bundle,
    uow: new InMemoryUnitOfWork(bundle),
    runtime: new FakeTemplateRuntime(),
    ops,
    ids: new FakeIdGenerator(),
    clock: new FakeClock(),
    logger: new CollectingLogger(),
  });
  await repos.templates.insert(templateRecord({ status: 'recording' }));
  await repos.templateSites.upsert(templateSiteRecord({ siteId: 'site-a.test' }));
  await repos.templateSites.upsert(templateSiteRecord({ siteId: 'site-b.test' }));
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return isAppError(err) ? err.code : 'other';
  }
}

describe('recording a template', () => {
  it('opens the window with every enabled site and snapshots the jar once', async () => {
    ops.jarCookies = [fakeCookie('.site-a.test', 'pref')];
    const started = await service.start(ID, {}, OPERATOR);
    expect(started.session_id).toBe('recording-0000aaaa');
    expect(ops.opened[0]?.siteIds).toEqual(['site-a.test', 'site-b.test']);
    expect(ops.opened[0]?.principal).toEqual(OPERATOR);
    await service.start(ID, { sites: ['www.site-b.test'] }, OPERATOR);
    expect(ops.opened[1]?.siteIds).toEqual(['site-b.test']);
    expect(actions.rows.filter((r) => r.action === 'template.record.start')).toHaveLength(1);
  });

  it('refuses a disabled template and a site the template does not have', async () => {
    expect(await codeOf(service.start(ID, { sites: ['other.test'] }, OPERATOR))).toBe(
      'VALIDATION_FAILED',
    );
    await repos.templates.update(ID, { status: 'disabled' });
    expect(await codeOf(service.start(ID, {}, OPERATOR))).toBe('TEMPLATE_DISABLED');
    expect(await codeOf(service.start('tp-missing000', {}, OPERATOR))).toBe('TEMPLATE_NOT_FOUND');
  });

  it("learns the cookie names a site gained since the window opened at I'm signed in", async () => {
    ops.jarCookies = [fakeCookie('.site-a.test', 'pref')];
    await service.start(ID, {}, OPERATOR);
    ops.jarCookies.push(fakeCookie('.site-a.test', 'sid'), fakeCookie('.site-a.test', '_ga'));
    const site = await service.confirm(ID, 'site-a.test', 'operator');
    expect(site.learned_cookie_names).toEqual(['sid']);
    expect(site.health.state).toBe('signed_in');
    const stored = await repos.templateSites.list(ID);
    expect(stored.find((s) => s.siteId === 'site-a.test')?.learnedCookieNames).toEqual(['sid']);
  });

  it('keeps only the learned names still in the jar when no new cookie appeared (re-recording)', async () => {
    await repos.templateSites.upsert(
      templateSiteRecord({ siteId: 'site-a.test', learnedCookieNames: ['old', 'gone'] }),
    );
    ops.jarCookies = [fakeCookie('.site-a.test', 'old')];
    await service.start(ID, {}, OPERATOR);
    const site = await service.confirm(ID, 'site-a.test', 'operator');
    expect(site.learned_cookie_names).toEqual(['old']);
  });

  it('reports the origins a removal could not clear (never silently)', async () => {
    await service.start(ID, {}, OPERATOR);
    ops.jarCookies?.push(fakeCookie('.idp.test', 'idp'));
    ops.uncleared = ['https://app.idp.test'];
    const done = await service.finish(ID, { removeSignIns: ['idp.test'] }, 'operator');
    expect(done.removed_sign_ins).toEqual([
      {
        domain: 'idp.test',
        cookies_removed: 1,
        origins_cleared: ['https://idp.test'],
        uncleared_origins: ['https://app.idp.test'],
      },
    ]);
  });

  it('answers CONFLICT without a window or without a new cookie on the site', async () => {
    expect(await codeOf(service.confirm(ID, 'site-a.test', 'operator'))).toBe('CONFLICT');
    await service.start(ID, {}, OPERATOR);
    expect(await codeOf(service.confirm(ID, 'site-b.test', 'operator'))).toBe('CONFLICT');
  });

  it('Finish removes unlisted sign-ins, keeps unconfirmed sites as signed out and sets ready', async () => {
    await service.start(ID, {}, OPERATOR);
    ops.jarCookies?.push(fakeCookie('.site-a.test', 'sid'), fakeCookie('.idp.test', 'idp'));
    await service.confirm(ID, 'site-a.test', 'operator');
    // A domain without a pack counts once a window opened it as a page.
    expect(await service.unlisted(ID, await repos.templateSites.list(ID))).toEqual([]);
    ops.visitedSites.add('idp.test');
    expect(await service.unlisted(ID, await repos.templateSites.list(ID))).toEqual(['idp.test']);
    const done = await service.finish(ID, { removeSignIns: ['www.idp.test'] }, 'operator');
    expect(done.version).toBeNull();
    expect(done.template.status).toBe('ready');
    expect(ops.removed).toEqual(['idp.test']);
    expect(ops.closed).toBe(1);
    const health = Object.fromEntries(done.template.sites.map((s) => [s.site_id, s.health.state]));
    expect(health).toEqual({ 'site-a.test': 'signed_in', 'site-b.test': 'signed_out' });
    expect(await service.unlisted(ID, await repos.templateSites.list(ID))).toEqual([]);
    expect(actions.rows.map((r) => r.action)).toContain('template.record.finish');
    // Done: a second Finish has nothing to finish.
    expect(await codeOf(service.finish(ID, {}, 'operator'))).toBe('CONFLICT');
  });

  it('refuses to remove the sign-in of a site of the template', async () => {
    await service.start(ID, {}, OPERATOR);
    expect(await codeOf(service.finish(ID, { removeSignIns: ['site-a.test'] }, 'operator'))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await codeOf(service.removeSignIn(ID, 'site-b.test', 'operator'))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('Cancel closes the window and keeps the template recording', async () => {
    await service.start(ID, {}, OPERATOR);
    await service.cancel(ID, 'operator');
    expect(ops.closed).toBe(1);
    expect((await repos.templates.get(ID))?.status).toBe('recording');
    // Without a window, Finish of a template still being set up still completes it.
    const done = await service.finish(ID, {}, 'operator');
    expect(done.template.status).toBe('ready');
  });

  it('removes an unlisted sign-in and clears saved passwords on request', async () => {
    ops.jarCookies = [fakeCookie('.idp.test', 'idp'), fakeCookie('www.idp.test', 'x')];
    expect((await service.removeSignIn(ID, 'idp.test', 'operator')).cookies_removed).toBe(2);
    await service.clearProfileSecrets(ID, 'operator');
    expect(ops.clearedSecrets).toEqual([ID]);
    expect(actions.rows.map((r) => r.action)).toEqual([
      'template.signin.remove',
      'template.profile_secrets.clear',
    ]);
  });
});

/** Packs for LinkedIn and Google with the bundled packs' sign-in cookie names. */
const PACKS: TemplatePacks = {
  ...NO_PACKS,
  packIdFor: (domain) =>
    ['linkedin.com', 'licdn.com'].includes(domain)
      ? 'linkedin.com'
      : domain === 'google.com'
        ? 'google.com'
        : null,
  detail: (packId) => ({
    pack: {
      domains: packId === 'linkedin.com' ? ['linkedin.com', 'licdn.com'] : [packId],
      signed_in: { cookie_names: packId === 'linkedin.com' ? ['li_at', 'liap'] : ['SID', 'HSID'] },
    } as unknown as SitePackV1,
  }),
};

/** The owner's jar after signing in to LinkedIn in the window (2026-11-17, names only). */
const OWNER_JAR = () => [
  fakeCookie('.www.linkedin.com', 'li_at'),
  fakeCookie('.linkedin.com', 'liap'),
  { ...fakeCookie('.www.linkedin.com', 'JSESSIONID'), httpOnly: false },
  fakeCookie('.doubleclick.net', 'IDE'),
  fakeCookie('www.google.com', '_GRECAPTCHA'),
  fakeCookie('.facebook.com', 'fr'),
];

describe('a pack site signed in without I’m signed in (owner report 2026-11-17)', () => {
  const LI = 'tp-linkedin01';
  let recorded: { siteId: string; verdict: ProbeVerdict; trigger: string }[];
  let probed: { siteIds: readonly string[] | undefined; trigger: string }[];
  /** What the fake navigation probe answers for a probed site. */
  let probeAnswer: ProbeVerdict;

  /** A health service that records verdicts and answers probes with `probeAnswer`. */
  function attachFakeHealth(): void {
    const apply = async (templateId: string, siteId: string, verdict: ProbeVerdict) => {
      const [row] = (await repos.templateSites.list(templateId)).filter((s) => s.siteId === siteId);
      if (row !== undefined)
        await repos.templateSites.upsert({
          ...row,
          health: { ...row.health, state: verdict.outcome, reason: verdict.reason },
        });
    };
    service.attachHealth({
      record: async (template: TemplateRecord, siteId: string, verdict: ProbeVerdict, trigger) => {
        recorded.push({ siteId, verdict, trigger });
        await apply(template.templateId, siteId, verdict);
      },
      probe: async (templateId, options) => {
        probed.push({ siteIds: options.siteIds, trigger: options.trigger });
        for (const siteId of options.siteIds ?? []) await apply(templateId, siteId, probeAnswer);
        return [];
      },
    });
  }

  beforeEach(async () => {
    recorded = [];
    probed = [];
    probeAnswer = { outcome: 'signed_out', reason: 'redirect', finalUrl: null };
    const bundle = { ...repos, operatorActions: actions };
    service = new TemplateRecordingService({
      repos: bundle,
      uow: new InMemoryUnitOfWork(bundle),
      runtime: new FakeTemplateRuntime(),
      ops,
      ids: new FakeIdGenerator(),
      clock: new FakeClock(),
      logger: new CollectingLogger(),
      packs: PACKS,
    });
    await repos.templates.insert(
      templateRecord({ templateId: LI, name: 'job-hunting', status: 'recording' }),
    );
    // The browser's first start probed before anyone signed in.
    await repos.templateSites.upsert(
      templateSiteRecord({
        templateId: LI,
        siteId: 'linkedin.com',
        packId: 'linkedin.com',
        health: {
          ...templateSiteRecord().health,
          state: 'signed_out',
          reason: 'cookies_absent',
        },
      }),
    );
  });

  it('Finish reads the pack’s cookies: LinkedIn is signed in and nothing is unlisted', async () => {
    ops.jarCookies = [];
    await service.start(LI, {}, OPERATOR);
    ops.jarCookies = OWNER_JAR();
    // Even pages the window opened on those domains would not make ad cookies sign-ins.
    for (const site of ['linkedin.com', 'google.com', 'facebook.com']) ops.visitedSites.add(site);
    expect(await service.unlisted(LI, await repos.templateSites.list(LI))).toEqual([]);
    const done = await service.finish(LI, {}, 'operator');
    const site = done.template.sites[0];
    expect(site?.health.state).toBe('signed_in');
    expect(site?.health.reason).toBe(DETECTED_BY_PACK_COOKIES);
    expect(done.template.status).toBe('ready');
  });

  it('while the window is open, the tick records the detection as a probe row (trigger recording)', async () => {
    attachFakeHealth();
    ops.jarCookies = [];
    await service.start(LI, {}, OPERATOR);
    ops.recording = { id: 'recording-0000aaaa' } as never;
    await service.tick();
    expect(recorded).toEqual([]);
    // Only one of the two names: not yet.
    ops.jarCookies = [fakeCookie('.linkedin.com', 'liap')];
    await service.tick();
    expect(recorded).toEqual([]);
    ops.jarCookies = OWNER_JAR();
    await service.tick();
    expect(recorded).toEqual([
      {
        siteId: 'linkedin.com',
        verdict: { outcome: 'signed_in', reason: DETECTED_BY_PACK_COOKIES, finalUrl: null },
        trigger: 'recording',
      },
    ]);
    // Signed in now: the next tick records nothing more.
    await service.tick();
    expect(recorded).toHaveLength(1);
  });

  it('lists a domain the operator really signed in to (Google, by its pack’s cookies)', async () => {
    ops.jarCookies = [
      ...OWNER_JAR(),
      fakeCookie('.google.com', 'SID'),
      fakeCookie('.google.com', 'HSID'),
    ];
    expect(await service.unlisted(LI, await repos.templateSites.list(LI))).toEqual(['google.com']);
  });

  it('cookies already there when the window opened prove nothing: no tick flips the site (review #85 H2)', async () => {
    attachFakeHealth();
    // Signing in again to a site whose server invalidated the session: the cookies are still there.
    ops.jarCookies = OWNER_JAR();
    await service.start(LI, {}, OPERATOR);
    ops.recording = { id: 'recording-0000aaaa' } as never;
    await service.tick();
    await service.tick();
    expect(recorded).toEqual([]);
    const [site] = await repos.templateSites.list(LI);
    expect(site?.health.state).toBe('signed_out');
  });

  it('at Finish, stale cookies get the navigation probe instead (here: signed out)', async () => {
    attachFakeHealth();
    ops.jarCookies = OWNER_JAR();
    await service.start(LI, {}, OPERATOR);
    const done = await service.finish(LI, {}, 'operator');
    expect(recorded).toEqual([]);
    expect(probed).toEqual([{ siteIds: ['linkedin.com'], trigger: 'recording' }]);
    expect(done.template.sites[0]?.health.state).toBe('signed_out');
  });

  it('at Finish, a probe that finds the site signed in keeps it signed in', async () => {
    attachFakeHealth();
    probeAnswer = { outcome: 'signed_in', reason: 'no_redirect', finalUrl: null };
    ops.jarCookies = OWNER_JAR();
    await service.start(LI, {}, OPERATOR);
    const done = await service.finish(LI, {}, 'operator');
    expect(done.template.sites[0]?.health).toMatchObject({
      state: 'signed_in',
      reason: 'no_redirect',
    });
  });

  it('a sign-in cookie set again in the window (a new expiry) counts as a sign-in', async () => {
    attachFakeHealth();
    ops.jarCookies = OWNER_JAR();
    await service.start(LI, {}, OPERATOR);
    ops.recording = { id: 'recording-0000aaaa' } as never;
    ops.jarCookies = OWNER_JAR().map((c) =>
      c.name === 'li_at' ? { ...c, expires: c.expires + 600 } : c,
    );
    await service.tick();
    expect(recorded.map((r) => r.verdict.reason)).toEqual([DETECTED_BY_PACK_COOKIES]);
  });

  it('signing in again on a ready template: stale cookies stay signed out until a real sign-in', async () => {
    attachFakeHealth();
    await repos.templates.update(LI, { status: 'ready' });
    ops.jarCookies = OWNER_JAR();
    await service.start(LI, {}, OPERATOR);
    ops.recording = { id: 'recording-0000aaaa' } as never;
    await service.tick();
    expect(recorded).toEqual([]);
    // The operator signs in: LinkedIn replaces li_at.
    ops.jarCookies = OWNER_JAR().map((c) =>
      c.name === 'li_at' ? { ...c, expires: c.expires + 86_400 } : c,
    );
    await service.tick();
    expect(recorded).toHaveLength(1);
  });
});
