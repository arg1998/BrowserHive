/** @module app/config/resolve.errors.test — unit tests for resolve.errors */
import { describe, expect, it } from 'bun:test';
import type { ConfigFailureCode } from './failure.ts';
import { resolveErr, resolveOk, TOKEN_A } from './test-support.ts';

const FILE = '/work/browserhive.config.json';

interface ErrorRow {
  readonly name: string;
  readonly env?: Record<string, string>;
  readonly file?: string;
  readonly argv?: readonly string[];
  readonly exitCode: 64 | 3;
  readonly code?: ConfigFailureCode;
  readonly rendered: string;
}

/** Every fail-fast message of spec 08 §4 and §4.1, exactly as rendered. */
const ROWS: readonly ErrorRow[] = [
  {
    name: 'unknown CLI flag with did-you-mean',
    argv: ['--maxSession', '3'],
    exitCode: 64,
    code: 'CONFIG_UNKNOWN_KEY',
    rendered:
      "browserhive: unknown flag '--maxSession'. Did you mean '--maxSessions'? Run 'browserhive --help'.",
  },
  {
    name: 'kebab-case flag hints the camelCase name',
    argv: ['--max-sessions', '3'],
    exitCode: 64,
    rendered:
      "browserhive: unknown flag '--max-sessions'. Did you mean '--maxSessions'? Run 'browserhive --help'.",
  },
  {
    name: 'lower-case flag hints the camelCase name (case-sensitive matching)',
    argv: ['--maxsessions=3'],
    exitCode: 64,
    rendered:
      "browserhive: unknown flag '--maxsessions'. Did you mean '--maxSessions'? Run 'browserhive --help'.",
  },
  {
    name: 'unknown flag without a suggestion',
    argv: ['--banana'],
    exitCode: 64,
    rendered: "browserhive: unknown flag '--banana'. Run 'browserhive --help'.",
  },
  {
    name: 'unsupported flag spelling hints the supported key',
    argv: ['--pretty-logs'],
    exitCode: 64,
    rendered:
      "browserhive: unknown flag '--pretty-logs'. Did you mean '--logFormat'? Run 'browserhive --help'.",
  },
  {
    name: 'unsupported flag with no replacement',
    argv: ['--admin-port', '9877'],
    exitCode: 64,
    rendered:
      "browserhive: unknown flag '--admin-port'. This option is not supported: the dashboard shares --host and --port. Run 'browserhive --help'.",
  },
  {
    name: 'unknown env var with did-you-mean',
    env: { BROWSERHIVE_MAX_SESSION: '3' },
    exitCode: 64,
    code: 'CONFIG_UNKNOWN_KEY',
    rendered:
      "browserhive: unknown environment variable 'BROWSERHIVE_MAX_SESSION'. Did you mean 'BROWSERHIVE_MAX_SESSIONS'?",
  },
  {
    name: 'unsupported env var spelling hints the supported key',
    env: { BROWSERHIVE_DISABLE_PATCHRIGHT: '1' },
    exitCode: 64,
    rendered:
      "browserhive: unknown environment variable 'BROWSERHIVE_DISABLE_PATCHRIGHT'. Did you mean 'BROWSERHIVE_STEALTH_DRIVER'?",
  },
  {
    name: 'misspelt identity variable suggests the identity name (08 §2.2)',
    env: { BROWSERHIVE_HARNES: 'codex' },
    exitCode: 64,
    code: 'CONFIG_UNKNOWN_KEY',
    rendered:
      "browserhive: unknown environment variable 'BROWSERHIVE_HARNES'. Did you mean 'BROWSERHIVE_HARNESS'?",
  },
  {
    name: 'unknown key in the config file',
    file: '{"maxSession": 3}',
    exitCode: 64,
    code: 'CONFIG_UNKNOWN_KEY',
    rendered: `browserhive: unknown key 'maxSession' in ${FILE}. Did you mean 'maxSessions'?`,
  },
  {
    name: 'reserved key from the cli',
    argv: ['--proxy', 'http://p:1'],
    exitCode: 64,
    code: 'CONFIG_RESERVED_KEY',
    rendered: "browserhive: 'proxy' is reserved for a future release and cannot be set.",
  },
  {
    name: 'reserved key from env and file',
    env: { BROWSERHIVE_TENANT: 'x' },
    file: '{"notifications": true}',
    exitCode: 64,
    rendered:
      "browserhive: 'tenant' is reserved for a future release and cannot be set.\nbrowserhive: 'notifications' is reserved for a future release and cannot be set.",
  },
  {
    name: 'reserved enum member',
    argv: ['--vault', 'onepassword'],
    exitCode: 64,
    code: 'CONFIG_RESERVED_KEY',
    rendered: "browserhive: 'onepassword' is reserved for a future release and cannot be set.",
  },
  {
    name: 'invalid duration',
    argv: ['--sessionLease', '2 hours'],
    exitCode: 64,
    code: 'CONFIG_INVALID',
    rendered:
      "browserhive: invalid value for --sessionLease: '2 hours'. Expected a duration like '2h', '30m', '90s', '500ms', or an integer of milliseconds.",
  },
  {
    name: 'invalid enum lists the members',
    env: { BROWSERHIVE_TRANSPORT: 'tcp' },
    exitCode: 64,
    rendered:
      "browserhive: invalid value for BROWSERHIVE_TRANSPORT: 'tcp'. Expected one of: http, stdio.",
  },
  {
    name: 'invalid JSON value is quoted as JSON',
    file: '{"port": 70000}',
    exitCode: 64,
    rendered: `browserhive: invalid value for 'port' in ${FILE}: '70000'. Expected an integer between 1 and 65535.`,
  },
  {
    name: 'zod-native messages fall back to the key grammar',
    file: '{"admin": 5}',
    exitCode: 64,
    rendered: `browserhive: invalid value for 'admin' in ${FILE}: '5'. Expected a boolean: 'true', 'false', '1', '0', 'yes' or 'no'.`,
  },
  {
    name: 'refinement failures keep their message',
    argv: ['--sessionLease', '30s'],
    exitCode: 64,
    rendered:
      "browserhive: invalid value for --sessionLease: '30s'. Expected a duration of at least '1m'.",
  },
  {
    name: 'a malformed secret is redacted, never echoed (env)',
    env: { BROWSERHIVE_AUTH_TOKENS: 'z'.repeat(40) },
    exitCode: 64,
    code: 'CONFIG_INVALID',
    rendered:
      "browserhive: invalid value for BROWSERHIVE_AUTH_TOKENS: <redacted>. Expected items of the form 'name:token' with a token of at least 32 characters.",
  },
  {
    name: 'a malformed secret is redacted, never echoed (config file)',
    file: '{"otelHeaders": {"authorization": 42}}',
    exitCode: 64,
    code: 'CONFIG_INVALID',
    rendered: `browserhive: invalid value for 'otelHeaders' in ${FILE}: <redacted>. Expected a comma-separated map like 'k=v,k2=v2' (or a JSON object of strings).`,
  },
  {
    name: 'port 0 is rejected outside the programmatic API',
    argv: ['--port', '0'],
    exitCode: 64,
    rendered:
      "browserhive: invalid value for --port: '0'. Expected an integer between 1 and 65535.",
  },
  {
    name: 'empty env value',
    env: { BROWSERHIVE_PORT: '' },
    exitCode: 64,
    code: 'CONFIG_EMPTY_VALUE',
    rendered: 'browserhive: BROWSERHIVE_PORT is set but empty. Unset it or provide a value.',
  },
  {
    name: 'empty cli value',
    argv: ['--host='],
    exitCode: 64,
    rendered: 'browserhive: --host is set but empty. Unset it or provide a value.',
  },
  {
    name: 'empty JSON string',
    file: '{"host": ""}',
    exitCode: 64,
    rendered: `browserhive: 'host' in ${FILE} is set but empty. Unset it or provide a value.`,
  },
  {
    name: 'missing flag value',
    argv: ['--port'],
    exitCode: 64,
    code: 'CONFIG_USAGE',
    rendered: 'browserhive: --port requires a value.',
  },
  {
    name: 'stray positional',
    argv: ['--admin', 'serve'],
    exitCode: 64,
    rendered: "browserhive: unexpected argument 'serve'. Run 'browserhive --help'.",
  },
  {
    name: 'config key inside a config file',
    file: '{"config": "./other.json"}',
    exitCode: 64,
    rendered: `browserhive: 'config' cannot be set from a config file (use --config or BROWSERHIVE_CONFIG).`,
  },
  {
    name: 'explicit config file missing',
    argv: ['--config', '/etc/none.json'],
    exitCode: 64,
    code: 'CONFIG_FILE_INVALID',
    rendered: 'browserhive: cannot read /etc/none.json: no such file',
  },
  {
    name: 'invalid JSON with line and column',
    file: '{"port": 1,\n  "admin": tru }',
    exitCode: 64,
    rendered: `browserhive: cannot read ${FILE}: invalid JSON at line 2, column 12: unexpected token 't'`,
  },
  {
    name: 'rule 1: minAttentionWait below attentionTimeout',
    argv: ['--minAttentionWait', '45m', '--attentionTimeout', '30m'],
    exitCode: 64,
    code: 'CONFIG_INVALID',
    rendered:
      'browserhive: minAttentionWait must be less than attentionTimeout (got minAttentionWait=45m, attentionTimeout=30m). Set minAttentionWait=0 to disable the floor.',
  },
  {
    name: 'rule 2: humanize requires stealth',
    argv: ['--humanize', '--stealth', 'off'],
    exitCode: 64,
    rendered:
      "browserhive: humanize=true requires stealth to be 'standard' or 'max' (got stealth=off).",
  },
  {
    name: 'rule 3: explicit fingerprint requires stealth',
    env: { BROWSERHIVE_FINGERPRINT: 'true', BROWSERHIVE_STEALTH: 'off' },
    exitCode: 64,
    rendered:
      "browserhive: fingerprint=true requires stealth to be 'standard' or 'max' (got stealth=off).",
  },
  {
    name: 'rule 4: explicit captcha=attention needs admin and http',
    file: '{"captcha": "attention"}',
    exitCode: 64,
    rendered:
      'browserhive: captcha=attention requires admin=true and transport=http, because CAPTCHA hand-off needs the dashboard.',
  },
  {
    name: 'rule 5: admin requires http is a policy refusal',
    argv: ['--admin', '--transport', 'stdio'],
    exitCode: 3,
    code: 'ADMIN_REQUIRES_HTTP',
    rendered:
      'browserhive: [ADMIN_REQUIRES_HTTP] admin=true requires transport=http. The dashboard is not available under stdio.',
  },
  {
    name: 'rule 6: auth=token requires http',
    argv: ['--auth', 'token', '--transport', 'stdio'],
    exitCode: 64,
    rendered:
      'browserhive: auth=token requires transport=http. Under stdio every caller is the local principal.',
  },
  {
    name: 'rule 7: otel keys require otel=true, naming the keys set',
    argv: ['--otelEndpoint', 'http://c:4318', '--otelServiceName', 'x'],
    exitCode: 64,
    rendered: 'browserhive: otelEndpoint and otelServiceName require otel=true.',
  },
  {
    name: 'rule 8: trustedProxies on a loopback bind',
    argv: ['--trustedProxies', '10.0.0.0/8'],
    exitCode: 64,
    rendered:
      'browserhive: trustedProxies requires a non-loopback host; on a loopback bind X-Forwarded-For is never trusted.',
  },
  {
    name: 'rule 9: screenshotTrace requires trace',
    argv: ['--screenshotTrace'],
    exitCode: 64,
    rendered: 'browserhive: screenshotTrace=true requires trace=true.',
  },
  {
    name: 'rule 10: blocklistWatch requires blocklist',
    argv: ['--blocklistWatch'],
    exitCode: 64,
    rendered: 'browserhive: blocklistWatch=true requires blocklist to be set.',
  },
  {
    name: 'rule 11: insecure bind refused',
    argv: ['--host', '0.0.0.0'],
    exitCode: 3,
    code: 'INSECURE_BIND_REFUSED',
    rendered:
      'browserhive: [INSECURE_BIND_REFUSED] Refusing to bind 0.0.0.0 without authentication. Set auth=token, or set allowInsecureBind=true to accept the risk.',
  },
  {
    name: 'a hostname that only looks like loopback is still refused',
    argv: ['--host', '127.evil.example'],
    exitCode: 3,
    rendered:
      'browserhive: [INSECURE_BIND_REFUSED] Refusing to bind 127.evil.example without authentication. Set auth=token, or set allowInsecureBind=true to accept the risk.',
  },
  {
    name: 'dataDir inside a config file located in the data dir',
    argv: ['--dataDir', '/data'],
    file: '',
    exitCode: 64,
    rendered:
      'browserhive: config: dataDir cannot be set from a config file located in the data dir',
  },
];

describe('resolveConfig fail-fast messages (spec 08 §4)', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const files =
        row.file === undefined
          ? {}
          : row.file === ''
            ? { '/data/browserhive.config.json': '{"dataDir": "/elsewhere"}' }
            : { [FILE]: row.file };
      const failure = resolveErr({ env: row.env ?? {}, argv: row.argv ?? [], files });
      expect(failure.render()).toBe(row.rendered);
      expect(failure.exitCode).toBe(row.exitCode);
      if (row.code !== undefined) expect(failure.code).toBe(row.code);
    });
  }

  it('reports every problem of every source before exiting', () => {
    const failure = resolveErr({
      env: { BROWSERHIVE_PORT: '', BROWSERHIVE_MAX_SESSION: '1' },
      argv: ['--maxSession', '3', '--sessionLease', 'soon'],
      files: { [FILE]: '{"maxSession": 4, "proxy": 1}' },
    });
    expect(failure.problems.map((p) => p.location)).toEqual([
      'BROWSERHIVE_MAX_SESSION',
      'BROWSERHIVE_PORT',
      '--maxSession',
      '--sessionLease',
      `file:${FILE}#maxSession`,
      `file:${FILE}#proxy`,
    ]);
    expect(failure.exitCode).toBe(64);
    expect(failure.render().split('\n')).toHaveLength(6);
  });

  it('collects several cross-field violations at once', () => {
    const failure = resolveErr({ argv: ['--screenshotTrace', '--blocklistWatch'] });
    expect(failure.problems.map((p) => p.key)).toEqual(['screenshotTrace', 'blocklistWatch']);
    expect(failure.problems.every((p) => p.source === 'cross-field')).toBe(true);
  });

  it('carries structured problem fields', () => {
    const failure = resolveErr({ argv: ['--maxSession', '3'] });
    expect(failure.problems[0]).toEqual({
      code: 'CONFIG_UNKNOWN_KEY',
      source: 'cli',
      location: '--maxSession',
      message:
        "unknown flag '--maxSession'. Did you mean '--maxSessions'? Run 'browserhive --help'.",
      suggestions: ['--maxSessions'],
    });
  });

  it('reports OTEL_* parse failures only when otel is on', () => {
    const failure = resolveErr({
      env: { BROWSERHIVE_OTEL: 'true', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    });
    expect(failure.render()).toBe(
      "browserhive: invalid value for OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc'. Expected one of: http/protobuf, http/json.",
    );
  });

  it('checks logLevel modules against the injected registry', () => {
    const failure = resolveErr({
      argv: ['--logLevel', 'info,nope=debug'],
      knownLogModules: ['sessions', 'http'],
    });
    expect(failure.render()).toBe(
      "browserhive: invalid value for --logLevel: 'info,nope=debug'. Unknown log module 'nope' (expected one of sessions, http).",
    );
    expect(
      resolveOk({ argv: ['--logLevel', 'info,http=debug'], knownLogModules: ['http'] }).config
        .logLevel,
    ).toEqual({
      root: 'info',
      modules: { http: 'debug' },
    });
  });

  it('does not fire the explicit-only rules for derived or OTEL-supplied values', () => {
    expect(resolveOk({ argv: ['--stealth', 'off'] }).config.fingerprint).toBe(false);
    expect(resolveOk({ env: { OTEL_SERVICE_NAME: 'lab' } }).config.otel).toBe(false);
    expect(resolveOk({ argv: ['--transport', 'stdio'] }).config.captcha).toBe('attention');
  });

  it('accepts the LAN scenario with auth=token and the admin scenario on http', () => {
    const lan = resolveOk({
      argv: ['--host', '0.0.0.0', '--auth', 'token', '--admin', '--authTokens', TOKEN_A],
    });
    expect(lan.config.host).toBe('0.0.0.0');
    expect(lan.diagnostics.warnings).toEqual([]);
  });
});
