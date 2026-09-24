/** @module contracts/test/config.schema — defaults, reserved members, cross-field rule texts, JSON Schema smoke */
import { describe, expect, it } from 'bun:test';
import {
  CONFIG_FILE_SCHEMA_ID,
  CONFIG_KEYS,
  configFileJsonSchema,
  crossFieldIssues,
  isInsecureBind,
  type ServerConfig,
  serverConfigObject,
  serverConfigSchema,
  serverConfigSchemaFor,
} from '../src/config/index.ts';

/** The derived keys the resolver supplies; everything else takes its default. */
const DERIVED = { dataDir: '/tmp/bh', maxSessions: 4, fingerprint: false, trace: false } as const;

/** Parses without the cross-field `superRefine`, so the rules can be exercised one by one. */
function resolved(overrides: Record<string, unknown> = {}): ServerConfig {
  return serverConfigObject.parse({ ...DERIVED, ...overrides });
}

describe('serverConfigSchema', () => {
  it('fills every default from the key table', () => {
    const config = resolved();
    expect(config).toMatchObject({
      transport: 'http',
      host: '127.0.0.1',
      port: 9876,
      auth: 'off',
      authTokens: [],
      allowInsecureBind: false,
      admin: false,
      shutdownTimeout: 20_000,
      sessionCloseTimeout: 10_000,
      persistence: 'memory',
      defaultHeadless: true,
      defaultChannel: 'chromium',
      sessionLease: 7_200_000,
      attentionTimeout: 21_600_000,
      minAttentionWait: 1_800_000,
      allowEvaluate: true,
      stealth: 'standard',
      stealthDriver: 'auto',
      humanize: false,
      captcha: 'attention',
      blocklistWatch: false,
      vault: 'off',
      logLevel: { root: 'info', modules: {} },
      logFormat: 'auto',
      color: 'auto',
      logRingSize: 5000,
      logPersist: 'off',
      screenshotTrace: false,
      screencastQuality: 60,
      recordToolResults: 'full',
      retentionDays: 7,
      retentionBytes: 1024 ** 3,
      backupsKeep: 5,
      otel: false,
      otelEndpoint: 'http://127.0.0.1:4318',
      otelProtocol: 'http/protobuf',
      otelHeaders: {},
      otelServiceName: 'browserhive',
      otelSampleRatio: 1,
      otelSignals: ['traces', 'metrics', 'logs'],
      otelVerbose: false,
    });
    expect(config.blocklist).toBeUndefined();
    expect(config.otelTraceUrlTemplate).toBeUndefined();
    expect(config.config).toBeUndefined();
  });

  it('accepts strings from env/CLI and typed values from JSON alike', () => {
    const a = resolved({
      port: '9877',
      admin: 'yes',
      sessionLease: '1h',
      retentionBytes: '2GiB',
      authTokens: 'ci:0123456789abcdef0123456789abcdef',
    });
    const b = resolved({
      port: 9877,
      admin: true,
      sessionLease: 3_600_000,
      retentionBytes: 2 * 1024 ** 3,
      authTokens: ['ci:0123456789abcdef0123456789abcdef'],
    });
    expect(a).toEqual(b);
  });

  it('rejects unknown keys, reserved members, and out-of-range values with the key in the path', () => {
    const issues = (input: Record<string, unknown>) =>
      serverConfigSchema
        .safeParse({ ...DERIVED, ...input })
        .error?.issues.map((i) => [i.path.join('.'), i.message]) ?? [];
    expect(issues({ maxSession: 2 })[0]?.[0]).toBe('');
    expect(issues({ transport: 'ws' })).toEqual([
      ['transport', "'ws' is reserved for a future release and cannot be set."],
    ]);
    expect(issues({ captcha: 'solver' })[0]?.[1]).toContain('reserved');
    expect(issues({ persistence: 'blueprint' })[0]?.[0]).toBe('persistence');
    expect(issues({ retentionDays: 0 })[0]?.[1]).toContain('an integer >= 1');
    expect(issues({ retentionBytes: '1MiB' })[0]?.[1]).toContain("at least '64MiB'");
    expect(issues({ sessionLease: '30s' })[0]?.[1]).toContain("at least '1m'");
    expect(issues({ authTokens: 'short:abc' })[0]?.[1]).toContain('32');
    expect(issues({ trustedProxies: '10.0.0.0/33' })[0]?.[0]).toBe('trustedProxies');
    expect(issues({ otelSignals: 'traces,profiles' })[0]?.[0]).toBe('otelSignals');
    expect(issues({ screencastQuality: 101 })[0]?.[0]).toBe('screencastQuality');
  });
});

describe('cross-field rules (spec 08 §4.1)', () => {
  it('1 minAttentionWait < attentionTimeout', () => {
    const config = resolved({ minAttentionWait: '45m', attentionTimeout: '30m' });
    expect(crossFieldIssues(config).map((i) => i.message)).toEqual([
      'minAttentionWait must be less than attentionTimeout (got minAttentionWait=45m, attentionTimeout=30m). Set minAttentionWait=0 to disable the floor.',
    ]);
    expect(crossFieldIssues(resolved({ minAttentionWait: 0, attentionTimeout: '1m' }))).toEqual([]);
  });
  it('2 humanize needs stealth', () => {
    expect(crossFieldIssues(resolved({ humanize: true, stealth: 'off' }))[0]?.message).toBe(
      "humanize=true requires stealth to be 'standard' or 'max' (got stealth=off).",
    );
  });
  it('3 fingerprint needs stealth only when explicit', () => {
    const config = resolved({ fingerprint: true, stealth: 'off' });
    expect(crossFieldIssues(config)).toEqual([]);
    expect(crossFieldIssues(config, new Set(['fingerprint']))[0]?.message).toBe(
      "fingerprint=true requires stealth to be 'standard' or 'max' (got stealth=off).",
    );
  });
  it('4 captcha=attention needs admin+http only when explicit', () => {
    expect(crossFieldIssues(resolved())).toEqual([]);
    expect(crossFieldIssues(resolved(), new Set(['captcha']))[0]?.message).toBe(
      'captcha=attention requires admin=true and transport=http, because CAPTCHA hand-off needs the dashboard.',
    );
    expect(crossFieldIssues(resolved({ admin: true }), new Set(['captcha']))).toEqual([]);
  });
  it('5 admin requires http (documented code) and 6 auth=token requires http', () => {
    const issues = crossFieldIssues(resolved({ transport: 'stdio', admin: true, auth: 'token' }));
    expect(issues).toEqual([
      {
        path: 'admin',
        code: 'ADMIN_REQUIRES_HTTP',
        message: 'admin=true requires transport=http. The dashboard is not available under stdio.',
      },
      {
        path: 'auth',
        message:
          'auth=token requires transport=http. Under stdio every caller is the local principal.',
      },
    ]);
    const parsed = serverConfigSchema.safeParse({ ...DERIVED, transport: 'stdio', admin: true });
    expect(parsed.error?.issues[0]).toMatchObject({
      path: ['admin'],
      params: { code: 'ADMIN_REQUIRES_HTTP' },
    });
  });
  it('7 otel* keys require otel=true, naming the keys actually set', () => {
    const config = resolved({ otelEndpoint: 'http://c:4318', otelServiceName: 'x' });
    expect(crossFieldIssues(config)).toEqual([]);
    expect(crossFieldIssues(config, new Set(['otelEndpoint', 'otelServiceName']))[0]?.message).toBe(
      'otelEndpoint and otelServiceName require otel=true.',
    );
    expect(crossFieldIssues(config, new Set(['otelEndpoint']))[0]?.message).toBe(
      'otelEndpoint requires otel=true.',
    );
    expect(
      crossFieldIssues(
        resolved({ otel: true, otelEndpoint: 'http://c:4318' }),
        new Set(['otelEndpoint']),
      ),
    ).toEqual([]);
  });
  it('8-10 trustedProxies, screenshotTrace, blocklistWatch', () => {
    expect(crossFieldIssues(resolved({ trustedProxies: '10.0.0.0/8' }))[0]?.message).toBe(
      'trustedProxies requires a non-loopback host; on a loopback bind X-Forwarded-For is never trusted.',
    );
    expect(
      crossFieldIssues(resolved({ trustedProxies: '10.0.0.0/8', host: '0.0.0.0', auth: 'token' })),
    ).toEqual([]);
    expect(crossFieldIssues(resolved({ screenshotTrace: true }))[0]?.message).toBe(
      'screenshotTrace=true requires trace=true.',
    );
    expect(crossFieldIssues(resolved({ blocklistWatch: true }))[0]?.message).toBe(
      'blocklistWatch=true requires blocklist to be set.',
    );
    expect(crossFieldIssues(resolved({ blocklistWatch: true, blocklist: './b.txt' }))).toEqual([]);
  });
  it('11 insecure bind is a policy guard, not a validation issue', () => {
    expect(isInsecureBind(resolved({ host: '0.0.0.0' }))).toBe(true);
    expect(isInsecureBind(resolved({ host: '0.0.0.0', auth: 'token' }))).toBe(false);
    expect(isInsecureBind(resolved({ host: '0.0.0.0', allowInsecureBind: true }))).toBe(false);
    expect(isInsecureBind(resolved({ host: '127.0.0.1' }))).toBe(false);
    expect(crossFieldIssues(resolved({ host: '0.0.0.0' }))).toEqual([]);
  });
  it('serverConfigSchemaFor threads the explicit set into superRefine', () => {
    const schema = serverConfigSchemaFor(new Set(['fingerprint']));
    expect(
      schema.safeParse({ ...DERIVED, fingerprint: true, stealth: 'off' }).error?.issues[0]?.path,
    ).toEqual(['fingerprint']);
  });
});

describe('configFileJsonSchema', () => {
  it('generates draft 2020-12 with one optional property per non-CLI key plus $schema', () => {
    const schema = configFileJsonSchema();
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['$id']).toBe(CONFIG_FILE_SCHEMA_ID);
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toBeUndefined();
    const properties = schema['properties'];
    expect(typeof properties).toBe('object');
    const props = properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toHaveLength(CONFIG_KEYS.length);
    expect(props['config']).toBeUndefined();
    expect(props['$schema']).toBeDefined();
    expect(props['sessionLease']).toMatchObject({
      default: '2h',
      'x-browserhive-env': 'BROWSERHIVE_SESSION_LEASE',
      'x-browserhive-cli': '--sessionLease',
    });
    expect(props['otelHeaders']).toMatchObject({ 'x-browserhive-secret': true });
    expect(props['logLevel']).toMatchObject({ default: 'info', 'x-browserhive-runtime': true });
    expect(props['maxSessions']?.['default']).toBeUndefined();
    expect(String(props['maxSessions']?.['description'])).toContain('erived');
    for (const key of Object.keys(props)) {
      for (const internal of [
        'describe',
        'group',
        'secret',
        'restartRequired',
        'grammar',
        'cliOnly',
      ]) {
        expect(props[key]?.[internal]).toBeUndefined();
      }
    }
    expect(() => JSON.stringify(schema)).not.toThrow();
  });
});

/** The subset of JSON Schema the generated config schema uses, enough to ask "does it accept this string?". */
function acceptsString(node: unknown, value: string, defs: Record<string, unknown>): boolean {
  if (typeof node !== 'object' || node === null) return true;
  const schema = node as Record<string, unknown>;
  const ref = schema['$ref'];
  if (typeof ref === 'string') return acceptsString(defs[ref.replace('#/$defs/', '')], value, defs);
  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) return anyOf.some((branch) => acceptsString(branch, value, defs));
  const type = schema['type'];
  if (
    type !== undefined &&
    !(type === 'string' || (Array.isArray(type) && type.includes('string')))
  ) {
    return false;
  }
  const members = schema['enum'];
  if (Array.isArray(members) && !members.includes(value)) return false;
  const pattern = schema['pattern'];
  if (typeof pattern === 'string' && !new RegExp(pattern, 'u').test(value)) return false;
  return true;
}

describe('configFileJsonSchema and references (spec 08 §3.1, §6)', () => {
  const schema = configFileJsonSchema();
  const props = schema['properties'] as Record<string, Record<string, unknown>>;
  const defs = schema['$defs'] as Record<string, unknown>;

  it('defines $defs.configRef as a string holding an {env:NAME} reference', () => {
    expect(defs['configRef']).toMatchObject({ type: 'string' });
    const pattern = new RegExp(String((defs['configRef'] as { pattern: string }).pattern), 'u');
    for (const good of ['{env:STEALTH}', '{env:X:-max}', '{env:_A1:-}', 'x{env:A}y']) {
      expect(pattern.test(good)).toBe(true);
    }
    for (const bad of ['max', '{env:}', '{ENV:X}', '{file:/x}', '{env:X:-{y}}']) {
      expect(pattern.test(bad)).toBe(false);
    }
  });

  it('every property accepts a string holding a reference', () => {
    for (const [key, property] of Object.entries(props)) {
      if (key === '$schema') continue;
      expect([key, acceptsString(property, '{env:X}', defs)]).toEqual([key, true]);
    }
  });

  it('widens every enum with the reference branch and still rejects other strings', () => {
    const widened: string[] = [];
    for (const [key, property] of Object.entries(props)) {
      if (!JSON.stringify(property).includes('"enum"')) continue;
      widened.push(key);
      expect(JSON.stringify(property)).toContain('"$ref":"#/$defs/configRef"');
    }
    expect(widened.sort()).toEqual(
      [
        'auth',
        'color',
        'defaultChannel',
        'logFormat',
        'logLevel',
        'logPersist',
        'otelProtocol',
        'recordToolResults',
        'sandbox',
        'stealth',
        'stealthDriver',
      ].sort(),
    );
    expect(acceptsString(props['stealth'], 'max', defs)).toBe(true);
    expect(acceptsString(props['stealth'], '{env:STEALTH:-max}', defs)).toBe(true);
    expect(acceptsString(props['stealth'], 'banana', defs)).toBe(false);
    expect(props['stealth']).toMatchObject({
      default: 'standard',
      'x-browserhive-env': 'BROWSERHIVE_STEALTH',
      anyOf: [{ type: 'string', enum: ['off', 'standard', 'max'] }, { $ref: '#/$defs/configRef' }],
    });
  });
});
