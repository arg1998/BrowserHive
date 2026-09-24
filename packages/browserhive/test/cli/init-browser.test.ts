/** @module test/cli/init-browser — `init`'s browser step: detection report, the menu (Enter never changes anything), non-interactive flags, the Chrome install and the config-file merge. */
import { describe, expect, it } from 'bun:test';
import type { Channel } from '@browserhive/contracts/enums';
import type { SandboxProbeResult } from '@browserhive/core/server';
import { menuEntries, renderMenu, sandboxSummary } from '../../src/cli/commands/init-browser.ts';
import {
  cliHarness,
  DATA_DIR,
  detected,
  MemoryFs,
  probeState,
  sandboxEnvironment,
} from './helpers.ts';

const CONFIG = `${DATA_DIR}/browserhive.config.json`;
const works = { state: 'works', version: '154.0.8037.57' } as const;
const unavailable = { state: 'unavailable', reason: 'No usable sandbox!' } as const;
const ubuntu = sandboxEnvironment({ apparmorRestrictsUserns: true });

/** A host with Chrome installed (sandboxes) and the bundled browser blocked by AppArmor. */
function chromeHost() {
  return probeState({
    browsers: [detected('chromium'), detected('chrome', { installed: true }), detected('edge')],
    sandbox: { chromium: unavailable, chrome: works },
    environment: ubuntu,
  });
}

function dataDirFs(): MemoryFs {
  const fs = new MemoryFs();
  fs.ensureDir(DATA_DIR);
  return fs;
}

describe('init: detection report', () => {
  it('non-interactive: report only, no prompt, nothing written, exit 0', async () => {
    const fs = dataDirFs();
    const run = await cliHarness({ argv: ['init', '--skipBrowsers'], fs, probes: chromeHost() });
    expect(run.code).toBe(0);
    expect(run.prompts).toEqual([]);
    expect(run.stdout).toContain(
      '✓ chromium    Chrome for Testing 153.0.8010.12 (bundled, always kept)',
    );
    expect(run.stdout).toContain(
      '✓ chrome      Google Chrome 154.0.8037.57 at /opt/google/chrome/chrome',
    );
    expect(run.stdout).toContain('– edge        not installed');
    expect(run.stdout).toContain(
      '! sandbox     chrome: works · chromium: unavailable here (AppArmor), falls back',
    );
    expect(run.stdout).toContain('✓ default browser  chromium');
    expect(fs.writes.filter((w) => w.startsWith('write'))).toEqual([]);
  });

  it('never prompts in CI even on a terminal', async () => {
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers'],
      env: { CI: 'true' },
      answers: ['2'],
      fs: dataDirFs(),
      probes: chromeHost(),
    });
    expect(run.prompts).toEqual([]);
    expect(run.code).toBe(0);
  });

  it('never prompts in a container', async () => {
    const probes = chromeHost();
    probes.environment = sandboxEnvironment({ container: true });
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers'],
      answers: ['2'],
      fs: dataDirFs(),
      probes,
    });
    expect(run.prompts).toEqual([]);
  });
});

describe('init: the menu', () => {
  it('Enter keeps the current choice: no save prompt, nothing written', async () => {
    const fs = dataDirFs();
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers'],
      answers: [''],
      fs,
      probes: chromeHost(),
    });
    expect(run.code).toBe(0);
    expect(run.prompts).toEqual(['Choice [1]: ']);
    expect(run.stdout).toContain('Which browser should sessions use by default?');
    expect(run.stdout).toMatch(/1\) Chromium \(bundled\)\s+← current/);
    expect(run.stdout).toMatch(
      /2\) Google Chrome \(installed 154\.0\.8037\.57\)\s+recommended for stealth/,
    );
    expect(run.stdout).toContain('✓ default browser  chromium');
    expect(fs.writes.filter((w) => w.startsWith('write'))).toEqual([]);
  });

  it('picking Chrome asks to save, then creates the config file in the data dir (0600)', async () => {
    const fs = dataDirFs();
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers'],
      answers: ['2', ''],
      fs,
      probes: chromeHost(),
    });
    expect(run.code).toBe(0);
    expect(run.prompts).toEqual([
      'Choice [1]: ',
      `Save defaultChannel=chrome to ${CONFIG}? [Y/n] `,
    ]);
    expect(JSON.parse(await fs.readFile(CONFIG))).toEqual({ defaultChannel: 'chrome' });
    expect(fs.entries.get(CONFIG)?.mode).toBe(0o600);
    expect(run.stdout).toContain(
      `✓ saved  defaultChannel=chrome in ${CONFIG}. Override any time with --defaultChannel or BROWSERHIVE_DEFAULT_CHANNEL.`,
    );
  });

  it('answering n to the save leaves everything as it was', async () => {
    const fs = dataDirFs();
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers'],
      answers: ['2', 'n'],
      fs,
      probes: chromeHost(),
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('✓ default browser  chromium (not saved)');
    expect(await fs.stat(CONFIG)).toBeNull();
  });

  it('an existing config file is merged: other keys, order and $schema kept', async () => {
    const fs = new MemoryFs({
      '/work/browserhive.config.json': JSON.stringify({
        $schema: './browserhive.schema.json',
        port: 9000,
        defaultChannel: 'chromium',
        admin: true,
      }),
    });
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers', '--channel', 'chrome', '--yes'],
      fs,
      probes: chromeHost(),
    });
    expect(run.code).toBe(0);
    expect(await fs.readFile('/work/browserhive.config.json')).toBe(
      `${JSON.stringify(
        {
          $schema: './browserhive.schema.json',
          port: 9000,
          defaultChannel: 'chrome',
          admin: true,
        },
        null,
        2,
      )}\n`,
    );
  });

  it('an invalid number is asked again; the install entry is offered when Chrome is missing', async () => {
    const probes = probeState({ environment: ubuntu, sandbox: { chromium: unavailable } });
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers'],
      answers: ['9', ''],
      fs: dataDirFs(),
      probes,
    });
    expect(run.prompts).toEqual(['Choice [1]: ', 'Choice [1]: ']);
    expect(run.stdout).toContain('Type a number from 1 to 2, or press Enter to keep chromium.');
    expect(run.stdout).toMatch(
      /2\) Install Google Chrome \(needs administrator rights\)\s+recommended for stealth/,
    );
  });

  it('choosing the install entry runs playwright install chrome, then saves chrome', async () => {
    const probes = probeState({ environment: ubuntu, sandbox: { chromium: unavailable } });
    const fs = dataDirFs();
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers'],
      answers: ['2', 'y'],
      fs,
      probes,
      run: (_command, args) => {
        if (args.includes('chrome')) {
          probes.browsers = [
            detected('chromium'),
            detected('chrome', { installed: true }),
            detected('edge'),
          ];
          probes.sandbox = { chromium: unavailable, chrome: works };
        }
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    expect(run.code).toBe(0);
    expect(run.runs).toEqual([
      { command: '/usr/bin/bun', args: ['/pkg/playwright/cli.js', 'install', 'chrome'] },
    ]);
    expect(run.stdout).toContain('✓ Google Chrome  installed 154.0.8037.57');
    expect(JSON.parse(await fs.readFile(CONFIG))).toEqual({ defaultChannel: 'chrome' });
  });
});

describe('init: non-interactive flags', () => {
  it('--channel without --yes and without a terminal refuses to write (exit 1)', async () => {
    const fs = dataDirFs();
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers', '--channel', 'chrome'],
      fs,
      probes: chromeHost(),
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      `✗ default browser  not saved: add --yes to write defaultChannel=chrome to ${CONFIG} without a prompt`,
    );
    expect(await fs.stat(CONFIG)).toBeNull();
  });

  it('--channel chrome --yes saves without a prompt', async () => {
    const fs = dataDirFs();
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers', '--channel', 'chrome', '--yes'],
      fs,
      probes: chromeHost(),
    });
    expect(run.code).toBe(0);
    expect(run.prompts).toEqual([]);
    expect(JSON.parse(await fs.readFile(CONFIG))).toEqual({ defaultChannel: 'chrome' });
  });

  it('--channel for a browser that is not installed fails and changes nothing (no silent switch)', async () => {
    const fs = dataDirFs();
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers', '--channel', 'chrome', '--yes'],
      fs,
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      '✗ default browser  Google Chrome is not installed; add --installChrome. Nothing was changed.',
    );
    expect(await fs.stat(CONFIG)).toBeNull();
  });

  it('--installChrome installs without changing the default; a failure names the retry', async () => {
    const failed = await cliHarness({
      argv: ['init', '--skipBrowsers', '--installChrome'],
      fs: dataDirFs(),
      run: () => ({ code: 1, stdout: '', stderr: 'sudo: a password is required', timedOut: false }),
    });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(
      '✗ Google Chrome  install failed (exit 1): sudo: a password is required',
    );
    expect(failed.stdout).toContain('Retry with: npx playwright install chrome');
  });

  it('a flag or env var that overrides the file is pointed out after saving', async () => {
    const run = await cliHarness({
      argv: ['init', '--skipBrowsers', '--channel', 'chrome', '--yes'],
      env: { BROWSERHIVE_DEFAULT_CHANNEL: 'edge' },
      fs: dataDirFs(),
      probes: chromeHost(),
    });
    expect(run.stdout).toContain(
      '! default browser  BROWSERHIVE_DEFAULT_CHANNEL is set and still overrides the config file',
    );
  });

  it('--channel with an unknown browser is a usage error', async () => {
    const run = await cliHarness({ argv: ['init', '--channel', 'firefox'] });
    expect(run.code).toBe(64);
    expect(run.stderr).toContain(
      "invalid value for --channel: 'firefox'. Expected one of: chromium, chrome, edge.",
    );
  });
});

describe('menu contents are computed for the host', () => {
  it('Chrome is labelled, never pre-selected; sandbox pros and cons come from the probes', () => {
    const host = {
      browsers: [
        detected('chromium'),
        detected('chrome', { installed: true }),
        detected('edge', { installed: true, version: '153.0.4234.48' }),
      ],
      sandbox: new Map<Channel, SandboxProbeResult>([
        ['chromium', unavailable],
        ['chrome', works],
        ['edge', unavailable],
      ]),
      environment: ubuntu,
    };
    const entries = menuEntries(host, 'chromium', { platform: 'linux', arch: 'x64' });
    expect(entries.map((e) => [e.channel, e.tag])).toEqual([
      ['chromium', 'current'],
      ['chrome', 'recommended for stealth'],
      ['edge', null],
    ]);
    expect(entries[0]?.cons).toContain(
      'Runs without the sandbox here unless you add an AppArmor profile',
    );
    expect(entries[0]?.cons[0]).toBe(
      'Reports its pinned full version (153.0.8010.12); your Google Chrome is 154.0.8037.57',
    );
    expect(entries[1]?.pros).toContain('Sandbox works on this machine');
    expect(entries[2]?.cons).toContain('Cannot run sandboxed on this machine (AppArmor)');
    expect(entries[2]?.cons.join(' ')).toContain('presents it as Google Chrome');
    const lines = renderMenu(entries);
    expect(lines[2]).toMatch(/^ {2}1\) Chromium \(bundled\) +← current$/);
  });

  it('no install entry on Linux arm64, where Google ships no Chrome', () => {
    const host = {
      browsers: [detected('chromium'), detected('chrome'), detected('edge')],
      sandbox: new Map<Channel, SandboxProbeResult>(),
      environment: ubuntu,
    };
    expect(menuEntries(host, 'chromium', { platform: 'linux', arch: 'arm64' })).toHaveLength(1);
    expect(menuEntries(host, 'chromium', { platform: 'darwin', arch: 'arm64' })).toHaveLength(2);
  });

  it('the sandbox summary states the consequence of the mode', () => {
    const host = {
      browsers: [],
      sandbox: new Map<Channel, SandboxProbeResult>([
        ['chromium', unavailable],
        ['chrome', works],
      ]),
      environment: ubuntu,
    };
    expect(sandboxSummary(host, 'auto')).toBe(
      'chrome: works · chromium: unavailable here (AppArmor), falls back',
    );
    expect(sandboxSummary(host, 'on')).toBe(
      'chrome: works · chromium: unavailable here (AppArmor), refuses (sandbox=on)',
    );
    expect(
      sandboxSummary({ ...host, environment: sandboxEnvironment({ root: true }) }, 'auto'),
    ).toBe('running as root: Chrome refuses the sandbox, sessions run without it');
  });
});
