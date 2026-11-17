/** @module app/site-packs/pack-prober.test — the pack prober over a scripted maintenance page (spec 13 §8.1): the cookie pre-check never opens a page; the navigation goes to the probe URL behind a domain guard that aborts main-frame documents leaving the pack's domains (fail-closed: no guard, no navigation); timeouts, network failures, challenges and landmarks classify; the page is always closed; an abort closes it; a site without a pack in force falls back to the generic probe; the selector picks the pack prober only for sites with a pack in force. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import { FakePackPage, fakeFrame } from '../../../test/helpers/fake-pack-page.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { createCollectingLogger } from '../../infra/logging/collecting-logger.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';
import { GENERIC_PROBER, type SiteProbeContext } from '../templates/site-prober.ts';
import { PackProber, packProberSelector } from './pack-prober.ts';

const SITE = 'site-a.test';
const pack = SitePackV1.parse({
  schema: 1,
  id: SITE,
  version: 1,
  min_client: '0.3.0',
  title: 'Site A',
  domains: [SITE],
  sign_in: { url: { host: SITE, path: '/login' }, human_only: false },
  signed_in: {
    probe: { host: `www.${SITE}`, path: '/feed' },
    kind: 'landmark',
    landmark: '#feed',
    cookie_names: ['sid'],
  },
  write_policy: { default: 'confirm', stance: 'prohibited' },
});
const effective: EffectivePack = {
  packId: SITE,
  pack,
  version: 1,
  sha256: 'd'.repeat(64),
  source: 'local',
  localOverride: false,
};
let inForce: boolean;
const lookup: SitePackLookup = {
  effectiveFor: (host) => (inForce && host.endsWith(SITE) ? effective : null),
  effectiveById: (id) => (inForce && id === SITE ? effective : null),
  generation: 1,
};

let page: FakePackPage;
let opened: number;
let closed: number;
let prober: PackProber;
const NOW = 1_700_000_000_000;
const site = templateSiteRecord({ siteId: SITE, packId: SITE });

beforeEach(() => {
  inForce = true;
  page = new FakePackPage();
  opened = 0;
  closed = 0;
  prober = new PackProber({
    lookup: () => lookup,
    openPage: async () => {
      opened += 1;
      return {
        page: page.asPage(),
        close: async () => {
          closed += 1;
        },
      };
    },
    logger: createCollectingLogger(),
  });
});

function ctx(
  cookies = [{ name: 'sid', domain: `.${SITE}`, expires: -1 }],
  signal = new AbortController().signal,
): SiteProbeContext {
  return {
    template: templateRecord(),
    site,
    host: null,
    jar: async () => cookies.map((c) => ({ ...c, httpOnly: true, secure: true })),
    now: NOW,
    signal,
  };
}

describe('PackProber', () => {
  it('the cookie pre-check answers cookies_absent without a page', async () => {
    expect(await prober.probe(ctx([]))).toEqual({
      outcome: 'signed_out',
      reason: 'cookies_absent',
      finalUrl: null,
    });
    expect(opened).toBe(0);
  });

  it('navigates to the probe URL behind the domain guard and classifies; the page is closed', async () => {
    page.count = (expr) => (expr === 'css=#feed' ? 1 : 0);
    expect(await prober.probe(ctx())).toEqual({
      outcome: 'signed_in',
      reason: 'landmark',
      finalUrl: `https://www.${SITE}/feed`,
    });
    expect(page.gotos).toEqual([`https://www.${SITE}/feed`]);
    expect([opened, closed]).toEqual([1, 1]);
    // The guard: a main-frame document leaving the domains is aborted, everything else goes on.
    const handler = page.routes[0]?.handler;
    if (handler === undefined) throw new Error('no guard');
    const calls: string[] = [];
    const route = (url: string, type: string, frame: unknown) => ({
      request: () => ({ url: () => url, resourceType: () => type, frame: () => frame }),
      abort: async (code: string) => void calls.push(`abort ${url} ${code}`),
      fallback: async () => void calls.push(`fallback ${url}`),
    });
    await handler(route('https://evil.test/', 'document', page.main));
    await handler(route('https://cdn.site-a.test/x', 'document', page.main));
    await handler(route('https://evil.test/frame', 'document', fakeFrame('x', null)));
    await handler(route('https://evil.test/a.js', 'script', page.main));
    expect(calls).toEqual([
      'abort https://evil.test/ blockedbyclient',
      'fallback https://cdn.site-a.test/x',
      'fallback https://evil.test/frame',
      'fallback https://evil.test/a.js',
    ]);
  });

  it('timeouts, network failures and challenges; never signed_out on a challenge', async () => {
    page.onGoto = async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    };
    expect(await prober.probe(ctx())).toMatchObject({ outcome: 'inconclusive', reason: 'timeout' });
    page.onGoto = async () => {
      throw new Error('net::ERR_BLOCKED_BY_CLIENT');
    };
    expect(await prober.probe(ctx())).toMatchObject({ outcome: 'inconclusive', reason: 'network' });
    page.onGoto = async (url) => {
      page.currentUrl = `https://${SITE}/login?next=x`;
      page.pageTitle = 'Just a moment...';
      page.children = [
        fakeFrame('https://challenges.cloudflare.com/t', { x: 0, y: 0, width: 300, height: 65 }),
      ];
      return url === '' ? null : { status: 403 };
    };
    expect(await prober.probe(ctx())).toEqual({
      outcome: 'challenged',
      reason: 'challenge:captcha',
      finalUrl: `https://${SITE}/login`,
    });
    expect(closed).toBe(3);
  });

  it('fails closed without the guard, closes the page on abort', async () => {
    page.route = async () => {
      throw new Error('route refused');
    };
    expect(await prober.probe(ctx())).toMatchObject({ outcome: 'inconclusive', reason: 'network' });
    expect(page.gotos).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    expect(await prober.probe(ctx(undefined, controller.signal))).toMatchObject({
      reason: 'timeout',
    });
  });

  it('falls back to the generic probe, and the selector picks by pack in force', async () => {
    const fallback = () => GENERIC_PROBER;
    const select = packProberSelector(prober, () => lookup, fallback);
    expect(select(site)).toBe(prober);
    expect(select(templateSiteRecord({ siteId: SITE, packId: null }))).toBe(GENERIC_PROBER);
    inForce = false;
    expect(select(site)).toBe(GENERIC_PROBER);
    expect(await prober.probe(ctx())).toMatchObject({ outcome: 'inconclusive', reason: 'no_pack' });
    expect(opened).toBe(0);
  });
});
