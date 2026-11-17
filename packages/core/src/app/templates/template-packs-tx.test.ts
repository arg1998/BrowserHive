/** @module app/templates/template-packs-tx.test — a first-use approval commits with the template or site that needed it, or not at all (review #83 C-L9), on SQLite so the rollback is real. */

import { afterEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import {
  createDirRegistry,
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
import { openMemory, type TestDb } from '../../../test/persistence/setup.ts';
import type { UnitOfWork } from '../../ports/persistence/index.ts';
import { TemplateService } from './template-service.ts';

let dirs: SitePackDirs;
let db: TestDb;
afterEach(async () => {
  removeDirs(dirs);
  await db.close();
});

describe('first use inside the template transaction (review #83 C-L9)', () => {
  it('a template write that fails leaves the pack unapproved', async () => {
    dirs = makeDirs();
    writePack(dirs.bundled, sitePack('site-a.test', 1));
    db = await openMemory();
    const ids = new FakeIdGenerator();
    const logger = new CollectingLogger();
    const registry = createDirRegistry(dirs, {
      uow: db.uow,
      repos: db.repos,
      ids,
      clock: db.clock,
    });
    await registry.reload();
    let fail = true;
    // The template's transaction fails after every write (a constraint, a full disk).
    const failing: UnitOfWork = {
      transaction: (fn) =>
        db.uow.transaction(async (repos) => {
          const result = await fn(repos);
          if (fail) throw new Error('disk full');
          return result;
        }),
    };
    const service = new TemplateService({
      repos: db.repos,
      uow: failing,
      runtime: new FakeTemplateRuntime(),
      geo: FAKE_TEMPLATE_GEO,
      files: new FakeTemplateFiles(),
      degradations: new RecordingDegradations(),
      ids: { opaque: (n) => 'y'.repeat(n), eventId: () => ids.eventId() },
      clock: db.clock,
      logger,
      packs: registry,
      config: {
        enabled: true,
        authMode: 'off',
        maxPagesPerHost: 40,
        defaults: {
          channel: 'chromium',
          stealth: 'standard',
          fingerprint: false,
          humanize: false,
          agentWindows: 'normal',
        },
      },
    });
    const body = {
      name: 'jobs',
      sites: [{ site_id: 'site-a.test', pack_sha256: packSha(sitePack('site-a.test', 1)) }],
    };
    await expect(service.create(body, 'p-op')).rejects.toThrow('disk full');
    expect(await db.repos.sitePackState.get('site-a.test')).toBeNull();
    expect(registry.get('site-a.test')?.approved).toBeNull();
    fail = false;
    const created = await service.create(body, 'p-op');
    expect(created.sites[0]?.pack_version).toBe(1);
    expect((await db.repos.sitePackState.get('site-a.test'))?.approvedBy).toBe('p-op');
    expect(registry.effectiveFor('site-a.test')?.version).toBe(1);
  });
});
