/** @module app/site-packs/registry-local.test — unsigned local files (spec 13 §10.5, §17 T3a): inactive until approved per SHA-256, an edited file "changed since approval" while BrowserHive's copy keeps applying, `approve-local` with a stale hash refused, the override's precedence and audit, signed layouts skipped, invalid files reported, imports. */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { isAppError } from '../../kernel/errors/app-error.ts';

let dirs: SitePackDirs;
afterEach(() => removeDirs(dirs));

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('resolved');
}

async function withLocal(bundled = false) {
  dirs = makeDirs();
  if (bundled) writePack(dirs.bundled, sitePack('site-a.test', 1));
  writePack(dirs.local, sitePack('site-a.test', 7, { title: 'Local A' }));
  const kit = createSitePackKit({ dirs });
  await kit.registry.reload();
  return kit;
}

describe('local files', () => {
  it('a file never approved applies nothing', async () => {
    const { registry } = await withLocal();
    expect(registry.effectiveFor('site-a.test')).toBeNull();
    const view = registry.get('site-a.test');
    expect(view?.local).toMatchObject({
      state: 'not_approved',
      sha256: packSha(sitePack('site-a.test', 7, { title: 'Local A' })),
      approved_sha256: null,
      problem: null,
    });
    expect(view?.offer).toBeNull();
    expect(registry.list().local_needing_approval).toBe(1);
    expect(registry.pending()).toMatchObject([{ kind: 'local', state: 'not_approved' }]);
  });

  it('applies once approved by its hash; a stale hash is refused', async () => {
    const { registry, actions } = await withLocal();
    const local = sitePack('site-a.test', 7, { title: 'Local A' });
    expect((await errorOf(registry.approveLocal('site-a.test', 'a'.repeat(64), 'p-op'))).code).toBe(
      'CONFLICT',
    );
    const view = await registry.approveLocal('site-a.test', packSha(local), 'p-op');
    expect(view.local?.state).toBe('approved');
    expect(view.approved).toMatchObject({ version: 7, source: 'local', by: 'p-op' });
    expect(registry.effectiveFor('www.site-a.test')).toMatchObject({
      version: 7,
      source: 'local',
      localOverride: true,
    });
    expect(actions.rows.map((r) => [r.action, r.details?.['sha256']])).toEqual([
      ['site_pack.approve_local', packSha(local)],
    ]);
  });

  it('an edited file is changed since approval while the approved copy keeps applying', async () => {
    const { registry } = await withLocal();
    const first = sitePack('site-a.test', 7, { title: 'Local A' });
    await registry.approveLocal('site-a.test', packSha(first), 'p-op');
    const edited = sitePack('site-a.test', 8, { title: 'Local A edited' });
    writePack(dirs.local, edited);
    await registry.reload();
    const view = registry.get('site-a.test');
    expect(view?.local).toMatchObject({
      state: 'changed',
      sha256: packSha(edited),
      approved_sha256: packSha(first),
    });
    expect(registry.effectiveFor('site-a.test')).toMatchObject({
      version: 7,
      sha256: packSha(first),
    });
    const diff = await registry.diff('site-a.test', { to: 'local' });
    expect(diff.from?.sha256).toBe(packSha(first));
    expect(diff.changes).toContainEqual({
      path: 'title',
      from: 'Local A',
      to: 'Local A edited',
      class: null,
    });
    // The hash shown before the edit no longer approves anything.
    expect((await errorOf(registry.approveLocal('site-a.test', packSha(first), 'p-op'))).code).toBe(
      'CONFLICT',
    );
    await registry.approveLocal('site-a.test', packSha(edited), 'p-op');
    expect(registry.effectiveFor('site-a.test')?.version).toBe(8);
  });

  it('approved local content overrides the approved bundled version, audited on load', async () => {
    const { registry, actions, repos, ids } = await withLocal(true);
    await registry.approveSite('site-a.test', undefined, 'p-op');
    expect(registry.effectiveFor('site-a.test')?.source).toBe('bundled');
    const local = sitePack('site-a.test', 7, { title: 'Local A' });
    await registry.approveLocal('site-a.test', packSha(local), 'p-op');
    expect(registry.get('site-a.test')?.local_override).toBe(true);
    expect(registry.get('site-a.test')?.approved?.version).toBe(1);
    expect(registry.effectiveFor('site-a.test')?.version).toBe(7);
    await registry.reload();
    const overrides = () => actions.rows.filter((r) => r.action === 'site_pack.local_override');
    expect(overrides()).toHaveLength(0);
    // The next boot loads the override: one row; another load of the same content none.
    const booted = createSitePackKit({ dirs, repos, actions, ids });
    await booted.registry.reload();
    expect(overrides()).toHaveLength(1);
    await booted.registry.reload();
    expect(overrides()).toHaveLength(1);
    // Deleting the file ends the override; the bundled approval applies again.
    rmSync(join(dirs.local, 'site-a.test.json'));
    await registry.reload();
    expect(registry.effectiveFor('site-a.test')?.version).toBe(1);
  });

  it('an invalid file is reported and cannot be approved', async () => {
    dirs = makeDirs();
    mkdirSync(dirs.local, { recursive: true });
    writeFileSync(join(dirs.local, 'site-a.test.json'), '{"schema": 1, "id": "site-a.test"}');
    const { registry } = createSitePackKit({ dirs });
    await registry.reload();
    expect(registry.get('site-a.test')?.local?.problem).toContain('version');
    expect(registry.status().skipped.map((s) => [s.pack_id, s.reason])).toContainEqual([
      'site-a.test',
      'invalid',
    ]);
    const error = await errorOf(registry.approveLocal('site-a.test', 'a'.repeat(64), 'p-op'));
    expect(error.code).toBe('SITE_PACK_INVALID');
  });

  it('counts and skips signed layouts', async () => {
    dirs = makeDirs();
    mkdirSync(join(dirs.local, 'packs'), { recursive: true });
    writeFileSync(join(dirs.local, 'keys.json'), '{}');
    mkdirSync(join(dirs.local, 'another-layout'));
    const { registry } = createSitePackKit({ dirs });
    await registry.reload();
    expect(registry.status().local.signed_layouts).toBe(2);
    expect(
      registry.status().skipped.filter((s) => s.reason === 'signed_layout_unsupported'),
    ).toHaveLength(2);
  });

  it('imports an unsigned pack into the local folder, needing approval', async () => {
    dirs = makeDirs();
    const { registry, actions } = createSitePackKit({ dirs });
    await registry.reload();
    const pack = sitePack('site-b.test', 2);
    const result = await registry.importPack(pack, 'p-op');
    expect(result.imported).toEqual([
      { pack_id: 'site-b.test', version: 2, state: 'not_approved', sha256: packSha(pack) },
    ]);
    expect(registry.effectiveFor('site-b.test')).toBeNull();
    expect(actions.rows.map((r) => r.action)).toEqual(['site_pack.import']);
    const bad = await errorOf(registry.importPack({ schema: 1 }, 'p-op'));
    expect(bad.code).toBe('SITE_PACK_INVALID');
    expect(bad.details).toMatchObject({ source: 'import' });
  });
});
