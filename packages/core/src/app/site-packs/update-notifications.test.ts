/** @module app/site-packs/update-notifications.test — `site_pack.update_pending` (spec 13 §8.6): one line per pending item, warn for a local file changed since approval, one thread, resolved when nothing waits; and the registry feeding it through `site_pack.status`. */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  createSitePackKit,
  makeDirs,
  removeDirs,
  type SitePackDirs,
  sitePack,
  writePack,
} from '../../../test/helpers/site-pack-kit.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { draftFor, revisionFor } from '../notifications/producers.ts';
import { UPDATES_THREAD, updatesDraft, updatesRevision } from './update-notifications.ts';

type Status = DomainEvents['site_pack.status'];

function status(items: NonNullable<Status['updates']>['items']): Status {
  return {
    type: 'site_pack.status',
    status: {} as Status['status'],
    updates: { at: 5, items },
  };
}

describe('site_pack.update_pending', () => {
  it('opens one thread with a one-line summary', () => {
    const draft = updatesDraft(
      status([
        { pack_id: 'linkedin.com', title: 'LinkedIn', from_version: 7, to_version: 8, local: null },
        { pack_id: 'x.com', title: 'X', from_version: null, to_version: 3, local: 'changed' },
      ]),
    );
    expect(draft).toMatchObject({
      kind: 'site_pack.update_pending',
      type: 'system',
      severity: 'warn',
      state: 'open',
      thread: UPDATES_THREAD,
      target: '/site-packs?pending=1',
      body: 'linkedin.com v7 → v8 available; local x.com changed',
      once: { kinds: ['site_pack.update_pending'] },
    });
    expect(draft?.content(1).blocks[0]).toMatchObject({ type: 'fields' });
  });

  it('is info for a bundled candidate alone, and resolves when nothing waits', () => {
    const one = updatesDraft(
      status([{ pack_id: 'a.test', title: 'A', from_version: 1, to_version: 2, local: null }]),
    );
    expect(one?.severity).toBe('info');
    expect(updatesRevision(status([]))).toMatchObject({
      thread: UPDATES_THREAD,
      change: { state: 'resolved' },
    });
    expect(updatesDraft(status([]))).toBeNull();
    expect(
      updatesRevision(
        status([{ ...{ pack_id: 'a', title: 'A' }, from_version: 1, to_version: 2, local: null }]),
      ),
    ).toBeNull();
  });
});

describe('the registry feeds it', () => {
  let dirs: SitePackDirs;
  afterEach(() => removeDirs(dirs));

  it('a local file needing approval produces a draft through the producer table', async () => {
    dirs = makeDirs();
    writePack(dirs.local, sitePack('site-a.test', 1));
    const { registry, bus } = createSitePackKit({ dirs });
    await registry.reload();
    const last = bus.published.filter((e) => e.name === 'site_pack.status').at(-1);
    const event = { name: 'site_pack.status' as const, at: 0, payload: last?.payload as Status };
    expect(draftFor(event)?.body).toBe('local site-a.test not yet approved');
    expect(revisionFor(event)).toBeNull();
  });
});
