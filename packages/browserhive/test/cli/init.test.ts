/** @module test/cli/init — `browserhive init`: steps with ✓/✗, idempotent re-run ("already installed"), download failure exits 1 naming the retry command */
import { describe, expect, it } from 'bun:test';
import { configFileJsonSchema } from '@browserhive/contracts/config';
import { cliHarness, DATA_DIR, MemoryFs, probeState, storageState } from './helpers.ts';

const missing = {
  packageVersion: '1.63.0',
  executablePath: '/cache/chromium-1243/chrome',
  installed: false,
};

describe('init', () => {
  it("fresh host: creates the data dir, downloads Patchright's Chromium, migrates, prints next steps", async () => {
    const probes = probeState({ patchright: { ...missing } });
    const fs = new MemoryFs();
    const run = await cliHarness({
      argv: ['init'],
      fs,
      probes,
      storage: storageState({ userVersion: 0, pending: [{ version: 1, name: 'initial' }] }),
      run: () => {
        probes.patchright.installed = true;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`✓ data directory ${DATA_DIR}  created (0700)`);
    for (const sub of [
      'sessions',
      'auth-states',
      'uploads',
      'backups',
      'admin',
      'templates',
      'site-packs',
    ]) {
      expect(await fs.stat(`${DATA_DIR}/${sub}`)).not.toBeNull();
    }
    // Patchright is the only driver (D-65): nothing is downloaded for stock Playwright.
    expect(run.runs).toEqual([
      { command: '/usr/bin/bun', args: ['/pkg/patchright/cli.js', 'install', 'chromium'] },
    ]);
    expect(run.stdout).not.toContain('Playwright');
    expect(run.stdout).toContain('✓ Chromium for Patchright 1.63.0  installed');
    expect(run.stdout).toContain('✓ database schema v1  applied 1 migration');
    expect(run.storage.opened).toEqual([{ readOnly: false, migrate: true, owner: 'init' }]);
    expect(run.stdout).toContain('Next steps');
    expect(run.stdout).toContain('browserhive --admin');
  });

  it('is idempotent: a re-run reports already installed and downloads nothing', async () => {
    const fs = new MemoryFs();
    fs.ensureDir(DATA_DIR);
    const run = await cliHarness({ argv: ['init'], fs });
    expect(run.code).toBe(0);
    expect(run.runs).toEqual([]);
    expect(run.stdout).toContain('already exists');
    expect(run.stdout).toContain('✓ Chromium for Patchright 1.63.0  already installed');
    expect(run.stdout).toContain('✓ database schema v1  up to date');
  });

  it('--force re-downloads', async () => {
    const run = await cliHarness({ argv: ['init', '--force'] });
    expect(run.runs).toHaveLength(1);
  });

  it('the removed --stealthDriver: patchright warns and runs, playwright is a usage error (D-65)', async () => {
    const kept = await cliHarness({ argv: ['init', '--stealthDriver', 'patchright'] });
    expect(kept.code).toBe(0);
    expect(`${kept.stdout}${kept.stderr}`).toContain(
      '--stealthDriver is deprecated and ignored: Patchright is the only browser driver since 0.3.0. Remove it; from 0.4.0 it is an unknown key.',
    );
    const removed = await cliHarness({ argv: ['init', '--stealthDriver', 'playwright'] });
    expect(removed.code).toBe(64);
    expect(removed.stderr).toContain(
      "browserhive: --stealthDriver: the Playwright driver was removed in 0.3.0; every session runs on Patchright. Remove 'stealthDriver'. For a browser without BrowserHive's stealth patches, set stealth to off.",
    );
    expect(removed.runs).toEqual([]);
  });

  it('a failed download exits 1 with the exact retry command', async () => {
    const run = await cliHarness({
      argv: ['init'],
      probes: probeState({ patchright: { ...missing } }),
      run: () => ({
        code: 1,
        stdout: '',
        stderr: 'Downloading Chromium\nError: getaddrinfo ENOTFOUND cdn.playwright.dev',
        timedOut: false,
      }),
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      '✗ Chromium for Patchright  download failed (exit 1): Error: getaddrinfo ENOTFOUND cdn.playwright.dev',
    );
    expect(run.stdout).toContain('Retry with: bunx patchright@1.63.0 install chromium');
    expect(run.stdout).toContain(
      "Setup is incomplete. Fix the ✗ steps above and run 'browserhive init' again.",
    );
  });

  it('a missing patchright package is a failure: there is no other driver', async () => {
    const run = await cliHarness({
      argv: ['init'],
      probes: probeState({
        patchright: { packageVersion: null, executablePath: null, installed: false },
      }),
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      '✗ Chromium for Patchright  patchright package not installed; reinstall browserhive',
    );
  });

  it('--skipBrowsers skips downloads; a running server skips the database step', async () => {
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers'],
      lock: { pid: 7, owner: 'serve', startedAt: 1 },
    });
    expect(run.code).toBe(0);
    expect(run.runs).toEqual([]);
    expect(run.stdout).toContain('✓ browsers  skipped (--skipBrowsers)');
    expect(run.stdout).toContain('! database  skipped: in use by a running BrowserHive (pid 7)');
  });

  it('--writeSchema writes browserhive.schema.json next to the config file', async () => {
    const fs = new MemoryFs({ '/work/browserhive.config.json': '{"port": 9000}' });
    const run = await cliHarness({ argv: ['init', '--skipBrowsers', '--writeSchema'], fs });
    expect(run.code).toBe(0);
    const schema: unknown = JSON.parse(await fs.readFile('/work/browserhive.schema.json'));
    expect(schema).toEqual(JSON.parse(JSON.stringify(configFileJsonSchema())));
    expect(run.stdout).toContain('✓ schema file /work/browserhive.schema.json');
  });

  it('a database failure is reported as ✗ with exit 1', async () => {
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers'],
      openError: new Error('disk full'),
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('✗ database  disk full');
  });
});
