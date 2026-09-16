/** @module infra/browsers/proxy.test — forced loopback/RFC1918 bypass and the pass-through resolver. */

import { describe, expect, it } from 'bun:test';
import { FORCED_PROXY_BYPASS, mergeBypass, PassThroughProxyResolver } from './proxy.ts';

describe('mergeBypass', () => {
  it('always contains loopback and RFC1918 ranges, forced entries first', () => {
    const merged = mergeBypass(undefined).split(',');
    expect(merged).toEqual([...FORCED_PROXY_BYPASS]);
    expect(merged).toContain('localhost');
    expect(merged).toContain('127.0.0.0/8');
    expect(merged).toContain('::1');
    expect(merged).toContain('10.0.0.0/8');
    expect(merged).toContain('172.16.0.0/12');
    expect(merged).toContain('192.168.0.0/16');
    expect(merged).toContain('*.local');
  });

  it('unions the caller list, de-duplicating case-insensitively and trimming', () => {
    const merged = mergeBypass('  Localhost ; *.corp.example, 10.0.0.0/8 ,,').split(',');
    expect(merged.filter((e) => e.toLowerCase() === 'localhost')).toHaveLength(1);
    expect(merged).toContain('*.corp.example');
    expect(merged.filter((e) => e === '10.0.0.0/8')).toHaveLength(1);
    expect(merged.every((e) => e === e.trim() && e.length > 0)).toBe(true);
  });
});

describe('PassThroughProxyResolver', () => {
  const resolver = new PassThroughProxyResolver();

  it('returns null when nothing was requested', async () => {
    expect(await resolver.resolve({ sessionId: 's-1', requested: null })).toBeNull();
  });

  it('passes the BYO proxy through with the forced bypass and byo source', async () => {
    const resolved = await resolver.resolve({
      sessionId: 's-1',
      requested: { server: 'http://p:1', bypass: '*.corp', username: 'u', label: 'byo:p:1' },
    });
    expect(resolved?.server).toBe('http://p:1');
    expect(resolved?.username).toBe('u');
    expect(resolved?.label).toBe('byo:p:1');
    expect(resolved?.source).toBe('byo');
    expect(resolved?.bypass?.split(',')).toContain('*.corp');
    expect(resolved?.bypass?.split(',')).toContain('127.0.0.0/8');
  });
});
