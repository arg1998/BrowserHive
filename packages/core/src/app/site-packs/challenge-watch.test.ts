/** @module app/site-packs/challenge-watch.test — detection on a scripted host page (spec 13 §9.5): a redirect into a challenge URL is detected at the commit, the agent's own `navigate`/`new_tab` URL is exempt for that document only, title/landmark/text after `domcontentloaded`, provider frames counted only as surfaces (challenge paths at once; visible ≥ 100×60 frames after `load` and the 2 s second look; badges and invisible frames never), each rule once per document. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakePackPage, fakeFrame, settle } from '../../../test/helpers/fake-pack-page.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';
import { AgentNavigations } from './agent-navigations.ts';
import type { DetectedChallenge } from './challenge-outcomes.ts';
import { ChallengeWatch, SURFACE_RECHECK_MS } from './challenge-watch.ts';

const SITE = 'site-a.test';
const pack = SitePackV1.parse({
  schema: 1,
  id: SITE,
  version: 1,
  min_client: '0.3.0',
  title: 'Site A',
  domains: [SITE],
  sign_in: { url: { host: SITE, path: '/login' }, human_only: false },
  signed_in: { probe: { host: SITE, path: '/feed' }, kind: 'landmark', landmark: '#feed' },
  write_policy: { default: 'confirm', stance: 'prohibited' },
  challenges: [
    {
      id: 'checkpoint',
      kind: 'checkpoint',
      match: { url: `${SITE}/checkpoint*` },
      action: 'attention',
    },
    {
      id: 'locked',
      kind: 'locked',
      match: { title_contains: 'Suspended', text: 'appeal' },
      action: 'stop',
    },
    { id: 'reauth', kind: 'reauth', match: { landmark: 'form#reauth' }, action: 'attention' },
  ],
});
const effective: EffectivePack = {
  packId: SITE,
  pack,
  version: 1,
  sha256: 'c'.repeat(64),
  source: 'local',
  localOverride: false,
};
const lookup: SitePackLookup = {
  effectiveFor: (host) => (host.endsWith(SITE) ? effective : null),
  effectiveById: () => effective,
  generation: 1,
};

let clock: FakeClock;
let page: FakePackPage;
let navigations: AgentNavigations;
let seen: DetectedChallenge[];

beforeEach(() => {
  clock = new FakeClock();
  page = new FakePackPage();
  navigations = new AgentNavigations(clock);
  seen = [];
  const watch = new ChallengeWatch({
    lookup: () => lookup,
    navigations,
    outcomes: { handle: async (d) => void seen.push(d) },
    clock,
    logger: createCollectingLogger(),
  });
  watch.watch('tp-1', page.asPage(), 's-1');
});

const ids = () => seen.map((d) => `${d.rule.packId}#${d.rule.id}`);

describe('ChallengeWatch', () => {
  it('a redirect into a challenge URL is detected once per document', async () => {
    page.commit(`https://${SITE}/checkpoint/lg?x=1`);
    page.emit('domcontentloaded');
    await settle();
    expect(ids()).toEqual([`${SITE}#checkpoint`]);
    expect(seen[0]).toMatchObject({ templateId: 'tp-1', sessionId: 's-1' });
    page.commit(`https://${SITE}/checkpoint/again`);
    await settle();
    expect(ids()).toHaveLength(2);
  });

  it("the agent's own navigate and new_tab URLs are exempt for that document only", async () => {
    const url = `https://${SITE}/checkpoint/lg`;
    navigations.expectOnPage(page, url);
    page.commit(url);
    await settle();
    expect(seen).toEqual([]);
    // The next document at the same URL (a reload by the site) is not the agent's.
    page.commit(url);
    await settle();
    expect(ids()).toEqual([`${SITE}#checkpoint`]);
    seen.length = 0;
    navigations.expectNewTab('s-1', `${url}#frag`);
    page.commit(url);
    await settle();
    expect(seen).toEqual([]);
  });

  it('title and text (ANDed), and a landmark after domcontentloaded', async () => {
    page.count = (expr) => (expr === 'text=appeal' ? 1 : 0);
    page.commit(`https://${SITE}/home`, 'Account Suspended');
    await settle();
    expect(ids()).toEqual([`${SITE}#locked`]);
    seen.length = 0;
    page.count = (expr) => (expr === 'css=form#reauth' ? 1 : 0);
    page.commit(`https://${SITE}/home`, 'Home');
    await settle();
    expect(ids()).toEqual([`${SITE}#reauth`]);
  });

  it('provider frames: a challenge path at once, a visible frame after load and 2 s, badges and invisible frames never', async () => {
    page.commit('https://other.test/', 'Just a moment...');
    await settle();
    expect(seen).toEqual([]);
    page.emit(
      'framenavigated',
      fakeFrame('https://www.google.com/recaptcha/api2/anchor?size=invisible', {
        x: 1100,
        y: 700,
        width: 256,
        height: 60,
      }),
    );
    page.emit(
      'framenavigated',
      fakeFrame(
        'https://challenges.cloudflare.com/x',
        { x: 0, y: 0, width: 300, height: 65 },
        false,
      ),
    );
    page.emit(
      'framenavigated',
      fakeFrame('https://challenges.cloudflare.com/y', { x: 0, y: 0, width: 80, height: 65 }),
    );
    await settle();
    await clock.advance(SURFACE_RECHECK_MS);
    await settle();
    expect(seen).toEqual([]);
    page.emit(
      'framenavigated',
      fakeFrame('https://challenges.cloudflare.com/z', { x: 10, y: 10, width: 300, height: 65 }),
    );
    await settle();
    expect(ids()).toEqual(['browserhive#cloudflare-interstitial']);
    seen.length = 0;
    page.commit('https://other.test/', 'Sign in');
    page.emit(
      'framenavigated',
      fakeFrame('https://www.google.com/recaptcha/api2/bframe?k=1', null, false),
    );
    await settle();
    expect(ids()).toEqual(['browserhive#provider-surface']);
    expect(seen[0]?.rule.action).toBe('notify');
  });
});
