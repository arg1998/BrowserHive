/** @module app/config/resolve.sources.test — unit tests for resolve.sources */
import { describe, expect, it } from 'bun:test';
import { keyMeta } from '@browserhive/contracts/config';
import { resolveOk, TOKEN_A } from './test-support.ts';

const FILE = '/work/browserhive.config.json';

describe('paths, OTEL sub-source, overrides and freezing', () => {
  it('resolves relative paths against cwd for env and cli, against the file dir for JSON', () => {
    const cli = resolveOk({ argv: ['--blocklist', './bl.txt', '--dataDir', 'data'] });
    expect(cli.config.blocklist).toBe('/work/bl.txt');
    expect(cli.config.dataDir).toBe('/work/data');
    const env = resolveOk({ env: { BROWSERHIVE_BLOCKLIST: 'lists/bl.txt' } });
    expect(env.config.blocklist).toBe('/work/lists/bl.txt');
    const file = resolveOk({
      configFile: '/etc/browserhive/browserhive.config.json',
      files: {
        '/etc/browserhive/browserhive.config.json': '{"blocklist":"../bl.txt","dataDir":"data"}',
      },
    });
    expect(file.config.blocklist).toBe('/etc/bl.txt');
    expect(file.config.dataDir).toBe('/etc/browserhive/data');
    expect(file.provenance.dataDir.rendered).toBe('/etc/browserhive/data');
    expect(resolveOk({ argv: ['--blocklist', '/abs/bl.txt'] }).config.blocklist).toBe(
      '/abs/bl.txt',
    );
  });

  it('skips the identity variables: not config, no provenance, empty allowed (08 §2.2)', () => {
    const resolved = resolveOk({
      env: {
        BROWSERHIVE_HARNESS: 'codex',
        BROWSERHIVE_MODEL: '',
        BROWSERHIVE_WORKSPACE: 'shop',
        BROWSERHIVE_PORT: '9000',
      },
    });
    expect(resolved.config.port).toBe(9000);
    expect(Object.keys(resolved.provenance)).not.toContain('harness');
    expect(JSON.stringify(resolved.provenance)).not.toContain('BROWSERHIVE_HARNESS');
  });

  it('reads OTEL_* below BROWSERHIVE_* env and never enables telemetry by itself', () => {
    const onlyOtel = resolveOk({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer t',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_SERVICE_NAME: 'lab',
        OTEL_TRACES_SAMPLER_ARG: '0.25',
      },
    });
    expect(onlyOtel.config.otel).toBe(false);
    expect(onlyOtel.config.otelEndpoint).toBe('http://collector:4318');
    expect(onlyOtel.config.otelHeaders).toEqual({ Authorization: 'Bearer t' });
    expect(onlyOtel.config.otelProtocol).toBe('http/json');
    expect(onlyOtel.config.otelServiceName).toBe('lab');
    expect(onlyOtel.config.otelSampleRatio).toBe(0.25);
    expect(onlyOtel.provenance.otelEndpoint).toMatchObject({
      source: 'env(otel)',
      location: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    });
    expect(onlyOtel.explicitKeys.has('otelEndpoint')).toBe(false);
    expect(onlyOtel.diagnostics.shadowLines).toEqual([]);
  });

  it('lets BROWSERHIVE_* env shadow OTEL_* with the env(otel) label', () => {
    const bundle = resolveOk({
      env: {
        BROWSERHIVE_OTEL: 'true',
        BROWSERHIVE_OTEL_ENDPOINT: 'http://mine:4318',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      },
    });
    expect(bundle.config.otelEndpoint).toBe('http://mine:4318');
    expect(bundle.diagnostics.shadowLines.map((l) => l.text)).toEqual([
      'config: otelEndpoint=http://mine:4318 (env) shadows env(otel)=http://collector:4318',
    ]);
  });

  it('ignores empty or invalid OTEL_* variables when otel is off, with a warning', () => {
    const bundle = resolveOk({
      env: { OTEL_SERVICE_NAME: '', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    });
    expect(bundle.config.otelServiceName).toBe('browserhive');
    expect(bundle.config.otelProtocol).toBe('http/protobuf');
    expect(bundle.provenance.otelProtocol.source).toBe('default');
    expect(bundle.diagnostics.warnings).toEqual([
      "ignoring OTEL_EXPORTER_OTLP_PROTOCOL: invalid value for OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc'. Expected one of: http/protobuf, http/json.",
    ]);
  });

  it('accepts typed programmatic overrides as the cli source above argv', () => {
    const bundle = resolveOk({
      argv: ['--port', '1'],
      overrides: { port: 0, sessionLease: 7_200_000, admin: true, maxSessions: 'unbounded' },
    });
    expect(bundle.config.port).toBe(0);
    expect(bundle.config.sessionLease).toBe(7_200_000);
    expect(bundle.config.maxSessions).toBe('unbounded');
    expect(bundle.provenance.port).toMatchObject({
      source: 'cli',
      location: 'options.port',
      rendered: '0',
    });
    expect(bundle.provenance.admin).toMatchObject({ source: 'cli', location: 'options.admin' });
    expect(bundle.provenance.port.shadowed).toEqual([]);
    expect(bundle.config.trace).toBe(true);
  });

  it('uses configFile=false to skip discovery and a string to force a file', () => {
    const files = { [FILE]: '{"port": 5}', '/etc/bh.json': '{"port": 6}' };
    expect(resolveOk({ files, configFile: false }).config.port).toBe(9876);
    expect(resolveOk({ files, configFile: false }).configFilePath).toBeUndefined();
    expect(resolveOk({ files, configFile: '/etc/bh.json' }).config.port).toBe(6);
    expect(resolveOk({ files, configFile: 'etc/../etc/bh.json', cwd: '/' }).config.port).toBe(6);
    expect(resolveOk({ files, argv: ['--config', '/etc/bh.json'] }).config.config).toBe(
      '/etc/bh.json',
    );
    expect(resolveOk({ files, env: { BROWSERHIVE_CONFIG: '/etc/bh.json' } }).config.port).toBe(6);
  });

  it('honours a dataDir from a config file found in cwd but not from one found in the data dir', () => {
    const fromCwd = resolveOk({ files: { [FILE]: '{"dataDir": "/elsewhere"}' } });
    expect(fromCwd.config.dataDir).toBe('/elsewhere');
    const inData = resolveOk({
      argv: ['--dataDir', '/data'],
      files: { '/data/browserhive.config.json': '{"port": 7}' },
    });
    expect(inData.config.port).toBe(7);
    expect(inData.configFilePath).toBe('/data/browserhive.config.json');
  });

  it('returns a deep-frozen config and provenance', () => {
    const bundle = resolveOk({
      argv: ['--trustedProxies', '10.0.0.1', '--host', '0.0.0.0', '--auth', 'token'],
    });
    expect(Object.isFrozen(bundle.config)).toBe(true);
    expect(Object.isFrozen(bundle.config.trustedProxies)).toBe(true);
    expect(Object.isFrozen(bundle.config.logLevel)).toBe(true);
    expect(Object.isFrozen(bundle.provenance)).toBe(true);
    expect(Object.isFrozen(bundle.provenance.host.shadowed)).toBe(true);
    expect(Object.isFrozen(bundle.diagnostics.shadowLines)).toBe(true);
  });

  it('warns instead of failing when allowInsecureBind acknowledges a non-loopback bind', () => {
    const bundle = resolveOk({ argv: ['--host', '0.0.0.0', '--allowInsecureBind'] });
    expect(bundle.diagnostics.warnings).toHaveLength(1);
    expect(bundle.diagnostics.warnings[0]).toContain('allowInsecureBind=true');
  });

  it('marks every secret key redacted in provenance', () => {
    const bundle = resolveOk({
      env: {
        BROWSERHIVE_AUTH_TOKENS: TOKEN_A,
        BROWSERHIVE_OTEL: 'true',
        BROWSERHIVE_OTEL_HEADERS: 'a=b',
      },
    });
    for (const key of ['authTokens', 'otelHeaders'] as const) {
      expect(keyMeta(key).secret).toBe(true);
      expect(bundle.provenance[key].rendered).toBe('<redacted>');
    }
  });
});
