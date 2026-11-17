/** @module app/site-packs/registry-classify.test — the registry's classification (spec 13 §9.7, §17 T3b "a pending bundled version shows its classification"): candidates classified at load with the change row, the view, the `site_pack.pending` event and the diff; rows from before the classifier classified at load; the `stealth-profile` verdict following template edits; Apply and approve-local refused with `SITE_PACK_BELOW_FLOOR` (T3b lead decision 4). */

import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import {
  createSitePackKit,
  makeDirs,
  packSha,
  removeDirs,
  type SitePackDirs,
  sitePack,
  writePack,
} from '../../../test/helpers/site-pack-kit.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';

let dirs: SitePackDirs;
afterEach(() => removeDirs(dirs));

const STEALTH_MAX = {
  strategies: [{ id: 'stealth-profile' as const, params: { min_level: 'max' } }],
};

/**
 * Release 1 bundles `site-a.test` v1 (approved, used by template `job-hunt` with `stealth`), then
 * release 2 bundles v2 = `extra` on the same state.
 */
async function upgraded(
  extra: Partial<SitePackV1Input>,
  template: { stealth?: 'off' | 'standard' | 'max'; siteEnabled?: boolean } = {},
) {
  dirs = makeDirs();
  writePack(dirs.bundled, sitePack('site-a.test', 1));
  const first = createSitePackKit({ dirs });
  await first.registry.reload();
  await first.registry.approveSite('site-a.test', packSha(sitePack('site-a.test', 1)), 'p-op');
  await first.repos.templates.insert(templateRecord({ stealth: template.stealth ?? 'standard' }));
  await first.repos.templateSites.upsert(
    templateSiteRecord({
      packId: 'site-a.test',
      packVersion: 1,
      enabled: template.siteEnabled ?? true,
    }),
  );
  const release2 = join(dirs.root, 'release-2');
  writePack(release2, sitePack('site-a.test', 2, extra));
  const kit = createSitePackKit({
    dirs,
    repos: first.repos,
    actions: first.actions,
    ids: first.ids,
    bundledDir: release2,
  });
  await kit.registry.reload();
  return kit;
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('a pending bundled version shows its classification', () => {
  it('a guard removed: loosening in the row, the view, pending(), the event and the diff', async () => {
    const { registry, repos, bus } = await upgraded({ guards: [] });
    const [row] = await repos.sitePackChanges.listPending();
    expect(row?.classification).toBe('loosening');
    expect(row?.diff).toContainEqual({
      path: 'guards[logout]',
      from: {
        id: 'logout',
        kind: 'logout',
        match: { url: 'www.site-a.test/logout' },
        action: 'block',
      },
      to: null,
      class: 'loosening',
    });
    expect(registry.get('site-a.test')?.pending[0]?.classification).toBe('loosening');
    expect(registry.pending()[0]).toMatchObject({ kind: 'candidate', classification: 'loosening' });
    const event = bus.published.find((e) => e.name === 'site_pack.pending');
    expect(event?.payload).toMatchObject({ to_version: 2, classification: 'loosening' });
    const diff = await registry.diff('site-a.test', { to: 2 });
    expect(diff.classification).toBe('loosening');
    expect(diff.changes.map((c) => c.class)).toEqual(['loosening']);
  });

  it('a challenge added is tightening; a headed requirement is restrictive', async () => {
    const tight = await upgraded({
      challenges: [
        {
          id: 'wall',
          kind: 'captcha',
          match: { url: 'www.site-a.test/wall' },
          action: 'attention',
        },
      ],
    });
    expect(tight.registry.get('site-a.test')?.pending[0]?.classification).toBe('tightening');
    removeDirs(dirs);
    const headed = await upgraded({ browser: { headed: 'required' } });
    expect(headed.registry.get('site-a.test')?.pending[0]?.classification).toBe('restrictive');
  });

  it('the update notification line names the classification', async () => {
    const { bus } = await upgraded({ guards: [] });
    const last = bus.published.filter((e) => e.name === 'site_pack.status').at(-1);
    const payload = last?.payload as { updates?: { items: { classification?: unknown }[] } };
    expect(payload.updates?.items[0]?.classification).toBe('loosening');
  });

  it('a row written before the classifier is classified at the next load', async () => {
    const kit = await upgraded({ guards: [] });
    const [row] = await kit.repos.sitePackChanges.listPending();
    if (row === undefined) throw new Error('no pending row');
    await kit.repos.sitePackChanges.classify(
      row.eventId,
      'unclassified',
      row.diff?.map((c) => ({ ...c, class: null })) ?? null,
    );
    await kit.registry.reload();
    const [after] = await kit.repos.sitePackChanges.listPending();
    expect(after?.classification).toBe('loosening');
    expect(after?.diff?.every((c) => c.class === 'loosening')).toBe(true);
    expect(kit.registry.get('site-a.test')?.pending[0]?.classification).toBe('loosening');
  });
});

describe('the stealth floor and the templates using the pack', () => {
  it('a floor above a using template is restrictive and Apply is refused with SITE_PACK_BELOW_FLOOR', async () => {
    const { registry } = await upgraded(STEALTH_MAX);
    expect(registry.get('site-a.test')?.pending[0]?.classification).toBe('restrictive');
    const error = await errorOf(registry.apply('site-a.test', 2, 'p-op'));
    expect(error.code).toBe('SITE_PACK_BELOW_FLOOR');
    expect(error.details).toMatchObject({
      pack_id: 'site-a.test',
      version: 2,
      templates: [
        {
          template_id: 'tp-fixture001',
          name: 'job-hunt',
          issues: [{ code: 'stealth_below_floor' }],
        },
      ],
    });
    expect(error.publicMessage).toContain("'job-hunt' needs stealth 'max' or higher");
    expect(registry.effectiveFor('site-a.test')?.version).toBe(1);
  });

  it('after the template meets the floor the verdict follows (refreshUsage) and Apply succeeds', async () => {
    const { registry, repos } = await upgraded(STEALTH_MAX);
    await repos.templates.update('tp-fixture001', { stealth: 'max' });
    await registry.refreshUsage();
    expect(registry.get('site-a.test')?.pending[0]?.classification).toBe('tightening');
    await registry.apply('site-a.test', 2, 'p-op');
    expect(registry.effectiveFor('site-a.test')?.version).toBe(2);
  });

  it('a disabled site is out of the floor: tightening, and Apply succeeds', async () => {
    const { registry } = await upgraded(STEALTH_MAX, { siteEnabled: false });
    expect(registry.get('site-a.test')?.pending[0]?.classification).toBe('tightening');
    expect((await registry.apply('site-a.test', 2, 'p-op')).approved?.version).toBe(2);
  });

  it('approve-local is refused below the floor too', async () => {
    const kit = await upgraded({});
    writePack(kit.dirs.local, sitePack('site-a.test', 7, { title: 'Local A', ...STEALTH_MAX }));
    await kit.registry.reload();
    const diff = await kit.registry.diff('site-a.test', { to: 'local' });
    expect(diff.classification).toBe('restrictive');
    const sha = packSha(sitePack('site-a.test', 7, { title: 'Local A', ...STEALTH_MAX }));
    expect((await errorOf(kit.registry.approveLocal('site-a.test', sha, 'p-op'))).code).toBe(
      'SITE_PACK_BELOW_FLOOR',
    );
  });
});
