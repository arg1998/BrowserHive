/** @module test/cli/doctor-site-packs — the `site packs` row of `doctor` (spec 13 §11.9): bundled packs verify (✓), a bundled pack that does not (✗), local files not yet approved or changed since approval and invalid ones (!), signed layouts (!), `sitePacks=false`. */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { resolveBundledPacksDir } from '../../src/composition/site-packs.ts';
import { cliHarness, DATA_DIR, MemoryFs, storageState } from './helpers.ts';

const BUNDLED = resolveBundledPacksDir() ?? '/bundled';
const REGISTRY = resolve(import.meta.dir, '..', '..', '..', '..', 'registry', 'packs');
const GITHUB = readFileSync(join(REGISTRY, 'github.com.json'), 'utf8');
const LOCAL = `${DATA_DIR}/site-packs/local`;

const Row = z.object({ check: z.string(), status: z.string(), detail: z.string() });

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function row(
  files: Record<string, string>,
  options: { argv?: string[]; approvals?: { packId: string; sha256: string | null }[] } = {},
) {
  const fs = new MemoryFs({ [`${DATA_DIR}/browserhive.db`]: 'db', ...files });
  fs.ensureDir(BUNDLED);
  const run = await cliHarness({
    argv: ['doctor', '--json', ...(options.argv ?? [])],
    fs,
    storage: storageState({ sitePackApprovals: options.approvals ?? [] }),
  });
  const rows = z.array(Row).parse(JSON.parse(run.stdout));
  return rows.find((r) => r.check === 'site packs');
}

describe('doctor: site packs', () => {
  it('bundled packs that verify are ✓ (a pack for a newer release is counted, not a problem)', async () => {
    expect(await row({ [`${BUNDLED}/github.com.json`]: GITHUB })).toEqual({
      check: 'site packs',
      status: 'ok',
      detail: '0 bundled packs (1 need a newer BrowserHive)',
    });
  });

  it('a bundled pack that does not verify is ✗', async () => {
    const found = await row({ [`${BUNDLED}/x.com.json`]: GITHUB });
    expect(found?.status).toBe('fail');
    expect(found?.detail).toContain('bundled packs do not verify: x.com (id_mismatch)');
  });

  it('a build index whose hash does not match is ✗', async () => {
    const index = {
      release: '0.3.0',
      built_at: null,
      packs: [
        {
          id: 'github.com',
          version: 1,
          sha256: '0'.repeat(64),
          size: GITHUB.length,
          path: 'packs/github.com.json',
        },
      ],
    };
    const found = await row({
      [`${BUNDLED}/index.json`]: JSON.stringify(index),
      [`${BUNDLED}/packs/github.com.json`]: GITHUB,
    });
    expect(found?.status).toBe('fail');
    expect(found?.detail).toContain('github.com (hash mismatch)');
  });

  it('local files not yet approved, changed since approval or invalid are warnings', async () => {
    const edited = GITHUB.replace('"title": "GitHub"', '"title": "GitHub (edited)"');
    const found = await row(
      {
        [`${LOCAL}/github.com.json`]: edited,
        [`${LOCAL}/broken.test.json`]: '{}',
        [`${LOCAL}/keys.json`]: '{}',
      },
      { approvals: [{ packId: 'github.com', sha256: sha(GITHUB) }] },
    );
    expect(found?.status).toBe('warn');
    expect(found?.detail).toContain('local files skipped: broken.test');
    expect(found?.detail).toContain('1 signed layout');
    // The binary in the harness is older than the pack's min_client: it is skipped, not compared.
    const approved = await row(
      { [`${LOCAL}/github.com.json`]: GITHUB },
      { approvals: [{ packId: 'github.com', sha256: null }] },
    );
    expect(approved?.status).toBe('warn');
  });

  it('a valid local file not approved, and one changed since approval', async () => {
    const pack = z.record(z.string(), z.unknown()).parse(JSON.parse(GITHUB));
    const current = `${JSON.stringify({ ...pack, min_client: '0.0.1' }, null, 2)}\n`;
    const fresh = await row({ [`${LOCAL}/github.com.json`]: current });
    expect(fresh?.detail).toContain('local files not yet approved: github.com');
    const changed = await row(
      { [`${LOCAL}/github.com.json`]: current },
      { approvals: [{ packId: 'github.com', sha256: sha(GITHUB) }] },
    );
    expect(changed?.detail).toContain('local files changed since approval: github.com');
    const ok = await row(
      { [`${LOCAL}/github.com.json`]: current },
      { approvals: [{ packId: 'github.com', sha256: sha(current) }] },
    );
    expect(ok).toMatchObject({ status: 'ok', detail: '0 bundled packs, 1 approved local file' });
  });

  it('sitePacks=false is ✓ and reads nothing', async () => {
    const found = await row({ [`${BUNDLED}/x.com.json`]: GITHUB }, { argv: ['--sitePacks=false'] });
    expect(found).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('sitePacks=false'),
    });
  });
});
