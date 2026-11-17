/** @module features/templates/wizard/site-needs.test — reading a pack's needs (spec 13 §9.4 `stealth-profile`, §11.1): the stealth floor with the server's defaults, fingerprint required or forbidden, a headed browser, stealth for a hand-only sign-in; the chips; unmet needs and the step 3 problems (one per field); the field of each server issue code; forced humanized input as an advisory (own chip and fix without a floor, never a step 3 problem) */
import { describe, expect, it } from 'bun:test';
import { packContent } from '../../../../test/fixtures/site-packs.ts';
import {
  FIELD_OF_ISSUE_CODE,
  humanizeAdvisory,
  humanizeUnmet,
  needChips,
  needProblems,
  siteNeedsOf,
  unmetNeeds,
} from './site-needs.ts';

const profile = (params: Record<string, string | boolean>) =>
  packContent({ strategies: [{ id: 'stealth-profile', params }] });

describe('siteNeedsOf', () => {
  it('reads the stealth-profile floor as the server does', () => {
    expect(siteNeedsOf('linkedin.com', 'LinkedIn', profile({ min_level: 'max' }))).toEqual({
      site: 'linkedin.com',
      title: 'LinkedIn',
      minStealth: 'max',
      fingerprint: null,
      headed: false,
      humanize: false,
    });
    // Defaults: a `standard` floor; an unknown value reads as the default.
    expect(siteNeedsOf('a', 'A', profile({}))?.minStealth).toBe('standard');
    expect(siteNeedsOf('a', 'A', profile({ min_level: 'ultra' }))?.minStealth).toBe('standard');
    expect(siteNeedsOf('a', 'A', profile({ fingerprint: 'forbidden' }))?.fingerprint).toBe(
      'forbidden',
    );
    expect(siteNeedsOf('a', 'A', profile({ fingerprint: 'any' }))?.fingerprint).toBeNull();
  });

  it('reads a headed browser and a hand-only sign-in; nothing needed is null', () => {
    const headed = packContent({ browser: { channel: 'any', headed: 'required' } });
    expect(siteNeedsOf('a', 'A', headed)).toMatchObject({ headed: true, minStealth: null });
    const handOnly = packContent({
      sign_in: { url: { host: 'www.linkedin.com', path: '/login' }, human_only: true },
    });
    expect(siteNeedsOf('a', 'A', handOnly)?.minStealth).toBe('standard');
    expect(siteNeedsOf('a', 'A', packContent())).toBeNull();
  });
});

describe('forced humanized input (D50, advisory)', () => {
  const humanizeInput = packContent({ strategies: [{ id: 'humanize-input', params: {} }] });

  it('reads humanize-input and stealth-profile.humanize', () => {
    expect(siteNeedsOf('a', 'A', humanizeInput)).toEqual({
      site: 'a',
      title: 'A',
      minStealth: null,
      fingerprint: null,
      headed: false,
      humanize: true,
    });
    expect(siteNeedsOf('a', 'A', profile({ humanize: true }))).toMatchObject({
      humanize: true,
      minStealth: 'standard',
    });
    expect(siteNeedsOf('a', 'A', profile({}))?.humanize).toBe(false);
  });

  it('is its own chip and fix only without a stealth floor, unmet only with stealth off', () => {
    const alone = siteNeedsOf('a', 'A', humanizeInput);
    if (alone === null) throw new Error('needs expected');
    expect(needChips(alone)).toEqual(['Humanized input needs stealth on']);
    expect(humanizeAdvisory(alone)).toBe(true);
    const off = { stealth: 'off', fingerprint: false, headless: true } as const;
    expect(humanizeUnmet(alone, off)).toMatchObject({ field: 'stealth', to: 'standard' });
    expect(humanizeUnmet(alone, { ...off, stealth: 'standard' })).toBeNull();
    // Advisory: never a step 3 problem (stealth off is not refused for it).
    expect(unmetNeeds(alone, off)).toEqual([]);
    expect(needProblems([alone], off)).toEqual([]);
    // With a floor, "Needs stealth on" already says it (and blocks below it).
    const floored = siteNeedsOf('a', 'A', profile({ humanize: true }));
    if (floored === null) throw new Error('needs expected');
    expect(needChips(floored)).toEqual(['Needs stealth on']);
    expect(humanizeUnmet(floored, off)).toBeNull();
  });
});

describe('chips and unmet needs', () => {
  const all = {
    site: 's.test',
    title: 'S',
    minStealth: 'max' as const,
    fingerprint: 'forbidden' as const,
    headed: true,
    humanize: false,
  };

  it('labels every need', () => {
    expect(needChips(all)).toEqual([
      'Needs stealth Max',
      'Fingerprint noise must be off',
      'Needs a visible browser',
    ]);
    expect(
      needChips({ ...all, minStealth: 'standard', fingerprint: 'required', headed: false }),
    ).toEqual(['Needs stealth on', 'Needs fingerprint on']);
  });

  it('says what the settings miss and what meets it', () => {
    expect(
      unmetNeeds(all, { stealth: 'standard', fingerprint: true, headless: true }).map((u) => [
        u.field,
        u.to,
      ]),
    ).toEqual([
      ['stealth', 'max'],
      ['fingerprint', false],
      ['headless', false],
    ]);
    expect(unmetNeeds(all, { stealth: 'max', fingerprint: false, headless: false })).toEqual([]);
  });

  it('gives one step 3 problem per field', () => {
    const other = { ...all, title: 'T', fingerprint: null, headed: false };
    expect(
      needProblems([all, other], { stealth: 'off', fingerprint: false, headless: false }),
    ).toEqual([{ field: 'stealth', message: 'S needs Hide automation set to Max.' }]);
  });

  it('maps server issue codes to the setting', () => {
    expect(FIELD_OF_ISSUE_CODE['stealth_below_floor']).toBe('stealth');
    expect(FIELD_OF_ISSUE_CODE['fingerprint_forbidden']).toBe('fingerprint');
    expect(FIELD_OF_ISSUE_CODE['headed_required']).toBe('headless');
    expect(FIELD_OF_ISSUE_CODE['not_registrable']).toBeUndefined();
  });
});
