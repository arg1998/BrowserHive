/** @module domain/policies/proxy-request.test — BYO proxy extraction precedence and label derivation. */

import { describe, expect, it } from 'bun:test';
import { proxyLabelFor, requestedProxy } from './proxy-request.ts';

describe('requestedProxy', () => {
  it('returns null without any proxy', () => {
    expect(requestedProxy(undefined, undefined)).toBeNull();
    expect(requestedProxy({ args: ['--foo'] }, { locale: 'de' })).toBeNull();
  });

  it('context proxy wins over launch proxy', () => {
    const spec = requestedProxy(
      { proxy: { server: 'http://launch.example:1' } },
      {
        proxy: {
          server: 'http://ctx.example:2',
          bypass: 'localhost',
          username: 'u',
          password: 'p',
        },
      },
    );
    expect(spec).toEqual({
      server: 'http://ctx.example:2',
      bypass: 'localhost',
      username: 'u',
      password: 'p',
      label: 'ctx.example:2',
      source: 'byo',
    });
  });

  it('falls back to the launch proxy and omits absent optional fields', () => {
    expect(requestedProxy({ proxy: { server: 'socks5://h:9' } }, undefined)).toEqual({
      server: 'socks5://h:9',
      label: 'h:9',
      source: 'byo',
    });
    expect(requestedProxy({ proxy: { server: '' } }, undefined)).toBeNull();
  });

  it('detects a raw --proxy-server arg', () => {
    const spec = requestedProxy(
      { args: ['--x', '--proxy-server=http://user:pw@raw.example:3128'] },
      undefined,
    );
    expect(spec?.server).toBe('http://user:pw@raw.example:3128');
    expect(spec?.label).toBe('raw.example:3128');
    expect(spec?.source).toBe('byo');
    const bare = requestedProxy({ args: ['--proxy-pac-url'] }, undefined);
    expect(bare?.label).toBe('--proxy-pac-url');
  });

  it('label is host:port without credentials', () => {
    expect(proxyLabelFor('http://user:secret@proxy.example:8080')).toBe('proxy.example:8080');
    expect(proxyLabelFor('proxy.example:8080')).toBe('proxy.example:8080');
    expect(proxyLabelFor('not a url')).toBe('not a url');
  });
});
