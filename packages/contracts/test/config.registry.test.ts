/** @module contracts/test/config.registry — key table coverage, name uniqueness and round-trips */
import { describe, expect, it } from 'bun:test';
import {
  CONFIG_KEYS,
  envNameOf,
  KEY_ALIASES,
  keyMeta,
  keysInGroup,
  lookupKey,
  namesFor,
  RESERVED_CONFIG_KEYS,
  RESERVED_ENUM_MEMBERS,
  secretKeys,
} from '../src/config/index.ts';

/** Every key of spec 08 §5 (plus the spec 10 §4/§8 knobs). */
const SPEC_KEYS = [
  'config',
  'transport',
  'host',
  'port',
  'auth',
  'authTokens',
  'allowInsecureBind',
  'trustedProxies',
  'allowedHosts',
  'admin',
  'dataDir',
  'shutdownTimeout',
  'sessionCloseTimeout',
  'persistence',
  'defaultHeadless',
  'defaultChannel',
  'sandbox',
  'maxSessions',
  'sessionLease',
  'attentionTimeout',
  'minAttentionWait',
  'allowEvaluate',
  'stealth',
  'stealthDriver',
  'fingerprint',
  'humanize',
  'captcha',
  'blocklist',
  'blocklistWatch',
  'vault',
  'logLevel',
  'logFormat',
  'color',
  'trace',
  'screenshotTrace',
  'screencastQuality',
  'recordToolResults',
  'retentionDays',
  'retentionBytes',
  'backupsKeep',
  'otel',
  'otelEndpoint',
  'otelProtocol',
  'otelHeaders',
  'otelServiceName',
  'otelSampleRatio',
  'otelTraceUrlTemplate',
  'logRingSize',
  'logPersist',
  'otelSignals',
  'otelVerbose',
  'urlQueryAllowlist',
] as const;

describe('CONFIG_KEYS', () => {
  it('covers every key of the spec 08 key table', () => {
    for (const key of SPEC_KEYS) expect(CONFIG_KEYS).toContain(key);
    expect(CONFIG_KEYS.length).toBe(SPEC_KEYS.length);
  });

  it('derives names mechanically and keeps them unique across keys and reserved keys', () => {
    expect(namesFor('maxSessions')).toEqual({
      env: 'BROWSERHIVE_MAX_SESSIONS',
      cli: '--maxSessions',
      json: 'maxSessions',
    });
    expect(namesFor('otelEndpoint').env).toBe('BROWSERHIVE_OTEL_ENDPOINT');
    expect(namesFor('allowInsecureBind').env).toBe('BROWSERHIVE_ALLOW_INSECURE_BIND');
    expect(envNameOf('otelTraceUrlTemplate')).toBe('BROWSERHIVE_OTEL_TRACE_URL_TEMPLATE');
    const all = [...CONFIG_KEYS, ...RESERVED_CONFIG_KEYS];
    for (const source of ['env', 'cli', 'json'] as const) {
      const names = all.map((key) => namesFor(key)[source]);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('round-trips every spelling through lookupKey', () => {
    for (const key of CONFIG_KEYS) {
      const names = namesFor(key);
      expect(lookupKey('env', names.env)).toEqual({ kind: 'key', key });
      expect(lookupKey('cli', names.cli)).toEqual({ kind: 'key', key });
      expect(lookupKey('json', names.json)).toEqual({ kind: 'key', key });
    }
    for (const key of RESERVED_CONFIG_KEYS) {
      expect(lookupKey('json', key)).toEqual({ kind: 'reserved', key });
      expect(lookupKey('env', namesFor(key).env)).toEqual({ kind: 'reserved', key });
    }
    expect(lookupKey('cli', '--max-sessions')).toEqual({ kind: 'unknown' });
    expect(lookupKey('cli', '--maxsessions')).toEqual({ kind: 'unknown' });
    expect(lookupKey('env', 'BROWSERHIVE_MAX_SESSION')).toEqual({ kind: 'unknown' });
  });

  it('has metadata for every key', () => {
    for (const key of CONFIG_KEYS) {
      const meta = keyMeta(key);
      expect(meta.describe.length).toBeGreaterThan(10);
      expect(meta.group.length).toBeGreaterThan(0);
      expect(typeof meta.grammar).toBe('string');
    }
    expect(secretKeys()).toEqual(['authTokens', 'otelHeaders']);
    expect(CONFIG_KEYS.filter((k) => !keyMeta(k).restartRequired)).toEqual([
      'logLevel',
      'logFormat',
      'otelTraceUrlTemplate',
    ]);
    expect(CONFIG_KEYS.filter((k) => keyMeta(k).cliOnly)).toEqual(['config']);
    expect(CONFIG_KEYS.filter((k) => keyMeta(k).derivedFrom !== undefined)).toEqual([
      'dataDir',
      'maxSessions',
      'fingerprint',
      'trace',
    ]);
    expect(keyMeta('maxSessions').derivedFrom).toBe('hostMemory');
    expect(keyMeta('sessionLease')).toMatchObject({
      default: 7_200_000,
      defaultText: '2h',
      group: 'sessions',
    });
    expect(keyMeta('retentionDays').default).toBe(7);
    expect(keyMeta('otelHeaders')).toMatchObject({ secret: true, default: {} });
    expect(keysInGroup('telemetry')[0]).toBe('otel');
  });

  it('registers the reserved enum members and key aliases', () => {
    expect(RESERVED_ENUM_MEMBERS.vault).toEqual(['local', 'onepassword', 'http']);
    expect(RESERVED_ENUM_MEMBERS.captcha).toEqual(['solver']);
    expect(KEY_ALIASES['--pretty-logs']).toBe('logFormat');
    expect(KEY_ALIASES['BROWSERHIVE_DISABLE_PATCHRIGHT']).toBe('stealthDriver');
  });
});
