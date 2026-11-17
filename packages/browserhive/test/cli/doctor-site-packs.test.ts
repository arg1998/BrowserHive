/** @module test/cli/doctor-site-packs — the `site packs` row of `doctor` (spec 13 §11.9): bundled packs verify (✓), a bundled pack that does not (✗), local files not yet approved or changed since approval and invalid ones (!), signed layouts (!), `sitePacks=false`. */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  emptySitePackState,
  type SitePackStateRecord,
} from '@browserhive/core/ports/persistence/site-packs';
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
  options: {
    argv?: string[];
    approvals?: { packId: string; sha256: string | null }[];
    states?: SitePackStateRecord[];
    unreadable?: string[];
  } = {},
) {
  const fs = new MemoryFs({ [`${DATA_DIR}/browserhive.db`]: 'db', ...files });
  fs.ensureDir(BUNDLED);
  const run = await cliHarness({
    argv: ['doctor', '--json', ...(options.argv ?? [])],
    fs,
    storage: storageState({
      sitePackStates: [
        ...(options.approvals ?? []).map((a) => ({
          ...emptySitePackState(a.packId, 0),
          localApprovedSha256: a.sha256,
        })),
        ...(options.states ?? []),
      ],
      sitePackUnreadable: options.unreadable ?? [],
    }),
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

  it('approved packs that do not apply are warnings (review #83 S-M8, C-M5)', async () => {
    const pack = z.record(z.string(), z.unknown()).parse(JSON.parse(GITHUB));
    const current = `${JSON.stringify({ ...pack, min_client: '0.0.1' }, null, 2)}\n`;
    // Approved at a version whose copy is gone, and a pack whose row cannot be read.
    const found = await row(
      { [`${BUNDLED}/github.com.json`]: current },
      {
        states: [
          {
            ...emptySitePackState('github.com', 0),
            approvedVersion: 0,
            approvedSha256: 'f'.repeat(64),
            approvedSource: 'bundled',
          },
        ],
        unreadable: ['linkedin.com'],
      },
    );
    expect(found?.status).toBe('warn');
    expect(found?.detail).toContain('packs not in force: github.com (not_found');
    expect(found?.detail).toContain('linkedin.com (unreadable');
  });

  it('a domain covered by two approved packs is named with its owner', async () => {
    const pack = z.record(z.string(), z.unknown()).parse(JSON.parse(GITHUB));
    const github = `${JSON.stringify({ ...pack, min_client: '0.0.1' }, null, 2)}\n`;
    const other = `${JSON.stringify(
      {
        ...pack,
        id: 'gist.test',
        domains: ['gist.test', 'github.com'],
        min_client: '0.0.1',
        guards: [],
        element_guards: [],
        challenges: [],
        sign_in: undefined,
        identity_provider: 'github.com',
        signed_in: { probe: { host: 'gist.test', path: '/' }, kind: 'landmark', landmark: 'body' },
      },
      null,
      2,
    )}\n`;
    const found = await row(
      { [`${BUNDLED}/github.com.json`]: github, [`${LOCAL}/gist.test.json`]: other },
      {
        states: [
          {
            ...emptySitePackState('github.com', 0),
            approvedVersion: 1,
            approvedSha256: sha(github),
            approvedSource: 'bundled',
            approvedAt: 1,
          },
          {
            ...emptySitePackState('gist.test', 0),
            localApprovedSha256: sha(other),
            localApprovedAt: 2,
          },
        ],
      },
    );
    expect(found?.detail).toContain(
      'gist.test (domain_overlap: github.com is covered by the pack github.com',
    );
  });
});
