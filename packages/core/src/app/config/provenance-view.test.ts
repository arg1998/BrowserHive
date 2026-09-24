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

describe('references in the views (spec 08 §3.1, §7.1)', () => {
  const refs = () =>
    resolveOk({
      env: {
        OTLP_HOST: 'collector.internal',
        OTLP_TOKEN: 't'.repeat(40),
        BROWSERHIVE_MAX_SESSIONS: '2',
      },
      argv: ['--maxSessions', '8'],
      files: {
        [FILE]: JSON.stringify({
          otel: true,
          otelEndpoint: 'http://{env:OTLP_HOST}:4318',
          otelHeaders: { Authorization: 'Bearer {env:OTLP_TOKEN}' },
          maxSessions: '{env:MAX:-4}',
        }),
      },
    });

  it('config show: SOURCE names the variables, SHADOWED marks a shadowed file value', () => {
    const rows = Object.fromEntries(configShowRows(refs().provenance).map((r) => [r.key, r]));
    expect(rows['otelEndpoint']).toEqual({
      key: 'otelEndpoint',
      value: 'http://collector.internal:4318',
      source: 'config-file via $OTLP_HOST',
      shadowed: [],
    });
    expect(rows['otelHeaders']).toMatchObject({
      value: '<redacted>',
      source: 'config-file via $OTLP_TOKEN',
    });
    expect(rows['maxSessions']?.shadowed).toEqual(['config-file=4 via $MAX (default)', 'env=2']);
  });

  it('configView carries refs everywhere and a template only when the key is not secret', () => {
    const b = refs();
    const view = configView(b.config, b.provenance);
    expect(view.otelEndpoint).toMatchObject({
      refs: [{ scheme: 'env', ref: 'OTLP_HOST', from: 'value' }],
      template: 'http://{env:OTLP_HOST}:4318',
    });
    expect(view.otelHeaders.value).toEqual({ redacted: true });
    expect(view.otelHeaders.refs).toEqual([
      { scheme: 'env', ref: 'OTLP_TOKEN', from: 'value', at: 'Authorization' },
    ]);
    expect(view.otelHeaders.template).toBeUndefined();
    expect(view.maxSessions.shadowed[0]).toEqual({
      source: 'file',
      value: '4',
      location: `file:${FILE}#maxSessions`,
      refs: [{ scheme: 'env', ref: 'MAX', from: 'default' }],
    });
    expect(JSON.stringify(view)).not.toContain('t'.repeat(40));
  });

  it('the banner summary counts rungs, not references', () => {
    const b = refs();
    expect(configSourceSummary(b.provenance, b.configFilePath)).toBe(
      `env:1  file:${FILE}:4  cli:1`,
    );
  });
});
