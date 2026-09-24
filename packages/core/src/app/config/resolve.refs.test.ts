/** @module app/config/resolve.refs.test — `{env:NAME}` references through the whole resolver: ladder, provenance, every message of spec 08 §4, warnings for values that are not expanded (spec 08 §3.1, D-29) */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${env:…}` in plain strings is the config-file text under test, not a template.
import { describe, expect, it } from 'bun:test';
import type { ConfigKey, ProvenanceSource } from '@browserhive/contracts/config';
import type { ConfigFailureCode } from './failure.ts';
import { fakeHost, resolveErr, resolveOk, TOKEN_A, TOKEN_B } from './test-support.ts';

const FILE = '/work/browserhive.config.json';
const SECRET = 't'.repeat(40);

interface Row {
  readonly name: string;
  readonly key: ConfigKey;
  readonly env?: Record<string, string>;
  readonly file: Record<string, unknown>;
  readonly argv?: readonly string[];
  readonly value: unknown;
  readonly source: ProvenanceSource;
  readonly shadow?: string;
}

const LADDER: readonly Row[] = [
  {
    name: 'a file value with a reference beats env, and the shadow line names the variable',
    key: 'otelEndpoint',
    env: { OTLP_HOST: 'collector.internal', BROWSERHIVE_OTEL_ENDPOINT: 'http://127.0.0.1:4318' },
    file: { otel: true, otelEndpoint: 'http://{env:OTLP_HOST}:4318' },
    value: 'http://collector.internal:4318',
    source: 'file',
    shadow:
      'config: otelEndpoint=http://collector.internal:4318 (config-file via $OTLP_HOST) shadows env=http://127.0.0.1:4318',
  },
  {
    name: 'a flag shadows a file value with a reference',
    key: 'otelEndpoint',
    env: { OTLP_HOST: 'collector.internal', BROWSERHIVE_OTEL_ENDPOINT: 'http://127.0.0.1:4318' },
    file: { otel: true, otelEndpoint: 'http://{env:OTLP_HOST}:4318' },
    argv: ['--otelEndpoint', 'http://cli:4318'],
    value: 'http://cli:4318',
    source: 'cli',
    shadow:
      'config: otelEndpoint=http://cli:4318 (cli) shadows config-file=http://collector.internal:4318 via $OTLP_HOST, env=http://127.0.0.1:4318',
  },
  {
    name: 'a secret key names the variable and never the value',
    key: 'otelHeaders',
    env: { OTLP_TOKEN: SECRET, OTEL_EXPORTER_OTLP_HEADERS: 'x=y' },
    file: { otel: true, otelHeaders: { Authorization: 'Bearer {env:OTLP_TOKEN}' } },
    value: { Authorization: `Bearer ${SECRET}` },
    source: 'file',
    shadow:
      'config: otelHeaders=<redacted> (config-file via $OTLP_TOKEN) shadows env(otel)=<redacted>',
  },
  {
    name: 'a default that was used is marked',
    key: 'maxSessions',
    env: { BROWSERHIVE_MAX_SESSIONS: '2' },
    file: { maxSessions: '{env:MAX_SESSIONS:-4}' },
    value: 4,
    source: 'file',
    shadow: 'config: maxSessions=4 (config-file via $MAX_SESSIONS (default)) shadows env=2',
  },
  {
    name: 'the file speaks the env dialect: a number from a string',
    key: 'port',
    env: { PORT: '9901' },
    file: { port: '{env:PORT}' },
    value: 9901,
    source: 'file',
  },
  {
    name: 'one variable expands into a list',
    key: 'authTokens',
    env: { BH_TOKENS: `${TOKEN_A},${TOKEN_B}` },
    file: { authTokens: '{env:BH_TOKENS}' },
    value: [TOKEN_A, TOKEN_B],
    source: 'file',
  },
  {
    name: 'array elements expand one by one',
    key: 'authTokens',
    env: { CI_TOKEN: 'a'.repeat(32) },
    file: { authTokens: ['agent-a:{env:CI_TOKEN}', TOKEN_B] },
    value: [TOKEN_A, TOKEN_B],
    source: 'file',
  },
  {
    name: 'an enum from a reference',
    key: 'stealth',
    env: { STEALTH: 'max' },
    file: { stealth: '{env:STEALTH}' },
    value: 'max',
    source: 'file',
  },
  {
    name: 'a boolean from a reference',
    key: 'humanize',
    env: { HUMANIZE: 'yes' },
    file: { humanize: '{env:HUMANIZE}' },
    value: true,
    source: 'file',
  },
  {
    name: 'the {{…}} escape keeps the text literal',
    key: 'otelTraceUrlTemplate',
    file: { otelTraceUrlTemplate: 'https://x/{{env:X}}/{trace_id}' },
    value: 'https://x/{env:X}/{trace_id}',
    source: 'file',
  },
];

describe('references on the ladder (spec 08 §1, §3.1)', () => {
  for (const row of LADDER) {
    it(row.name, () => {
      const bundle = resolveOk({
        env: row.env ?? {},
        argv: row.argv ?? [],
        files: { [FILE]: JSON.stringify(row.file) },
      });
      expect<unknown>(bundle.config[row.key]).toEqual(row.value);
      expect(bundle.provenance[row.key].source).toBe(row.source);
      if (row.shadow !== undefined) {
        expect(bundle.diagnostics.shadowLines.map((line) => line.text)).toContain(row.shadow);
      }
      expect(JSON.stringify(bundle.diagnostics)).not.toContain(SECRET);
    });
  }
});

describe('provenance of references', () => {
  it('records refs and the template of a key that is not secret', () => {
    const bundle = resolveOk({
      env: { OTLP_HOST: 'collector.internal' },
      files: { [FILE]: '{"otel": true, "otelEndpoint": "http://{env:OTLP_HOST}:4318"}' },
    });
    expect(bundle.provenance.otelEndpoint).toEqual({
      key: 'otelEndpoint',
      source: 'file',
      rendered: 'http://collector.internal:4318',
      location: `file:${FILE}#otelEndpoint`,
      shadowed: [],
      refs: [{ scheme: 'env', ref: 'OTLP_HOST', from: 'value' }],
      template: 'http://{env:OTLP_HOST}:4318',
    });
    expect(bundle.explicitKeys.has('otelEndpoint')).toBe(true);
  });

  it('keeps refs with their position but never a template on a secret key', () => {
    const bundle = resolveOk({
      env: { OTLP_TOKEN: SECRET },
      files: {
        [FILE]: JSON.stringify({
          otel: true,
          otelHeaders: { Authorization: 'Bearer {env:OTLP_TOKEN}' },
        }),
      },
    });
    expect(bundle.provenance.otelHeaders).toEqual({
      key: 'otelHeaders',
      source: 'file',
      rendered: '<redacted>',
      location: `file:${FILE}#otelHeaders`,
      shadowed: [],
      refs: [{ scheme: 'env', ref: 'OTLP_TOKEN', from: 'value', at: 'Authorization' }],
    });
    // The name contains `token`, so the value is also registered directly (the extractor registers
    // it as well; a duplicate registration is harmless).
    expect(bundle.referencedSecrets).toEqual([SECRET]);
  });

  it('writes an array or object template as compact JSON', () => {
    const bundle = resolveOk({
      env: { PROXY: '10.0.0.1' },
      files: {
        [FILE]: JSON.stringify({
          host: '0.0.0.0',
          auth: 'token',
          authTokens: [TOKEN_A],
          trustedProxies: ['{env:PROXY}', '10.0.0.2'],
        }),
      },
    });
    expect(bundle.provenance.trustedProxies).toMatchObject({
      rendered: '10.0.0.1,10.0.0.2',
      refs: [{ scheme: 'env', ref: 'PROXY', from: 'value', at: '[0]' }],
      template: '["{env:PROXY}","10.0.0.2"]',
    });
  });

  it('redacts a key whose reference name looks credential-bearing, everywhere, for this run', () => {
    const bundle = resolveOk({
      env: { GRAFANA_API_TOKEN: SECRET, BROWSERHIVE_OTEL_SERVICE_NAME: 'lab' },
      files: { [FILE]: '{"otel": true, "otelServiceName": "{env:GRAFANA_API_TOKEN}"}' },
    });
    expect(bundle.config.otelServiceName).toBe(SECRET);
    expect(bundle.provenance.otelServiceName).toEqual({
      key: 'otelServiceName',
      source: 'file',
      rendered: '<redacted>',
      location: `file:${FILE}#otelServiceName`,
      shadowed: [{ source: 'env', raw: '<redacted>', location: 'BROWSERHIVE_OTEL_SERVICE_NAME' }],
      refs: [{ scheme: 'env', ref: 'GRAFANA_API_TOKEN', from: 'value' }],
      sensitive: true,
    });
    expect(bundle.diagnostics.shadowLines.map((l) => l.text)).toEqual([
      'config: otelServiceName=<redacted> (config-file via $GRAFANA_API_TOKEN) shadows env=<redacted>',
    ]);
    expect(bundle.referencedSecrets).toEqual([SECRET]);
  });

  it('never registers a default as a secret, and a plain file carries no reference fields', () => {
    const fallback = resolveOk({
      files: { [FILE]: '{"otel": true, "otelServiceName": "{env:API_TOKEN:-dev}"}' },
    });
    expect(fallback.config.otelServiceName).toBe('dev');
    expect(fallback.referencedSecrets).toEqual([]);
    const plain = resolveOk({ files: { [FILE]: '{"port": 2}' } });
    expect(plain.provenance.port).toEqual({
      key: 'port',
      source: 'file',
      rendered: '2',
      location: `file:${FILE}#port`,
      shadowed: [],
    });
    expect(plain.referencedSecrets).toEqual([]);
  });

  it('never rescans expanded text', () => {
    const failure = resolveErr({
      env: { FOO: '{env:BAR}', BAR: '127.0.0.1' },
      files: { [FILE]: '{"host": "{env:FOO}"}' },
    });
    expect(failure.render()).toContain(`'{env:BAR}' (interpolated from {env:FOO}).`);
    const ok = resolveOk({
      env: { FOO: '{env:BAR}' },
      files: { [FILE]: '{"otelTraceUrlTemplate": "{env:FOO}"}' },
    });
    expect(ok.config.otelTraceUrlTemplate).toBe('{env:BAR}');
  });

  it('resolves a relative path from a reference against the config file directory', () => {
    const bundle = resolveOk({
      env: { BL: 'lists/bl.txt' },
      configFile: '/etc/bh/browserhive.config.json',
      files: { '/etc/bh/browserhive.config.json': '{"blocklist": "{env:BL}"}' },
    });
    expect(bundle.config.blocklist).toBe('/etc/bh/lists/bl.txt');
    expect(bundle.provenance.blocklist.template).toBe('{env:BL}');
  });

  it('matches variable names case-insensitively on Windows only', () => {
    const files = { [FILE]: '{"otelTraceUrlTemplate": "{env:TRACE_URL}"}' };
    const env = { Trace_Url: 'https://x/{trace_id}' };
    const win = resolveOk({ env, files, host: fakeHost({ platform: 'win32' }) });
    expect(win.config.otelTraceUrlTemplate).toBe('https://x/{trace_id}');
    expect(resolveErr({ env, files }).code).toBe('CONFIG_REF_UNRESOLVED');
  });

  it('applies the policy guards to an expanded value', () => {
    const failure = resolveErr({
      env: { BIND: '0.0.0.0' },
      files: { [FILE]: '{"host": "{env:BIND}"}' },
    });
    expect(failure.code).toBe('INSECURE_BIND_REFUSED');
    expect(failure.exitCode).toBe(3);
  });
});

interface ErrorRow {
  readonly name: string;
  readonly env?: Record<string, string>;
  readonly file: string;
  readonly code: ConfigFailureCode;
  readonly rendered: string;
}

const EXPECTED_REF =
  'Expected {env:NAME} or {env:NAME:-default}, where NAME matches [A-Za-z_][A-Za-z0-9_]* and the default contains no braces.';

/** Every reference message of spec 08 §4, exactly as rendered. */
const ERRORS: readonly ErrorRow[] = [
  {
    name: 'unset variable',
    file: '{"otel": true, "otelHeaders": {"Authorization": "Bearer {env:OTLP_TOKEN}"}}',
    code: 'CONFIG_REF_UNRESOLVED',
    rendered: `browserhive: 'otelHeaders' in ${FILE} references {env:OTLP_TOKEN}, but OTLP_TOKEN is not set. Set it, or write a default as {env:OTLP_TOKEN:-<value>}.`,
  },
  {
    name: 'empty variable',
    env: { OTLP_TOKEN: '' },
    file: '{"otel": true, "otelHeaders": {"Authorization": "Bearer {env:OTLP_TOKEN}"}}',
    code: 'CONFIG_REF_UNRESOLVED',
    rendered: `browserhive: 'otelHeaders' in ${FILE} references {env:OTLP_TOKEN}, but OTLP_TOKEN is set and empty. Set it to a value, or write a default as {env:OTLP_TOKEN:-<value>}.`,
  },
  {
    name: 'empty after expansion',
    file: '{"otel": true, "otelServiceName": "{env:SERVICE:-}"}',
    code: 'CONFIG_EMPTY_VALUE',
    rendered: `browserhive: 'otelServiceName' in ${FILE} is empty after resolving {env:SERVICE:-}. Unset it or provide a value.`,
  },
  {
    name: 'invalid value produced by a reference',
    env: { OTLP_URL: 'collector:4318' },
    file: '{"otel": true, "otelEndpoint": "{env:OTLP_URL}"}',
    code: 'CONFIG_INVALID',
    rendered: `browserhive: invalid value for 'otelEndpoint' in ${FILE}: 'collector:4318' (interpolated from {env:OTLP_URL}). Expected an absolute http: or https: URL like 'http://127.0.0.1:4318'.`,
  },
  {
    name: 'invalid value produced by a default',
    file: '{"sessionLease": "{env:LEASE:-2 hours}"}',
    code: 'CONFIG_INVALID',
    rendered: `browserhive: invalid value for 'sessionLease' in ${FILE}: '2 hours' (interpolated from {env:LEASE} (default)). Expected a duration like '2h', '30m', '90s', '500ms', or an integer of milliseconds.`,
  },
  {
    name: 'invalid secret value is redacted',
    env: { CI_TOKEN: 'z'.repeat(40) },
    file: '{"authTokens": "{env:CI_TOKEN}"}',
    code: 'CONFIG_INVALID',
    rendered: `browserhive: invalid value for 'authTokens' in ${FILE}: <redacted> (interpolated from {env:CI_TOKEN}). Expected items of the form 'name:token' with a token of at least 32 characters.`,
  },
  {
    name: 'invalid value under a credential-looking name is redacted',
    env: { API_TOKEN: SECRET },
    file: '{"otel": true, "otelEndpoint": "{env:API_TOKEN}"}',
    code: 'CONFIG_INVALID',
    rendered: `browserhive: invalid value for 'otelEndpoint' in ${FILE}: <redacted> (interpolated from {env:API_TOKEN}). Expected an absolute http: or https: URL like 'http://127.0.0.1:4318'.`,
  },
  {
    name: 'malformed reference',
    file: '{"port": "{env:}"}',
    code: 'CONFIG_REF_UNRESOLVED',
    rendered: `browserhive: 'port' in ${FILE}: '{env:}' is not a valid reference. ${EXPECTED_REF}`,
  },
  {
    name: 'nested reference is malformed',
    file: '{"otel": true, "otelEndpoint": "{env:A:-{env:B}}"}',
    code: 'CONFIG_REF_UNRESOLVED',
    rendered: `browserhive: 'otelEndpoint' in ${FILE}: '{env:A:-{env:B}' is not a valid reference. ${EXPECTED_REF}`,
  },
  {
    name: 'malformed reference on a secret key shows no text',
    file: '{"authTokens": "ci:{env:A:-literal{"}',
    code: 'CONFIG_REF_UNRESOLVED',
    rendered: `browserhive: 'authTokens' in ${FILE} contains a reference that is not valid. ${EXPECTED_REF}`,
  },
  {
    name: 'unknown scheme',
    file: '{"otel": true, "otelServiceName": "{file:/run/secrets/name}"}',
    code: 'CONFIG_REF_UNRESOLVED',
    rendered: `browserhive: 'otelServiceName' in ${FILE}: unknown reference scheme in '{file:/run/secrets/name}'. Supported references: {env:NAME}, {env:NAME:-default}. To keep the text literal, write '{{file:/run/secrets/name}}'.`,
  },
  {
    name: 'mis-cased scheme',
    file: '{"host": "{ENV:HOST}"}',
    code: 'CONFIG_REF_UNRESOLVED',
    rendered: `browserhive: 'host' in ${FILE}: unknown reference scheme in '{ENV:HOST}'. Did you mean '{env:HOST}'? Supported references: {env:NAME}, {env:NAME:-default}. To keep the text literal, write '{{ENV:HOST}}'.`,
  },
  {
    name: 'unknown scheme on a secret key names the scheme only',
    file: '{"authTokens": "{file:/run/secrets/tok}"}',
    code: 'CONFIG_REF_UNRESOLVED',
    rendered: `browserhive: 'authTokens' in ${FILE}: unknown reference scheme 'file'. Supported references: {env:NAME}, {env:NAME:-default}. To keep the text literal, double its braces: {{…}}.`,
  },
  {
    name: '${env:…} habit',
    file: '{"otel": true, "otelEndpoint": "${env:OTLP_HOST}"}',
    code: 'CONFIG_REF_UNRESOLVED',
    rendered: `browserhive: 'otelEndpoint' in ${FILE}: '\${env:OTLP_HOST}' looks like a reference with an extra '$'. Did you mean '{env:OTLP_HOST}'?`,
  },
  {
    name: '${env:…} on a secret key hides the default',
    file: '{"authTokens": "${env:T:-abc}"}',
    code: 'CONFIG_REF_UNRESOLVED',
    rendered: `browserhive: 'authTokens' in ${FILE}: '\${env:T:-…}' looks like a reference with an extra '$'. Did you mean '{env:T:-…}'?`,
  },
];

describe('reference problems (spec 08 §4)', () => {
  for (const row of ERRORS) {
    it(row.name, () => {
      const failure = resolveErr({ env: row.env ?? {}, files: { [FILE]: row.file } });
      expect(failure.render()).toBe(row.rendered);
      expect(failure.exitCode).toBe(64);
      expect(failure.code).toBe(row.code);
    });
  }

  it('reports every bad reference of the file together, with the other problems', () => {
    const failure = resolveErr({
      env: { BROWSERHIVE_PORT: '' },
      files: {
        [FILE]: JSON.stringify({
          host: '{env:A}',
          otelServiceName: '{nope:x}',
          maxSessions: '{env:}',
          authTokens: ['{env:B}', '{env:C}'],
        }),
      },
    });
    expect(failure.problems.map((p) => [p.code, p.location])).toEqual([
      ['CONFIG_EMPTY_VALUE', 'BROWSERHIVE_PORT'],
      ['CONFIG_REF_UNRESOLVED', `file:${FILE}#host`],
      ['CONFIG_REF_UNRESOLVED', `file:${FILE}#otelServiceName`],
      ['CONFIG_REF_UNRESOLVED', `file:${FILE}#maxSessions`],
      ['CONFIG_REF_UNRESOLVED', `file:${FILE}#authTokens`],
      ['CONFIG_REF_UNRESOLVED', `file:${FILE}#authTokens`],
    ]);
    expect(failure.render().split('\n')).toHaveLength(6);
  });
});

describe('references outside the config file are not expanded (spec 08 §3.1)', () => {
  it('warns once per variable, flag or option, and keeps the text as it is', () => {
    const bundle = resolveOk({
      env: {
        BROWSERHIVE_OTEL: 'true',
        BROWSERHIVE_OTEL_ENDPOINT: 'http://{env:OTLP_HOST}:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer {env:TOK:-abc}',
        OTLP_HOST: 'collector',
      },
      argv: ['--otelServiceName', '{env:NAME}'],
      overrides: { otelTraceUrlTemplate: '${env:URL}' },
    });
    expect(bundle.config.otelEndpoint).toBe('http://{env:OTLP_HOST}:4318');
    expect(bundle.config.otelServiceName).toBe('{env:NAME}');
    expect(bundle.diagnostics.warnings).toEqual([
      "BROWSERHIVE_OTEL_ENDPOINT contains '{env:OTLP_HOST}'; references are expanded only in browserhive.config.json.",
      "OTEL_EXPORTER_OTLP_HEADERS contains '{env:TOK:-…}'; references are expanded only in browserhive.config.json.",
      "--otelServiceName contains '{env:NAME}'; references are expanded only in browserhive.config.json.",
      "options.otelTraceUrlTemplate contains '${env:URL}'; references are expanded only in browserhive.config.json.",
    ]);
    expect(bundle.provenance.otelEndpoint.refs).toBeUndefined();
  });

  it('does not warn for braces that are not references', () => {
    const bundle = resolveOk({ argv: ['--otelTraceUrlTemplate', 'https://x/{trace_id}'] });
    expect(bundle.diagnostics.warnings).toEqual([]);
  });
});
