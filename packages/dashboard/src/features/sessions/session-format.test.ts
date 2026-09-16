/** @module features/sessions/session-format.test — closed-reason copy, the coarse running time of the header meta line, which states count as ended, and the id suffix of the sessions list */
import { describe, expect, it } from 'bun:test';
import { idSuffix } from './list/sessions-columns.tsx';
import {
  closedReasonNote,
  closedReasonText,
  coarseDuration,
  sessionEnded,
} from './session-format.ts';

describe('session format', () => {
  it('says who or what closed a session', () => {
    expect(closedReasonText('user')).toBe('Closed by the agent');
    expect(closedReasonText('operator')).toBe('Closed from the dashboard');
    expect(closedReasonText(null)).toBe('Closed');
    expect(closedReasonNote('lease_expired')).toBe('lease ran out');
    expect(closedReasonNote(null)).toBeNull();
  });

  it('keeps the running time coarse so the meta line does not reflow every second', () => {
    expect(coarseDuration(42_400)).toBe('42s');
    expect(coarseDuration(20 * 60_000 + 59_000)).toBe('20m');
    expect(coarseDuration(60 * 60_000)).toBe('1h');
    expect(coarseDuration(75 * 60_000 + 5_000)).toBe('1h 15m');
    expect(coarseDuration(-5)).toBe('0s');
  });

  it('treats a draining session as ended', () => {
    expect(sessionEnded({ live: true, state: 'live' })).toBe(false);
    expect(sessionEnded({ live: true, state: 'draining' })).toBe(true);
    expect(sessionEnded({ live: false, state: 'closed' })).toBe(true);
  });

  it('shows the unique part of a session id', () => {
    expect(idSuffix({ slug: 'shop', session_id: 'shop-9f2k1x' as never })).toBe('9f2k1x');
    expect(idSuffix({ slug: 'other', session_id: 'shop-00000001' as never })).not.toBe('');
  });
});
