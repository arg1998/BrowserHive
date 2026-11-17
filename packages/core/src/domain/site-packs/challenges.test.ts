/** @module domain/site-packs/challenges.test — challenge matching (spec 13 §9.5): providers by frame URL, challenge paths, badge frames, the visibility rule, `DEFAULT_CHALLENGES`, ANDed members, pack rules before the defaults, and the agent's own URL exempting `url` members only. */

import { describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import {
  type ChallengePageFacts,
  type ChallengeProvider,
  challengeReason,
  challengeRulesFor,
  DEFAULT_CHALLENGES,
  firstChallenge,
  isBadgeFrame,
  isChallengePath,
  isVisibleSurface,
  providerOfFrameUrl,
} from './challenges.ts';
import { basePack } from './test-fixtures.ts';

const pack = SitePackV1.parse({
  ...basePack(),
  challenges: [
    {
      id: 'checkpoint',
      kind: 'checkpoint',
      match: { url: 'www.linkedin.com/checkpoint/*' },
      action: 'attention',
    },
    {
      id: 'locked',
      kind: 'locked',
      match: { title_contains: 'restricted', text: 'appeal' },
      action: 'stop',
    },
    { id: 'reauth', kind: 'reauth', match: { landmark: '#reauth' }, action: 'attention' },
  ],
});

function facts(
  over: Partial<ChallengePageFacts> & {
    landmarks?: string[];
    texts?: string[];
    pageTitle?: string;
  } = {},
): ChallengePageFacts {
  return {
    url: over.url ?? 'https://www.linkedin.com/feed/',
    urlExempt: over.urlExempt ?? false,
    surfaces: over.surfaces ?? new Set<ChallengeProvider>(),
    title: async () => over.pageTitle ?? 'Feed',
    hasLandmark: async (s) => (over.landmarks ?? []).includes(s),
    hasText: async (t) => (over.texts ?? []).includes(t),
  };
}

describe('providers', () => {
  it.each([
    ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile', 'cloudflare'],
    ['https://www.google.com/recaptcha/api2/anchor?k=x', 'recaptcha'],
    ['https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x', 'recaptcha'],
    [
      'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox',
      'hcaptcha',
    ],
    ['https://client-api.arkoselabs.com/v2/key/enforcement.html', 'arkose'],
    ['https://geo.captcha-delivery.com/captcha/?initialCid=x', 'datadome'],
    ['https://www.google.com/search?q=recaptcha', null],
    ['http://challenges.cloudflare.com/x', null],
    ['https://hcaptcha.com.evil.test/x', null],
    ['about:blank', null],
  ])('%s → %s', (url, provider) => {
    expect(providerOfFrameUrl(url)).toBe(provider as ChallengeProvider | null);
  });

  it('challenge paths', () => {
    expect(isChallengePath('recaptcha', 'https://www.google.com/recaptcha/api2/bframe?k=1')).toBe(
      true,
    );
    expect(isChallengePath('recaptcha', 'https://www.google.com/recaptcha/enterprise/bframe')).toBe(
      true,
    );
    expect(isChallengePath('recaptcha', 'https://www.google.com/recaptcha/api2/anchor')).toBe(
      false,
    );
    expect(isChallengePath('hcaptcha', 'https://a.hcaptcha.com/x#frame=challenge&id=1')).toBe(true);
    expect(isChallengePath('hcaptcha', 'https://a.hcaptcha.com/x#frame=checkbox')).toBe(false);
    expect(isChallengePath('arkose', 'https://x.arkoselabs.com/v2/k/enforcement.1.html')).toBe(
      true,
    );
    expect(isChallengePath('datadome', 'https://geo.captcha-delivery.com/captcha/?x')).toBe(true);
    expect(isChallengePath('datadome', 'https://js.captcha-delivery.com/captcha/')).toBe(false);
    expect(isChallengePath('cloudflare', 'https://challenges.cloudflare.com/x')).toBe(false);
  });

  it('the reCAPTCHA v3 and Enterprise anchors with size=invisible are badges', () => {
    expect(
      isBadgeFrame('recaptcha', 'https://www.google.com/recaptcha/api2/anchor?size=invisible'),
    ).toBe(true);
    expect(
      isBadgeFrame('recaptcha', 'https://www.google.com/recaptcha/api2/anchor?size=normal'),
    ).toBe(false);
    expect(isBadgeFrame('cloudflare', 'https://challenges.cloudflare.com/x?size=invisible')).toBe(
      false,
    );
  });
});

describe('the visibility rule', () => {
  const vp = { width: 1280, height: 800 };
  it.each([
    [{ x: 10, y: 10, width: 300, height: 65 }, true, vp, true],
    [{ x: 10, y: 10, width: 99, height: 65 }, true, vp, false],
    [{ x: 10, y: 10, width: 300, height: 59 }, true, vp, false],
    [{ x: 10, y: 10, width: 300, height: 65 }, false, vp, false],
    [null, true, vp, false],
    [{ x: 1300, y: 10, width: 300, height: 65 }, true, vp, false],
    [{ x: -400, y: 10, width: 300, height: 65 }, true, vp, false],
    [{ x: 10, y: 900, width: 300, height: 65 }, true, vp, false],
    [{ x: 1200, y: 700, width: 300, height: 65 }, true, vp, true],
    [{ x: 1200, y: 700, width: 300, height: 65 }, true, null, true],
  ])('%j visible=%s viewport=%j → %s', (box, visible, viewport, expected) => {
    expect(isVisibleSurface(box, visible, viewport)).toBe(expected);
  });
});

describe('firstChallenge', () => {
  it('the Cloudflare interstitial needs its title and a cloudflare surface', async () => {
    const cf = new Set<ChallengeProvider>(['cloudflare']);
    expect(
      await firstChallenge(
        DEFAULT_CHALLENGES,
        facts({ pageTitle: 'Just a moment...', surfaces: cf }),
      ),
    ).toMatchObject({ id: 'cloudflare-interstitial', action: 'attention', kind: 'captcha' });
    expect(
      await firstChallenge(
        DEFAULT_CHALLENGES,
        facts({ pageTitle: 'Verify you are human', surfaces: cf }),
      ),
    ).toMatchObject({ id: 'cloudflare-interstitial' });
    // Without the title, a surface only notifies; without a surface, the title alone is nothing.
    expect(await firstChallenge(DEFAULT_CHALLENGES, facts({ surfaces: cf }))).toMatchObject({
      id: 'provider-surface',
      action: 'notify',
    });
    expect(
      await firstChallenge(DEFAULT_CHALLENGES, facts({ pageTitle: 'Just a moment...' })),
    ).toBeNull();
  });

  it('pack rules come first and their members are ANDed', async () => {
    const rules = challengeRulesFor(pack);
    expect(rules.map((r) => `${r.packId}#${r.id}`)).toEqual([
      'linkedin.com#checkpoint',
      'linkedin.com#locked',
      'linkedin.com#reauth',
      'browserhive#cloudflare-interstitial',
      'browserhive#provider-surface',
    ]);
    expect(
      await firstChallenge(rules, facts({ url: 'https://www.linkedin.com/checkpoint/lg' })),
    ).toMatchObject({ id: 'checkpoint' });
    expect(await firstChallenge(rules, facts({ pageTitle: 'Account restricted' }))).toBeNull();
    expect(
      await firstChallenge(rules, facts({ pageTitle: 'Account RESTRICTED', texts: ['appeal'] })),
    ).toMatchObject({ id: 'locked', action: 'stop' });
    expect(await firstChallenge(rules, facts({ landmarks: ['#reauth'] }))).toMatchObject({
      id: 'reauth',
    });
    expect(await firstChallenge(rules, facts({ surfaces: new Set(['arkose']) }))).toMatchObject({
      id: 'provider-surface',
    });
    expect(challengeRulesFor(null)).toBe(DEFAULT_CHALLENGES);
  });

  it("the agent's own URL never matches a url member, other members still do", async () => {
    const rules = challengeRulesFor(pack);
    const url = 'https://www.linkedin.com/checkpoint/lg';
    expect(await firstChallenge(rules, facts({ url, urlExempt: true }))).toBeNull();
    expect(
      await firstChallenge(rules, facts({ url, urlExempt: true, landmarks: ['#reauth'] })),
    ).toMatchObject({ id: 'reauth' });
  });

  it('a read that throws is no match (fail-open)', async () => {
    const broken: ChallengePageFacts = {
      ...facts(),
      hasLandmark: async () => {
        throw new Error('detached');
      },
    };
    expect(await firstChallenge(challengeRulesFor(pack), broken)).toBeNull();
    expect(challengeReason('captcha')).toBe('challenge:captcha');
  });
});
