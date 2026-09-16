/** @module infra/browsers/pass-through.test — pass-through schemas, sibling-field policy and BYO-proxy detection. */

import { describe, expect, it } from 'bun:test';
import {
  BrowserContextOptionsSchema,
  byoProxyPresent,
  extractByoProxy,
  LaunchOptionsSchema,
  parseContextOptions,
  proxyLabelFor,
} from './pass-through.ts';

describe('LaunchOptionsSchema', () => {
  it('types known fields', () => {
    const parsed = LaunchOptionsSchema.parse({ args: ['--x'], executablePath: '/bin/chrome' });
    expect(parsed.args).toEqual(['--x']);
    expect(parsed.executablePath).toBe('/bin/chrome');
  });

  it('passes unknown keys through verbatim (forward-compat)', () => {
    const parsed = LaunchOptionsSchema.parse({ slowMo: 50, futureFlag: true });
    expect(parsed).toMatchObject({ slowMo: 50, futureFlag: true });
  });

  it('accepts an empty object', () => {
    expect(LaunchOptionsSchema.parse({})).toEqual({});
  });

  it('rejects a non-string in args', () => {
    expect(() => LaunchOptionsSchema.parse({ args: ['ok', 3] })).toThrow();
  });
});

describe('BrowserContextOptionsSchema', () => {
  it('forwards arbitrary context options unchanged', () => {
    const opts = { viewport: { width: 800, height: 600 }, locale: 'en-GB', deviceScaleFactor: 2 };
    expect(BrowserContextOptionsSchema.parse(opts)).toEqual(opts);
  });

  it('accepts an empty object', () => {
    expect(BrowserContextOptionsSchema.parse({})).toEqual({});
  });

  it('refuses recordVideo on the context bag too', () => {
    expect(() => parseContextOptions({ recordVideo: { dir: '/tmp' } })).toThrow();
  });
});

describe('byoProxyPresent', () => {
  it('detects a proxy on either options bag', () => {
    expect(byoProxyPresent({ proxy: { server: 'http://p:1' } }, undefined)).toBe(true);
    expect(byoProxyPresent(undefined, { proxy: { server: 'http://p:1' } })).toBe(true);
  });

  it('detects a proxy smuggled through raw Chromium launch args', () => {
    // Without this the identity layer would assert a host locale over an egress it cannot see.
    expect(byoProxyPresent({ args: ['--proxy-server=http://p:1'] }, undefined)).toBe(true);
    expect(byoProxyPresent({ args: ['--proxy-pac-url=http://p/pac'] }, undefined)).toBe(true);
    expect(byoProxyPresent({ args: ['--host-resolver-rules=MAP * 1.2.3.4'] }, undefined)).toBe(
      true,
    );
  });

  it('detects the typed LaunchSpec.proxy (D-13)', () => {
    expect(byoProxyPresent(undefined, undefined, { server: 'http://p:1', label: 'x' })).toBe(true);
  });

  it('is false for an ordinary session', () => {
    expect(byoProxyPresent(undefined, undefined)).toBe(false);
    expect(byoProxyPresent({ args: ['--mute-audio'] }, { locale: 'en-US' })).toBe(false);
  });
});

describe('extractByoProxy', () => {
  it('normalises the structured proxy with a credential-free label', () => {
    const spec = extractByoProxy(
      { proxy: { server: 'http://user:pw@proxy.example:3128', username: 'u', password: 'p' } },
      undefined,
    );
    expect(spec).toEqual({
      server: 'http://user:pw@proxy.example:3128',
      username: 'u',
      password: 'p',
      label: 'byo:proxy.example:3128',
      source: 'byo',
    });
  });

  it('prefers the launch-level proxy, falls back to the context-level one, else null', () => {
    expect(
      extractByoProxy({ proxy: { server: 'http://a:1' } }, { proxy: { server: 'http://b:1' } })
        ?.server,
    ).toBe('http://a:1');
    expect(extractByoProxy(undefined, { proxy: { server: 'http://b:1' } })?.server).toBe(
      'http://b:1',
    );
    expect(extractByoProxy(undefined, undefined)).toBeNull();
  });

  it('labels a bare host:port and survives junk', () => {
    expect(proxyLabelFor('proxy:8080')).toBe('byo:proxy:8080');
    expect(proxyLabelFor('socks5://1.2.3.4:1080')).toBe('byo:1.2.3.4:1080');
    expect(proxyLabelFor('::::')).toBe('byo');
  });
});
