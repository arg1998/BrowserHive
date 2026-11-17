/** @module test/cli/sitepacks-verify — `browserhive sitepacks verify <path>` (spec 13 §11.5): offline, prints the pack or its issues, exit 0 valid / 1 invalid / 64 without a path, `--json`. */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { cliHarness } from './helpers.ts';

/** A real bundled pack (the repository's source of truth). */
const GITHUB = readFileSync(
  resolve(import.meta.dir, '..', '..', '..', '..', 'registry', 'packs', 'github.com.json'),
  'utf8',
);

const PACK = z.record(z.string(), z.unknown()).parse(JSON.parse(GITHUB));
/** Its version, whatever the current bundled one is. */
const VERSION = z.number().parse(PACK['version']);

const Report = z.object({
  path: z.string(),
  ok: z.boolean(),
  pack_id: z.string().nullable(),
  version: z.number().nullable(),
  sha256: z.string().nullable(),
  size: z.number().nullable(),
  reason: z.string().nullable(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
  warnings: z.array(z.string()),
});

describe('sitepacks verify', () => {
  it('a valid pack: exit 0 with its id, version and hash; nothing else is opened', async () => {
    const run = await cliHarness({
      argv: ['sitepacks', 'verify', 'packs/github.com.json'],
      files: { '/work/packs/github.com.json': GITHUB },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`github.com v${VERSION}`);
    expect(run.stdout).toMatch(/sha256 [0-9a-f]{64}/);
    expect(run.storage.opened).toEqual([]);
  });

  it('--json reports the pack', async () => {
    const run = await cliHarness({
      argv: ['sitepacks', 'verify', '/p/github.com.json', '--json'],
      files: { '/p/github.com.json': GITHUB },
    });
    const report = Report.parse(JSON.parse(run.stdout));
    expect(report).toMatchObject({
      ok: true,
      pack_id: 'github.com',
      version: VERSION,
      reason: null,
    });
  });

  it('an invalid pack: exit 1 with each issue', async () => {
    const bad = JSON.stringify({
      ...PACK,
      sign_in: { url: { host: 'evil.test', path: '/login' }, human_only: false },
    });
    const run = await cliHarness({
      argv: ['sitepacks', 'verify', '/p/github.com.json', '--json'],
      files: { '/p/github.com.json': bad },
    });
    expect(run.code).toBe(1);
    const report = Report.parse(JSON.parse(run.stdout));
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('invalid');
    expect(report.issues.some((i) => i.path.startsWith('sign_in'))).toBe(true);
  });

  it('a hostile file cannot drive the terminal: escapes in its strings print as U+FFFD (verify #83 N2)', async () => {
    // A key and an id that would overdraw the line with a fake "✓ valid" if printed raw.
    const evilKey = '\u001b[2K\r\u001b[32m✓ valid\u001b[0m';
    const evilId = '\u001b]8;;https://evil.test\u0007x\u001b]8;;\u0007';
    const bad = JSON.stringify({ ...PACK, id: evilId, [evilKey]: 1 });
    for (const json of [false, true]) {
      const run = await cliHarness({
        argv: ['sitepacks', 'verify', '/p/github.com.json', ...(json ? ['--json'] : [])],
        files: { '/p/github.com.json': bad },
      });
      expect(run.code).toBe(1);
      expect(run.stdout).not.toContain('\u001b');
      expect(run.stdout).toContain('\ufffd');
      expect(run.stdout).not.toContain('\u0007');
      expect(run.stderr).not.toContain('\u001b');
    }
  });

  it('a file named for another pack, a missing file, an unknown key', async () => {
    const renamed = await cliHarness({
      argv: ['sitepacks', 'verify', '/p/x.com.json'],
      files: { '/p/x.com.json': GITHUB },
    });
    expect(renamed.code).toBe(1);
    expect(renamed.stdout).toContain('id_mismatch');
    const missing = await cliHarness({ argv: ['sitepacks', 'verify', '/nope.json'] });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain('cannot read /nope.json');
    const extra = await cliHarness({
      argv: ['sitepacks', 'verify', join('/p', 'github.com.json')],
      files: { '/p/github.com.json': JSON.stringify({ ...PACK, script: 'x' }) },
    });
    expect(extra.code).toBe(1);
  });

  it('without a path is a usage error (64)', async () => {
    const run = await cliHarness({ argv: ['sitepacks', 'verify'] });
    expect(run.code).toBe(64);
    expect(run.stderr).toContain('requires a path argument');
  });
});
