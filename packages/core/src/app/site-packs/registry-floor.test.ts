/** @module app/site-packs/registry-floor.test — D-71 on every path that changes the content in force (review #84 surfaces M1, runtime M3): Revert is refused with `SITE_PACK_BELOW_FLOOR` like Apply; deleting an approved local file turns the site off on templates below the floor now in force (audit row, `TEMPLATE_SITE_BELOW_FLOOR`, `template.changed`) and the record resolves once no turned-off site is below a floor; a revocation's fallback above a template's floor is never applied by itself, and one that is applied leaves every template at or above its floor. */

import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { createMemorySitePacks } from '../../../test/helpers/in-memory-site-packs.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import {
  createSitePackKit,
  makeDirs,
  packSha,
  removeDirs,
  type SitePackDirs,
  sitePack,
  writePack,
} from '../../../test/helpers/site-pack-kit.ts';
import { RecordingDegradations } from '../../../test/helpers/template-kit.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { packFloorIssues } from '../../domain/site-packs/stealth-floor.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { SITE_BELOW_FLOOR } from './registry-floor.ts';

let dirs: SitePackDirs | undefined;
afterEach(() => {
  if (dirs !== undefined) removeDirs(dirs);
  dirs = undefined;
});

const SITE = 'site-a.test';
const SECOND = 'tp-second0001';
const floor = (min_level: 'standard' | 'max'): Partial<SitePackV1Input> => ({
  strategies: [{ id: 'stealth-profile', params: { min_level } }],
});

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('Revert checks the stealth floor like Apply', () => {
  /**
   * v1 (floor max) approved for a `max` template; release 2's v2 drops the floor and is applied;
   * a second template with stealth `standard` then adds the site, which v2 allows.
   */
  async function revertSetup() {
    dirs = makeDirs();
    writePack(dirs.bundled, sitePack(SITE, 1, floor('max')));
    const first = createSitePackKit({ dirs });
    await first.registry.reload();
    await first.registry.approveSite(SITE, packSha(sitePack(SITE, 1, floor('max'))), 'p-op');
    await first.repos.templates.insert(templateRecord({ stealth: 'max' }));
    await first.repos.templateSites.upsert(templateSiteRecord({ packId: SITE, packVersion: 1 }));
    const release2 = join(dirs.root, 'release-2');
    writePack(release2, sitePack(SITE, 2));
    const kit = createSitePackKit({
      dirs,
      repos: first.repos,
      actions: first.actions,
      ids: first.ids,
      bundledDir: release2,
    });
    await kit.registry.reload();
    await kit.registry.apply(SITE, 2, 'p-op');
    await kit.repos.templates.insert(
      templateRecord({ templateId: SECOND, name: 'second', stealth: 'standard' }),
    );
    await kit.repos.templateSites.upsert(
      templateSiteRecord({ templateId: SECOND, packId: SITE, packVersion: 2 }),
    );
    await kit.registry.refreshUsage();
    return kit;
  }

  it('a template added under the newer version below the previous floor refuses Revert', async () => {
    const kit = await revertSetup();
    const error = await errorOf(kit.registry.revert(SITE, 'p-op'));
    expect(error.code).toBe('SITE_PACK_BELOW_FLOOR');
    expect(error.details).toMatchObject({
      pack_id: SITE,
      version: 1,
      templates: [
        { template_id: SECOND, name: 'second', issues: [{ code: 'stealth_below_floor' }] },
      ],
    });
    // Nothing changed: v2 stays in force, no revert row, the site stays on.
    expect(kit.registry.effectiveFor(SITE)?.version).toBe(2);
    expect(kit.repos.sitePackChanges.rows.some((r) => r.decision === 'reverted')).toBe(false);
    expect((await kit.repos.templateSites.list(SECOND))[0]?.enabled).toBe(true);
  });

  it('the runtime PoC: a template lowered under v2 refuses Revert to the v1 floor', async () => {
    dirs = makeDirs();
    writePack(dirs.bundled, sitePack(SITE, 1, floor('max')));
    const first = createSitePackKit({ dirs });
    await first.registry.reload();
    await first.registry.approveSite(SITE, packSha(sitePack(SITE, 1, floor('max'))), 'p-op');
    await first.repos.templates.insert(templateRecord({ stealth: 'max' }));
    await first.repos.templateSites.upsert(templateSiteRecord({ packId: SITE, packVersion: 1 }));
    const release2 = join(dirs.root, 'release-2');
    writePack(release2, sitePack(SITE, 2));
    const kit = createSitePackKit({
      dirs,
      repos: first.repos,
      actions: first.actions,
      ids: first.ids,
      bundledDir: release2,
    });
    await kit.registry.reload();
    await kit.registry.apply(SITE, 2, 'p-op');
    await kit.repos.templates.update('tp-fixture001', { stealth: 'standard' });
    await kit.registry.refreshUsage();
    expect((await errorOf(kit.registry.revert(SITE, 'p-op'))).code).toBe('SITE_PACK_BELOW_FLOOR');
    expect(kit.registry.effectiveFor(SITE)?.version).toBe(2);
  });

  it('the diff to the previous version classifies what Revert would do (review #84 L4)', async () => {
    const kit = await revertSetup();
    const diff = await kit.registry.diff(SITE, { to: 1 });
    expect(diff.from?.version).toBe(2);
    expect(diff.to.version).toBe(1);
    // v1's floor is above the `standard` template that added the site under v2.
    expect(diff.classification).toBe('restrictive');
  });

  it('once the site is off on that template, Revert succeeds', async () => {
    const kit = await revertSetup();
    const [site] = await kit.repos.templateSites.list(SECOND);
    if (site === undefined) throw new Error('no site');
    await kit.repos.templateSites.upsert({ ...site, enabled: false });
    await kit.registry.refreshUsage();
    expect((await kit.registry.revert(SITE, 'p-op')).approved?.version).toBe(1);
  });
});

describe('a deleted local file ends the override without an Apply', () => {
  /**
   * The bundled v1 (floor max) is approved for a `max` template; a local file without a floor is
   * approved; a `standard` template adds the site under it. Then the file is deleted.
   */
  async function localSetup() {
    dirs = makeDirs();
    const degradations = new RecordingDegradations();
    writePack(dirs.bundled, sitePack(SITE, 1, floor('max')));
    const kit = createSitePackKit({ dirs, degradations });
    await kit.registry.reload();
    await kit.registry.approveSite(SITE, packSha(sitePack(SITE, 1, floor('max'))), 'p-op');
    await kit.repos.templates.insert(templateRecord({ stealth: 'max' }));
    await kit.repos.templateSites.upsert(templateSiteRecord({ packId: SITE, packVersion: 1 }));
    const local = sitePack(SITE, 7, { title: 'Local A' });
    writePack(dirs.local, local);
    await kit.registry.reload();
    await kit.registry.approveLocal(SITE, packSha(local), 'p-op');
    expect(kit.registry.effectiveFor(SITE)?.localOverride).toBe(true);
    await kit.repos.templates.insert(
      templateRecord({ templateId: SECOND, name: 'second', stealth: 'standard' }),
    );
    await kit.repos.templateSites.upsert(
      templateSiteRecord({ templateId: SECOND, packId: SITE, packVersion: 7 }),
    );
    await kit.registry.refreshUsage();
    expect(degradations.reports).toEqual([]);
    rmSync(join(dirs.local, `${SITE}.json`));
    await kit.registry.reload();
    return { ...kit, degradations };
  }

  it('turns the site off on the template below the floor now in force, and only there', async () => {
    const kit = await localSetup();
    const effective = kit.registry.effectiveFor(SITE);
    expect(effective).toMatchObject({ version: 1, localOverride: false });
    expect((await kit.repos.templateSites.list(SECOND))[0]?.enabled).toBe(false);
    expect((await kit.repos.templateSites.list('tp-fixture001'))[0]?.enabled).toBe(true);
    // D-71 holds: no enabled site is below the floor of the content in force.
    for (const site of await kit.repos.templateSites.listAll()) {
      const template = await kit.repos.templates.get(site.templateId);
      if (!site.enabled || template === null || effective === null) continue;
      expect(packFloorIssues(template, effective.pack)).toEqual([]);
    }
    expect(kit.templatesChanged).toContain(SECOND);
    expect(kit.registry.get(SITE)?.used_by).toContain(SECOND);
  });

  it('writes an audit row by browserhive and reports TEMPLATE_SITE_BELOW_FLOOR naming the template', async () => {
    const kit = await localSetup();
    const row = kit.actions.rows.find(
      (r) => r.resourceId === SECOND && r.action === 'template.update',
    );
    expect(row).toMatchObject({
      principalId: 'browserhive',
      resourceKind: 'template',
      details: {
        changed: [`sites.${SITE}`],
        site: { site_id: SITE, enabled: false, pack_id: SITE },
        reason: 'below_pack_floor',
        why: 'local_override_ended',
        pack_version: 1,
      },
    });
    expect(kit.degradations.reports).toHaveLength(1);
    const [report] = kit.degradations.reports;
    expect(report).toMatchObject({
      code: SITE_BELOW_FLOOR,
      severity: 'error',
      details: {
        pack_id: SITE,
        version: 1,
        reason: 'local_override_ended',
        template_ids: [SECOND],
        templates: [{ template_id: SECOND, name: 'second', site_ids: [SITE] }],
      },
    });
    expect(report?.message).toContain("'second' needs stealth 'max' or higher");
    expect(report?.message).toContain('turned the site off');
  });

  it('a second reload neither reports again nor recovers while the site stays off below the floor', async () => {
    const kit = await localSetup();
    const before = kit.degradations.recoveries.length;
    await kit.registry.reload();
    await kit.registry.refreshUsage();
    expect(kit.degradations.reports).toHaveLength(1);
    expect(kit.degradations.recoveries.slice(before)).not.toContain(SITE_BELOW_FLOOR);
  });

  it('resolves once the turned-off site is removed', async () => {
    const kit = await localSetup();
    const before = kit.degradations.recoveries.length;
    await kit.repos.templateSites.remove(SECOND, SITE);
    await kit.registry.refreshUsage();
    expect(kit.degradations.recoveries.slice(before)).toContain(SITE_BELOW_FLOOR);
  });
});

describe('a revocation fallback and the floor', () => {
  const PACK = 'pack-a.test';

  /** v1 (`v1Extra`) approved, v2 (`v2Extra`) applied, then a `standard` template adds the site. */
  async function revocable(v1Extra: Partial<SitePackV1Input>, v2Extra: Partial<SitePackV1Input>) {
    const repos = new InMemoryRepositories();
    const actions = new InMemoryOperatorActionRepository();
    const degradations = new RecordingDegradations();
    const { registry, bundled } = await createMemorySitePacks({
      repos: { ...repos, operatorActions: actions },
      clock: new FakeClock(),
      ids: new FakeIdGenerator(),
      logger: createCollectingLogger(),
      degradations,
    });
    bundled.put(sitePack(PACK, 1, v1Extra));
    await registry.reload();
    await registry.approveSite(PACK, packSha(sitePack(PACK, 1, v1Extra)), 'p-op');
    bundled.put(sitePack(PACK, 2, v2Extra));
    await registry.reload();
    await registry.apply(PACK, 2, 'p-op');
    await repos.templates.insert(templateRecord({ stealth: 'standard' }));
    await repos.templateSites.upsert(
      templateSiteRecord({ siteId: PACK, packId: PACK, packVersion: 2 }),
    );
    await registry.refreshUsage();
    return { registry, repos, degradations };
  }

  it('a fallback whose floor is above a using template is restrictive and is not applied', async () => {
    const { registry, repos, degradations } = await revocable(floor('max'), {});
    const result = await registry.revoke(PACK, 2, 'browserhive');
    expect(result).toMatchObject({ outcome: 'decision_opened', classification: 'restrictive' });
    expect(registry.effectiveFor(PACK)?.version).toBe(2);
    expect((await repos.templateSites.listAll())[0]?.enabled).toBe(true);
    expect(degradations.reports).toEqual([]);
  });

  it('an applied fallback leaves every using template at or above its floor', async () => {
    // v2 relaxed the write policy (going back tightens); v1's floor is the template's own level.
    const { registry, repos, degradations } = await revocable(floor('standard'), {
      write_policy: {
        default: 'warn',
        stance: 'prohibited',
        exception: 'Writes are only reported while the owner checks them.',
      },
      ...floor('standard'),
    });
    const result = await registry.revoke(PACK, 2, 'browserhive');
    expect(result).toMatchObject({ outcome: 'fallback_applied', classification: 'tightening' });
    const effective = registry.effectiveFor(PACK);
    expect(effective?.version).toBe(1);
    const [site] = await repos.templateSites.listAll();
    const template = await repos.templates.get('tp-fixture001');
    if (effective === null || template === null) throw new Error('missing');
    expect(site?.enabled).toBe(true);
    expect(packFloorIssues(template, effective.pack)).toEqual([]);
    expect(degradations.reports).toEqual([]);
  });
});
