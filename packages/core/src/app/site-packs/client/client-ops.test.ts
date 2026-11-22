/** @module app/site-packs/client/client-ops.test — Tests of what the registry client does with a verified index (spec 13 §9.7, §10.3 step 3, §10.5, §10.6, §17 T4b acceptance): Download & review of exactly one file, Apply and Revert, swapped and oversized files refused, Download all, auto-update (tightening applied, loosening waits, the D74 cap), revocations (D52), signed imports, export then import offline, and signed layouts in the local folder. */

import { describe, expect, it } from 'bun:test';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import { FakeClock } from '../../../../test/helpers/fake-clock.ts';
import {
  createClientKit,
  type ListedVersion,
  type MemoryFetcher,
  signRegistry,
} from '../../../../test/helpers/registry-client-kit.ts';
import { testKey } from '../../../../test/helpers/registry-kit.ts';
import { packBytes, sitePack } from '../../../../test/helpers/site-pack-kit.ts';

const NOW = Date.UTC(2026, 10, 22, 10);
const PACK = 'pack-a.test';

/** A stricter version: one more blocking guard (tightening). */
function tighter(version: number, extra: Partial<SitePackV1Input> = {}): SitePackV1Input {
  const base = sitePack(PACK, version, extra);
  return {
    ...base,
    guards: [
      ...(base.guards ?? []),
      {
        id: 'delete',
        kind: 'destructive',
        match: { url: `www.${PACK}/delete`, methods: ['DELETE'] },
        action: 'block',
      },
    ],
  };
}

/** A looser version: the logout guard removed. */
function looser(version: number): SitePackV1Input {
  return { ...sitePack(PACK, version), guards: [] };
}

async function kitWith(
  versions: readonly ListedVersion[],
  options: {
    autoUpdate?: boolean;
    root?: ReturnType<typeof testKey>;
    online?: ReturnType<typeof testKey>;
  } = {},
) {
  const registry = signRegistry({
    now: NOW,
    versions,
    ...(options.root !== undefined && { root: options.root }),
    ...(options.online !== undefined && { online: options.online }),
  });
  const kit = await createClientKit({
    registry,
    clock: new FakeClock(NOW),
    autoUpdate: options.autoUpdate ?? false,
  });
  const offer = kit.registry.get(PACK)?.offer;
  await kit.registry.approveSite(PACK, offer?.sha256, 'admin');
  // Followed as if a template used it.
  await kit.registry.setFollow(PACK, true, 'admin');
  return { kit, registry, fetcher: kit.fetcher as MemoryFetcher };
}

describe('Download & review, Apply, Revert', () => {
  it('fetches exactly that file, verifies it, shows the classified diff; Apply approves it and Revert restores v1', async () => {
    const { kit, fetcher } = await kitWith([{ pack: tighter(2) }]);
    await kit.client.check();
    fetcher.requests.length = 0;
    const { view, diff } = await kit.client.download(PACK, 2, 'admin');
    const path =
      view.pending[0]?.sha256 === undefined ? '' : `packs/${PACK}/${view.pending[0].sha256}.json`;
    expect(fetcher.requests.map((r) => r.path)).toEqual([path]);
    expect(view.pending[0]).toEqual(
      expect.objectContaining({ version: 2, state: 'downloaded', classification: 'tightening' }),
    );
    expect(diff.classification).toBe('tightening');
    expect(diff.changes.some((c) => c.path.includes('delete'))).toBe(true);
    const applied = await kit.registry.apply(PACK, 2, 'admin');
    expect(applied.approved).toEqual(
      expect.objectContaining({
        version: 2,
        source: 'remote',
        provenance: expect.objectContaining({ kind: 'remote', index_version: 10 }),
      }),
    );
    expect(applied.previous).toEqual({ version: 1, source: 'bundled' });
    const reverted = await kit.registry.revert(PACK, 'admin');
    expect(reverted.approved?.version).toBe(1);
  });

  it('Apply of a version that is only available (not downloaded) is refused', async () => {
    const { kit } = await kitWith([{ pack: tighter(2) }]);
    await kit.client.check();
    await expect(kit.registry.apply(PACK, 2, 'admin')).rejects.toMatchObject({
      code: 'SITE_PACK_UPDATE_NOT_PENDING',
    });
  });

  it('refuses a swapped pack file and an oversized one, with the state unchanged', async () => {
    const other = packBytes(sitePack(PACK, 2, { title: 'Swapped' }));
    for (const served of [other, new Uint8Array(70 * 1024)]) {
      const { kit } = await kitWith([{ pack: tighter(2), served }]);
      await kit.client.check();
      const before = kit.registry.get(PACK);
      await expect(kit.client.download(PACK, 2, 'admin')).rejects.toMatchObject({
        code: 'SITE_PACK_DOWNLOAD_FAILED',
      });
      expect(kit.registry.get(PACK)).toEqual(before);
    }
  });

  it('refuses a version the index does not list as available', async () => {
    const { kit } = await kitWith([{ pack: tighter(2) }]);
    await kit.client.check();
    await expect(kit.client.download(PACK, 7, 'admin')).rejects.toMatchObject({
      code: 'SITE_PACK_NOT_LISTED',
    });
  });

  it('a version for another BrowserHive is not available and names the range it needs', async () => {
    const { kit } = await kitWith([{ pack: { ...tighter(2), min_client: '9.0.0' } }]);
    await kit.client.check();
    const view = kit.registry.get(PACK);
    expect(view?.pending).toEqual([]);
    expect(view?.online).toEqual(
      expect.objectContaining({ version: 2, needs_client: '9.0.0 or later', usable_version: null }),
    );
  });
});

describe('Download all', () => {
  it('fetches every listed version BrowserHive lacks, of every pack', async () => {
    const { kit, fetcher } = await kitWith([
      { pack: tighter(3) },
      { pack: tighter(2, { title: 'two' }) },
      { pack: sitePack('pack-b.test', 1) },
    ]);
    await kit.client.check();
    fetcher.requests.length = 0;
    const result = await kit.client.downloadAll('admin');
    expect(result.downloaded).toHaveLength(3);
    expect(fetcher.requests.every((r) => r.path.startsWith('packs/'))).toBe(true);
    expect(fetcher.requests).toHaveLength(3);
    expect(kit.registry.get(PACK)?.pending[0]?.state).toBe('downloaded');
    fetcher.requests.length = 0;
    const again = await kit.client.downloadAll('admin');
    expect(again.held).toBe(3);
    expect(fetcher.requests).toEqual([]);
  });
});

describe('auto-update', () => {
  it('downloads and applies a tightening candidate of a followed pack', async () => {
    const { kit } = await kitWith([{ pack: tighter(2) }], { autoUpdate: true });
    await kit.client.check();
    const view = kit.registry.get(PACK);
    expect(view?.approved).toEqual(expect.objectContaining({ version: 2, by: 'browserhive' }));
    const changes = await kit.registry.changes({ limit: 10 });
    expect(changes.data.some((c) => c.decision === 'auto' && c.decided_by === 'browserhive')).toBe(
      true,
    );
  });

  it('leaves a loosening candidate downloaded for an operator', async () => {
    const { kit } = await kitWith([{ pack: looser(2) }], { autoUpdate: true });
    await kit.client.check();
    const view = kit.registry.get(PACK);
    expect(view?.approved?.version).toBe(1);
    expect(view?.pending[0]).toEqual(
      expect.objectContaining({ version: 2, state: 'downloaded', classification: 'loosening' }),
    );
  });

  it('leaves a tightening version that adds too many blocking guards (D74)', async () => {
    const base = sitePack(PACK, 2);
    const many: SitePackV1Input = {
      ...base,
      guards: [
        ...(base.guards ?? []),
        ...[1, 2, 3, 4].map((n) => ({
          id: `extra-${n}`,
          kind: 'destructive' as const,
          match: { url: `www.${PACK}/x${n}`, methods: ['DELETE' as const] },
          action: 'block' as const,
        })),
      ],
    };
    const { kit } = await kitWith([{ pack: many }], { autoUpdate: true });
    await kit.client.check();
    expect(kit.registry.get(PACK)?.approved?.version).toBe(1);
    expect(kit.registry.get(PACK)?.pending[0]?.state).toBe('downloaded');
  });

  it('never touches a pinned pack', async () => {
    const { kit } = await kitWith([{ pack: tighter(2) }], { autoUpdate: true });
    await kit.registry.pin(PACK, 1, 'admin');
    await kit.client.check();
    expect(kit.registry.get(PACK)?.approved?.version).toBe(1);
  });
});

describe('revocation (D52)', () => {
  /** v2 applied over v1, then the registry revokes v2. */
  async function revoked(v2: SitePackV1Input) {
    const root = testKey();
    const online = testKey();
    const { kit, fetcher } = await kitWith([{ pack: v2 }], { root, online });
    await kit.client.check();
    await kit.client.download(PACK, 2, 'admin');
    await kit.registry.apply(PACK, 2, 'admin');
    fetcher.files = signRegistry({
      now: NOW,
      root,
      online,
      indexVersion: 11,
      versions: [{ pack: v2, revoked: true }],
    }).files;
    await kit.client.check();
    return kit;
  }

  it('a revoked version with a looser fallback stays in force and opens a decision', async () => {
    const kit = await revoked(tighter(2));
    const view = kit.registry.get(PACK);
    expect(view?.approved?.version).toBe(2);
    expect(view?.approved_revoked).toBe(true);
    expect(view?.pending[0]).toEqual(
      expect.objectContaining({ version: 1, classification: 'revoked' }),
    );
    expect(kit.registry.pending().some((p) => p.kind === 'candidate' && p.toVersion === 1)).toBe(
      true,
    );
    // Handled once: a second check opens no second decision.
    await kit.client.check();
    expect(kit.registry.get(PACK)?.pending).toHaveLength(1);
  });

  it('a revoked version whose fallback is tightening or neutral falls back at once', async () => {
    const kit = await revoked(sitePack(PACK, 2, { title: 'Only the title changed' }));
    const view = kit.registry.get(PACK);
    expect(view?.approved?.version).toBe(1);
    expect(view?.approved_revoked).toBe(false);
  });
});

describe('signed imports and export', () => {
  it('export then import on an offline host yields the same candidates', async () => {
    const { kit, registry } = await kitWith([{ pack: tighter(2) }]);
    await kit.client.check();
    await kit.client.download(PACK, 2, 'admin');
    const exported = await kit.client.exportLayout();
    expect(Object.keys(exported.files).sort()).toEqual(
      expect.arrayContaining(['index.json', 'index.json.sig', 'keys.json', 'keys.json.sig']),
    );
    const offline = await createClientKit({
      trustRoot: registry.trustRoot,
      updateCheck: false,
      clock: new FakeClock(NOW),
    });
    const offer = offline.registry.get(PACK)?.offer;
    await offline.registry.approveSite(PACK, offer?.sha256, 'admin');
    const files = new Map(
      Object.entries(exported.files).map(([p, b]) => [p, new Uint8Array(Buffer.from(b, 'base64'))]),
    );
    const imported = await offline.client.importLayout(files, 'usb-export', 'admin');
    expect(imported.layout?.outcome).toBe('updated');
    expect(imported.imported).toEqual([
      expect.objectContaining({ pack_id: PACK, version: 2, state: 'downloaded' }),
    ]);
    const a = kit.registry.get(PACK)?.pending.map(({ version, sha256, state, classification }) => ({
      version,
      sha256,
      state,
      classification,
    }));
    const b = offline.registry
      .get(PACK)
      ?.pending.map(({ version, sha256, state, classification }) => ({
        version,
        sha256,
        state,
        classification,
      }));
    expect(b).toEqual(a);
    expect(offline.registry.get(PACK)?.pending[0]?.provenance).toEqual({
      kind: 'import',
      file: 'usb-export',
    });
    expect((offline.fetcher as MemoryFetcher).requests).toEqual([]);
    // Importing the same layout again changes nothing.
    expect((await offline.client.importLayout(files, 'usb-export', 'admin')).layout?.outcome).toBe(
      'not_modified',
    );
  });

  it('refuses a layout that does not verify, with nothing changed', async () => {
    const { kit, registry } = await kitWith([{ pack: tighter(2) }]);
    const files = new Map(registry.files);
    files.set('index.json.sig', registry.files.get('keys.json.sig') ?? new Uint8Array());
    await expect(kit.client.importLayout(files, 'bad', 'admin')).rejects.toMatchObject({
      code: 'SITE_PACK_INVALID',
    });
    expect(kit.registry.status().index_version).toBeNull();
  });

  it('a signed layout in the local folder is queued like an import', async () => {
    const { registry } = await kitWith([{ pack: tighter(2) }]);
    const kit = await createClientKit({
      trustRoot: registry.trustRoot,
      updateCheck: false,
      clock: new FakeClock(NOW),
      readFolder: async (dir, path) =>
        dir === '/mem/local/export' ? (registry.files.get(path) ?? null) : null,
    });
    const offer = kit.registry.get(PACK)?.offer;
    await kit.registry.approveSite(PACK, offer?.sha256, 'admin');
    await kit.client.importLocalLayouts(['/mem/local/export', '/mem/local/notes']);
    expect(kit.registry.get(PACK)?.pending[0]).toEqual(
      expect.objectContaining({ version: 2, state: 'downloaded', source: 'import' }),
    );
    expect(kit.registry.status().index_origin).toBe('local');
    expect(kit.registry.status().skipped).toEqual([
      expect.objectContaining({ pack_id: '/mem/local/notes', reason: 'layout_refused' }),
    ]);
  });
});
