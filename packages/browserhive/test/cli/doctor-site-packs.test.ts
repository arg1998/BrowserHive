/** @module test/cli/doctor-site-packs — the `site packs` row of `doctor` (spec 13 §11.9): bundled packs verify (✓), a bundled pack that does not (✗), local files not yet approved or changed since approval and invalid ones (!), signed layouts (!), `sitePacks=false`. */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TemplateSiteRecord } from '@browserhive/core/ports/persistence/records-templates';
import {
  emptySitePackState,
  type SitePackChangeRecord,
  type SitePackStateRecord,
} from '@browserhive/core/ports/persistence/site-packs';
import { z } from 'zod';
import { resolveBundledPacksDir } from '../../src/composition/site-packs.ts';
import { cliHarness, DATA_DIR, MemoryFs, storageState } from './helpers.ts';

const BUNDLED = resolveBundledPacksDir() ?? '/bundled';
const REGISTRY = resolve(import.meta.dir, '..', '..', '..', '..', 'registry', 'packs');
const GITHUB = readFileSync(join(REGISTRY, 'github.com.json'), 'utf8');
const LOCAL = `${DATA_DIR}/site-packs/local`;

/** What this build says while it pins no root keys (the key ceremony has not run, D71). */
const NO_KEYS = 'this build pins no registry keys yet: no update check runs';

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
    pending?: SitePackChangeRecord[];
    sites?: TemplateSiteRecord[];
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
      sitePackPending: options.pending ?? [],
      templateSites: options.sites ?? [],
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
      detail: `0 bundled packs (1 need a newer BrowserHive), ${NO_KEYS}, no registry snapshot in this build`,
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
    // T4b reads signed layouts: one in the folder is no longer a warning.
    expect(found?.detail).not.toContain('signed layout');
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
    expect(ok).toMatchObject({
      status: 'ok',
      detail: `0 bundled packs, 1 approved local file, ${NO_KEYS}, no registry snapshot in this build`,
    });
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

  it('pending updates of followed packs are warnings, as the server counts them (spec 13 §11.9, review #100 L11)', async () => {
    const candidate = (packId: string, toVersion: number, classification = 'tightening') =>
      ({
        seq: 1,
        eventId: `ev-${packId}-${toVersion}`,
        packId,
        fromVersion: 1,
        toVersion,
        toSha256: 'a'.repeat(64),
        source: 'remote',
        classification,
        newDomains: [],
        notes: null,
        diff: null,
        decision: 'pending',
        decidedBy: null,
        createdAt: 1,
        decidedAt: null,
      }) as unknown as SitePackChangeRecord;
    const site = (packId: string) =>
      ({ templateId: 'tp-1', siteId: packId, packId }) as unknown as TemplateSiteRecord;
    const found = await row(
      {},
      {
        pending: [
          candidate('used.test', 3), // followed: a template uses it
          candidate('on.test', 2), // followed: explicitly on
          candidate('pinned.test', 5), // followed, but pinned
          candidate('idle.test', 4), // not followed
          candidate('revoked.test', 1, 'revoked'), // revoked fallbacks wait regardless
        ],
        sites: [site('used.test'), site('pinned.test')],
        states: [
          { ...emptySitePackState('on.test', 0), follow: true },
          { ...emptySitePackState('pinned.test', 0), pinnedVersion: 2 },
        ],
      },
    );
    expect(found?.status).toBe('warn');
    expect(found?.detail).toContain(
      'pending updates of followed packs: on.test v2, revoked.test v1, used.test v3',
    );
    expect(found?.detail).not.toContain('idle.test');
    expect(found?.detail).not.toContain('pinned.test');
  });
});
