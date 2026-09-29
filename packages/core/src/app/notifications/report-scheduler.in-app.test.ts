/** @module app/notifications/report-scheduler.in-app.test — reports in the dashboard (D-45, spec 03 §9.7) on a fake clock with in-memory repositories: one in-app copy per period shared by the channels of that period (two zones make two), channel copies naming it, digests stored read and anomaly alerts unread, the in-app schedule with no channel at all, the anomaly watches shared by equal thresholds and closed when unwanted, the on-demand copy and the announcements. */

import { describe, expect, it } from 'bun:test';
import type { Notification } from '@browserhive/contracts/http';
import type {
  NotificationChannelRules,
  ReportSettings,
} from '@browserhive/contracts/notifications';
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
import { digestCursorKey, IN_APP_SCHEDULE, ReportScheduler } from './report-scheduler.ts';
import { ReportService } from './report-service.ts';
import { ReportSettingsStore } from './report-settings.ts';
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
const A = 'nc-00000000000a';
const B = 'nc-00000000000b';
const DAILY: NotificationChannelRules = {
  digest: { every: 'day', at: '09:00' },
  time_zone: ZONE,
};

const quiet = (now: number): AnomalyFacts => ({
  ...sampleAnomalyFacts(now),
  toolCalls: 0,
  errors: 0,
  attentionWaiting: [],
});
const failing = (now: number): AnomalyFacts => ({
  ...sampleAnomalyFacts(now),
  attentionWaiting: [],
  toolCalls: 100,
  errors: 40,
});

const EMPTY_DAY = (w: { since: number; until: number }): DigestFacts => ({
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
});

interface Setup {
  readonly channels?: readonly { id: string; name: string; rules: NotificationChannelRules }[];
  readonly settings?: ReportSettings;
  readonly digest?: (window: { since: number; until: number }) => DigestFacts;
  readonly anomaly?: (now: number) => AnomalyFacts;
}

async function setup(opts: Setup = {}) {
  const clock = new FakeClock(START);
  const repos = new InMemoryRepositories();
  const uow = new InMemoryUnitOfWork(repos);
  const logger = new CollectingLogger();
  const ids = new FakeIdGenerator();
  for (const c of opts.channels ?? []) {
    await repos.notificationChannels.upsert(
      channelRecord({ channelId: c.id, name: c.name, rules: c.rules }),
    );
  }
  const registry = new ChannelRegistry({
    repo: repos.notificationChannels,
    clock,
    ids,
    logger,
    factories: new Map([['fake', () => new FakeChannel('fake', capabilities())]]),
  });
  await registry.load();
  const settings = new ReportSettingsStore(repos.notificationCursors);
  if (opts.settings !== undefined) await settings.save(opts.settings, START);
  const facts: ReportFacts = {
    digest: async (window, rule) =>
      opts.digest?.(window) ?? { ...sampleDigestFacts(window.until, rule), window: { ...window } },
    anomaly: async (now) => (opts.anomaly ?? quiet)(now),
  };
  const intervals = new ManualIntervals();
  const announced: { op: string; notification: Notification }[] = [];
  const make = () =>
    new ReportScheduler({
      registry,
      facts,
      uow,
      repos,
      outbox: {
        plan: (message, now, to) => planDeliveries(message, registry.channels(), now, to),
        kick: () => undefined,
      },
      clock,
      ids,
      logger,
      hostZone: () => 'UTC',
      settings,
      inbox: (op, notification) => void announced.push({ op, notification }),
      redactor: createRedactor(),
      scheduler: intervals,
    });
  const scheduler = make();
  const rows = () => [...repos.notifications.rows.values()];
  const inApp = () => rows().filter((r) => (r.thread ?? '').startsWith('report:'));
  const copies = () =>
    rows().filter((r) => r.category === 'reports' && !(r.thread ?? '').startsWith('report:'));
  const service = new ReportService({ repo: repos.notifications, settings, scheduler, clock });
  return {
    clock,
    repos,
    registry,
    settings,
    scheduler,
    make,
    intervals,
    announced,
    inApp,
    copies,
    service,
  };
}

describe('in-app digest copies (D-45)', () => {
  it('writes one in-app copy for two channels on the same period, both copies naming it', async () => {
    const t = await setup({
      channels: [
        { id: A, name: 'phone', rules: DAILY },
        { id: B, name: 'team', rules: { ...DAILY, content: 'counts' } },
      ],
    });
    await t.scheduler.tick();
    await t.clock.set(NINE + 30_000);
    await t.scheduler.tick();
    const [copy] = t.inApp();
    expect(t.inApp()).toHaveLength(1);
    expect(copy).toMatchObject({
      kind: 'digest.daily',
      type: 'lifecycle',
      principalId: null,
      // A digest never counts toward the badge and stays in the inbox until dismissed.
      readAt: NINE + 30_000,
      dismissedAt: null,
      target: `/notifications/reports/${copy?.notificationId}`,
    });
    const message = decodeMessage(copy?.messageJson ?? null);
    expect(message?.privacy.level).toBe('full');
    expect(message?.alert).toBe(false);
    expect(message?.report?.window).toEqual({ since: NINE - DAY, until: NINE });
    expect(t.copies().map((c) => c.sourceEventId)).toEqual([
      copy?.notificationId,
      copy?.notificationId,
    ]);
    expect(t.copies().every((c) => c.dismissedAt !== null)).toBe(true);
    expect(t.announced.map((a) => [a.op, a.notification.notification_id])).toEqual([
      ['created', copy?.notificationId],
    ]);
    expect(await t.repos.notifications.unreadCount(null)).toBe(0);
    // The history lists it once, with both channels.
    const page = await t.service.list({ limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.channels.map((c) => [c.name, c.status])).toEqual([
      ['phone', 'pending'],
      ['team', 'pending'],
    ]);
  });

  it('writes two copies when the zones differ, even for the same instants', async () => {
    const t = await setup({
      channels: [
        { id: A, name: 'berlin', rules: DAILY },
        {
          id: B,
          name: 'london',
          rules: { digest: { every: 'day', at: '08:00' }, time_zone: 'Europe/London' },
        },
      ],
    });
    await t.scheduler.tick();
    await t.clock.set(NINE + 30_000);
    await t.scheduler.tick();
    expect(t.inApp()).toHaveLength(2);
    const zones = t.inApp().map((r) => decodeMessage(r.messageJson)?.report?.time_zone);
    expect(zones.sort()).toEqual(['Europe/Berlin', 'Europe/London']);
  });

  it('writes no in-app copy for an empty period', async () => {
    const t = await setup({
      channels: [{ id: A, name: 'phone', rules: DAILY }],
      digest: EMPTY_DAY,
    });
    await t.scheduler.tick();
    await t.clock.set(NINE + 1000);
    await t.scheduler.tick();
    expect(t.inApp()).toHaveLength(0);
    expect(t.copies()).toHaveLength(1);
    expect(t.copies()[0]?.sourceEventId).toBeNull();
  });

  it('shares the period with the in-app schedule', async () => {
    const t = await setup({
      channels: [{ id: A, name: 'phone', rules: DAILY }],
      settings: { digest: { every: 'day', at: '09:00' }, time_zone: ZONE },
    });
    await t.scheduler.tick();
    await t.clock.set(NINE + 1000);
    await t.scheduler.tick();
    expect(t.inApp()).toHaveLength(1);
    expect(t.announced).toHaveLength(1);
    // "BrowserHive only" is a report that reached no channel: not this one.
    expect((await t.service.list({ limit: 10, inAppOnly: true })).items).toHaveLength(0);
    expect((await t.service.list({ limit: 10, channelId: A })).items).toHaveLength(1);
  });
});

describe('the in-app schedule (D-45)', () => {
  it('produces digests with no channel at all', async () => {
    const t = await setup({ settings: { digest: { every: 'day', at: '09:00' }, time_zone: ZONE } });
    t.scheduler.start();
    expect(t.intervals.fns).toHaveLength(1);
    await t.scheduler.tick();
    await t.clock.set(NINE + 1000);
    await t.scheduler.tick();
    expect(t.inApp()).toHaveLength(1);
    expect(t.copies()).toHaveLength(0);
    expect(t.repos.notificationDeliveries.rows).toHaveLength(0);
    expect(await t.repos.notificationCursors.get(digestCursorKey(IN_APP_SCHEDULE))).toContain(
      `day@09:00@${ZONE}`,
    );
    const page = await t.service.list({ limit: 10, inAppOnly: true });
    expect(page.items.map((i) => i.channels)).toEqual([[]]);
    t.scheduler.stop();
  });

  it('arms when the settings switch on and re-arms a changed schedule without a late digest', async () => {
    const t = await setup();
    t.scheduler.start();
    expect(t.intervals.fns).toHaveLength(0);
    await t.settings.save({ digest: { every: 'day', at: '09:00' }, time_zone: ZONE }, START);
    expect(t.intervals.fns).toHaveLength(1);
    await t.scheduler.tick();
    // Moved to 08:00 at 10:00 the next day: 08:00 passed, nothing is sent late.
    await t.clock.set(NINE + HOUR);
    await t.settings.save({ digest: { every: 'day', at: '08:00' }, time_zone: ZONE }, NINE + HOUR);
    await t.scheduler.tick();
    expect(t.inApp()).toHaveLength(0);
    await t.settings.save({}, NINE + HOUR);
    expect(t.intervals.fns).toHaveLength(0);
    t.scheduler.stop();
  });

  it('runs a weekly digest on Friday at 17:00 over seven days, weekend included', async () => {
    const t = await setup({
      settings: { digest: { every: 'week', at: '17:00' }, time_zone: ZONE },
    });
    await t.scheduler.tick();
    // Fri 2 Oct 2026 17:00 in Berlin = 15:00 UTC.
    const friday = Date.UTC(2026, 9, 2, 15);
    await t.clock.set(friday + 1000);
    await t.scheduler.tick();
    const report = decodeMessage(t.inApp()[0]?.messageJson ?? null)?.report;
    expect(report?.window).toEqual({ since: friday - 7 * DAY, until: friday });
    expect(t.inApp()[0]?.kind).toBe('digest.weekly');
  });

  it('skips the weekend with weekdays only; Monday covers it', async () => {
    const t = await setup({
      settings: { digest: { every: 'day', at: '09:00', weekdays_only: true }, time_zone: ZONE },
    });
    await t.scheduler.tick();
    // Sat 3 and Sun 4 Oct: nothing. Mon 5 Oct 09:00 Berlin = 07:00 UTC.
    await t.clock.set(Date.UTC(2026, 9, 2, 7, 1));
    await t.scheduler.tick();
    expect(t.inApp()).toHaveLength(1);
    await t.clock.set(Date.UTC(2026, 9, 3, 7, 1));
    await t.scheduler.tick();
    await t.clock.set(Date.UTC(2026, 9, 4, 7, 1));
    await t.scheduler.tick();
    expect(t.inApp()).toHaveLength(1);
    await t.clock.set(Date.UTC(2026, 9, 5, 7, 1));
    await t.scheduler.tick();
    const monday = t.inApp().find((r) => r.createdAt === Date.UTC(2026, 9, 5, 7, 1));
    expect(decodeMessage(monday?.messageJson ?? null)?.report).toMatchObject({
      window: { since: Date.UTC(2026, 9, 2, 7), until: Date.UTC(2026, 9, 5, 7) },
      late: false,
      skipped: 0,
    });
  });

  it('shows the in-app schedule like a channel', async () => {
    const t = await setup({
      settings: { digest: { every: 'day', at: '09:00', weekdays_only: true }, anomaly: {} },
    });
    expect(t.service.settings()).toMatchObject({
      host_time_zone: 'UTC',
      reports: {
        time_zone: 'UTC',
        host_zone: true,
        digest: { every: 'day', weekdays_only: true, next_at: Date.UTC(2026, 8, 29, 9) },
        anomaly: { next_check_at: START, active: [] },
      },
    });
  });

  it('refuses a weekday on a daily digest and an unknown zone', async () => {
    const t = await setup();
    await expect(
      t.service.saveSettings({ digest: { every: 'day', at: '09:00', day: 'mon' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(t.service.saveSettings({ time_zone: 'Mars/Olympus' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('anomaly watches (D-45)', () => {
  it('writes one unread in-app alert for two channels with the same thresholds', async () => {
    const t = await setup({
      channels: [
        { id: A, name: 'phone', rules: { anomaly: {} } },
        // The same thresholds spelled out: one watch.
        { id: B, name: 'team', rules: { anomaly: { error_rate: 20, min_calls: 20 } } },
      ],
      anomaly: failing,
    });
    await t.scheduler.tick();
    expect(t.inApp()).toHaveLength(1);
    const [alert] = t.inApp();
    expect(alert).toMatchObject({
      kind: 'report.anomaly',
      type: 'system',
      readAt: null,
      dismissedAt: null,
      state: 'open',
      target: `/notifications/reports/${alert?.notificationId}`,
    });
    expect(await t.repos.notifications.unreadCount(null)).toBe(1);
    expect(t.copies().map((c) => c.sourceEventId)).toEqual([
      alert?.notificationId,
      alert?.notificationId,
    ]);
    expect(t.announced.map((a) => a.op)).toEqual(['created']);
  });

  it('keeps separate watches for different thresholds', async () => {
    const t = await setup({
      channels: [
        { id: A, name: 'phone', rules: { anomaly: {} } },
        { id: B, name: 'team', rules: { anomaly: { error_rate: 50 } } },
      ],
      anomaly: failing,
    });
    await t.scheduler.tick();
    // 40 % fails: only the default (20 %) watch fires.
    expect(t.inApp()).toHaveLength(1);
    expect(t.copies()).toHaveLength(1);
  });

  it('says back to normal silently, in place', async () => {
    let facts = failing;
    const t = await setup({
      settings: { anomaly: {} },
      anomaly: (now) => facts(now),
    });
    await t.scheduler.tick();
    const [alert] = t.inApp();
    facts = quiet;
    await t.clock.set(START + HOUR + 1000);
    await t.scheduler.tick();
    expect(t.inApp()).toHaveLength(1);
    const row = t.repos.notifications.rows.get(alert?.notificationId ?? '');
    expect(row?.state).toBe('resolved');
    const message = decodeMessage(row?.messageJson ?? null);
    expect(message?.title).toBe('Back to normal');
    expect(message?.alert).toBe(false);
    expect(t.announced.map((a) => [a.op, a.notification.state])).toEqual([
      ['created', 'open'],
      ['updated', 'resolved'],
    ]);
  });

  it('closes the open alert of a watch no longer wanted', async () => {
    const t = await setup({ settings: { anomaly: {} }, anomaly: failing });
    t.scheduler.start();
    await t.scheduler.tick();
    const [alert] = t.inApp();
    await t.settings.save({}, START + 1000);
    await t.scheduler.tick();
    const row = t.repos.notifications.rows.get(alert?.notificationId ?? '');
    expect(row?.state).toBe('final');
    expect(decodeMessage(row?.messageJson ?? null)?.summary).toBe('No longer checked.');
    expect(t.intervals.fns).toHaveLength(0);
    t.scheduler.stop();
  });

  it('survives a restart without repeating the alert', async () => {
    const t = await setup({ settings: { anomaly: {} }, anomaly: failing });
    await t.scheduler.tick();
    await t.clock.set(START + HOUR + 1000);
    await t.make().tick();
    expect(t.inApp()).toHaveLength(1);
  });
});

describe('on-demand digests (D-45)', () => {
  it('store their own in-app copy, even when empty', async () => {
    const t = await setup({
      channels: [{ id: A, name: 'phone', rules: DAILY }],
      digest: EMPTY_DAY,
    });
    const record = await t.repos.notificationChannels.get(A);
    if (record === null) throw new Error('no channel');
    const built = await t.scheduler.manualDigest(record);
    const id = await t.scheduler.storeManualCopy(built);
    expect(t.inApp().map((r) => r.notificationId)).toEqual([id]);
    expect(decodeMessage(t.inApp()[0]?.messageJson ?? null)?.report?.manual).toBe(true);
    // Asking twice for the same instant finds the same copy.
    expect(await t.scheduler.storeManualCopy(built)).toBe(id);
  });
});

describe('ReportService (D-45)', () => {
  it('reads one report and refuses a row that is not an in-app copy', async () => {
    const t = await setup({ channels: [{ id: A, name: 'phone', rules: DAILY }] });
    await t.scheduler.tick();
    await t.clock.set(NINE + 1000);
    await t.scheduler.tick();
    const [copy] = t.inApp();
    const detail = await t.service.get(copy?.notificationId ?? '');
    expect(detail.message.kind).toBe('digest.daily');
    expect(detail.report.channels.map((c) => c.channel_id)).toEqual([A]);
    await expect(t.service.get(t.copies()[0]?.notificationId ?? '')).rejects.toMatchObject({
      code: 'REPORT_NOT_FOUND',
    });
    await expect(t.service.get('n-unknown00000')).rejects.toMatchObject({
      code: 'REPORT_NOT_FOUND',
    });
  });

  it('filters the history by kind and period', async () => {
    const t = await setup({
      channels: [{ id: A, name: 'phone', rules: { ...DAILY, anomaly: {} } }],
      anomaly: failing,
    });
    await t.scheduler.tick();
    await t.clock.set(NINE + 1000);
    await t.scheduler.tick();
    const kinds = async (kind: readonly string[]) =>
      (await t.service.list({ limit: 10, kinds: kind })).items.map((i) => i.notification.kind);
    expect(await kinds(['digest.daily'])).toEqual(['digest.daily']);
    expect(await kinds(['report.anomaly'])).toEqual(['report.anomaly']);
    const since = await t.service.list({ limit: 10, since: NINE });
    expect(since.items.map((i) => i.notification.kind)).toEqual(['digest.daily']);
  });
});
