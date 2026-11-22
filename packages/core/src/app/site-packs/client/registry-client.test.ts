/** Tests of the registry client's check (spec 13 §10.3, §10.4, D69): exactly the four signed files, the floors, conditional requests that never depend on ETag semantics, every refusal leaving the state unchanged, stale and failed degradations, and the schedule. */

import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../../test/helpers/fake-clock.ts';
import {
  createClientKit,
  kitRepos,
  type MemoryFetcher,
  MemoryHeldStore,
  signRegistry,
} from '../../../../test/helpers/registry-client-kit.ts';
import { iso, testKey } from '../../../../test/helpers/registry-kit.ts';
import { sitePack } from '../../../../test/helpers/site-pack-kit.ts';
import { sha256Hex } from '../../../domain/site-packs/load.ts';

const NOW = Date.UTC(2026, 10, 22, 10);
const DAY = 86_400_000;
const PACK = 'pack-a.test';
const SIGNED = ['keys.json', 'keys.json.sig', 'index.json', 'index.json.sig'];

/** pack-a.test v1 bundled and approved; the registry lists v2. */
async function approvedKit(extra: Parameters<typeof signRegistry>[0]['versions'] = []) {
  const registry = signRegistry({
    now: NOW,
    versions: [
      { pack: sitePack(PACK, 2, { title: 'Site A v2' }), notes: 'Adds a title.' },
      ...extra,
    ],
  });
  const kit = await createClientKit({ registry, clock: new FakeClock(NOW) });
  await kit.registry.approveSite(PACK, undefined, 'admin').catch(async () => {
    const offer = kit.registry.get(PACK)?.offer;
    await kit.registry.approveSite(PACK, offer?.sha256, 'admin');
  });
  return { kit, registry };
}

function floors(kit: Awaited<ReturnType<typeof createClientKit>>) {
  return {
    keys: kit.repos.sitePackMeta.values.get('site_packs.keys_version') ?? null,
    index: kit.repos.sitePackMeta.values.get('site_packs.index_version') ?? null,
  };
}

describe('the update check', () => {
  it('fetches only keys.json, index.json and their signatures and lists a newer version as available', async () => {
    const { kit } = await approvedKit();
    const fetcher = kit.fetcher as MemoryFetcher;
    const result = await kit.client.check('admin');
    expect(result.outcome).toBe('updated');
    expect(result.available).toBe(1);
    expect(fetcher.requests.map((r) => r.path)).toEqual(SIGNED);
    const view = kit.registry.get(PACK);
    expect(view?.pending).toEqual([
      expect.objectContaining({
        version: 2,
        state: 'available',
        notes: 'Adds a title.',
        released: '2026-11-20',
        source: 'remote',
        classification: 'unclassified',
      }),
    ]);
    expect(view?.pending[0]?.provenance).toEqual(
      expect.objectContaining({ kind: 'remote', index_version: 10 }),
    );
    expect(floors(kit)).toEqual({ keys: '1', index: '10' });
    expect(result.status.index_version).toBe(10);
    expect(result.status.last_outcome).toBe('updated');
  });

  it('a newer version of a pack nobody follows is listed but not pending for review', async () => {
    const registry = signRegistry({ now: NOW, versions: [{ pack: sitePack(PACK, 2) }] });
    const kit = await createClientKit({ registry, clock: new FakeClock(NOW) });
    const offer = kit.registry.get(PACK)?.offer;
    await kit.registry.approveSite(PACK, offer?.sha256, 'admin');
    await kit.registry.setFollow(PACK, false, 'admin');
    await kit.client.check();
    const list = kit.registry.list();
    expect(list.data.find((v) => v.pack_id === PACK)?.pending).toHaveLength(1);
    expect(list.pending_count).toBe(0);
  });

  it('sends If-None-Match with the hash of the held body only, and a 304 costs no download', async () => {
    const { kit } = await approvedKit();
    const fetcher = kit.fetcher as MemoryFetcher;
    await kit.client.check();
    fetcher.requests.length = 0;
    fetcher.shaEtags = true;
    const again = await kit.client.check();
    expect(again.outcome).toBe('not_modified');
    expect(fetcher.requests.map((r) => r.path)).toEqual(SIGNED);
    const held = kit.held.files;
    expect(fetcher.requests.map((r) => r.ifNoneMatch)).toEqual(
      SIGNED.map((f) => `"${sha256Hex(held.get(f as never) ?? new Uint8Array())}"`),
    );
  });

  it('a 200 with the bytes it holds is not modified (an ETag that is not the hash changes nothing)', async () => {
    const { kit } = await approvedKit();
    await kit.client.check();
    const again = await kit.client.check();
    expect(again.outcome).toBe('not_modified');
    expect(floors(kit)).toEqual({ keys: '1', index: '10' });
  });

  it('makes no request at all with the update check off', async () => {
    const registry = signRegistry({ now: NOW, versions: [{ pack: sitePack(PACK, 2) }] });
    const kit = await createClientKit({ registry, updateCheck: false, clock: new FakeClock(NOW) });
    const result = await kit.client.check('admin');
    expect(result.outcome).toBe('disabled');
    expect(result.status.check_off).toBe('update_check_off');
    expect((kit.fetcher as MemoryFetcher).requests).toEqual([]);
    expect(kit.timers).toEqual([]);
  });

  it('makes no request while the build pins no registry keys', async () => {
    const registry = signRegistry({ now: NOW, versions: [{ pack: sitePack(PACK, 2) }] });
    const kit = await createClientKit({
      registry,
      trustRoot: { keys: [] },
      clock: new FakeClock(NOW),
    });
    const result = await kit.client.check();
    expect(result.outcome).toBe('disabled');
    expect(result.status.check_off).toBe('no_trust_root');
    expect(result.status.trusts_registry).toBe(false);
    expect((kit.fetcher as MemoryFetcher).requests).toEqual([]);
    expect(kit.timers).toEqual([]);
  });

  it('schedules the first check 5 minutes after start, then 24 h ± 2 h, backing off after failures', async () => {
    const { kit } = await approvedKit();
    expect(kit.timers.map((t) => t.ms)).toEqual([5 * 60_000]);
    kit.timers[0]?.fn();
    await Bun.sleep(5);
    expect(kit.timers.at(-1)?.ms).toBe(24 * 3_600_000);
    (kit.fetcher as MemoryFetcher).fail = {
      kind: 'failed',
      reason: 'network',
      status: null,
      detail: 'offline',
      date: null,
    };
    kit.timers.at(-1)?.fn();
    await Bun.sleep(5);
    expect(kit.timers.at(-1)?.ms).toBe(3_600_000);
  });
});

describe('refusals leave everything as it was', () => {
  /** A kit that accepted index 10, then the registry serves `next`. */
  async function after(next: (base: ReturnType<typeof signRegistry>) => Map<string, Uint8Array>) {
    const { kit, registry } = await approvedKit();
    await kit.client.check();
    const before = {
      floors: floors(kit),
      held: [...kit.held.files.entries()],
      pending: kit.registry.get(PACK)?.pending,
    };
    (kit.fetcher as MemoryFetcher).files = next(registry);
    const result = await kit.client.check();
    expect(result.outcome).toBe('failed');
    expect(floors(kit)).toEqual(before.floors);
    expect([...kit.held.files.entries()]).toEqual(before.held);
    expect(kit.registry.get(PACK)?.pending).toEqual(before.pending);
    return { kit, result };
  }

  const same = (
    base: ReturnType<typeof signRegistry>,
    options: Partial<Parameters<typeof signRegistry>[0]>,
  ) =>
    signRegistry({
      now: NOW,
      root: base.root,
      online: base.online,
      versions: [{ pack: sitePack(PACK, 3) }],
      ...options,
    }).files;

  it('an expired index', async () => {
    const { result } = await after((b) =>
      same(b, {
        indexVersion: 11,
        index: { issued_at: iso(NOW - 9 * DAY), expires: iso(NOW - DAY) },
      }),
    );
    expect(result.error?.code).toBe('expired');
  });

  it('a rolled-back index', async () => {
    const { result } = await after((b) => same(b, { indexVersion: 9 }));
    expect(result.error?.code).toBe('rollback');
  });

  it('a fast-forwarded index', async () => {
    const { result } = await after((b) => same(b, { indexVersion: 10 + 100_001 }));
    expect(result.error?.code).toBe('fast_forward');
  });

  it('an index issued in the future', async () => {
    const { result } = await after((b) =>
      same(b, {
        indexVersion: 11,
        index: { issued_at: iso(NOW + 3_600_000), expires: iso(NOW + 2 * DAY) },
      }),
    );
    expect(result.error?.code).toBe('issued_in_future');
  });

  it('an index from an online key past its not_after', async () => {
    const { result } = await after((b) =>
      same(b, {
        indexVersion: 11,
        keys: {
          online: [
            {
              key_id: b.online.keyId,
              public_key: b.online.publicKey,
              not_after: iso(NOW - 60_000),
            },
          ],
        },
      }),
    );
    expect(result.error?.code).toBe('key_expired');
  });

  it('a wrong online key', async () => {
    const { result } = await after((b) => same(b, { indexVersion: 11, indexSigner: testKey() }));
    expect(result.error?.code).toBe('unknown_key');
  });

  it('an unknown root key', async () => {
    const { result } = await after(
      () =>
        signRegistry({ now: NOW, indexVersion: 11, versions: [{ pack: sitePack(PACK, 3) }] }).files,
    );
    expect(result.error?.code).toBe('unknown_key');
  });

  it('three failures in a row record SITE_PACKS_FETCH_FAILED, a good check recovers it', async () => {
    const { kit } = await approvedKit();
    const fetcher = kit.fetcher as MemoryFetcher;
    const files = fetcher.files;
    fetcher.files = new Map();
    for (let i = 0; i < 3; i += 1) await kit.client.check();
    expect(kit.degradations.reports.map((r) => r.code)).toContain('SITE_PACKS_FETCH_FAILED');
    expect(kit.registry.status().failures).toBe(3);
    fetcher.files = files;
    await kit.client.check();
    expect(kit.degradations.recoveries).toContain('SITE_PACKS_FETCH_FAILED');
    expect(kit.registry.status().failures).toBe(0);
  });
});

describe('stale and floors', () => {
  it('an expired held index is stale: SITE_PACKS_STALE with the clock hint, downloads refused', async () => {
    const clock = new FakeClock(NOW);
    const registry = signRegistry({ now: NOW, versions: [{ pack: sitePack(PACK, 2) }] });
    const kit = await createClientKit({ registry, clock });
    const offer = kit.registry.get(PACK)?.offer;
    await kit.registry.approveSite(PACK, offer?.sha256, 'admin');
    await kit.client.check();
    await clock.advance(8 * DAY);
    (kit.fetcher as MemoryFetcher).date = NOW + 8 * DAY - 2 * 3_600_000;
    const result = await kit.client.check();
    expect(result.outcome).toBe('failed');
    expect(result.status.stale).toBe(true);
    const stale = kit.degradations.reports.find((r) => r.code === 'SITE_PACKS_STALE');
    expect(stale?.message).toContain('check the system clock');
    await expect(kit.client.download(PACK, 2, 'admin')).rejects.toMatchObject({
      code: 'SITE_PACKS_REGISTRY_UNAVAILABLE',
    });
  });

  it('a newer keys.json with index_floor lowers the floor once', async () => {
    const root = testKey();
    const online = testKey();
    const first = signRegistry({
      now: NOW,
      root,
      online,
      indexVersion: 500,
      versions: [{ pack: sitePack(PACK, 2) }],
    });
    const kit = await createClientKit({ registry: first, clock: new FakeClock(NOW) });
    await kit.client.check();
    const reset = signRegistry({
      now: NOW,
      root,
      online,
      keysVersion: 2,
      indexVersion: 20,
      keys: { index_floor: 10 },
      versions: [{ pack: sitePack(PACK, 2) }],
    });
    (kit.fetcher as MemoryFetcher).files = reset.files;
    expect((await kit.client.check()).outcome).toBe('updated');
    expect(floors(kit)).toEqual({ keys: '2', index: '20' });
    const older = signRegistry({
      now: NOW,
      root,
      online,
      keysVersion: 2,
      indexVersion: 15,
      keys: { index_floor: 10 },
      versions: [{ pack: sitePack(PACK, 2) }],
    });
    (kit.fetcher as MemoryFetcher).files = older.files;
    const refused = await kit.client.check();
    expect(refused.error?.code).toBe('rollback');
  });

  it('the release snapshot sets the floors of a fresh install', async () => {
    const root = testKey();
    const online = testKey();
    const snapshot = signRegistry({
      now: NOW - 30 * DAY,
      root,
      online,
      keysVersion: 3,
      indexVersion: 400,
      versions: [],
    });
    const store = new MemoryHeldStore();
    for (const f of SIGNED) store.files.set(f as never, snapshot.files.get(f) ?? new Uint8Array());
    const registry = signRegistry({
      now: NOW,
      root,
      online,
      keysVersion: 3,
      indexVersion: 300,
      versions: [],
    });
    const kit = await createClientKit({ registry, snapshot: store, clock: new FakeClock(NOW) });
    expect(floors(kit)).toEqual({ keys: '3', index: '400' });
    expect(kit.registry.status().snapshot).toEqual({
      index_version: 400,
      verified: true,
      detail: null,
    });
    expect((await kit.client.check()).error?.code).toBe('rollback');
  });

  it('keeps the held index and floors across a restart', async () => {
    const repos = kitRepos();
    const held = new MemoryHeldStore();
    const registry = signRegistry({ now: NOW, versions: [{ pack: sitePack(PACK, 2) }] });
    const one = await createClientKit({ registry, repos, held, clock: new FakeClock(NOW) });
    await one.client.check();
    one.client.stop();
    const two = await createClientKit({ registry, repos, held, clock: new FakeClock(NOW) });
    expect(two.registry.status().index_version).toBe(10);
    expect(two.registry.get(PACK)?.online?.version).toBe(2);
  });
});
