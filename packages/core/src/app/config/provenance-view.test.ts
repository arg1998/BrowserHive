/** @module app/config/provenance-view.test — unit tests for provenance-view */
import { describe, expect, it } from 'bun:test';
import { CONFIG_KEYS, keyMeta } from '@browserhive/contracts/config';
import { configShowRows, configSourceSummary, configView, shadowLines } from './provenance-view.ts';
import { resolveOk, TOKEN_A, TOKEN_B } from './test-support.ts';

const FILE = '/work/browserhive.config.json';

function bundle() {
  return resolveOk({
    env: {
      BROWSERHIVE_MAX_SESSIONS: '2',
      BROWSERHIVE_AUTH_TOKENS: TOKEN_B,
      BROWSERHIVE_OTEL: 'true',
      OTEL_SERVICE_NAME: 'lab',
    },
    files: { [FILE]: '{"maxSessions": 4, "logLevel": "debug", "otelHeaders": {"a": "b"}}' },
    argv: ['--maxSessions', '8', '--authTokens', TOKEN_A, '--admin'],
  });
}

describe('configShowRows', () => {
  it('renders one row per key with redacted secrets, labels and shadowed sources', () => {
    const rows = configShowRows(bundle().provenance);
    expect(rows.map((r) => r.key)).toEqual([...CONFIG_KEYS]);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey['maxSessions']).toEqual({
      key: 'maxSessions',
      value: '8',
      source: 'cli',
      shadowed: ['config-file=4', 'env=2'],
    });
    expect(byKey['authTokens']).toEqual({
      key: 'authTokens',
      value: '<redacted>',
      source: 'cli',
      shadowed: ['env=<redacted>'],
    });
    expect(byKey['otelHeaders']).toMatchObject({ value: '<redacted>', source: 'config-file' });
    expect(byKey['trace']).toEqual({
      key: 'trace',
      value: 'true',
      source: 'derived (admin)',
      shadowed: [],
    });
    expect(byKey['blocklist']).toEqual({
      key: 'blocklist',
      value: '—',
      source: 'default',
      shadowed: [],
    });
    expect(byKey['otelServiceName']).toMatchObject({ value: 'lab', source: 'env(otel)' });
    expect(byKey['sessionLease']).toMatchObject({ value: '2h', source: 'default' });
  });
});

describe('configView', () => {
  it('replaces secrets with { redacted: true } and keeps typed values elsewhere', () => {
    const { config, provenance } = bundle();
    const view = configView(config, provenance);
    expect(view.authTokens.value).toEqual({ redacted: true });
    expect(view.otelHeaders.value).toEqual({ redacted: true });
    expect(view.maxSessions).toEqual({
      value: 8,
      source: 'cli',
      location: '--maxSessions',
      shadowed: [
        { source: 'file', value: '4', location: `file:${FILE}#maxSessions` },
        { source: 'env', value: '2', location: 'BROWSERHIVE_MAX_SESSIONS' },
      ],
      restartRequired: true,
    });
    expect(view.logLevel).toMatchObject({
      value: { root: 'debug', modules: {} },
      source: 'file',
      restartRequired: false,
    });
    expect(view.trace).toMatchObject({ value: true, source: 'derived', derivedFrom: 'admin' });
    expect(view.blocklist).toMatchObject({ value: undefined, source: 'default' });
    expect(Object.keys(view)).toEqual([...CONFIG_KEYS]);
    for (const key of CONFIG_KEYS) {
      if (keyMeta(key).secret) expect(view[key].value).toEqual({ redacted: true });
    }
    expect(JSON.stringify(view)).not.toContain(TOKEN_A.slice(8));
  });
});

describe('shadowLines', () => {
  it('matches the resolver diagnostics and the spec format', () => {
    const b = bundle();
    expect(shadowLines(b.provenance)).toEqual(b.diagnostics.shadowLines);
    expect(shadowLines(b.provenance).map((l) => l.text)).toEqual([
      'config: authTokens=<redacted> (cli) shadows env=<redacted>',
      'config: maxSessions=8 (cli) shadows config-file=4, env=2',
    ]);
  });
});

describe('configSourceSummary', () => {
  it('counts keys per source for the banner', () => {
    const b = bundle();
    expect(configSourceSummary(b.provenance, b.configFilePath)).toBe(
      `env:3  env(otel):1  file:${FILE}:3  cli:3`,
    );
    expect(configSourceSummary(resolveOk().provenance, undefined)).toBe('none');
  });
});
