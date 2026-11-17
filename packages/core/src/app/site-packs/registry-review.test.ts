/** @module app/site-packs/registry-review.test — regressions of the PR #83 review: a pack never takes another pack's domains (C-M1, S-M1: approve-local, import and Apply refused naming the owner; an overlap left in stored state keeps the owner's domains and the newcomer's others), one unreadable row affects only its pack (C-M5), and the errors with their own codes (S-L5). */

import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
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
import { isAppError } from '../../kernel/errors/app-error.ts';
import { emptySitePackState } from '../../ports/persistence/site-packs.ts';

let dirs: SitePackDirs;
afterEach(() => removeDirs(dirs));

/** `site-a.test` covering `site-b.test` too (like linkedin.com and licdn.com). */
const A = sitePack('site-a.test', 1, { domains: ['site-a.test', 'site-b.test'] });
/** The reviewer's local pack: another id claiming `site-b.test`, with no guards. */
const AAA = sitePack('aaa.test', 1, { domains: ['aaa.test', 'site-b.test'], guards: [] });

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('resolved');
}

async function approvedA() {
  dirs = makeDirs();
  writePack(dirs.bundled, A);
  const kit = createSitePackKit({ dirs });
  await kit.registry.reload();
  await kit.registry.approveSite('site-a.test', packSha(A), 'p-op');
  return kit;
}

describe('domain ownership (review #83 C-M1, S-M1)', () => {
  it("approving a local pack that claims another pack's domain is refused, naming it", async () => {
    const { registry } = await approvedA();
    writePack(dirs.local, AAA);
    await registry.reload();
    const error = await errorOf(registry.approveLocal('aaa.test', packSha(AAA), 'p-op'));
    expect(error.code).toBe('SITE_PACK_DOMAIN_TAKEN');
    expect(error.details).toEqual({
      pack_id: 'aaa.test',
      domain: 'site-b.test',
      owner: 'site-a.test',
    });
    expect(registry.effectiveFor('www.site-a.test')?.packId).toBe('site-a.test');
    expect(registry.effectiveFor('cdn.site-b.test')?.packId).toBe('site-a.test');
    expect(registry.get('aaa.test')?.local?.state).toBe('not_approved');
  });

  it('importing such a pack is refused before anything is written', async () => {
    const { registry } = await approvedA();
    const error = await errorOf(registry.importPack(AAA, 'p-op'));
    expect(error.code).toBe('SITE_PACK_DOMAIN_TAKEN');
    expect(registry.get('aaa.test')).toBeNull();
  });

  it('applying a newer version that takes another pack’s domain is refused', async () => {
    const { registry, repos, actions, ids } = await approvedA();
    writePack(dirs.bundled, sitePack('site-c.test', 1));
    await registry.reload();
    await registry.approveSite('site-c.test', packSha(sitePack('site-c.test', 1)), 'p-op');
    const release2 = join(dirs.root, 'release-2');
    writePack(release2, A);
    writePack(release2, sitePack('site-c.test', 2, { domains: ['site-c.test', 'site-b.test'] }));
    const next = createSitePackKit({ dirs, repos, actions, ids, bundledDir: release2 });
    await next.registry.reload();
    const error = await errorOf(next.registry.apply('site-c.test', 2, 'p-op'));
    expect(error.code).toBe('SITE_PACK_DOMAIN_TAKEN');
    expect(next.registry.effectiveFor('site-b.test')?.packId).toBe('site-a.test');
  });

  it('an overlap already in the stored state never disables the owner or the newcomer’s other domains', async () => {
    const { registry, repos } = await approvedA();
    writePack(dirs.local, AAA);
    // As if an older build had approved it: the state says approved, the file is unchanged.
    await repos.sitePackState.put({
      ...emptySitePackState('aaa.test', 1),
      localApprovedSha256: packSha(AAA),
      localApprovedAt: Number.MAX_SAFE_INTEGER - 1,
    });
    await registry.reload();
    expect(registry.effectiveFor('site-a.test')?.packId).toBe('site-a.test');
    expect(registry.effectiveFor('site-b.test')?.packId).toBe('site-a.test');
    expect(registry.effectiveFor('aaa.test')?.packId).toBe('aaa.test');
    expect(registry.get('aaa.test')?.skipped).toMatchObject({
      reason: 'domain_overlap',
      detail: expect.stringContaining('site-a.test'),
    });
  });
});

describe('unreadable rows (review #83 C-M5)', () => {
  it('a corrupt state row affects only its pack and is reported', async () => {
    dirs = makeDirs();
    writePack(dirs.bundled, sitePack('site-a.test', 1));
    writePack(dirs.bundled, sitePack('site-c.test', 1));
    const degradations = new RecordingDegradations();
    const kit = createSitePackKit({ dirs, degradations });
    await kit.registry.reload();
    await kit.registry.approveSite('site-a.test', packSha(sitePack('site-a.test', 1)), 'p-op');
    await kit.registry.approveSite('site-c.test', packSha(sitePack('site-c.test', 1)), 'p-op');
    kit.repos.sitePackState.corrupt.add('site-a.test');
    await kit.registry.reload();
    expect(kit.registry.effectiveFor('site-c.test')?.version).toBe(1);
    expect(kit.registry.effectiveFor('site-a.test')).toBeNull();
    expect(kit.registry.get('site-a.test')?.skipped?.reason).toBe('unreadable');
    expect(degradations.reports.map((d) => [d.code, d.details?.['pack_id']])).toEqual([
      ['SITE_PACKS_STATE_CORRUPT', 'site-a.test'],
    ]);
    kit.repos.sitePackState.corrupt.clear();
    await kit.registry.reload();
    expect(kit.registry.effectiveFor('site-a.test')?.version).toBe(1);
    expect(degradations.recoveries).toContain('SITE_PACKS_STATE_CORRUPT');
  });

  it('a corrupt pending row hides only that pack’s update', async () => {
    dirs = makeDirs();
    writePack(dirs.bundled, sitePack('site-a.test', 1));
    const degradations = new RecordingDegradations();
    const kit = createSitePackKit({ dirs, degradations });
    await kit.registry.reload();
    await kit.registry.approveSite('site-a.test', packSha(sitePack('site-a.test', 1)), 'p-op');
    writePack(dirs.bundled, sitePack('site-a.test', 2));
    await kit.registry.reload();
    expect(kit.registry.get('site-a.test')?.pending).toHaveLength(1);
    kit.repos.sitePackChanges.corrupt.add('site-a.test');
    await kit.registry.reload();
    expect(kit.registry.effectiveFor('site-a.test')?.version).toBe(1);
    expect(kit.registry.get('site-a.test')?.pending).toEqual([]);
    expect(degradations.reports[0]?.details?.['table']).toBe('site_pack_changes');
  });
});

describe('specific refusals (review #83 S-L5)', () => {
  it('approve-local without a local file is SITE_PACK_NO_LOCAL_FILE (404)', async () => {
    const { registry } = await approvedA();
    const error = await errorOf(registry.approveLocal('site-a.test', 'a'.repeat(64), 'p-op'));
    expect([error.code, error.httpStatus]).toEqual(['SITE_PACK_NO_LOCAL_FILE', 404]);
  });

  it('revert with nothing to revert to is SITE_PACK_NO_PREVIOUS (409)', async () => {
    const { registry } = await approvedA();
    const error = await errorOf(registry.revert('site-a.test', 'p-op'));
    expect([error.code, error.httpStatus]).toEqual(['SITE_PACK_NO_PREVIOUS', 409]);
  });
});
