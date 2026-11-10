/** @module kernel/self-address.test — loopback by meaning and the canonical loopback names. */

import { describe, expect, it } from 'bun:test';
import { canonicalHost, isCanonicalLoopback, isLoopbackByMeaning } from './self-address.ts';

describe('isLoopbackByMeaning', () => {
  it('accepts every spelling of loopback and the unspecified addresses', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'foo.localhost',
      'a.b.localhost',
      '127.0.0.1',
      '127.0.0.2',
      '127.255.255.255',
      '[::1]',
      '::1',
      '0:0:0:0:0:0:0:1',
      '0.0.0.0',
      '::',
      '[::ffff:127.0.0.1]',
      '::ffff:7f00:1',
      '[::ffff:7f12:3456]',
      '::127.0.0.1',
      '0:0:0:0:0:ffff:127.0.0.1',
    ]) {
      expect([host, isLoopbackByMeaning(host)]).toEqual([host, true]);
    }
  });

  it('refuses other hosts', () => {
    for (const host of [
      'example.com',
      'localhost.example.com',
      '128.0.0.1',
      '10.0.0.1',
      '::2',
      '::ffff:10.0.0.1',
      '::ffff:8000:1',
      'fe80::1',
      '1::1',
      'not:an:ip',
    ]) {
      expect([host, isLoopbackByMeaning(host)]).toEqual([host, false]);
    }
  });

  it('canonical loopback names are the cookie-scoped ones', () => {
    expect(['localhost', 'LocalHost.', '127.0.0.1', '[::1]'].map(isCanonicalLoopback)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['foo.localhost', '127.0.0.2', '::ffff:127.0.0.1'].map(isCanonicalLoopback)).toEqual([
      false,
      false,
      false,
    ]);
    expect(canonicalHost('[::1]')).toBe('::1');
  });
});
