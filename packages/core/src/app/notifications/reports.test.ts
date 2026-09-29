/** @module app/notifications/reports.test — the pure report producers (D-43, D-44, spec 03 §9.7) table-driven over fixture facts: what each content level carries, the empty-digest rule, late and skipped notes, silent sends in quiet hours, the anomaly checks with their hysteresis, and the anomaly alert. */

import { describe, expect, it } from 'bun:test';
import type { NotificationContentLevel } from '@browserhive/contracts/enums';
import {
  type AnomalyRule,
  type DigestRule,
  NotificationMessage,
} from '@browserhive/contracts/notifications';
import {
  type AnomalyFacts,
  type AnomalyState,
  anomalyThresholds,
  buildAnomaly,
  buildDigest,
  type DigestFacts,
  evaluateAnomalies,
  isEmptyDigest,
  type ReportContext,
  reportMessage,
} from './reports.ts';
import { sampleAnomalyFacts, sampleDigestFacts } from './samples.ts';

const HOUR = 3_600_000;
const UNTIL = Date.UTC(2026, 8, 29, 7); // 09:00 in Berlin
const DAILY: DigestRule = { every: 'day', at: '09:00' };

function ctx(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    zone: 'Europe/Berlin',
    level: 'titles',
    scheduledAt: UNTIL,
    late: false,
    skipped: 0,
    manual: false,
    quiet: false,
    ...overrides,
  };
}

function emptyFacts(): DigestFacts {
  return {
    window: { since: UNTIL - 24 * HOUR, until: UNTIL },
    sessionsStarted: 0,
    sessionsLive: 0,
    toolCalls: 0,
    errors: 0,
    previous: { toolCalls: 0, errors: 0 },
    attention: {
      created: 0,
      resolved: 0,
      rejected: 0,
      timedOut: 0,
      cancelled: 0,
      pending: 0,
      medianWaitMs: null,
    },
    vault: [],
    blocked: { count: 0, topPattern: null, topDomain: null },
    slowest: null,
    topErrors: [],
    degradations: [],
    harnesses: [{ harness: 'unknown', sessions: 0, toolCalls: 0, errors: 0 }],
    chart: { start: UNTIL - 24 * HOUR, stepMs: HOUR, values: Array(24).fill(0) },
  };
}

/** Every string a rendered report carries. */
function text(content: ReturnType<typeof buildDigest>): string {
  return JSON.stringify({ t: content.title, s: content.summary, b: content.blocks });
}

describe('isEmptyDigest', () => {
  const cases: readonly [string, (f: DigestFacts) => DigestFacts, boolean][] = [
    ['nothing happened', (f) => f, true],
    ['a live session alone is still empty', (f) => ({ ...f, sessionsLive: 3 }), true],
    ['a session started', (f) => ({ ...f, sessionsStarted: 1 }), false],
    ['a tool call', (f) => ({ ...f, toolCalls: 1 }), false],
    ['an attention request', (f) => ({ ...f, attention: { ...f.attention, created: 1 } }), false],
    ['a vault access', (f) => ({ ...f, vault: [{ result: 'success', count: 1 }] }), false],
    ['a blocked request', (f) => ({ ...f, blocked: { ...f.blocked, count: 1 } }), false],
    [
      'an open degradation',
      (f) => ({
        ...f,
        degradations: [{ code: 'X', severity: 'warn', message: 'm', since: 0 }],
      }),
      false,
    ],
  ];
  for (const [name, change, empty] of cases) {
    it(name, () => expect(isEmptyDigest(change(emptyFacts()))).toBe(empty));
  }
});

describe('buildDigest', () => {
  const facts = sampleDigestFacts(UNTIL, DAILY);
  const names = [
    'navigate',
    'NAVIGATION_TIMEOUT',
    '*.doubleclick.net',
    'Claude Code',
    'RETENTION_FAILED',
    'origin mismatch',
  ];
  const levels: readonly [NotificationContentLevel, readonly string[], readonly string[]][] = [
    ['counts', [], [...names, 'ads.example.net', 'database is locked']],
    ['titles', names, ['ads.example.net', 'database is locked']],
    ['full', [...names, 'ads.example.net', 'database is locked'], []],
  ];
  for (const [level, present, absent] of levels) {
    it(`carries at ${level} only what that level allows`, () => {
      const out = text(buildDigest(facts, DAILY, ctx({ level })));
      for (const name of present) expect(out).toContain(name);
      for (const name of absent) expect(out).not.toContain(name);
      // The numbers are there at every level.
      expect(out).toContain('3,412');
      expect(out).toContain('68 errors (2%)');
    });
  }

  it('titles the day in the channel zone and links the window on the Overview', () => {
    const d = buildDigest(facts, DAILY, ctx());
    expect(d.kind).toBe('digest.daily');
    expect(d.title).toBe('Daily digest · Tue 29 Sep');
    expect(d.summary).toBe('12 sessions (2 live) · 3,412 tool calls · 68 errors (2%)');
    expect(d.actions[0]).toMatchObject({
      kind: 'open',
      path: `/overview?since=${UNTIL - 24 * HOUR}&until=${UNTIL}`,
    });
    expect(d.report).toEqual({
      window: { since: UNTIL - 24 * HOUR, until: UNTIL },
      time_zone: 'Europe/Berlin',
      late: false,
      skipped: 0,
      manual: false,
    });
    expect(d.blocks.some((b) => b.type === 'chart')).toBe(true);
    expect(d.blocks.at(-1)).toEqual({
      type: 'footer',
      content: [{ type: 'text', text: '28 Sep 09:00 → 29 Sep 09:00 · Europe/Berlin' }],
    });
  });

  it('writes a weekly digest over its span', () => {
    const weekly: DigestRule = { every: 'week', at: '09:00', day: 'tue' };
    const d = buildDigest(sampleDigestFacts(UNTIL, weekly), weekly, ctx());
    expect(d.kind).toBe('digest.weekly');
    expect(d.title).toBe('Weekly digest · 22–29 Sep');
  });

  it('says when it is late, how many windows were skipped, or that it was sent on demand', () => {
    const late = text(buildDigest(facts, DAILY, ctx({ late: true, skipped: 2 })));
    expect(late).toContain('Sent late: BrowserHive was not running at 09:00 (Tue 29 Sep).');
    expect(late).toContain('2 earlier digests were skipped while BrowserHive was off.');
    expect(text(buildDigest(facts, DAILY, ctx({ skipped: 1 })))).toContain(
      '1 earlier digest was skipped',
    );
    expect(text(buildDigest(facts, DAILY, ctx({ manual: true })))).toContain('Sent on demand');
  });

  it('is silent inside quiet hours', () => {
    expect(buildDigest(facts, DAILY, ctx()).alert).toBe(true);
    expect(buildDigest(facts, DAILY, ctx({ quiet: true })).alert).toBe(false);
  });

  it('says plainly that nothing happened', () => {
    const d = buildDigest(emptyFacts(), DAILY, ctx());
    expect(d.summary).toBe('Nothing happened: no sessions, tool calls or requests today.');
    expect(d.blocks.some((b) => b.type === 'chart')).toBe(false);
  });

  it('builds a valid contract message at the level it was produced for', () => {
    const message = reportMessage(buildDigest(facts, DAILY, ctx({ level: 'counts' })), {
      id: 'n-000000000001',
      thread: 'digest:nc-x:1',
      revision: 1,
      createdAt: UNTIL,
      updatedAt: UNTIL,
      level: 'counts',
    });
    expect(NotificationMessage.parse(message).privacy).toEqual({
      level: 'counts',
      has_image: false,
    });
    expect(message.category).toBe('reports');
    expect(message.state).toBe('final');
  });
});

describe('evaluateAnomalies (D-44)', () => {
  const quiet: AnomalyFacts = {
    window: { since: UNTIL - HOUR, until: UNTIL },
    toolCalls: 100,
    errors: 0,
    blocked: 0,
    blockedBaselinePerHour: 10,
    attentionWaiting: [],
    live: 0,
    maxSessions: 10,
    degradations: [],
  };
  const on = (f: Partial<AnomalyFacts>, rule: AnomalyRule = {}, prev: AnomalyState = {}) =>
    Object.keys(evaluateAnomalies({ ...quiet, ...f }, rule, prev, UNTIL).active);
  const was = (check: keyof AnomalyState): AnomalyState => ({
    [check]: { since: UNTIL - HOUR, value: 1, threshold: 1 },
  });

  const cases: readonly [string, string[], string[]][] = [
    ['nothing crosses', on({}), []],
    ['error rate at 20 % with 20 calls fires', on({ toolCalls: 20, errors: 4 }), ['error_rate']],
    ['error rate with too few calls does not', on({ toolCalls: 19, errors: 19 }), []],
    ['error rate below the threshold does not', on({ toolCalls: 100, errors: 19 }), []],
    [
      'an active error rate stays above half the threshold',
      on({ toolCalls: 100, errors: 11 }, {}, was('error_rate')),
      ['error_rate'],
    ],
    [
      'an active error rate clears below half',
      on({ toolCalls: 100, errors: 9 }, {}, was('error_rate')),
      [],
    ],
    [
      'a request waiting 30 minutes fires',
      on({ attentionWaiting: [{ sessionSlug: 'a', waitedMs: 30 * 60_000 }] }),
      ['attention'],
    ],
    [
      'a request waiting 29 minutes does not',
      on({ attentionWaiting: [{ sessionSlug: 'a', waitedMs: 29 * 60_000 }] }),
      [],
    ],
    ['sessions at the limit fire', on({ live: 10 }), ['capacity']],
    ['one below the limit does not fire', on({ live: 9 }), []],
    ['active capacity stays at 90 %', on({ live: 9 }, {}, was('capacity')), ['capacity']],
    ['active capacity clears below 90 %', on({ live: 8 }, {}, was('capacity')), []],
    ['no limit, no capacity check', on({ live: 50, maxSessions: 0 }), []],
    ['a blocked spike fires', on({ blocked: 60 }), ['blocked']],
    ['a spike under the minimum does not', on({ blocked: 49, blockedBaselinePerHour: 1 }), []],
    ['a high but usual level does not', on({ blocked: 60, blockedBaselinePerHour: 30 }), []],
    ['an active spike stays above half', on({ blocked: 30 }, {}, was('blocked')), ['blocked']],
    ['an active spike clears below half', on({ blocked: 20 }, {}, was('blocked')), []],
    [
      'an unresolved error event fires',
      on({ degradations: [{ code: 'X', message: 'm', since: 0 }] }),
      ['degraded'],
    ],
    [
      'checks switched off never fire',
      on(
        {
          toolCalls: 100,
          errors: 100,
          live: 10,
          blocked: 1000,
          attentionWaiting: [{ sessionSlug: 'a', waitedMs: 10 * HOUR }],
          degradations: [{ code: 'X', message: 'm', since: 0 }],
        },
        {
          error_rate: null,
          attention_minutes: null,
          blocked_spike: null,
          capacity: false,
          degraded: false,
        },
      ),
      [],
    ],
    [
      'a tuned threshold is used',
      on({ toolCalls: 100, errors: 6 }, { error_rate: 5, min_calls: 50 }),
      ['error_rate'],
    ],
  ];
  for (const [name, got, want] of cases) {
    it(name, () => expect(got).toEqual(want));
  }

  it('reports crossings and clears, keeping when an active check began', () => {
    const first = evaluateAnomalies({ ...quiet, live: 10 }, {}, {}, UNTIL);
    expect(first.fired).toEqual(['capacity']);
    const later = evaluateAnomalies(
      { ...quiet, live: 10, toolCalls: 50, errors: 50 },
      {},
      first.active,
      UNTIL + HOUR,
    );
    expect(later.fired).toEqual(['error_rate']);
    expect(later.active.capacity?.since).toBe(UNTIL);
    const cleared = evaluateAnomalies(quiet, {}, later.active, UNTIL + 2 * HOUR);
    expect(cleared.cleared).toEqual(['error_rate', 'capacity']);
    expect(cleared.active).toEqual({});
  });

  it('fills the defaults', () => {
    expect(anomalyThresholds({})).toEqual({
      errorRate: 20,
      minCalls: 20,
      attentionMinutes: 30,
      blockedSpike: 3,
      blockedMin: 50,
      capacity: true,
      degraded: true,
    });
  });
});

describe('buildAnomaly', () => {
  const facts = sampleAnomalyFacts(UNTIL);
  const evaluation = evaluateAnomalies(facts, {}, {}, UNTIL);

  it('lists every active check, the new ones first, as a table', () => {
    const a = buildAnomaly({ facts, active: evaluation.active, fired: evaluation.fired }, ctx());
    expect(a.title).toBe('Something looks off: 2 checks');
    expect(a.summary).toBe(
      '34% of tool calls failed in the last hour · An attention request has waited 47 min',
    );
    expect(a.severity).toBe('warn');
    expect(a.alert).toBe(true);
    expect(a.state).toBe('open');
    const table = a.blocks.find((b) => b.type === 'table');
    expect(table?.type === 'table' && table.rows.length).toBe(2);
  });

  it('explains a single check in one sentence', () => {
    const one = evaluateAnomalies(facts, { attention_minutes: null }, {}, UNTIL);
    const a = buildAnomaly({ facts, active: one.active, fired: one.fired }, ctx());
    expect(a.title).toBe('Something looks off: 34% of tool calls failed in the last hour');
    expect(a.summary).toBe('72 of 212 tool calls failed between 08:00 and 09:00 (alert at 20%).');
  });

  it('is an error while BrowserHive is degraded or at capacity', () => {
    const degraded = {
      ...facts,
      degradations: [{ code: 'RETENTION_FAILED', message: 'x', since: 0 }],
    };
    const e = evaluateAnomalies(degraded, {}, {}, UNTIL);
    expect(
      buildAnomaly({ facts: degraded, active: e.active, fired: e.fired }, ctx()).severity,
    ).toBe('error');
  });

  it('keeps names out of counts', () => {
    const a = buildAnomaly(
      { facts, active: evaluation.active, fired: evaluation.fired },
      ctx({ level: 'counts' }),
    );
    expect(JSON.stringify(a.blocks)).not.toContain('checkout');
  });

  it('turns into a silent "Back to normal" without buttons', () => {
    const a = buildAnomaly(
      { facts, active: {}, fired: [], resolvedSince: UNTIL - 2 * HOUR },
      ctx(),
    );
    expect(a).toMatchObject({
      title: 'Back to normal',
      state: 'resolved',
      alert: false,
      actions: [],
    });
    expect(a.summary).toBe(
      'Every check is back under its threshold since 09:00 · it lasted 2h 00m.',
    );
  });
});
