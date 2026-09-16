/** @module infra/browsers/identity-resolver.test — coherence and downgrade rules 1–5. */

import { describe, expect, it } from 'bun:test';
import type { GeoSeed } from '../../ports/browser-driver.ts';
import type { GeoSeedResolver } from '../../ports/geo-seed-resolver.ts';
import { deriveFingerprint } from './fingerprint.ts';
import type { HostFacts } from './host-facts.ts';
import { type IdentityRequest, resolveIdentity } from './identity-resolver.ts';

const HOST: HostFacts = {
  platform: 'darwin',
  arch: 'arm64',
  release: '24.0.0',
  env: { LANG: 'en_US.UTF-8' },
};

const HOST_SEED: GeoSeed = {
  locale: 'en-CA',
  languages: ['en-CA', 'en'],
  countryCode: 'CA',
  timezoneId: 'America/Toronto',
  source: 'host',
};

function geoSeed(): GeoSeedResolver & { calls: { sessionId: string; proxyServer?: string }[] } {
  const calls: { sessionId: string; proxyServer?: string }[] = [];
  return {
    calls,
    resolve: (input) => {
      calls.push(input);
      return Promise.resolve(HOST_SEED);
    },
  };
}

const base: IdentityRequest = { sessionId: 'sess-abcd1234', headless: true, proxy: null };

describe('resolveIdentity coherence rules (spec 11 §2.6)', () => {
  it('rule 3: resolves the geo seed per session with no warnings on the plain path', async () => {
    const seed = geoSeed();
    const { identity, warnings } = await resolveIdentity(base, { geoSeed: seed, host: HOST });
    expect(identity.geo).toEqual(HOST_SEED);
    expect(identity.assertDisplay).toBe(true);
    expect(warnings).toEqual([]);
    expect(seed.calls).toEqual([{ sessionId: 'sess-abcd1234' }]);
  });

  it('rule 1: caller locale/timezone wins, missing half from the host, no warning, resolver not consulted', async () => {
    const seed = geoSeed();
    const { identity, warnings } = await resolveIdentity(
      { ...base, contextOptions: { timezoneId: 'Europe/Berlin' } },
      { geoSeed: seed, host: HOST },
    );
    expect(identity.geo?.timezoneId).toBe('Europe/Berlin');
    expect(identity.geo?.locale).toBe('en-US');
    expect(identity.geo?.languages).toEqual(['en-US', 'en']);
    expect(warnings).toEqual([]);
    expect(seed.calls).toHaveLength(0);
  });

  it('rule 1 beats rule 2: a caller seed with a BYO proxy is honoured without a warning', async () => {
    const { identity, warnings } = await resolveIdentity(
      {
        ...base,
        launchOptions: { proxy: { server: 'http://p:1' } },
        contextOptions: { locale: 'de-DE', timezoneId: 'Europe/Berlin' },
      },
      { geoSeed: geoSeed(), host: HOST },
    );
    expect(identity.geo?.locale).toBe('de-DE');
    expect(warnings).toEqual([]);
  });

  it('rule 2: a BYO proxy (options, raw args, or typed) ⇒ geo null + BYO_PROXY_UNSEEDED', async () => {
    const variants: IdentityRequest[] = [
      { ...base, launchOptions: { proxy: { server: 'http://p:1' } } },
      { ...base, contextOptions: { proxy: { server: 'http://p:1' } } },
      { ...base, launchOptions: { args: ['--proxy-server=http://p:1'] } },
      { ...base, proxy: { server: 'http://p:1', label: 'byo:p:1' } },
    ];
    for (const request of variants) {
      const seed = geoSeed();
      const { identity, warnings } = await resolveIdentity(request, { geoSeed: seed, host: HOST });
      expect(identity.geo).toBeNull();
      expect(identity.assertDisplay).toBe(true);
      expect(warnings.map((w) => w.code)).toEqual(['BYO_PROXY_UNSEEDED']);
      expect(warnings[0]?.details).toEqual({ fingerprint: 'display-only' });
      expect(seed.calls).toHaveLength(0);
    }
  });

  it('rule 4: the restored seed wins over the session id, fresh sessions differ', async () => {
    const deps = { geoSeed: geoSeed(), host: HOST };
    const restored = await resolveIdentity({ ...base, restoredSeed: 'profile-seed' }, deps);
    expect(restored.identity.fingerprint).toEqual(
      deriveFingerprint({ seed: 'profile-seed', hostPlatform: 'darwin' }),
    );
    const fresh = await resolveIdentity(base, deps);
    expect(fresh.identity.fingerprint.seed).toBe('sess-abcd1234');
    const other = await resolveIdentity({ ...base, sessionId: 'sess-zzzz9999' }, deps);
    expect(other.identity.fingerprint.seed).toBe('sess-zzzz9999');
  });

  it('rule 5: headful ⇒ geo only (no display assertion, no warning)', async () => {
    const { identity, warnings } = await resolveIdentity(
      { ...base, headless: false },
      { geoSeed: geoSeed(), host: HOST },
    );
    expect(identity.assertDisplay).toBe(false);
    expect(identity.geo).toEqual(HOST_SEED);
    expect(warnings).toEqual([]);
  });

  it('rule 5: a caller viewport ⇒ VIEWPORT_OVERRIDE_UNASSERTED and no display assertion', async () => {
    const { identity, warnings } = await resolveIdentity(
      { ...base, contextOptions: { viewport: { width: 800, height: 600 } } },
      { geoSeed: geoSeed(), host: HOST },
    );
    expect(identity.assertDisplay).toBe(false);
    expect(warnings.map((w) => w.code)).toEqual(['VIEWPORT_OVERRIDE_UNASSERTED']);
    expect(warnings[0]?.details).toEqual({ fingerprint: 'geo-only' });
  });

  it('passes the resolved proxy server to the geo resolver only when a caller seed is absent and no BYO downgrade applies', async () => {
    // A managed proxy (source 'managed') is still "BYO present" for the downgrade rule today, so
    // the resolver is never consulted; the slot exists for the proxy-exit resolver (spec 11 §11).
    const seed = geoSeed();
    await resolveIdentity(
      { ...base, proxy: { server: 'http://m:1', label: 'pool-a', source: 'managed' } },
      { geoSeed: seed, host: HOST },
    );
    expect(seed.calls).toHaveLength(0);
  });
});
