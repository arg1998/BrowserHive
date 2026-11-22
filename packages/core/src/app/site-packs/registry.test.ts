/** @module app/site-packs/registry.test — the approval state machine (spec 13 §9.6, §10.5, §10.6, §17 T3a): approval on first use with provenance, a newer bundled release pending until Apply, Reject, Revert, Pin, Follow defaults, precedence and overlaps, `sitePacks=false`. Local files are in `registry-local.test.ts`. */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSitePackKit,
  KIT_RELEASE,
  makeDirs,
  packSha,
  removeDirs,
  type SitePackDirs,
  sitePack,
  writePack,
} from '../../../test/helpers/site-pack-kit.ts';
import { templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';

let dirs: SitePackDirs;
afterEach(() => removeDirs(dirs));

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return isAppError(error) ? error.code : String(error);
  }
}

/** A registry whose bundled folder ships `site-a.test` v1, loaded. */
async function loaded(options: { enabled?: boolean } = {}) {
  dirs = makeDirs();
  writePack(dirs.bundled, sitePack('site-a.test', 1));
  const kit = createSitePackKit({ dirs, ...options });
  await kit.registry.reload();
  return kit;
}

describe('approval on first use', () => {
  it('offers the bundled version and applies nothing before approval', async () => {
    const { registry } = await loaded();
    expect(registry.effectiveFor('www.site-a.test')).toBeNull();
    const view = registry.get('site-a.test');
    expect(view?.approved).toBeNull();
    expect(view?.offer).toEqual({
      version: 1,
      sha256: packSha(sitePack('site-a.test', 1)),
      source: 'bundled',
      provenance: { kind: 'bundled', release: KIT_RELEASE },
    });
    expect(registry.packIdFor('site-a.test')).toBe('site-a.test');
  });

  it('approves the offer with its provenance, a change row, an audit row and a cached copy', async () => {
    const { registry, repos, actions } = await loaded();
    const sha = packSha(sitePack('site-a.test', 1));
    const before = registry.generation;
    const approval = await registry.approveSite('www.site-a.test', sha, 'p-op');
    expect(approval).toEqual({ packId: 'site-a.test', version: 1, sha256: sha });
    expect(registry.generation).toBeGreaterThan(before);
    expect(registry.effectiveFor('login.site-a.test')).toMatchObject({
      packId: 'site-a.test',
      version: 1,
      sha256: sha,
      source: 'bundled',
      localOverride: false,
    });
    const state = await repos.sitePackState.get('site-a.test');
    expect(state).toMatchObject({
      approvedVersion: 1,
      approvedSha256: sha,
      approvedSource: 'bundled',
      approvedProvenance: { kind: 'bundled', release: KIT_RELEASE },
      approvedDomains: ['site-a.test'],
      approvedBy: 'p-op',
    });
    const rows = [...repos.sitePackChanges.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'approved', classification: 'new_pack' });
    expect(actions.rows.map((r) => [r.action, r.details?.['provenance']])).toEqual([
      ['site_pack.approve', { kind: 'bundled', release: KIT_RELEASE }],
    ]);
    expect(existsSync(join(dirs.cache, 'bundled', 'site-a.test', `${sha}.json`))).toBe(true);
    expect(registry.get('site-a.test')?.offer).toBeNull();
  });

  it('refuses a reviewed hash that is not the offer, and keeps an approved version', async () => {
    const { registry, actions } = await loaded();
    expect(await codeOf(registry.approveSite('site-a.test', 'f'.repeat(64), 'p-op'))).toBe(
      'CONFLICT',
    );
    await registry.approveSite('site-a.test', packSha(sitePack('site-a.test', 1)), 'p-op');
    const again = await registry.approveSite('site-a.test', undefined, 'p-other');
    expect(again?.version).toBe(1);
    expect(actions.rows.filter((r) => r.action === 'site_pack.approve')).toHaveLength(1);
    expect(await codeOf(registry.approveSite('site-a.test', 'f'.repeat(64), 'p-op'))).toBe(
      'CONFLICT',
    );
  });

  it('without a reviewed hash it refuses and names the offer (review #83 S-M4)', async () => {
    const { registry, repos } = await loaded();
    const error = await registry.approveSite('site-a.test', undefined, 'p-op').catch((e) => e);
    expect(isAppError(error) && error.code).toBe('SITE_PACK_APPROVAL_REQUIRED');
    expect(isAppError(error) && error.details).toEqual({
      site_id: 'site-a.test',
      pack_id: 'site-a.test',
      version: 1,
      sha256: packSha(sitePack('site-a.test', 1)),
      source: 'bundled',
      release: KIT_RELEASE,
    });
    expect(await repos.sitePackState.get('site-a.test')).toBeNull();
  });

  it('leaves a site no pack covers generic, and refuses a hash for it', async () => {
    const { registry } = await loaded();
    expect(await registry.approveSite('site-b.test', undefined, 'p-op')).toBeNull();
    expect(await codeOf(registry.approveSite('site-b.test', 'a'.repeat(64), 'p-op'))).toBe(
      'CONFLICT',
    );
  });

  it('sitePacks=false: nothing applies and nothing is approved', async () => {
    const { registry } = await loaded({ enabled: false });
    expect(await registry.approveSite('site-a.test', undefined, 'p-op')).toBeNull();
    expect(registry.effectiveFor('site-a.test')).toBeNull();
    expect(registry.list().status.enabled).toBe(false);
  });
});

describe('a newer bundled release', () => {
  /** Approves v1 with release 1, then boots release 2 (bundled v2) on the same state. */
  async function upgraded() {
    const first = await loaded();
    await first.registry.approveSite('site-a.test', packSha(sitePack('site-a.test', 1)), 'p-op');
    await first.repos.templateSites.upsert(
      templateSiteRecord({ packId: 'site-a.test', packVersion: 1 }),
    );
    const release2 = join(dirs.root, 'release-2');
    const v2 = sitePack('site-a.test', 2, { title: 'Site A v2' });
    writePack(release2, v2);
    const kit = createSitePackKit({
      dirs,
      repos: first.repos,
      actions: first.actions,
      ids: first.ids,
      bundledDir: release2,
    });
    await kit.registry.reload();
    return { ...kit, v2 };
  }

  it('lists the new version as pending with its diff while the approved one keeps applying', async () => {
    const { registry, repos, bus, v2 } = await upgraded();
    expect(registry.effectiveFor('site-a.test')?.version).toBe(1);
    const view = registry.get('site-a.test');
    expect(view?.pending).toEqual([
      {
        version: 2,
        sha256: packSha(v2),
        state: 'downloaded',
        size: expect.any(Number),
        from: { version: 1, source: 'bundled' },
        refused: null,
        released: null,
        notes: null,
        classification: 'neutral',
        new_domains: [],
        source: 'bundled',
        provenance: { kind: 'bundled', release: KIT_RELEASE },
      },
    ]);
    const pendingRows = await repos.sitePackChanges.listPending();
    expect(pendingRows[0]?.diff).toContainEqual({
      path: 'title',
      from: 'Site site-a.test',
      to: 'Site A v2',
      class: 'neutral',
    });
    expect(bus.published.some((e) => e.name === 'site_pack.pending')).toBe(true);
    // Recorded once: another load inserts nothing.
    await registry.reload();
    expect(await repos.sitePackChanges.listPending()).toHaveLength(1);
    expect(registry.pending()).toEqual([
      {
        kind: 'candidate',
        packId: 'site-a.test',
        title: 'Site site-a.test',
        fromVersion: 1,
        toVersion: 2,
        sha256: packSha(v2),
        source: 'bundled',
        classification: 'neutral',
      },
    ]);
  });

  it('Apply makes it the approved version and moves the sites; Revert restores the old one', async () => {
    const { registry, repos, actions, templatesChanged } = await upgraded();
    const applied = await registry.apply('site-a.test', 2, 'p-op');
    expect(applied.approved?.version).toBe(2);
    expect(applied.previous).toEqual({ version: 1, source: 'bundled' });
    expect(applied.pending).toEqual([]);
    expect(registry.effectiveFor('site-a.test')?.version).toBe(2);
    expect((await repos.templateSites.listAll())[0]?.packVersion).toBe(2);
    expect(templatesChanged.length).toBeGreaterThan(0);
    expect(await codeOf(registry.apply('site-a.test', 2, 'p-op'))).toBe(
      'SITE_PACK_UPDATE_NOT_PENDING',
    );

    const reverted = await registry.revert('site-a.test', 'p-op');
    expect(reverted.approved?.version).toBe(1);
    expect(reverted.previous).toBeNull();
    expect(registry.effectiveFor('site-a.test')?.version).toBe(1);
    expect((await repos.templateSites.listAll())[0]?.packVersion).toBe(1);
    // The reverted version does not come back as pending.
    await registry.reload();
    expect(registry.get('site-a.test')?.pending).toEqual([]);
    expect(await codeOf(registry.revert('site-a.test', 'p-op'))).toBe('SITE_PACK_NO_PREVIOUS');
    expect(actions.rows.map((r) => r.action)).toEqual([
      'site_pack.approve',
      'site_pack.apply',
      'site_pack.revert',
    ]);
  });

  it('Reject dismisses it for good', async () => {
    const { registry } = await upgraded();
    expect(await codeOf(registry.reject('site-a.test', 3, 'p-op'))).toBe(
      'SITE_PACK_UPDATE_NOT_PENDING',
    );
    const view = await registry.reject('site-a.test', 2, 'p-op');
    expect(view.pending).toEqual([]);
    await registry.reload();
    expect(registry.get('site-a.test')?.pending).toEqual([]);
    expect(registry.effectiveFor('site-a.test')?.version).toBe(1);
  });

  it('a still newer release supersedes the older pending version', async () => {
    const { registry, repos, actions, ids } = await upgraded();
    const release3 = join(dirs.root, 'release-3');
    writePack(release3, sitePack('site-a.test', 3));
    const next = createSitePackKit({ dirs, repos, actions, ids, bundledDir: release3 });
    await next.registry.reload();
    expect(next.registry.get('site-a.test')?.pending.map((p) => p.version)).toEqual([3]);
    const decisions = [...repos.sitePackChanges.rows.values()].map((r) => [
      r.toVersion,
      r.decision,
    ]);
    expect(decisions).toContainEqual([2, 'superseded']);
    expect(registry.effectiveFor('site-a.test')?.version).toBe(1);
  });
});

describe('pin, follow, enable', () => {
  it('pins only the approved version', async () => {
    const { registry } = await loaded();
    expect(await codeOf(registry.pin('site-a.test', 1, 'p-op'))).toBe('VALIDATION_FAILED');
    await registry.approveSite('site-a.test', packSha(sitePack('site-a.test', 1)), 'p-op');
    expect(await codeOf(registry.pin('site-a.test', 2, 'p-op'))).toBe('VALIDATION_FAILED');
    expect((await registry.pin('site-a.test', 1, 'p-op')).pinned_version).toBe(1);
    expect((await registry.pin('site-a.test', null, 'p-op')).pinned_version).toBeNull();
  });

  it('follows automatically while a template uses the pack, unless set', async () => {
    const { registry, repos } = await loaded();
    expect(registry.get('site-a.test')?.follow).toEqual({ setting: 'auto', effective: false });
    await repos.templateSites.upsert(templateSiteRecord({ packId: 'site-a.test', packVersion: 1 }));
    await registry.reload();
    expect(registry.get('site-a.test')?.follow).toEqual({ setting: 'auto', effective: true });
    expect(registry.get('site-a.test')?.used_by).toEqual([templateSiteRecord().templateId]);
    expect((await registry.setFollow('site-a.test', false, 'p-op')).follow).toEqual({
      setting: 'off',
      effective: false,
    });
    expect((await registry.setFollow('site-a.test', null, 'p-op')).follow.setting).toBe('auto');
  });

  it('a disabled pack applies nothing and keeps its approval', async () => {
    const { registry, actions } = await loaded();
    await registry.approveSite('site-a.test', packSha(sitePack('site-a.test', 1)), 'p-op');
    expect((await registry.setEnabled('site-a.test', false, 'p-op')).enabled).toBe(false);
    expect(registry.effectiveFor('site-a.test')).toBeNull();
    expect((await registry.approveSite('site-a.test', undefined, 'p-op'))?.version).toBe(1);
    await registry.setEnabled('site-a.test', true, 'p-op');
    expect(registry.effectiveFor('site-a.test')?.version).toBe(1);
    expect(actions.rows.map((r) => r.action)).toContain('site_pack.disable');
  });

  it('answers SITE_PACK_NOT_FOUND for an unknown pack', async () => {
    const { registry } = await loaded();
    expect(await codeOf(registry.setFollow('nope.test', true, 'p-op'))).toBe('SITE_PACK_NOT_FOUND');
  });
});

/** `site-a.test` claiming a second domain, like linkedin.com and licdn.com. */
const WIDE = sitePack('site-a.test', 1, { domains: ['site-a.test', 'cdn-a.test'] });

describe('domains', () => {
  it('an approved pack keeps a domain another pack also claims (domain_overlap)', async () => {
    dirs = makeDirs();
    writePack(dirs.bundled, WIDE);
    const { registry } = createSitePackKit({ dirs });
    await registry.reload();
    await registry.approveSite('site-a.test', packSha(WIDE), 'p-op');
    writePack(dirs.bundled, sitePack('cdn-a.test', 1));
    await registry.reload();
    expect(registry.packIdFor('cdn-a.test')).toBe('site-a.test');
    expect(registry.get('cdn-a.test')?.skipped?.reason).toBe('domain_overlap');
    expect(registry.status().skipped.map((s) => [s.pack_id, s.reason])).toContainEqual([
      'cdn-a.test',
      'domain_overlap',
    ]);
  });
});
