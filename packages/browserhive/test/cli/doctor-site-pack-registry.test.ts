/** @module test/cli/doctor-site-pack-registry.test — the registry part of `doctor`'s `site packs` row (spec 13 §10.3, §10.9, §11.9, D-55): the update check's disclosure (on, off, no pinned keys), a stale or unreadable held index, repeated failures and clock skew from the client's `meta` row, and the release snapshot (verifies, aged, tampered, refused by a root that pins nothing). Offline: layouts are signed at run time with throwaway keys (registry-kit). */
import { describe, expect, it } from 'bun:test';
import { buildLayout, iso } from '@browserhive/core/test/registry-kit';
import { z } from 'zod';
import type { CliDeps } from '../../src/cli/deps.ts';
import { resolveBundledPacksDir } from '../../src/composition/site-packs.ts';
import { cliHarness, DATA_DIR, MemoryFs, storageState } from './helpers.ts';

const BUNDLED = resolveBundledPacksDir() ?? '/bundled';
const SNAPSHOT = `${BUNDLED}/registry/v1`;
const NOW = Date.parse('2026-11-22T12:00:00Z');
const DAY = 86_400_000;
const NO_KEYS = 'this build pins no registry keys yet: no update check runs';
const DISCLOSURE =
  'checks https://browserhive.ai/registry/v1/ every 24 h and downloads only the signed index; sends nothing about this install';

const Row = z.object({ check: z.string(), status: z.string(), detail: z.string() });

const layout = buildLayout({ now: NOW });

async function row(
  options: {
    argv?: string[];
    files?: Record<string, string | Uint8Array>;
    meta?: Record<string, string>;
    trust?: boolean;
    trustRoot?: CliDeps['sitePacksTrustRoot'];
  } = {},
) {
  const fs = new MemoryFs({ [`${DATA_DIR}/browserhive.db`]: 'db' });
  fs.ensureDir(BUNDLED);
  for (const [path, data] of Object.entries(options.files ?? {})) fs.put(path, data);
  const trustRoot = options.trustRoot ?? (options.trust === true ? layout.trustRoot : undefined);
  const run = await cliHarness({
    argv: ['doctor', '--json', ...(options.argv ?? [])],
    fs,
    storage: storageState({ meta: options.meta ?? {} }),
    overrides: {
      clock: { now: () => NOW },
      ...(trustRoot !== undefined && { sitePacksTrustRoot: trustRoot }),
    },
  });
  const rows = z.array(Row).parse(JSON.parse(run.stdout));
  const found = rows.find((r) => r.check === 'site packs');
  if (found === undefined) throw new Error('no site packs row');
  return found;
}

function snapshotFiles(files: ReadonlyMap<string, Uint8Array> = layout.files) {
  return Object.fromEntries([...files].map(([path, bytes]) => [`${SNAPSHOT}/${path}`, bytes]));
}

describe('doctor: the update check disclosure (D-55)', () => {
  it('while this build pins no root keys: no update check runs', async () => {
    const found = await row();
    expect(found.status).toBe('ok');
    expect(found.detail).toContain(NO_KEYS);
    expect(found.detail).not.toContain('every 24 h');
  });

  it('with root keys and the check on: what it fetches, how often, that it sends nothing', async () => {
    const found = await row({ trust: true });
    expect(found.status).toBe('ok');
    expect(found.detail).toContain(DISCLOSURE);
    const mirror = await row({
      trust: true,
      argv: ['--sitePacksUrl', 'https://mirror.example.org/registry/v1/'],
    });
    expect(mirror.detail).toContain('checks https://mirror.example.org/registry/v1/ every 24 h');
  });

  it('sitePacksUpdateCheck=false: no request', async () => {
    const found = await row({ trust: true, argv: ['--sitePacksUpdateCheck=false'] });
    expect(found.status).toBe('ok');
    expect(found.detail).toContain('update check off: no request');
    expect(found.detail).not.toContain('every 24 h');
  });
});

describe('doctor: the held index and the client status', () => {
  const HELD = `${DATA_DIR}/site-packs/remote/index.json`;
  const indexText = (expires: number) =>
    JSON.stringify({
      schema: 1,
      version: 41,
      issued_at: iso(expires - 7 * DAY),
      expires: iso(expires),
      packs: [],
    });

  it('a fresh held index is noted with its version and expiry', async () => {
    const found = await row({ files: { [HELD]: indexText(NOW + DAY) } });
    expect(found.status).toBe('ok');
    expect(found.detail).toContain('registry index v41 (expires 2026-11-23 12:00Z)');
  });

  it('an expired held index is a warning (stale)', async () => {
    const found = await row({ files: { [HELD]: indexText(NOW - DAY) } });
    expect(found.status).toBe('warn');
    expect(found.detail).toContain(
      'the held registry index v41 expired on 2026-11-21 12:00Z (stale)',
    );
  });

  it('a held index that does not parse is a warning', async () => {
    const found = await row({ files: { [HELD]: '{"schema": 1}' } });
    expect(found.status).toBe('warn');
    expect(found.detail).toContain('does not parse');
  });

  it('three failed checks in a row and a clock 10 min off are warnings', async () => {
    const client = JSON.stringify({
      last_check_at: NOW,
      last_ok_at: NOW - 3 * DAY,
      last_outcome: 'failed',
      last_error: { code: 'SITE_PACKS_FETCH_FAILED', message: 'connect ECONNREFUSED' },
      failures: 3,
      index_sha256: null,
      index_origin: 'registry',
      clock_skew_ms: -10 * 60_000,
    });
    const found = await row({ meta: { 'site_packs.client': client } });
    expect(found.status).toBe('warn');
    expect(found.detail).toContain(
      'the last 3 update checks failed: [SITE_PACKS_FETCH_FAILED] connect ECONNREFUSED',
    );
    // The registry's Date minus this clock: -10 min means this clock is 10 min ahead.
    expect(found.detail).toContain("this machine's clock is 10 min ahead of the registry's");
  });

  it('one failure and a small skew are notes only', async () => {
    const client = JSON.stringify({
      last_check_at: NOW,
      last_ok_at: NOW - DAY,
      last_outcome: 'failed',
      last_error: { code: 'SITE_PACKS_FETCH_FAILED', message: 'timeout' },
      failures: 1,
      clock_skew_ms: 30_000,
    });
    const found = await row({ meta: { 'site_packs.client': client } });
    expect(found.status).toBe('ok');
    expect(found.detail).toContain('last update check failed: [SITE_PACKS_FETCH_FAILED]');
    expect(found.detail).toContain('last good check 2026-11-21 12:00Z');
  });

  it('an unreadable client row is ignored', async () => {
    const found = await row({ meta: { 'site_packs.client': 'not json' } });
    expect(found.status).toBe('ok');
  });
});

describe('doctor: the release snapshot (spec 13 §10.9)', () => {
  it('absent (source runs, builds before the key ceremony): a note', async () => {
    expect((await row()).detail).toContain('no registry snapshot in this build');
  });

  it('verifies under the root keys of this build: ✓', async () => {
    const found = await row({ trust: true, files: snapshotFiles() });
    expect(found.status).toBe('ok');
    expect(found.detail).toContain('registry snapshot v10 verifies');
  });

  it('an aged snapshot (index past its expiry) verifies as of its issue time', async () => {
    const old = buildLayout({ now: NOW - 30 * DAY });
    const found = await row({ trustRoot: old.trustRoot, files: snapshotFiles(old.files) });
    expect(found.status).toBe('ok');
    expect(found.detail).toContain('registry snapshot v10 verifies (expired');
  });

  it('a tampered snapshot file is ✗', async () => {
    const files = new Map(layout.files);
    files.set('index.json', new TextEncoder().encode('{"schema":1}\n'));
    const found = await row({ trust: true, files: snapshotFiles(files) });
    expect(found.status).toBe('fail');
    expect(found.detail).toContain('the bundled registry snapshot does not verify: index.json');
  });

  it('a snapshot this build cannot check (no pinned root) is ✗', async () => {
    const found = await row({ files: snapshotFiles() });
    expect(found.status).toBe('fail');
    expect(found.detail).toContain('no_trust_root');
  });
});
