/** @module app/notifications/report-scheduler.test — the scheduled reports on a fake clock with manual intervals and in-memory repositories (D-43, D-44, spec 03 §9.7): zero cost without a schedule, arming, on-time and late digests with the skipped count, exactly once across ticks and restarts, rule changes, empty and quiet digests, paused channels, the anomaly episode (fire, hold, silent revision, back to normal, quiet hours), cursor cleanup and the views. */

import { describe, expect, it } from 'bun:test';
import type { NotificationChannelRules } from '@browserhive/contracts/notifications';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { capabilities, channelRecord, FakeChannel } from '../../../test/helpers/fake-channel.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import { createRedactor } from '../../kernel/redact.ts';
import { ManualIntervals } from '../maintenance/test-support.ts';
import { ChannelRegistry } from './channel-registry.ts';
import { decodeMessage } from './message.ts';
import type { ReportFacts } from './report-facts.ts';
import {
  anomalyCursorKey,
  digestCursorKey,
  forgetChannelCursors,
  ReportScheduler,
} from './report-scheduler.ts';
import type { AnomalyFacts, DigestFacts } from './reports.ts';
import { planDeliveries } from './routing.ts';
import { sampleAnomalyFacts, sampleDigestFacts } from './samples.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = 'Europe/Berlin';
/** 2026-09-28 12:00 UTC (14:00 in Berlin). */
const START = Date.UTC(2026, 8, 28, 12);
/** 09:00 Berlin on 29 Sep = 07:00 UTC. */
const NINE = Date.UTC(2026, 8, 29, 7);
const CHANNEL = 'nc-000000000001';

/** The outbox's planning over the registry (what `NotificationOutbox.plan` does). */
function routing(registry: ChannelRegistry, kick: () => void) {
  return {
    plan: (message: Parameters<typeof planDeliveries>[0], now: number, to?: string) =>
      planDeliveries(message, registry.channels(), now, to),
    kick,
  };
}

interface Setup {
  readonly rules?: NotificationChannelRules;
  readonly status?: 'active' | 'paused';
  readonly digest?: (window: { since: number; until: number }) => DigestFacts;
  readonly anomaly?: (now: number) => AnomalyFacts;
}

async function setup(opts: Setup = {}) {
  const clock = new FakeClock(START);
  const repos = new InMemoryRepositories();
  const uow = new InMemoryUnitOfWork(repos);
  const logger = new CollectingLogger();
  const ids = new FakeIdGenerator();
  const fake = new FakeChannel(CHANNEL, capabilities());
  await repos.notificationChannels.upsert(
    channelRecord({
      rules: opts.rules ?? { digest: { every: 'day', at: '09:00' }, time_zone: ZONE },
      status: opts.status ?? 'active',
    }),
  );
  const registry = new ChannelRegistry({
    repo: repos.notificationChannels,
    clock,
    ids,
    logger,
    factories: new Map([['fake', () => fake]]),
  });
  await registry.load();
  const calls = { digest: [] as { since: number; until: number }[], anomaly: 0, kicks: 0 };
  const facts: ReportFacts = {
    digest: async (window, rule) => {
      calls.digest.push({ ...window });
      return opts.digest?.(window) ?? sampleDigestFacts(window.until, rule);
    },
    anomaly: async (now) => {
      calls.anomaly += 1;
      return (
        opts.anomaly?.(now) ?? {
          ...sampleAnomalyFacts(now),
          toolCalls: 0,
          errors: 0,
          attentionWaiting: [],
        }
      );
    },
  };
  const intervals = new ManualIntervals();
  const counted: { kind: string; outcome: string; n: number }[] = [];
  const make = () =>
    new ReportScheduler({
      registry,
      facts,
      uow,
      repos,
      outbox: routing(registry, () => {
        calls.kicks += 1;
      }),
      clock,
      ids,
      logger,
      hostZone: () => 'UTC',
      redactor: createRedactor(),
      scheduler: intervals,
      counter: { add: (n, a) => void counted.push({ ...a, n }) },
    });
  const scheduler = make();
  /** The channel copies (stored out of the inbox). */
  const reports = () =>
    [...repos.notifications.rows.values()].filter(
      (r) => r.category === 'reports' && !(r.thread ?? '').startsWith('report:'),
    );
  /** The in-app copies (D-45). */
  const inApp = () =>
    [...repos.notifications.rows.values()].filter((r) => (r.thread ?? '').startsWith('report:'));
  const deliveries = () => repos.notificationDeliveries.rows;
  return {
    clock,
    repos,
    registry,
    scheduler,
    make,
    calls,
    intervals,
    counted,
    reports,
    inApp,
    deliveries,
  };
}

describe('ReportScheduler: timers', () => {
  it('arms no timer and makes no query when no channel schedules a report', async () => {
    const t = await setup({ rules: { categories: ['needs-you'] } });
    t.scheduler.start();
    expect(t.intervals.fns).toHaveLength(0);
    await t.scheduler.tick();
    expect(t.calls.digest).toHaveLength(0);
    expect(t.calls.anomaly).toBe(0);
    expect(t.repos.notificationCursors.rows.size).toBe(0);
  });

  it('arms when a schedule appears and disarms when it goes', async () => {
    const t = await setup({ rules: {} });
    t.scheduler.start();
    expect(t.intervals.fns).toHaveLength(0);
    const row = await t.repos.notificationChannels.get(CHANNEL);
    if (row === null) throw new Error('no row');
    await t.repos.notificationChannels.upsert({ ...row, rules: { anomaly: {} } });
    await t.registry.reload();
    expect(t.intervals.fns).toHaveLength(1);
    await t.repos.notificationChannels.upsert({ ...row, rules: {} });
    await t.registry.reload();
    expect(t.intervals.fns).toHaveLength(0);
    t.scheduler.stop();
  });
});

describe('ReportScheduler: digests (D-43)', () => {
  it('arms at the first tick and sends nothing for the past', async () => {
    const t = await setup();
    await t.scheduler.tick();
    expect(t.reports()).toHaveLength(0);
    const cursor = JSON.parse(
      (await t.repos.notificationCursors.get(digestCursorKey(CHANNEL))) ?? '{}',
    );
    expect(cursor).toEqual({ spec: `day@09:00@${ZONE}`, last: START, until: null });
  });

  it('sends the digest at its time, once, as an addressed, dismissed notification', async () => {
    const t = await setup();
    await t.scheduler.tick();
    await t.clock.set(NINE + 30_000);
    const pass = await t.scheduler.tick();
    expect(pass.digests).toBe(1);
    const [row] = t.reports();
    expect(row).toMatchObject({
      kind: 'digest.daily',
      readAt: NINE + 30_000,
      dismissedAt: NINE + 30_000,
    });
    const message = decodeMessage(row?.messageJson ?? null);
    expect(message?.report).toEqual({
      window: { since: NINE - DAY, until: NINE },
      time_zone: ZONE,
      late: false,
      skipped: 0,
      manual: false,
    });
    expect(message?.alert).toBe(true);
    expect(message?.privacy.level).toBe('titles');
    expect(t.deliveries().map((d) => [d.channelId, d.op, d.status])).toEqual([
      [CHANNEL, 'send', 'pending'],
    ]);
    expect(t.calls.kicks).toBe(1);
    expect(t.calls.digest).toEqual([{ since: NINE - DAY, until: NINE }]);
    // A second tick and a fresh scheduler (a restart) over the same database send nothing more.
    await t.scheduler.tick();
    await t.make().tick();
    expect(t.reports()).toHaveLength(1);
    expect(t.counted).toContainEqual({ kind: 'digest.daily', outcome: 'sent', n: 1 });
  });

  it('after downtime sends the newest missed window once, late, with the skipped count', async () => {
    const t = await setup();
    await t.scheduler.tick();
    // Off from 28 Sep 14:00 until 2 Oct 11:00 Berlin: 29, 30 Sep, 1 and 2 Oct at 09:00 were missed.
    await t.clock.set(Date.UTC(2026, 9, 2, 9));
    await t.make().tick();
    const reports = t.reports();
    expect(reports).toHaveLength(1);
    const message = decodeMessage(reports[0]?.messageJson ?? null);
    const newest = Date.UTC(2026, 9, 2, 7);
    expect(message?.report).toMatchObject({
      window: { since: newest - DAY, until: newest },
      late: true,
      skipped: 3,
    });
    expect(JSON.stringify(message?.blocks)).toContain('3 earlier digests were skipped');
    expect(t.counted).toContainEqual({ kind: 'digest.daily', outcome: 'late', n: 1 });
    expect(t.counted).toContainEqual({ kind: 'digest.daily', outcome: 'skipped', n: 3 });
  });

  it('re-arms without a late send when the schedule changes', async () => {
    const t = await setup();
    await t.scheduler.tick();
    await t.clock.set(NINE + 60_000);
    await t.scheduler.tick();
    expect(t.reports()).toHaveLength(1);
    // At 10:00 the operator moves the digest to 08:00: that time already passed today.
    await t.clock.set(NINE + HOUR);
    const row = await t.repos.notificationChannels.get(CHANNEL);
    if (row === null) throw new Error('no row');
    await t.repos.notificationChannels.upsert({
      ...row,
      rules: { ...row.rules, digest: { every: 'day', at: '08:00' } },
    });
    await t.registry.reload();
    await t.scheduler.tick();
    expect(t.reports()).toHaveLength(1);
    // The next day at 08:00 the window starts where the last digest ended (09:00).
    await t.clock.set(NINE + DAY - HOUR + 60_000);
    await t.scheduler.tick();
    expect(t.reports()).toHaveLength(2);
    expect(t.calls.digest.at(-1)).toEqual({ since: NINE, until: NINE + DAY - HOUR });
  });

  it('stores an empty day as suppressed: empty and sends nothing', async () => {
    const t = await setup({
      digest: (w) => ({
        ...sampleDigestFacts(w.until, { every: 'day', at: '09:00' }),
        sessionsStarted: 0,
        toolCalls: 0,
        errors: 0,
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
        degradations: [],
      }),
    });
    await t.scheduler.tick();
    await t.clock.set(NINE + 1000);
    await t.scheduler.tick();
    expect(t.deliveries().map((d) => [d.status, d.reason])).toEqual([['suppressed', 'empty']]);
    expect(t.calls.kicks).toBe(0);
    expect(t.counted).toContainEqual({ kind: 'digest.daily', outcome: 'empty', n: 1 });
  });

  it('sends silently when its time falls in the quiet hours', async () => {
    const t = await setup({
      rules: {
        digest: { every: 'day', at: '09:00' },
        time_zone: ZONE,
        quiet_hours: { start: '08:00', end: '10:00' },
      },
    });
    await t.scheduler.tick();
    await t.clock.set(NINE + 1000);
    await t.scheduler.tick();
    expect(decodeMessage(t.reports()[0]?.messageJson ?? null)?.alert).toBe(false);
    expect(t.deliveries()[0]?.status).toBe('pending');
  });

  it("logs a paused channel's digest as channel_paused and moves on", async () => {
    const t = await setup({ status: 'paused' });
    await t.scheduler.tick();
    await t.clock.set(NINE + 1000);
    await t.scheduler.tick();
    expect(t.deliveries().map((d) => [d.status, d.reason])).toEqual([
      ['suppressed', 'channel_paused'],
    ]);
    await t.clock.set(NINE + 2 * HOUR);
    await t.scheduler.tick();
    expect(t.reports()).toHaveLength(1);
  });

  it('follows the channel zone: the same rule fires at another instant in Tokyo', async () => {
    const t = await setup({
      rules: { digest: { every: 'day', at: '09:00' }, time_zone: 'Asia/Tokyo' },
    });
    await t.scheduler.tick();
    await t.clock.set(Date.UTC(2026, 8, 29, 0, 1)); // 09:01 in Tokyo, 02:01 in Berlin
    await t.scheduler.tick();
    expect(t.reports()).toHaveLength(1);
  });

  it('builds the on-demand digest without touching the schedule', async () => {
    const t = await setup();
    await t.scheduler.tick();
    const before = await t.repos.notificationCursors.get(digestCursorKey(CHANNEL));
    const row = await t.repos.notificationChannels.get(CHANNEL);
    if (row === null) throw new Error('no row');
    const built = await t.scheduler.manualDigest(row);
    expect(built.window).toEqual({ since: START - DAY, until: START });
    expect(built.message.report?.manual).toBe(true);
    expect(await t.repos.notificationCursors.get(digestCursorKey(CHANNEL))).toBe(before);
  });

  it('shows the next run in the channel zone', async () => {
    const t = await setup();
    const row = await t.repos.notificationChannels.get(CHANNEL);
    if (row === null) throw new Error('no row');
    expect(t.scheduler.view(row)).toMatchObject({
      time_zone: ZONE,
      host_zone: false,
      digest: { every: 'day', at: '09:00', day: null, next_at: NINE, last_until: null },
      anomaly: null,
    });
  });
});

describe('ReportScheduler: anomaly alerts (D-44)', () => {
  const failing = (now: number): AnomalyFacts => ({
    ...sampleAnomalyFacts(now),
    attentionWaiting: [],
    toolCalls: 100,
    errors: 40,
  });
  const failingAndFull = (now: number): AnomalyFacts => ({ ...failing(now), live: 10 });
  const healthy = (now: number): AnomalyFacts => ({ ...failing(now), errors: 0 });

  it('checks once an hour, alerts on a crossing, holds, edits silently, then says back to normal', async () => {
    let facts = failingAndFull;
    const t = await setup({
      rules: { anomaly: {}, time_zone: ZONE },
      anomaly: (now) => facts(now),
    });
    await t.scheduler.tick();
    expect(t.calls.anomaly).toBe(1);
    const first = t.reports();
    expect(first).toHaveLength(1);
    const alert = decodeMessage(first[0]?.messageJson ?? null);
    expect(alert).toMatchObject({
      kind: 'report.anomaly',
      state: 'open',
      alert: true,
      severity: 'error',
    });
    // Same hour: no second check.
    await t.clock.set(START + 10 * 60_000);
    await t.scheduler.tick();
    expect(t.calls.anomaly).toBe(1);
    // Next hour, still failing: nothing new, nothing edited.
    await t.clock.set(START + HOUR + 60_000);
    await t.scheduler.tick();
    expect(t.calls.anomaly).toBe(2);
    expect(t.deliveries()).toHaveLength(1);
    // Capacity clears, the error rate stays: a silent edit of the same alert.
    facts = failing;
    await t.clock.set(START + 2 * HOUR + 60_000);
    await t.scheduler.tick();
    const revised = decodeMessage(
      t.repos.notifications.rows.get(first[0]?.notificationId ?? '')?.messageJson ?? null,
    );
    expect(revised).toMatchObject({ revision: 2, alert: false, state: 'open', severity: 'warn' });
    expect(t.deliveries().map((d) => [d.op, d.revision])).toEqual([
      ['send', 1],
      ['edit', 2],
    ]);
    // Everything clears: resolved, silently.
    facts = healthy;
    await t.clock.set(START + 3 * HOUR + 60_000);
    await t.scheduler.tick();
    const resolved = decodeMessage(
      t.repos.notifications.rows.get(first[0]?.notificationId ?? '')?.messageJson ?? null,
    );
    expect(resolved).toMatchObject({
      revision: 3,
      state: 'resolved',
      alert: false,
      title: 'Back to normal',
    });
    expect(t.counted).toContainEqual({ kind: 'report.anomaly', outcome: 'resolved', n: 1 });
    // A later crossing is a new alert.
    facts = failing;
    await t.clock.set(START + 4 * HOUR + 60_000);
    await t.scheduler.tick();
    expect(t.reports()).toHaveLength(2);
  });

  it('a new crossing during an open alert sends a new alert and closes the old one', async () => {
    let facts = failing;
    const t = await setup({
      rules: { anomaly: {}, time_zone: ZONE },
      anomaly: (now) => facts(now),
    });
    await t.scheduler.tick();
    facts = failingAndFull;
    await t.clock.set(START + HOUR + 60_000);
    await t.scheduler.tick();
    const rows = t.reports().sort((a, b) => a.createdAt - b.createdAt);
    expect(rows.map((r) => r.state)).toEqual(['final', 'open']);
    expect(decodeMessage(rows[1]?.messageJson ?? null)?.title).toBe(
      'Something looks off: 2 checks',
    );
  });

  it('runs no check during quiet hours and checks at the first tick after them', async () => {
    const t = await setup({
      rules: { anomaly: {}, time_zone: 'UTC', quiet_hours: { start: '11:00', end: '13:00' } },
      anomaly: failing,
    });
    await t.scheduler.tick();
    // The channel is quiet; its watch (the in-app alert, D-45) has no quiet hours.
    expect(t.reports()).toHaveLength(0);
    expect(t.inApp()).toHaveLength(1);
    await t.clock.set(START + HOUR); // 13:00 UTC: quiet hours are over
    await t.scheduler.tick();
    expect(t.reports()).toHaveLength(1);
    // The channel's alert names the episode's in-app copy; the watch did not alert again.
    expect(t.inApp()).toHaveLength(1);
    expect(t.reports()[0]?.sourceEventId).toBe(t.inApp()[0]?.notificationId);
  });

  it('survives a restart without repeating the alert', async () => {
    const t = await setup({ rules: { anomaly: {} }, anomaly: failing });
    await t.scheduler.tick();
    await t.clock.set(START + HOUR + 60_000);
    await t.make().tick();
    expect(t.reports()).toHaveLength(1);
    const cursor = JSON.parse(
      (await t.repos.notificationCursors.get(anomalyCursorKey(CHANNEL))) ?? '{}',
    );
    expect(Object.keys(cursor.active)).toEqual(['error_rate']);
  });
});

describe('forgetChannelCursors', () => {
  it('removes the ntfy, digest and anomaly cursors of a channel', async () => {
    const t = await setup();
    for (const key of [
      `ntfy:${CHANNEL}`,
      digestCursorKey(CHANNEL),
      anomalyCursorKey(CHANNEL),
      'telegram:1',
    ]) {
      await t.repos.notificationCursors.set(key, '1', 0);
    }
    await forgetChannelCursors(t.repos.notificationCursors, CHANNEL);
    expect([...t.repos.notificationCursors.rows.keys()]).toEqual(['telegram:1']);
  });
});
