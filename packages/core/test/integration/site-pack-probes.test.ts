/** @module test/integration/site-pack-probes.test — spec 13 §17 T3a acceptance for navigation probes (§8.1) on real Chromium with the HTTPS fixture sites: the pack prober, in a page of BrowserHive's own maintenance session, produces all four outcomes (landmark, redirect, challenge, timeout), a probe path that moves below itself still reads signed in (`/feed/` → `/feed/foryou/`), every sign-in cookie present with no other signal reads `cookies_present`, the cookie pre-check decides without navigating, a challenged probe is never `signed_out`, and the probe page is closed afterwards. */

import { afterEach, describe, expect, it } from 'bun:test';
import { fixturePack, type PackWorld, packWorld } from './site-pack-fixture.ts';

let world: PackWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

const SITE = 'site-a.test';

async function probe(p: PackWorld) {
  const run = await p.health.probe(p.w.template.templateId, {
    trigger: 'manual',
    start: 'always',
    siteIds: [SITE],
  });
  const probes = p.w.harness.templates.repos.templateProbes.rows;
  return { result: run?.[0], row: probes[probes.length - 1] };
}

/** No maintenance session is left open once a probe returned. */
function maintenanceLeft(p: PackWorld): number {
  return p.w.harness.services.sessions
    .listAll()
    .filter((s) => s.template?.mode === 'maintenance' && !s.dead).length;
}

describe('pack probes', () => {
  it('produce all four outcomes against landmark, redirecting, challenge and timing-out pages', async () => {
    world = await packWorld(fixturePack('/pack/probe/in'), { probeTimeoutMs: 2_000 });
    const p = world;

    const signedIn = await probe(p);
    expect(signedIn.result).toMatchObject({ outcome: 'signed_in', reason: 'landmark' });
    expect(signedIn.row?.finalUrl).toBe('https://site-a.test/pack/probe/in');

    p.lookup.swap(fixturePack('/pack/probe/out'));
    const signedOut = await probe(p);
    expect(signedOut.result).toMatchObject({ outcome: 'signed_out', reason: 'redirect' });
    // Sanitized: the redirect's query is dropped.
    expect(signedOut.row?.finalUrl).toBe('https://site-a.test/login');

    p.lookup.swap(fixturePack('/pack/probe/cf'));
    const challenged = await probe(p);
    expect(challenged.result).toMatchObject({
      outcome: 'challenged',
      reason: 'challenge:captcha',
    });

    // Review #83 C-L5: a 403 bot wall on the probe path is not a session.
    p.lookup.swap(fixturePack('/pack/probe/forbidden'));
    const forbidden = await probe(p);
    expect(forbidden.result).toMatchObject({ outcome: 'inconclusive', reason: 'http_403' });

    p.lookup.swap(fixturePack('/pack/probe/slow'));
    const slow = await probe(p);
    expect(slow.result).toMatchObject({ outcome: 'inconclusive', reason: 'timeout' });

    expect(maintenanceLeft(p)).toBe(0);
    // Only GET navigations to the probe paths (the redirect target included).
    const probeRequests = p.w.sites.requests.filter((r) => r.path.startsWith('/pack/probe/'));
    expect(probeRequests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('a probe path that moves below itself is signed in (LinkedIn /feed/ → /feed/foryou/, owner 2026-11-17)', async () => {
    const pack = fixturePack('/pack/probe/feed/');
    world = await packWorld({
      ...pack,
      signed_in: { ...pack.signed_in, kind: 'redirect', landmark: undefined },
    });
    const { result, row } = await probe(world);
    expect(result).toMatchObject({ outcome: 'signed_in', reason: 'no_redirect' });
    expect(row?.finalUrl).toBe('https://site-a.test/pack/probe/feed/foryou/');
  });

  it('every sign-in cookie present and no other signal reads cookies_present', async () => {
    const pack = fixturePack('/pack/probe/moved');
    const plain = {
      ...pack,
      signed_in: { ...pack.signed_in, kind: 'redirect' as const, landmark: undefined },
    };
    world = await packWorld(plain);
    const p = world;
    // The first visit sets the sign-in cookie; the pack names none yet, so nothing says signed in.
    expect((await probe(p)).result).toMatchObject({ outcome: 'inconclusive', reason: 'no_signal' });
    p.lookup.swap({ ...plain, signed_in: { ...plain.signed_in, cookie_names: ['sid'] } });
    const { result, row } = await probe(p);
    expect(result).toMatchObject({ outcome: 'signed_in', reason: 'cookies_present' });
    expect(row?.finalUrl).toBe('https://site-a.test/pack/moved-home');
  });

  it('the cookie pre-check answers cookies_absent without navigating', async () => {
    const pack = fixturePack('/pack/probe/in');
    world = await packWorld({
      ...pack,
      signed_in: { ...pack.signed_in, cookie_names: ['sid'] },
    });
    const p = world;
    // Start the browser first, so the check reads the running browser's jar.
    await p.w.supervisor.launchMaintenance({
      template: p.w.template,
      sites: [],
      slug: 'maintenance',
      principal: { subject: 'browserhive' },
    });
    const { result, row } = await probe(p);
    expect(result).toMatchObject({ outcome: 'signed_out', reason: 'cookies_absent' });
    expect(row?.finalUrl).toBeNull();
    expect(p.w.sites.requests.some((r) => r.path.startsWith('/pack/probe/'))).toBe(false);
  });
});
