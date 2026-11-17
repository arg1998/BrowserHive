/** @module app/templates/template-packs.test — templates with site packs (spec 13 §9.6, §11.1, T3a): creating a template or adding a site approves the pack on first use (the reviewed SHA-256 must match), the site records `pack_id`/`pack_version`, its view shows the pack in force and its title. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeTemplateHostOps } from '../../../test/helpers/fake-host-ops.ts';
import { InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import {
  createSitePackKit,
  makeDirs,
  packSha,
  removeDirs,
  type SitePackDirs,
  type SitePackKit,
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
import { ReloginLinks } from './relogin-link.ts';
import { TemplateEditService } from './template-edit.ts';
import { TemplateService } from './template-service.ts';

let dirs: SitePackDirs;
let kit: SitePackKit;
let service: TemplateService;
let edit: TemplateEditService;

beforeEach(async () => {
  dirs = makeDirs();
  writePack(dirs.bundled, sitePack('site-a.test', 1));
  writePack(dirs.bundled, sitePack('site-b.test', 4));
  kit = createSitePackKit({ dirs });
  await kit.registry.reload();
  const repos: Repositories = { ...kit.repos, operatorActions: kit.actions };
  const logger = new CollectingLogger();
  const runtime = new FakeTemplateRuntime();
  service = new TemplateService({
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
  edit = new TemplateEditService({
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
});
afterEach(() => removeDirs(dirs));

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return isAppError(error) ? error.code : String(error);
  }
}

describe('first use from a template', () => {
  it('creating a template approves each covered site and records the pack on the site', async () => {
    const template = await service.create(
      {
        name: 'job-hunt',
        sites: [
          { site_id: 'www.site-a.test', pack_sha256: packSha(sitePack('site-a.test', 1)) },
          { site_id: 'other.test' },
        ],
      },
      'p-op',
    );
    const [a, other] = template.sites;
    expect(a).toMatchObject({ site_id: 'site-a.test', pack_id: 'site-a.test', pack_version: 1 });
    expect(a?.title).toBe('Site site-a.test');
    expect(a?.pack).toMatchObject({
      pack_id: 'site-a.test',
      version: 1,
      source: 'bundled',
      human_only: false,
      sign_in_url: 'https://www.site-a.test/login',
      guards: 1,
    });
    expect(other).toMatchObject({ pack_id: null, pack: null, title: 'other.test' });
    expect(kit.registry.get('site-a.test')?.approved?.by).toBe('p-op');
    // The sites using it are seen after a usage refresh (wired to template events).
    await kit.registry.refreshUsage();
    expect(kit.registry.get('site-a.test')?.used_by).toEqual([template.template_id]);
  });

  it('a reviewed hash that is not on offer is CONFLICT and creates nothing', async () => {
    const body = { name: 'jobs', sites: [{ site_id: 'site-a.test', pack_sha256: 'a'.repeat(64) }] };
    expect(await codeOf(service.create(body, 'p-op'))).toBe('CONFLICT');
    expect(await kit.repos.templates.getByName('jobs')).toBeNull();
    expect(kit.registry.get('site-a.test')?.approved).toBeNull();
  });

  it('adding a site approves on first use; pack_sha256 attaches a pack to a generic site', async () => {
    const template = await service.create({ name: 'jobs', sites: [{ site_id: 'x.test' }] }, 'p-op');
    const id = template.template_id;
    const added = await edit.putSite(id, 'site-b.test', {}, 'p-op');
    expect(added).toMatchObject({ pack_id: 'site-b.test', pack_version: 4 });
    expect(
      await codeOf(edit.putSite(id, 'site-b.test', { pack_sha256: 'b'.repeat(64) }, 'p-op')),
    ).toBe('CONFLICT');
    // A pack that arrives later attaches to the generic site when the operator reviews it.
    writePack(dirs.bundled, sitePack('x.test', 1));
    await kit.registry.reload();
    const attached = await edit.putSite(
      id,
      'x.test',
      { pack_sha256: packSha(sitePack('x.test', 1)) },
      'p-op',
    );
    expect(attached).toMatchObject({ pack_id: 'x.test', pack_version: 1 });
  });
});

describe('human_only packs', () => {
  it('refuse auto-relogin on their sites', async () => {
    writePack(
      dirs.bundled,
      sitePack('site-h.test', 1, {
        sign_in: { url: { host: 'www.site-h.test', path: '/login' }, human_only: true },
      }),
    );
    await kit.registry.reload();
    const template = await service.create(
      { name: 'h', sites: [{ site_id: 'site-h.test' }] },
      'p-op',
    );
    expect(template.sites[0]?.pack?.human_only).toBe(true);
    expect(kit.registry.humanOnly('site-h.test')).toBe(true);
    const links = new ReloginLinks({
      repos: { ...kit.repos, operatorActions: kit.actions },
      admin: {
        getBinding: () => Promise.reject(new Error('not reached')),
        putBinding: () => Promise.reject(new Error('not reached')),
      },
      ids: kit.ids,
      clock: kit.clock,
      packs: kit.registry,
    });
    const put = links.put(
      template.template_id,
      'site-h.test',
      {
        vaultHandle: 'h',
        autoRelogin: true,
        form: { username: '#u', password: '#p', path: '/login' },
        allowTemplate: false,
      },
      'p-op',
    );
    expect(await codeOf(put)).toBe('VALIDATION_FAILED');
  });
});
