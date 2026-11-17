/** @module domain/site-packs/strategy-notes.test — the sites' strategy notes (spec 13 §9.4; D49, D50): forced humanized input on a template with stealth off, `single-focus` on a headless template on macOS or Windows, and nothing otherwise. */

import { describe, expect, test } from 'bun:test';
import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import {
  headlessFocusReleases,
  packForcesHumanize,
  type StrategyNoteSettings,
  strategyNotesOf,
} from './strategy-notes.ts';
import { basePack } from './test-fixtures.ts';

function pack(strategies: SitePackV1Input['strategies']): SitePackV1 {
  return SitePackV1.parse({ ...basePack(), strategies });
}

const HUMANIZE = pack([{ id: 'humanize-input', params: {} }]);
const PROFILE_HUMANIZE = pack([
  { id: 'stealth-profile', params: { min_level: 'standard', humanize: true } },
]);
const PROFILE_PLAIN = pack([{ id: 'stealth-profile', params: { min_level: 'standard' } }]);
const FOCUS = pack([{ id: 'single-focus', params: {} }]);
const BOTH = pack([
  { id: 'humanize-input', params: {} },
  { id: 'single-focus', params: {} },
]);

const OFF_HEADLESS: StrategyNoteSettings = { stealth: 'off', headless: true };
const codes = (p: SitePackV1, s: StrategyNoteSettings, platform = 'linux') =>
  strategyNotesOf(p, s, platform).map((n) => n.code);

describe('humanize_needs_stealth (D50)', () => {
  test('stealth off with humanize-input: the note names the pack and says what to do', () => {
    const [note, ...rest] = strategyNotesOf(HUMANIZE, OFF_HEADLESS, 'linux');
    expect(rest).toEqual([]);
    expect(note?.code).toBe('humanize_needs_stealth');
    expect(note?.message).toContain(HUMANIZE.title);
    expect(note?.message).toContain('stealth off');
    expect(note?.message).toContain('create a template with stealth on');
    expect(note?.message).toContain('native');
  });

  test('stealth off with stealth-profile.humanize (a pack update can reach it)', () => {
    expect(codes(PROFILE_HUMANIZE, OFF_HEADLESS)).toEqual(['humanize_needs_stealth']);
  });

  test('stealth standard or max: humanized input applies, no note', () => {
    for (const stealth of ['standard', 'max'] as const) {
      expect(codes(HUMANIZE, { stealth, headless: false })).toEqual([]);
      expect(codes(PROFILE_HUMANIZE, { stealth, headless: true })).toEqual([]);
    }
  });

  test('a pack that does not force humanized input: no note', () => {
    expect(codes(PROFILE_PLAIN, OFF_HEADLESS)).toEqual([]);
    expect(codes(pack([]), OFF_HEADLESS)).toEqual([]);
    expect(packForcesHumanize(PROFILE_PLAIN)).toBe(false);
    expect(packForcesHumanize(HUMANIZE)).toBe(true);
    expect(packForcesHumanize(PROFILE_HUMANIZE)).toBe(true);
  });
});

describe('single_focus_limited (D49)', () => {
  const headless: StrategyNoteSettings = { stealth: 'standard', headless: true };
  const headed: StrategyNoteSettings = { stealth: 'standard', headless: false };

  test('headless on macOS and Windows: noted', () => {
    for (const platform of ['darwin', 'win32']) {
      const notes = strategyNotesOf(FOCUS, headless, platform);
      expect(notes.map((n) => n.code)).toEqual(['single_focus_limited']);
      expect(notes[0]?.message).toContain('macOS or Windows');
      expect(notes[0]?.message).toContain(FOCUS.title);
    }
  });

  test('headless on Linux (the window is minimized): no note', () => {
    expect(codes(FOCUS, headless, 'linux')).toEqual([]);
  });

  test('headed on any platform (the desktop decides real focus): no note', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(codes(FOCUS, headed, platform)).toEqual([]);
    }
  });

  test('a pack without single-focus: no note', () => {
    expect(codes(HUMANIZE, headless, 'darwin')).toEqual([]);
  });

  test('both notes, humanize first', () => {
    expect(codes(BOTH, OFF_HEADLESS, 'win32')).toEqual([
      'humanize_needs_stealth',
      'single_focus_limited',
    ]);
  });

  test('headlessFocusReleases is the runtime’s Linux-only minimize', () => {
    expect(headlessFocusReleases('linux')).toBe(true);
    expect(headlessFocusReleases('darwin')).toBe(false);
    expect(headlessFocusReleases('win32')).toBe(false);
  });
});
