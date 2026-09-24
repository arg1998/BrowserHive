/** @module interface/http/serializers/config-refs.redaction.test — invariant (spec 09 §3.2, 10 §9): a secret that reaches the config through a `{env:NAME}` reference never appears in a shadow line, a `config show` row, the config view, the wire, or a problem message; the variable's name always does (spec 08 §3.1) */
import { describe, expect, it } from 'bun:test';
import { SystemConfigKey } from '@browserhive/contracts/http';
import { configShowRows, configView, shadowLines } from '../../../app/config/provenance-view.ts';
import { secretConfigLiterals } from '../../../app/config/secret-literals.ts';
import { resolveErr, resolveOk } from '../../../app/config/test-support.ts';
import { SecretRegistry } from '../../../kernel/redact.ts';
import { configKeysToWire } from './system.ts';

const FILE = '/work/browserhive.config.json';

/** Low-entropy sentinels (gitleaks scans every commit): one per route into the config. */
const SENTINELS = {
  header: 'h'.repeat(40),
  token: 'k'.repeat(40),
  heuristic: 'q'.repeat(40),
  shadowedHeader: 'w'.repeat(40),
} as const;

/** Every surface a resolved configuration is rendered on. */
function surfaces(bundle: ReturnType<typeof resolveOk>): string {
  const view = configView(bundle.config, bundle.provenance);
  return JSON.stringify([
    bundle.provenance,
    bundle.diagnostics,
    shadowLines(bundle.provenance),
    configShowRows(bundle.provenance),
    view,
    configKeysToWire(view),
  ]);
}

describe('config references never leak a secret (invariant)', () => {
  const bundle = resolveOk({
    env: {
      OTLP_TOKEN: SENTINELS.header,
      CI_SECRET: SENTINELS.token,
      GRAFANA_API_TOKEN: SENTINELS.heuristic,
      OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer ${SENTINELS.shadowedHeader}`,
      BROWSERHIVE_OTEL_SERVICE_NAME: 'lab',
    },
    files: {
      [FILE]: JSON.stringify({
        otel: true,
        otelHeaders: { Authorization: 'Bearer {env:OTLP_TOKEN}', 'X-Team': 'ops-{env:CI_SECRET}' },
        authTokens: ['ci-runner:{env:CI_SECRET}', 'bot:{env:CI_SECRET}'],
        otelServiceName: '{env:GRAFANA_API_TOKEN}',
      }),
    },
  });

  it('keeps every sentinel out of every surface', () => {
    const rendered = surfaces(bundle);
    for (const sentinel of Object.values(SENTINELS)) expect(rendered).not.toContain(sentinel);
  });

  it('names every variable on every surface', () => {
    const rows = Object.fromEntries(configShowRows(bundle.provenance).map((r) => [r.key, r]));
    expect(rows['otelHeaders']?.source).toBe('config-file via $OTLP_TOKEN, $CI_SECRET');
    expect(rows['authTokens']?.source).toBe('config-file via $CI_SECRET');
    expect(rows['otelServiceName']).toMatchObject({
      value: '<redacted>',
      source: 'config-file via $GRAFANA_API_TOKEN',
      shadowed: ['env=<redacted>'],
    });
    const wire = configKeysToWire(configView(bundle.config, bundle.provenance));
    for (const row of wire) SystemConfigKey.parse(row);
    const byKey = Object.fromEntries(wire.map((row) => [row.key, row]));
    expect(byKey['otelHeaders']).toEqual({
      key: 'otelHeaders',
      value: '[REDACTED]',
      source: 'file',
      refs: [
        { scheme: 'env', ref: 'OTLP_TOKEN', from: 'value', at: 'Authorization' },
        { scheme: 'env', ref: 'CI_SECRET', from: 'value', at: 'X-Team' },
      ],
      shadowed: [{ source: 'env(otel)', value: '[REDACTED]' }],
      secret: true,
    });
    expect(byKey['otelServiceName']).toMatchObject({
      value: '[REDACTED]',
      secret: true,
      refs: [{ scheme: 'env', ref: 'GRAFANA_API_TOKEN', from: 'value' }],
      shadowed: [{ source: 'env', value: '[REDACTED]' }],
    });
    for (const key of ['otelHeaders', 'authTokens', 'otelServiceName']) {
      expect(byKey[key]?.template).toBeUndefined();
    }
  });

  it('registers what the references produced, so the scrub catches it in any later output', () => {
    const registry = new SecretRegistry({ now: () => 0 });
    for (const literal of [...secretConfigLiterals(bundle.config), ...bundle.referencedSecrets]) {
      registry.add(literal);
    }
    const line = `export failed: ${SENTINELS.header} ${SENTINELS.token} ${SENTINELS.heuristic}`;
    const scrubbed = registry.scrub(line);
    for (const sentinel of [SENTINELS.header, SENTINELS.token, SENTINELS.heuristic]) {
      expect(scrubbed).not.toContain(sentinel);
    }
  });

  it('keeps the sentinel out of every problem message', () => {
    const cases = [
      // wrong shape for authTokens (no name:)
      { authTokens: '{env:CI_SECRET}' },
      // wrong shape for a URL, under a credential-looking name on a key that is not secret
      { otel: true, otelEndpoint: '{env:GRAFANA_API_TOKEN}' },
      // malformed and unknown references next to a secret in the literal text of a secret key
      { authTokens: `ci:${SENTINELS.token}{env:A:-${SENTINELS.token}` },
      { authTokens: `{file:${SENTINELS.token}}` },
      { authTokens: `\${env:X:-${SENTINELS.token}}` },
      { otel: true, otelHeaders: { a: `${SENTINELS.header}{env:MISSING}` } },
    ];
    for (const file of cases) {
      const failure = resolveErr({
        env: { CI_SECRET: SENTINELS.token, GRAFANA_API_TOKEN: SENTINELS.heuristic },
        files: { [FILE]: JSON.stringify(file) },
      });
      const text = `${failure.render()}${JSON.stringify(failure.problems)}`;
      for (const sentinel of Object.values(SENTINELS)) expect(text).not.toContain(sentinel);
    }
  });
});

describe('configKeysToWire with references', () => {
  it('passes refs and the template of a key that is not secret, and refs of shadowed values', () => {
    const bundle = resolveOk({
      env: { OTLP_HOST: 'collector.internal' },
      argv: ['--otelEndpoint', 'http://cli:4318'],
      files: {
        [FILE]:
          '{"otel": true, "otelEndpoint": "http://{env:OTLP_HOST:-x}:4318", "otelServiceName": "svc-{env:TEAM:-lab}"}',
      },
    });
    const wire = configKeysToWire(configView(bundle.config, bundle.provenance));
    const byKey = Object.fromEntries(wire.map((row) => [row.key, row]));
    expect(byKey['otelEndpoint']).toEqual({
      key: 'otelEndpoint',
      value: 'http://cli:4318',
      source: 'cli',
      shadowed: [
        {
          source: 'file',
          value: 'http://collector.internal:4318',
          refs: [{ scheme: 'env', ref: 'OTLP_HOST', from: 'value' }],
        },
      ],
      secret: false,
    });
    expect(byKey['otelServiceName']).toEqual({
      key: 'otelServiceName',
      value: 'svc-lab',
      source: 'file',
      refs: [{ scheme: 'env', ref: 'TEAM', from: 'default' }],
      template: 'svc-{env:TEAM:-lab}',
      shadowed: [],
      secret: false,
    });
    expect(byKey['port']).toEqual({
      key: 'port',
      value: 9876,
      source: 'default',
      shadowed: [],
      secret: false,
    });
  });
});
