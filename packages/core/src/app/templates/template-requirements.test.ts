/** @module app/templates/template-requirements.test — the `stealth-profile` floor and the other pack requirements at every entry point (spec 13 §9.4, §9.6, §11.1; T3b): `POST /templates` (`sites[i]`), adding or enabling a site (`site_id`), and a `PATCH` that falls below an enabled site's pack (`headless`: stealth and fingerprint are frozen at creation); nothing is written or approved on a refusal, and `sitePacks=false` checks nothing. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeTemplateHostOps } from '../../../test/helpers/fake-host-ops.ts';
import { InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import {
  createSitePackKit,
  makeDirs,
  packSha,
  removeDirs,
  type SitePackDirs,
  sitePack,
  writePack,
} from '../../../test/helpers/site-pack-kit.ts';
import {
  FAKE_TEMPLATE_GEO,
  FakeTemplateFiles,
  FakeTemplateRuntime,
  RecordingDegradations,
} from '../../../test/helpers/template-kit.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { Repositories } from '../../ports/persistence/index.ts';
import { TemplateEditService } from './template-edit.ts';
import { TemplateService } from './template-service.ts';

/** `site-m.test` needs stealth max; `site-f.test` forbids fingerprint noise; `site-r.test` needs it; `site-h.test` needs a headed browser. */
const PACKS: Readonly<Record<string, Partial<SitePackV1Input>>> = {
  'site-m.test': { strategies: [{ id: 'stealth-profile', params: { min_level: 'max' } }] },
  'site-f.test': { strategies: [{ id: 'stealth-profile', params: { fingerprint: 'forbidden' } }] },
  'site-r.test': { strategies: [{ id: 'stealth-profile', params: { fingerprint: 'required' } }] },
  'site-h.test': { browser: { channel: 'any', headed: 'required' } },
};
const packOf = (id: string) => sitePack(id, 1, PACKS[id] ?? {});
const sha = (id: string) => packSha(packOf(id));

let dirs: SitePackDirs | null = null;
afterEach(() => {
  if (dirs !== null) removeDirs(dirs);
  dirs = null;
});

async function world(enabled = true) {
  dirs = makeDirs();
  for (const id of Object.keys(PACKS)) writePack(dirs.bundled, packOf(id));
  const kit = createSitePackKit({ dirs, enabled });
  await kit.registry.reload();
  const repos: Repositories = { ...kit.repos, operatorActions: kit.actions };
  const logger = new CollectingLogger();
  const runtime = new FakeTemplateRuntime();
  const service = new TemplateService({
    repos,
    uow: new InMemoryUnitOfWork(repos),
    runtime,
    geo: FAKE_TEMPLATE_GEO,
    files: new FakeTemplateFiles(),
    degradations: new RecordingDegradations(),
    ids: { opaque: (n) => 'x'.repeat(n), eventId: () => kit.ids.eventId() },
    clock: kit.clock,
    logger,
    packs: kit.registry,
    config: {
      enabled: true,
      authMode: 'off',
      maxPagesPerHost: 40,
      defaults: { channel: 'chromium', stealth: 'standard', fingerprint: false, humanize: false },
    },
  });
  const edit = new TemplateEditService({
    repos,
    uow: new InMemoryUnitOfWork(repos),
    runtime,
    ops: new FakeTemplateHostOps(),
    sessions: { peek: () => undefined, close: () => Promise.resolve(true) },
    ids: kit.ids,
    clock: kit.clock,
    logger,
    changed: () => undefined,
    packs: kit.registry,
  });
  return { kit, service, edit };
}

/** The issues of a `VALIDATION_FAILED` refusal as `path code`, or what happened instead. */
async function issuesOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
    return ['resolved'];
  } catch (error) {
    if (!isAppError(error) || error.code !== 'VALIDATION_FAILED') return [String(error)];
    const issues = (error.details as { issues: { path: string; code: string }[] }).issues;
    return issues.map((i) => `${i.path} ${i.code}`);
  }
}

describe('the stealth floor at creation', () => {
  it('refuses a template below a site pack floor and writes or approves nothing', async () => {
    const { kit, service } = await world();
    const body = {
      name: 'jobs',
      sites: [
        { site_id: 'other.test' },
        { site_id: 'site-m.test', pack_sha256: sha('site-m.test') },
      ],
    };
    expect(await issuesOf(service.create(body, 'p-op'))).toEqual(['sites[1] stealth_below_floor']);
    expect(await kit.repos.templates.getByName('jobs')).toBeNull();
    expect(kit.registry.get('site-m.test')?.approved).toBeNull();
    const ok = await service.create({ ...body, stealth: 'max' }, 'p-op');
    expect(ok.sites.map((s) => s.site_id)).toEqual(['other.test', 'site-m.test']);
  });

  it('refuses fingerprint noise a pack forbids and its absence where one requires it', async () => {
    const { service } = await world();
    const site = (id: string) => [{ site_id: id, pack_sha256: sha(id) }];
    expect(
      await issuesOf(
        service.create({ name: 'f', sites: site('site-f.test'), fingerprint: true }, 'p'),
      ),
    ).toEqual(['sites[0] fingerprint_forbidden']);
    expect(
      await issuesOf(
        service.create({ name: 'r', sites: site('site-r.test'), fingerprint: false }, 'p'),
      ),
    ).toEqual(['sites[0] fingerprint_required']);
    const both = await issuesOf(
      service.create(
        {
          name: 'both',
          sites: [...site('site-m.test'), ...site('site-r.test')],
          stealth: 'off',
          fingerprint: false,
        },
        'p',
      ),
    );
    // `stealth-profile` defaults to a `standard` floor: stealth off is below every selecting pack.
    expect(both).toEqual([
      'sites[0] stealth_below_floor',
      'sites[1] stealth_below_floor',
      'sites[1] fingerprint_required',
    ]);
  });

  it('names the pack in the operator message', async () => {
    const { service } = await world();
    try {
      await service.create(
        { name: 'm', sites: [{ site_id: 'site-m.test', pack_sha256: sha('site-m.test') }] },
        'p',
      );
      throw new Error('not refused');
    } catch (error) {
      expect(isAppError(error) && error.message).toContain(
        "Site site-m.test needs stealth 'max' or higher (the template has 'standard')",
      );
    }
  });

  it('checks nothing under sitePacks=false', async () => {
    const { service } = await world(false);
    const made = await service.create(
      { name: 'off', sites: [{ site_id: 'site-m.test' }], stealth: 'off', fingerprint: true },
      'p',
    );
    expect(made.sites[0]?.pack_id).toBeNull();
  });
});

describe('the stealth floor when a site is added or enabled', () => {
  it('refuses adding a site whose floor the template does not meet', async () => {
    const { kit, service, edit } = await world();
    const { template_id: id } = await service.create(
      { name: 'jobs', sites: [{ site_id: 'x.test' }] },
      'p',
    );
    expect(
      await issuesOf(edit.putSite(id, 'site-m.test', { pack_sha256: sha('site-m.test') }, 'p')),
    ).toEqual(['site_id stealth_below_floor']);
    expect((await kit.repos.templateSites.list(id)).map((s) => s.siteId)).toEqual(['x.test']);
    expect(kit.registry.get('site-m.test')?.approved).toBeNull();
    // The other floors and a headed-only pack on a headless template too.
    expect(
      await issuesOf(edit.putSite(id, 'site-r.test', { pack_sha256: sha('site-r.test') }, 'p')),
    ).toEqual(['site_id fingerprint_required']);
    const headless = await service.create(
      { name: 'hl', sites: [{ site_id: 'x.test' }], headless: true },
      'p',
    );
    expect(
      await issuesOf(
        edit.putSite(headless.template_id, 'site-h.test', { pack_sha256: sha('site-h.test') }, 'p'),
      ),
    ).toEqual(['site_id headed_required']);
  });

  it('refuses enabling a disabled site below its floor, but not a write-policy change', async () => {
    const { kit, service, edit } = await world();
    const { template_id: id } = await service.create(
      { name: 'jobs', sites: [{ site_id: 'site-f.test', pack_sha256: sha('site-f.test') }] },
      'p',
    );
    await edit.putSite(id, 'site-f.test', { enabled: false }, 'p');
    // Fingerprint is frozen at creation: simulate a template that has it on (an older template).
    await kit.repos.templates.update(id, { fingerprint: true });
    expect(await issuesOf(edit.putSite(id, 'site-f.test', { enabled: true }, 'p'))).toEqual([
      'site_id fingerprint_forbidden',
    ]);
    const policy = await edit.putSite(id, 'site-f.test', { write_policy: 'warn' }, 'p');
    expect(policy).toMatchObject({ enabled: false, write_policy: 'warn' });
  });
});

describe('the pack requirements on PATCH', () => {
  it('refuses an edit that falls below an enabled site and allows unrelated edits', async () => {
    const { kit, service, edit } = await world();
    const { template_id: id } = await service.create(
      { name: 'jobs', sites: [{ site_id: 'site-h.test', pack_sha256: sha('site-h.test') }] },
      'p',
    );
    expect(await issuesOf(edit.update(id, { headless: true }, { by: 'p' }))).toEqual([
      'headless headed_required',
    ]);
    expect((await kit.repos.templates.get(id))?.headless).toBe(false);
    await edit.putSite(id, 'site-h.test', { enabled: false }, 'p');
    await edit.update(id, { headless: true }, { by: 'p' });
    // A template already below a site (a pack applied later): unrelated edits still pass.
    const site = (await kit.repos.templateSites.list(id))[0];
    if (site === undefined) throw new Error('no site');
    await kit.repos.templateSites.upsert({ ...site, enabled: true });
    const renamed = await edit.update(id, { display_name: 'Jobs' }, { by: 'p' });
    expect(renamed.template.display_name).toBe('Jobs');
  });
});
