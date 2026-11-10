/** @module app/templates/template-recording.test — the recording workflow over fake host operations (spec 13 §7.1 step 5, §11.1): the window opens once with the jar snapshot, **I'm signed in** learns the new cookie names, Finish removes unlisted sign-ins, marks unconfirmed sites signed out and sets the template ready; Cancel and the host routes. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeTemplateHostOps } from '../../../test/helpers/fake-host-ops.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { fakeCookie } from '../../../test/helpers/fake-template-host.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { FakeTemplateRuntime } from '../../../test/helpers/template-kit.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { TemplateRecordingService } from './template-recording.ts';

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
