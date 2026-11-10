/** @module test/cli/doctor-templates.test — the session-template rows of `browserhive doctor` (spec 13 §11.9): data modes, key, display, agents, browsers, profiles, proxies and memory, with injected probes, an in-memory data dir and a read-only, never-migrating database read. */
import { describe, expect, it } from 'bun:test';
import { decodeTemplateKey, templateKeyOf } from '@browserhive/core/server';
import { z } from 'zod';
import type { TemplateRowFacts } from '../../src/cli/deps.ts';
import {
  cliHarness,
  DATA_DIR,
  detected,
  MemoryFs,
  type ProbeState,
  probeState,
  storageState,
} from './helpers.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const ID = 'tp-abcdefghij';
const NOW = 1_758_000_000_000;

function keyId(text: string): string {
  const bytes = decodeTemplateKey(text);
  if (bytes === null) throw new Error('bad test key');
  return templateKeyOf(bytes).keyId;
}

function row(overrides: Partial<TemplateRowFacts> = {}): TemplateRowFacts {
  return {
    templateId: ID,
    name: 'job-hunt',
    channel: 'chromium',
    headless: false,
    chromeMajor: '153',
    proxyPasswordEnv: null,
    lastUsedAt: null,
    ...overrides,
  };
}

/** A data dir with the database, one template directory with v1 and the key file. */
function dataFs(options: { key?: boolean } = {}): MemoryFs {
  const fs = new MemoryFs({ [`${DATA_DIR}/browserhive.db`]: 'db' });
  fs.put(`${DATA_DIR}/templates/${ID}/versions/v1.state.enc`, 'sealed');
  fs.put(`${DATA_DIR}/templates/${ID}/versions/v1.meta.json`, '{}');
  fs.ensureDir(`${DATA_DIR}/admin`);
  if (options.key !== false) fs.put(`${DATA_DIR}/admin/template.key`, `${KEY}\n`);
  return fs;
}

function files(key: string): ProbeState['templateFiles'] {
  return [{ templateId: ID, file: 'v1.state.enc', keyId: keyId(key) }];
}

const Row = z.object({
  check: z.string(),
  status: z.enum(['ok', 'warn', 'fail']),
  detail: z.string(),
});

async function doctor(options: {
  argv?: string[];
  rows?: TemplateRowFacts[];
  fs?: MemoryFs;
  probes?: Partial<ProbeState>;
  env?: Record<string, string>;
}) {
  const storage = storageState({ templateRows: options.rows ?? [row()] });
  const run = await cliHarness({
    argv: ['doctor', '--json', '--auth', 'token', ...(options.argv ?? [])],
    fs: options.fs ?? dataFs(),
    storage,
    probes: probeState({ templateFiles: files(KEY), ...options.probes }),
    env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11', ...options.env },
    overrides: { clock: { now: () => NOW } },
  });
  const rows = z.array(Row).parse(JSON.parse(run.stdout));
  return { run, storage, byName: new Map(rows.map((r) => [r.check, r])) };
}

const CHECKS = [
  'templates data',
  'template key',
  'template display',
  'template agents',
  'template browsers',
  'template profiles',
  'template proxies',
  'template memory',
];

describe('doctor template checks', () => {
  it('lists nothing while no template exists', async () => {
    const { byName } = await doctor({
      rows: [],
      fs: new MemoryFs({ [`${DATA_DIR}/browserhive.db`]: 'db' }),
      probes: { templateFiles: [] },
    });
    for (const check of CHECKS) expect(byName.has(check)).toBe(false);
  });

  it('a healthy template passes every row, reading the database read-only', async () => {
    const { byName, storage } = await doctor({});
    for (const check of CHECKS) expect(byName.get(check)?.status).toBe('ok');
    expect(byName.get('template key')?.detail).toContain('admin/template.key · 1 file(s) on it');
    expect(storage.opened.every((o) => o.readOnly && !o.migrate)).toBe(true);
  });

  it('templates data: modes broader than owner-only are a warning', async () => {
    const { byName } = await doctor({
      probes: {
        modes: {
          [`${DATA_DIR}/templates`]: 0o755,
          [`${DATA_DIR}/templates/${ID}/versions/v1.state.enc`]: 0o644,
        },
      },
    });
    const data = byName.get('templates data');
    expect(data?.status).toBe('warn');
    expect(data?.detail).toContain(`${DATA_DIR}/templates (0755)`);
    expect(data?.detail).toContain('v1.state.enc (0644)');
  });

  it('template key: files and no key is TEMPLATE_KEY_MISSING', async () => {
    const { byName } = await doctor({ fs: dataFs({ key: false }) });
    const key = byName.get('template key');
    expect(key?.status).toBe('fail');
    expect(key?.detail).toContain('[TEMPLATE_KEY_MISSING] 1 encrypted file(s) and no key resolves');
  });

  it('template key: another key id, the previous key, a broad key file and a flag are warnings', async () => {
    const foreign = await doctor({ probes: { templateFiles: files(OTHER_KEY) } });
    expect(foreign.byName.get('template key')?.status).toBe('warn');
    expect(foreign.byName.get('template key')?.detail).toContain(
      'job-hunt: 1 file(s) written with another key cannot be read',
    );
    const previous = await doctor({
      probes: { templateFiles: files(OTHER_KEY) },
      env: { BROWSERHIVE_TEMPLATE_KEY_PREVIOUS: OTHER_KEY },
    });
    expect(previous.byName.get('template key')?.detail).toContain(
      '1 file(s) still on templateKeyPrevious',
    );
    const broad = await doctor({
      probes: { modes: { [`${DATA_DIR}/admin/template.key`]: 0o644 } },
    });
    expect(broad.byName.get('template key')?.detail).toContain('has mode 0644');
    const flag = await doctor({ argv: ['--templateKey', KEY], fs: dataFs({ key: false }) });
    expect(flag.byName.get('template key')?.status).toBe('warn');
    expect(flag.byName.get('template key')?.detail).toContain('given as a command-line flag');
    expect(flag.run.stdout).not.toContain(KEY);
    const env = await doctor({
      env: { BROWSERHIVE_TEMPLATE_KEY: KEY },
      fs: dataFs({ key: false }),
    });
    expect(env.byName.get('template key')).toMatchObject({
      status: 'ok',
      detail: 'from templateKey · 1 file(s) on it',
    });
  });

  it('template display: no display fails with guidance; DISPLAY without XAUTHORITY warns; headless passes', async () => {
    const none = await doctor({
      rows: [row({ chromeMajor: null })],
      env: { DISPLAY: '', XDG_SESSION_TYPE: '' },
    });
    expect(none.byName.get('template display')?.status).toBe('fail');
    expect(none.byName.get('template display')?.detail).toContain('Xvfb :99 -auth <file>');
    expect(none.byName.get('template display')?.detail).toContain('VNC');
    const started = await doctor({ env: { DISPLAY: '', XDG_SESSION_TYPE: '' } });
    expect(started.byName.get('template display')?.status).toBe('ok');
    const xvfb = await doctor({ env: { DISPLAY: ':99', XDG_SESSION_TYPE: '' } });
    expect(xvfb.byName.get('template display')?.status).toBe('warn');
    expect(xvfb.byName.get('template display')?.detail).toContain('without XAUTHORITY');
    const authed = await doctor({
      env: { DISPLAY: ':99', XDG_SESSION_TYPE: '', XAUTHORITY: '/tmp/xa' },
    });
    expect(authed.byName.get('template display')?.status).toBe('ok');
    const headless = await doctor({
      rows: [row({ headless: true, chromeMajor: null })],
      env: { DISPLAY: '' },
    });
    expect(headless.byName.get('template display')?.detail).toBe('every template is headless');
  });

  it('template agents: stdio or auth=off is the separate-user warning', async () => {
    const off = await doctor({ argv: ['--auth', 'off'] });
    expect(off.byName.get('template agents')).toMatchObject({
      status: 'warn',
      detail:
        'agents that can run commands as this user can read the templates directly; run BrowserHive as a separate user or in a container, over HTTP with per-agent tokens',
    });
  });

  it('template browsers: a missing channel fails with the install command; a new major warns', async () => {
    const missing = await doctor({
      rows: [row({ channel: 'edge' })],
      probes: { browsers: [detected('chromium')] },
    });
    expect(missing.byName.get('template browsers')?.status).toBe('fail');
    expect(missing.byName.get('template browsers')?.detail).toContain('install Microsoft Edge');
    const drift = await doctor({ rows: [row({ chromeMajor: '150' })] });
    expect(drift.byName.get('template browsers')).toMatchObject({ status: 'warn' });
    expect(drift.byName.get('template browsers')?.detail).toContain('job-hunt (150 → 153)');
  });

  it('template profiles: saved passwords or autofill data warn, naming the template', async () => {
    const { byName } = await doctor({
      probes: { profileSecrets: [`${DATA_DIR}/templates/${ID}/userdata`] },
    });
    expect(byName.get('template profiles')?.status).toBe('warn');
    expect(byName.get('template profiles')?.detail).toStartWith('job-hunt: saved passwords');
  });

  it('template proxies: an unset password variable fails by name, never a value', async () => {
    const rows = [row({ proxyPasswordEnv: 'BH_PROXY_PW' })];
    const unset = await doctor({ rows });
    expect(unset.byName.get('template proxies')).toEqual({
      check: 'template proxies',
      status: 'fail',
      detail: 'job-hunt: BH_PROXY_PW is not set',
    });
    const set = await doctor({ rows, env: { BH_PROXY_PW: 's3cret-value' } });
    expect(set.byName.get('template proxies')?.status).toBe('ok');
    expect(set.run.stdout).not.toContain('s3cret-value');
  });

  it('template memory: recently used templates count at templateRecycleRss', async () => {
    const rows = ['a1', 'b1', 'c1'].map((name, i) =>
      row({ templateId: `tp-${name}aaaaaaa`, name, lastUsedAt: NOW - i * 3_600_000 }),
    );
    const tight = await doctor({ rows, argv: ['--maxSessions', '10'] });
    expect(tight.byName.get('template memory')?.status).toBe('warn');
    expect(tight.byName.get('template memory')?.detail).toContain(
      'need about 19.5 GiB; 16.0 GiB RAM',
    );
    const fits = await doctor({ rows, argv: ['--maxSessions', '4'] });
    expect(fits.byName.get('template memory')?.status).toBe('ok');
    const stale = await doctor({
      rows: [row({ lastUsedAt: NOW - 2 * 86_400_000 })],
      argv: ['--maxSessions', '10'],
    });
    expect(stale.byName.get('template memory')?.detail).toBe('no template used in the last 24 h');
  });
});
