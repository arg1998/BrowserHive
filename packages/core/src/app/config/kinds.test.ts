/** @module app/config/kinds.test — unit tests for kinds */
import { describe, expect, it } from 'bun:test';
import { CONFIG_KEYS, keyMeta } from '@browserhive/contracts/config';
import { deriveMaxSessions, hostRamGib, osDefaultDataDir } from './data-dir.ts';
import { keyKind, PATH_KEYS, quoteRaw, renderValue } from './kinds.ts';
import { fakeHost, GIB } from './test-support.ts';

describe('keyKind', () => {
  it('classifies the keys spec 08 §2.1 assigns a grammar to', () => {
    expect(keyKind('admin')).toBe('boolean');
    expect(keyKind('sessionLease')).toBe('duration');
    expect(keyKind('minAttentionWait')).toBe('duration');
    expect(keyKind('retentionBytes')).toBe('bytes');
    expect(keyKind('trustedProxies')).toBe('list');
    expect(keyKind('authTokens')).toBe('list');
    expect(keyKind('otelSignals')).toBe('list');
    expect(keyKind('otelHeaders')).toBe('map');
    expect(keyKind('logLevel')).toBe('levelSpec');
    expect(keyKind('dataDir')).toBe('path');
    expect(keyKind('port')).toBe('scalar');
    expect(keyKind('host')).toBe('scalar');
    expect(keyKind('maxSessions')).toBe('scalar');
  });

  it('every path key has the path grammar and every key has a grammar', () => {
    for (const key of PATH_KEYS) expect(keyMeta(key).grammar).toBe('a non-empty file system path');
    for (const key of CONFIG_KEYS) expect(typeof keyMeta(key).grammar).toBe('string');
  });
});

describe('renderValue', () => {
  it('renders the canonical form the parser accepts back', () => {
    expect(renderValue('sessionLease', 7_200_000)).toBe('2h');
    expect(renderValue('minAttentionWait', 0)).toBe('0ms');
    expect(renderValue('retentionBytes', 2 * GIB)).toBe('2GiB');
    expect(renderValue('logLevel', { root: 'info', modules: { sessions: 'debug' } })).toBe(
      'info,sessions=debug',
    );
    expect(renderValue('trustedProxies', ['a', 'b'])).toBe('a,b');
    expect(renderValue('otelHeaders', { k: 'v', k2: 'v2' })).toBe('k=v,k2=v2');
    expect(renderValue('admin', true)).toBe('true');
    expect(renderValue('port', 9876)).toBe('9876');
    expect(renderValue('maxSessions', 'unbounded')).toBe('unbounded');
    expect(renderValue('blocklist', undefined)).toBe('');
  });
});

describe('quoteRaw', () => {
  it('quotes strings as-is and JSON values stringified', () => {
    expect(quoteRaw('2 hours')).toBe("'2 hours'");
    expect(quoteRaw(70000)).toBe("'70000'");
    expect(quoteRaw(['a'])).toBe(`'["a"]'`);
  });
});

describe('data-dir derivations', () => {
  it('deriveMaxSessions = min(floor(GiB / 1.5), 20), at least 1', () => {
    expect(deriveMaxSessions(0)).toBe(1);
    expect(deriveMaxSessions(1 * GIB)).toBe(1);
    expect(deriveMaxSessions(3 * GIB)).toBe(2);
    expect(deriveMaxSessions(12 * GIB)).toBe(8);
    expect(deriveMaxSessions(16 * GIB)).toBe(10);
    expect(deriveMaxSessions(30 * GIB)).toBe(20);
    expect(deriveMaxSessions(256 * GIB)).toBe(20);
  });

  it('hostRamGib rounds to whole GiB', () => {
    expect(hostRamGib(12 * GIB)).toBe(12);
    expect(hostRamGib(15.6 * GIB)).toBe(16);
  });

  it('osDefaultDataDir follows D-24 per platform', () => {
    expect(osDefaultDataDir(fakeHost({ platform: 'darwin', homeDir: '/Users/me' }))).toBe(
      '/Users/me/Library/Application Support/BrowserHive',
    );
    expect(
      osDefaultDataDir(fakeHost({ platform: 'win32', homeDir: '/u', env: { LOCALAPPDATA: '' } })),
    ).toBe('/u/AppData/Local/BrowserHive');
    expect(osDefaultDataDir(fakeHost({ platform: 'freebsd', homeDir: '/home/me' }))).toBe(
      '/home/me/.local/share/browserhive',
    );
    expect(osDefaultDataDir(fakeHost({ env: { XDG_DATA_HOME: '' } }))).toBe(
      '/home/tester/.local/share/browserhive',
    );
  });
});
