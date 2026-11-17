/// <reference lib="dom" />
/** @module test/integration/site-pack-strategies-network.test — spec 13 §17 T3b acceptance for the network and host strategies on real headless Chromium (WP-N): `pace-writes` holds then aborts (rows `held` and `paced`, the `SITE_PACED` warning), `ramp-up` lowers a budget, `device-bound-session` marks the site from a response header, `webrtc-policy` restarts the host with the switch on its command line (and the ICE candidates follow it), `keep-alive` visits the keeper path and skips after an agent load, a Reddit-shaped client-side redirect after `load` probes `signed_out` (D48), and `sitePacks=false` leaves every one of them inert. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Page } from 'patchright';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { WEBRTC_POLICY_FLAGS } from '../../src/domain/site-packs/host-flags.ts';
import {
  inviteRule,
  type NetworkWorld,
  networkWorld,
  SITE,
  strategyPack,
  until,
} from './site-pack-strategies-network-fixture.ts';
import { STEALTH_LEGS } from './template-fixture.ts';

let world: NetworkWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

const PACED = { strategies: [{ id: 'pace-writes' as const, params: {} }] };

/** Launches an agent session and opens `path` on the fixture site in its page. */
async function agentPage(n: NetworkWorld, path: string): Promise<{ id: string; page: Page }> {
  const { session_id: id } = await n.w.harness.callJson<{ session_id: string }>('launch_session', {
    slug: 'strategies',
    template: n.w.template.name,
  });
  const page = n.w.harness.services.sessions.peek(id)?.view?.page;
  if (page === undefined) throw new Error('no page');
  await page.goto(n.w.sites.url(SITE, path));
  return { id, page };
}

/** Clicks the burst button and waits for the five writes' outcomes. */
async function burst(page: Page): Promise<string[]> {
  await page.click('#burst');
  await page.waitForFunction(
    () => (document.getElementById('out')?.textContent ?? '') !== '',
    null,
    {
      timeout: 20_000,
    },
  );
  return ((await page.textContent('#out')) ?? '').split(',');
}

/** The ICE candidates a fresh `RTCPeerConnection` gathers in `page` (3 s at most). */
async function iceCandidates(page: Page): Promise<string[]> {
  return await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const found: string[] = [];
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('x');
        const done = () => {
          pc.close();
          resolve(found);
        };
        pc.onicecandidate = (e) => {
          if (e.candidate === null) done();
          else found.push(e.candidate.candidate);
        };
        setTimeout(done, 3_000);
        void pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      }),
  );
}

describe.each([...STEALTH_LEGS])('network strategies (template stealth %s)', (stealth) => {
  it('pace-writes holds writes for their token, then aborts them with paced rows and SITE_PACED', async () => {
    // Two writes a minute: a token every 30 s (0.6 s on the fast pacer clock).
    world = await networkWorld({
      stealth,
      pack: strategyPack({ ...PACED, pacing: { rules: [inviteRule('minute', 2)] } }),
    });
    const n = world;
    const { id, page } = await agentPage(n, '/strategies/burst');
    const results = await burst(page);
    // Two within budget, two held (30 s and 60 s away), one refused (90 s away).
    expect(results.filter((r) => r === 'sent 200')).toHaveLength(4);
    expect(results.filter((r) => r === 'blocked')).toHaveLength(1);
    expect(n.seen('/api/invite', 'POST')).toBe(4);
    await until(() => n.hitActions().length === 3);
    expect(n.hitActions().sort()).toEqual(['held', 'held', 'paced']);
    await until(() => n.warnings(id).includes('SITE_PACED'));
  });

  it('webrtc-policy: a pack applied while the host runs restarts it with the switch', async () => {
    world = await networkWorld({ stealth });
    const n = world;
    await n.ops.startHost(n.w.template);
    const before = await n.commandLine();
    const firstPid = await n.w.supervisor.runningHost(n.w.template.templateId)?.browserPid?.();
    if (before !== null) {
      expect(before.some((a) => a.startsWith('--force-webrtc-ip-handling-policy'))).toBe(false);
    }
    n.lookup.swap(
      strategyPack({
        strategies: [{ id: 'webrtc-policy', params: { policy: 'disable_non_proxied_udp' } }],
      }),
    );
    n.w.harness.bus.publish('site_pack.changed', {
      type: 'site_pack.changed',
    } as unknown as DomainEvents['site_pack.changed']);
    await until(async () => {
      const pid = await n.w.supervisor.runningHost(n.w.template.templateId)?.browserPid?.();
      return pid != null && pid !== firstPid;
    }, 30_000);
    const after = await n.commandLine();
    if (after !== null) expect(after).toContain(WEBRTC_POLICY_FLAGS.disable_non_proxied_udp);
    // Without a proxy, the policy leaves WebRTC no UDP path: no host candidate is gathered.
    const { page } = await agentPage(n, '/strategies/plain');
    const candidates = await iceCandidates(page);
    expect(candidates.filter((c) => / udp /i.test(c))).toEqual([]);
  });
});

describe('network strategies (template stealth standard)', () => {
  it('ramp-up lowers a young template budget; past the ramp the full budget applies', async () => {
    const pack = strategyPack({
      strategies: [
        { id: 'pace-writes', params: {} },
        { id: 'ramp-up', params: { days: 10, start_fraction: 0.4 } },
      ],
      pacing: { rules: [inviteRule('hour', 4)] },
    });
    world = await networkWorld({ pack, createdAt: () => Date.now() });
    const young = await agentPage(world, '/strategies/burst');
    // 4 × 0.4 (and a few seconds of ramp) rounds up to 2 an hour: two go, the rest are refused.
    expect((await burst(young.page)).filter((r) => r === 'sent 200')).toHaveLength(2);
    await world.stop();
    world = await networkWorld({ pack });
    const old = await agentPage(world, '/strategies/burst');
    expect((await burst(old.page)).filter((r) => r === 'sent 200')).toHaveLength(4);
  });

  it('device-bound-session marks the site from a DBSC response header and publishes the change', async () => {
    world = await networkWorld({
      pack: strategyPack({ strategies: [{ id: 'device-bound-session', params: {} }] }),
    });
    const n = world;
    const repos = n.w.harness.templates.repos;
    const bound = async () =>
      (await repos.templateSites.list(n.w.template.templateId))[0]?.deviceBound === true;
    await agentPage(n, '/strategies/plain');
    await Bun.sleep(300);
    expect(await bound()).toBe(false);
    const { page } = await agentPage(n, '/strategies/dbsc');
    expect(await page.textContent('#dbsc')).toBe('bound');
    await until(bound);
    expect(
      n.w.harness.bus.published.some(
        (p) =>
          p.name === 'template.changed' &&
          (p.payload as { template: { template_id: string } }).template.template_id ===
            n.w.template.templateId,
      ),
    ).toBe(true);
  });

  it('keep-alive visits the keeper path as a probe, and skips after an agent load', async () => {
    world = await networkWorld({
      pack: strategyPack({
        signed_in: {
          probe: { host: SITE, path: '/strategies/stays' },
          kind: 'either',
          signed_out_redirects: [`${SITE}/login*`],
          landmark: '#feed',
        },
        strategies: [{ id: 'keep-alive', params: { interval_h: 6 } }],
        keeper: { interval_hours: 6, path: '/strategies/keep' },
      }),
    });
    const n = world;
    const H = 3_600_000;
    await n.keeper.tick();
    expect(n.seen('/strategies/keep')).toBe(0);
    await n.keeperClock.advance(7 * H);
    const visited = [...(await n.keeper.tick()).values()];
    expect(visited).toMatchObject([
      { kind: 'visited', verdict: { outcome: 'signed_in', reason: 'landmark' }, recorded: true },
    ]);
    expect(n.seen('/strategies/keep', 'GET')).toBe(1);
    const probes = n.w.harness.templates.repos.templateProbes.rows;
    expect(probes[probes.length - 1]).toMatchObject({ trigger: 'schedule', outcome: 'signed_in' });
    // An hour later an agent loads the site; the visit due five hours after that is skipped.
    await n.keeperClock.advance(H);
    await agentPage(n, '/strategies/plain');
    await n.keeperClock.advance(5 * H);
    const next = [...(await n.keeper.tick()).values()];
    expect(next).toEqual([{ kind: 'skipped', reason: 'agent_load' }]);
    expect(n.seen('/strategies/keep')).toBe(1);
  });

  it('D48: a Reddit-shaped probe that redirects client-side after load is signed_out; one that stays is signed_in', async () => {
    world = await networkWorld({
      pack: strategyPack({
        signed_in: {
          probe: { host: SITE, path: '/strategies/reddit' },
          kind: 'either',
          signed_out_redirects: [`${SITE}/login*`],
        },
      }),
    });
    const n = world;
    const probe = async () =>
      (
        await n.health.probe(n.w.template.templateId, {
          trigger: 'manual',
          start: 'always',
          siteIds: [SITE],
        })
      )?.[0];
    expect(await probe()).toMatchObject({ outcome: 'signed_out', reason: 'redirect' });
    n.lookup.swap(
      strategyPack({
        signed_in: {
          probe: { host: SITE, path: '/strategies/stays' },
          kind: 'either',
          signed_out_redirects: [`${SITE}/login*`],
        },
      }),
    );
    expect(await probe()).toMatchObject({ outcome: 'signed_in', reason: 'no_redirect' });
  });

  it('sitePacks=false: no pacing, no device binding, no switches, no keeper visit', async () => {
    world = await networkWorld({
      packs: false,
      pack: strategyPack({
        strategies: [
          { id: 'pace-writes', params: {} },
          { id: 'device-bound-session', params: {} },
          { id: 'webrtc-policy', params: { policy: 'disable_non_proxied_udp' } },
          { id: 'keep-alive', params: { interval_h: 6 } },
        ],
        pacing: { rules: [inviteRule('hour', 1)] },
      }),
    });
    const n = world;
    const { page } = await agentPage(n, '/strategies/burst');
    expect((await burst(page)).filter((r) => r === 'sent 200')).toHaveLength(5);
    expect(n.hitActions()).toEqual([]);
    await page.goto(n.w.sites.url(SITE, '/strategies/dbsc'));
    await Bun.sleep(300);
    const sites = await n.w.harness.templates.repos.templateSites.list(n.w.template.templateId);
    expect(sites[0]?.deviceBound).toBe(false);
    const line = await n.commandLine();
    if (line !== null) {
      expect(line.some((a) => a.startsWith('--force-webrtc-ip-handling-policy'))).toBe(false);
    }
    await n.keeperClock.advance(100 * 3_600_000);
    expect((await n.keeper.tick()).size).toBe(0);
  });
});
