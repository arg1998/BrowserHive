/** @module app/config/resolve.ladder.test — unit tests for resolve.ladder */
import { describe, expect, it } from 'bun:test';
import type { ConfigKey, ProvenanceSource } from '@browserhive/contracts/config';
import { fakeHost, GIB, resolveOk, TOKEN_A, TOKEN_B } from './test-support.ts';

const FILE = '/work/browserhive.config.json';

interface LadderRow {
  readonly name: string;
  readonly key: ConfigKey;
  readonly env?: Record<string, string>;
  readonly file?: Record<string, unknown>;
  readonly argv?: readonly string[];
  readonly value: unknown;
  readonly source: ProvenanceSource;
  readonly shadow?: string;
}

const ROWS: readonly LadderRow[] = [
  {
    name: 'defaults apply when nothing is supplied',
    key: 'port',
    value: 9876,
    source: 'default',
  },
  {
    name: 'env beats default',
    key: 'port',
    env: { BROWSERHIVE_PORT: '1234' },
    value: 1234,
    source: 'env',
  },
  {
    name: 'file beats env',
    key: 'logLevel',
    env: { BROWSERHIVE_LOG_LEVEL: 'info' },
    file: { logLevel: 'debug' },
    value: { root: 'debug', modules: {} },
    source: 'file',
    shadow: 'config: logLevel=debug (config-file) shadows env=info',
  },
  {
    name: 'cli beats file and env, shadows listed highest first',
    key: 'maxSessions',
    env: { BROWSERHIVE_MAX_SESSIONS: '2' },
    file: { maxSessions: 4 },
    argv: ['--maxSessions', '8'],
    value: 8,
    source: 'cli',
    shadow: 'config: maxSessions=8 (cli) shadows config-file=4, env=2',
  },
  {
    name: 'secrets are redacted on both sides of a shadow line',
    key: 'authTokens',
    env: { BROWSERHIVE_AUTH_TOKENS: TOKEN_B },
    argv: ['--authTokens', TOKEN_A],
    value: [TOKEN_A],
    source: 'cli',
    shadow: 'config: authTokens=<redacted> (cli) shadows env=<redacted>',
  },
  {
    name: 'durations render canonically in shadow lines',
    key: 'sessionLease',
    env: { BROWSERHIVE_SESSION_LEASE: '7200000' },
    argv: ['--sessionLease', '90m'],
    value: 5_400_000,
    source: 'cli',
    shadow: 'config: sessionLease=90m (cli) shadows env=2h',
  },
  {
    name: 'bytes render canonically',
    key: 'retentionBytes',
    file: { retentionBytes: '2GiB' },
    argv: ['--retentionBytes', String(3 * 1024 ** 3)],
    value: 3 * 1024 ** 3,
    source: 'cli',
    shadow: 'config: retentionBytes=3GiB (cli) shadows config-file=2GiB',
  },
  {
    name: 'rightmost cli occurrence wins for scalars',
    key: 'port',
    argv: ['--port', '1', '--port=2'],
    value: 2,
    source: 'cli',
  },
  {
    name: 'repeated list flags concatenate, JSON arrays are accepted',
    key: 'trustedProxies',
    file: { trustedProxies: ['10.0.0.0/8'], host: '0.0.0.0', auth: 'token' },
    argv: ['--trustedProxies', '192.168.0.1', '--trustedProxies', '10.1.0.0/16,fe80::1'],
    value: ['192.168.0.1', '10.1.0.0/16', 'fe80::1'],
    source: 'cli',
    shadow:
      'config: trustedProxies=192.168.0.1,10.1.0.0/16,fe80::1 (cli) shadows config-file=10.0.0.0/8',
  },
  {
    name: 'maps parse k=v pairs and JSON objects',
    key: 'otelHeaders',
    env: { BROWSERHIVE_OTEL: 'true', BROWSERHIVE_OTEL_HEADERS: 'Authorization=Bearer x=y' },
    file: { otelHeaders: { 'X-Team': 'lab' } },
    value: { 'X-Team': 'lab' },
    source: 'file',
    shadow: 'config: otelHeaders=<redacted> (config-file) shadows env=<redacted>',
  },
  {
    name: 'boolean grammar accepts yes/no/1/0 case-insensitively',
    key: 'humanize',
    env: { BROWSERHIVE_HUMANIZE: 'YES' },
    value: true,
    source: 'env',
  },
  {
    name: '--noKey negates a boolean',
    key: 'admin',
    env: { BROWSERHIVE_ADMIN: '1' },
    argv: ['--noAdmin'],
    value: false,
    source: 'cli',
    shadow: 'config: admin=false (cli) shadows env=true',
  },
  {
    name: '--key=false sets a boolean false',
    key: 'defaultHeadless',
    argv: ['--defaultHeadless=false'],
    value: false,
    source: 'cli',
  },
  {
    name: 'unbounded maxSessions is accepted from JSON strings',
    key: 'maxSessions',
    file: { maxSessions: 'unbounded' },
    value: 'unbounded',
    source: 'file',
  },
  {
    name: 'level spec with module overrides',
    key: 'logLevel',
    argv: ['--logLevel', 'info,sessions=debug,http=warn'],
    value: { root: 'info', modules: { sessions: 'debug', http: 'warn' } },
    source: 'cli',
  },
];

describe('resolveConfig ladder (defaults < env < file < cli)', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const files = row.file === undefined ? {} : { [FILE]: JSON.stringify(row.file) };
      const bundle = resolveOk({ env: row.env ?? {}, argv: row.argv ?? [], files });
      expect<unknown>(bundle.config[row.key]).toEqual(row.value);
      expect(bundle.provenance[row.key].source).toBe(row.source);
      const lines = bundle.diagnostics.shadowLines.map((line) => line.text);
      if (row.shadow === undefined) {
        expect(bundle.provenance[row.key].shadowed).toEqual([]);
      } else {
        expect(lines).toContain(row.shadow);
      }
      if (row.file !== undefined) expect(bundle.configFilePath).toBe(FILE);
    });
  }

  it('records the location of the winning source', () => {
    const bundle = resolveOk({
      env: { BROWSERHIVE_PORT: '1' },
      files: { [FILE]: '{"port": 2}' },
      argv: ['--port', '3'],
    });
    expect(bundle.provenance.port).toEqual({
      key: 'port',
      source: 'cli',
      rendered: '3',
      location: '--port',
      shadowed: [
        { source: 'file', raw: '2', location: `file:${FILE}#port` },
        { source: 'env', raw: '1', location: 'BROWSERHIVE_PORT' },
      ],
    });
    expect(bundle.explicitKeys.has('port')).toBe(true);
    expect(bundle.explicitKeys.has('host')).toBe(false);
  });

  it('emits exactly one shadow line per multiply-supplied key, in registry order', () => {
    const bundle = resolveOk({
      env: { BROWSERHIVE_PORT: '1', BROWSERHIVE_STEALTH: 'off' },
      argv: ['--stealth', 'max', '--port', '2'],
    });
    expect(bundle.diagnostics.shadowLines.map((l) => l.key)).toEqual(['port', 'stealth']);
  });
});

describe('derived defaults', () => {
  it('derives trace from admin, fingerprint from stealth, maxSessions from RAM, dataDir from the OS', () => {
    const bundle = resolveOk({ argv: ['--admin', '--stealth', 'max'] });
    expect(bundle.config.trace).toBe(true);
    expect(bundle.provenance.trace).toEqual({
      key: 'trace',
      source: 'derived',
      rendered: 'true',
      derivedFrom: 'admin',
      shadowed: [],
    });
    expect(bundle.config.fingerprint).toBe(true);
    expect(bundle.provenance.fingerprint).toMatchObject({
      source: 'derived',
      derivedFrom: 'stealth',
    });
    expect(bundle.config.maxSessions).toBe(8);
    expect(bundle.provenance.maxSessions).toMatchObject({
      source: 'derived',
      derivedFrom: 'hostMemory',
      rendered: '8',
    });
    expect(bundle.config.dataDir).toBe('/home/tester/.local/share/browserhive');
    expect(bundle.provenance.dataDir).toMatchObject({ source: 'derived', derivedFrom: 'platform' });
  });

  it('derives false values when the inputs are off', () => {
    const bundle = resolveOk();
    expect(bundle.config.trace).toBe(false);
    expect(bundle.config.fingerprint).toBe(false);
    expect(bundle.provenance.trace.source).toBe('derived');
  });

  it('explicit values replace the derivation and carry their own provenance', () => {
    const bundle = resolveOk({ argv: ['--trace', '--maxSessions', '3', '--dataDir', '/srv/bh'] });
    expect(bundle.provenance.trace).toMatchObject({ source: 'cli', location: '--trace' });
    expect(bundle.provenance.maxSessions).toMatchObject({ source: 'cli', rendered: '3' });
    expect(bundle.provenance.dataDir).toMatchObject({ source: 'cli', rendered: '/srv/bh' });
    expect(bundle.provenance.trace.derivedFrom).toBeUndefined();
  });

  it('clamps the RAM derivation to [1, 20]', () => {
    expect(resolveOk({ host: fakeHost({ totalMemoryBytes: 1 * GIB }) }).config.maxSessions).toBe(1);
    expect(resolveOk({ host: fakeHost({ totalMemoryBytes: 64 * GIB }) }).config.maxSessions).toBe(
      20,
    );
    expect(resolveOk({ host: fakeHost({ totalMemoryBytes: 32 * GIB }) }).config.maxSessions).toBe(
      20,
    );
    expect(resolveOk({ host: fakeHost({ totalMemoryBytes: 16 * GIB }) }).config.maxSessions).toBe(
      10,
    );
  });

  it('uses the OS data-dir defaults of D-24', () => {
    const darwin = fakeHost({ platform: 'darwin', homeDir: '/Users/me' });
    expect(resolveOk({ host: darwin }).config.dataDir).toBe(
      '/Users/me/Library/Application Support/BrowserHive',
    );
    const win = fakeHost({
      platform: 'win32',
      homeDir: '/Users/me',
      env: { LOCALAPPDATA: '/lad' },
    });
    expect(resolveOk({ host: win }).config.dataDir).toBe('/lad/BrowserHive');
    const winNoLad = fakeHost({ platform: 'win32', homeDir: '/Users/me' });
    expect(resolveOk({ host: winNoLad }).config.dataDir).toBe(
      '/Users/me/AppData/Local/BrowserHive',
    );
    const xdg = fakeHost({ env: { XDG_DATA_HOME: '/xdg' } });
    expect(resolveOk({ host: xdg }).config.dataDir).toBe('/xdg/browserhive');
  });
});
