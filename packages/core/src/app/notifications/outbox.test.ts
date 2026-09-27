/** @module app/notifications/outbox.test — the delivery outbox state machine on a fake clock with a scripted channel (D-34, D-35, spec 03 §9.4): enqueue in the notification's transaction, zero-channel cost, send/edit/delete, coalescing, edit spacing, retries, dead jobs, the breaker and the degradation-loop cut, message_gone, backlog collapse, crash recovery, the TTL sweep. */

import { describe, expect, it } from 'bun:test';
import type { NotificationChannelRules } from '@browserhive/contracts/notifications';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { capabilities, channelRecord, FakeChannel } from '../../../test/helpers/fake-channel.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { type ChannelCapabilities, ChannelSendError } from '../../ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../../ports/persistence/records.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { ManualIntervals } from '../maintenance/test-support.ts';
import { ChannelRegistry } from './channel-registry.ts';
import { createLocalLinkBuilder } from './links.ts';
import { buildMessage, encodeMessage } from './message.ts';
import { NotificationService } from './notification-service.ts';
import { NotificationOutbox, type OutboxOptions } from './outbox.ts';
import { attentionCreated, attentionResolved, toolCalled } from './test-fixtures.ts';

interface SetupOptions {
  readonly channels?: readonly NotificationChannelRecord[];
  readonly caps?: ChannelCapabilities;
  readonly rules?: NotificationChannelRules;
  readonly options?: Partial<OutboxOptions>;
  readonly noFactory?: boolean;
  /** Let the service kick the worker after each commit (default: tests drive every pass). */
  readonly kick?: boolean;
}

async function setup(opts: SetupOptions = {}) {
  const clock = new FakeClock();
  const repos = new InMemoryRepositories();
  const uow = new InMemoryUnitOfWork(repos);
  const bus = new RecordingEventBus<DomainEvents>();
  const logger = new CollectingLogger();
  const ids = new FakeIdGenerator();
  const fake = new FakeChannel('nc-000000000001', opts.caps ?? capabilities());
  const channels = opts.channels ?? [channelRecord({ rules: opts.rules ?? {} })];
  for (const c of channels) await repos.notificationChannels.upsert(c);
  const registry = new ChannelRegistry({
    repo: repos.notificationChannels,
    clock,
    ids,
    logger,
    ...(opts.noFactory !== true && { factories: new Map([['fake', () => fake]]) }),
  });
  await registry.load();
  const counted: { channel_kind: string; status: string }[] = [];
  const intervals = new ManualIntervals();
  const outbox = new NotificationOutbox({
    uow,
    repos,
    registry,
    links: createLocalLinkBuilder(() => 'http://127.0.0.1:9876'),
    clock,
    logger,
    bus,
    scheduler: intervals,
    jitter: () => 0.5,
    counter: { add: (_n, attributes) => void counted.push({ ...attributes }) },
    ...(opts.options !== undefined && { options: opts.options }),
  });
  const service = new NotificationService({
    repo: repos.notifications,
    bus,
    clock,
    ids,
    logger,
    uow,
    outbox:
      opts.kick === true
        ? outbox
        : { plan: (message, now) => outbox.plan(message, now), kick: () => undefined },
  });
  service.start();
  const deliveries = () => repos.notificationDeliveries.rows;
  const statuses = () => deliveries().map((d) => [d.op, d.revision, d.status, d.reason]);
  return {
    clock,
    repos,
    bus,
    logger,
    fake,
    registry,
    outbox,
    service,
    intervals,
    counted,
    deliveries,
    statuses,
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Produces an attention request through the bus and waits for the service. */
async function attention(t: Ctx, id = 'a-000000000001') {
  t.bus.publish(
    'attention.created',
    attentionCreated(id, 'takeover').payload as DomainEvents['attention.created'],
  );
  await t.service.idle();
}

async function resolve(t: Ctx, id = 'a-000000000001') {
  t.bus.publish(
    'attention.resolved',
    attentionResolved(id, 'resolved').payload as DomainEvents['attention.resolved'],
  );
  await t.service.idle();
}

describe('enqueue', () => {
  it('writes the send job with the notification; zero channels write nothing and arm no timer', async () => {
    const t = await setup();
    await attention(t);
    expect(t.statuses()).toEqual([['send', 1, 'pending', null]]);
    const none = await setup({ channels: [] });
    none.outbox.start();
    await attention(none);
    expect(none.deliveries()).toEqual([]);
    expect(none.intervals.fns).toHaveLength(0);
    expect(await none.outbox.tick()).toEqual({ processed: 0, deletesEnqueued: 0, collapsed: 0 });
    expect(none.repos.notifications.rows.size).toBe(1);
  });

  it('a commit kicks the worker, and a tick joins the running pass', async () => {
    const t = await setup({ kick: true });
    await attention(t);
    await t.outbox.tick();
    expect(t.statuses()).toEqual([['send', 1, 'sent', null]]);
    expect(t.fake.calls).toHaveLength(1);
  });

  it('arms the timer only while a channel exists and stops it', async () => {
    const t = await setup();
    t.outbox.start();
    expect(t.intervals.fns).toHaveLength(1);
    t.outbox.stop();
    expect(t.intervals.fns).toHaveLength(0);
  });

  it('suppresses with a reason where a channel is paused or has no adapter', async () => {
    const paused = await setup({ channels: [channelRecord({ status: 'paused' })] });
    await attention(paused);
    expect(paused.statuses()).toEqual([['send', 1, 'suppressed', 'channel_paused']]);
    const bare = await setup({ noFactory: true });
    await attention(bare);
    expect(bare.statuses()).toEqual([['send', 1, 'suppressed', 'no_adapter']]);
  });
});

describe('send and edit', () => {
  it('sends the degraded message and records the platform message', async () => {
    const t = await setup();
    await attention(t);
    await t.outbox.tick();
    expect(t.fake.ops('send')).toHaveLength(1);
    const delivered = t.fake.ops('send')[0]?.delivery;
    // actButtons is false on the fake: act buttons became their open fallback, links are absolute.
    expect(delivered?.message.actions.every((a) => a.kind === 'open')).toBe(true);
    expect(delivered?.links.url('/x')).toBe('http://127.0.0.1:9876/x');
    expect(delivered?.message.privacy.level).toBe('titles');
    expect(t.statuses()).toEqual([['send', 1, 'sent', null]]);
    const cm = await t.repos.notificationChannelMessages.get(
      'nc-000000000001',
      delivered?.message.id ?? '',
    );
    expect(cm).toMatchObject({ lastRevision: 1, messageRef: { message_id: 1 }, expiresAt: null });
    expect(t.counted).toEqual([{ channel_kind: 'fake', status: 'sent' }]);
    expect((await t.repos.notificationChannels.get('nc-000000000001'))?.lastOkAt).toBe(
      t.clock.now(),
    );
  });

  it('edits in place on a revision, at most once per 3 s, silently and without buttons', async () => {
    const t = await setup();
    await attention(t);
    await t.outbox.tick();
    await resolve(t);
    expect(t.statuses().at(-1)).toEqual(['edit', 2, 'pending', null]);
    await t.outbox.tick();
    expect(t.fake.ops('edit')).toHaveLength(0); // deferred: the message was updated < 3 s ago
    await t.clock.advance(3_000);
    await t.outbox.tick();
    const edit = t.fake.ops('edit')[0];
    expect(edit?.ref).toEqual({ message_id: 1 });
    expect(edit?.delivery?.message).toMatchObject({
      revision: 2,
      state: 'resolved',
      alert: false,
      actions: [],
    });
    expect(t.statuses()).toEqual([
      ['send', 1, 'sent', null],
      ['edit', 2, 'sent', null],
    ]);
  });

  it('coalesces: a send that runs after a revision sends the latest state and supersedes the edit', async () => {
    const t = await setup();
    await attention(t);
    await resolve(t);
    await t.outbox.tick();
    expect(t.fake.calls.map((c) => c.op)).toEqual(['send']);
    expect(t.fake.ops('send')[0]?.delivery?.message).toMatchObject({
      revision: 2,
      state: 'resolved',
    });
    expect(t.statuses()).toEqual([
      ['send', 1, 'sent', null],
      ['edit', 2, 'superseded', 'covered'],
    ]);
  });

  it('grows a tool-error group as edits of one message', async () => {
    const t = await setup();
    await t.service.produce(toolCalled(1, { ok: false }));
    await t.outbox.tick();
    await t.clock.advance(4_000);
    await t.service.produce(toolCalled(2, { ok: false }));
    await t.service.produce(toolCalled(3, { ok: false }));
    await t.outbox.tick();
    expect(t.fake.calls.map((c) => c.op)).toEqual(['send', 'edit']);
    expect(t.fake.ops('edit')[0]?.delivery?.message.title).toBe('shop · 3 tool errors');
    // The older edit job rendered the current state (3 errors), which covers the newer one.
    expect(t.statuses()).toEqual([
      ['send', 1, 'sent', null],
      ['edit', 2, 'sent', null],
      ['edit', 3, 'superseded', 'covered'],
    ]);
  });

  it('a message deleted in the chat supersedes the edit and later ones, without counting a failure', async () => {
    const t = await setup();
    await attention(t);
    await t.outbox.tick();
    await t.clock.advance(3_000);
    t.fake.script(new ChannelSendError('message_gone', 'message to edit not found'));
    await resolve(t);
    await t.outbox.tick();
    expect(t.statuses().at(-1)).toEqual(['edit', 2, 'superseded', 'message_gone']);
    const cm = [...t.repos.notificationChannelMessages.rows.values()][0];
    expect(cm?.deletedAt).not.toBeNull();
    expect((await t.repos.notificationChannels.get('nc-000000000001'))?.failureCount).toBe(0);
  });

  it('replies in the thread where the platform supports it', async () => {
    const t = await setup();
    await t.service.produce(toolCalled(1, { ok: false }));
    await t.outbox.tick();
    const first = [...t.repos.notifications.rows.values()][0];
    if (first === undefined) throw new Error('no row');
    await t.repos.notifications.markRead(first.notificationId, t.clock.now());
    await t.service.produce(toolCalled(2, { ok: false })); // a read group starts a new row, same thread
    await t.outbox.tick();
    expect(t.fake.ops('send')[1]?.delivery?.replyTo).toEqual({ message_id: 1 });
  });
});

describe('failures', () => {
  it('retries with exponential backoff and honours retry_after', async () => {
    const t = await setup();
    t.fake.script(
      new Error('socket hang up'),
      new ChannelSendError('rate_limited', 'slow down', { retryAfterMs: 7_000 }),
    );
    await attention(t);
    const start = t.clock.now();
    await t.outbox.tick();
    expect(t.deliveries()[0]).toMatchObject({
      status: 'retrying',
      attempts: 1,
      nextAttemptAt: start + 1_000,
      reason: 'unavailable',
    });
    await t.clock.advance(1_000);
    await t.outbox.tick();
    expect(t.deliveries()[0]).toMatchObject({
      status: 'retrying',
      attempts: 2,
      nextAttemptAt: start + 1_000 + 7_000,
    });
    await t.clock.advance(6_999);
    await t.outbox.tick();
    expect(t.fake.calls).toHaveLength(2);
    await t.clock.advance(1);
    await t.outbox.tick();
    expect(t.deliveries()[0]).toMatchObject({ status: 'sent', attempts: 3 });
    expect(t.counted.map((c) => c.status)).toEqual(['retrying', 'retrying', 'sent']);
  });

  it('is dead after 8 attempts', async () => {
    const t = await setup({ options: { breakerThreshold: 100 } });
    t.fake.script(...Array.from({ length: 8 }, () => new Error('down')));
    await attention(t);
    for (let i = 0; i < 8; i++) {
      await t.outbox.tick();
      await t.clock.advance(20 * 60_000);
    }
    expect(t.deliveries()[0]).toMatchObject({
      status: 'dead',
      reason: 'max_attempts',
      attempts: 8,
    });
    expect(t.fake.calls).toHaveLength(8);
  });

  it('is dead once 24 h old, and at once when not retryable', async () => {
    const t = await setup();
    t.fake.script(new Error('down'), new Error('down'));
    await attention(t);
    await t.outbox.tick();
    await t.clock.advance(24 * 3_600_000);
    await t.outbox.tick();
    expect(t.deliveries()[0]).toMatchObject({ status: 'dead', reason: 'expired' });
    const auth = await setup();
    auth.fake.script(new ChannelSendError('auth', 'Unauthorized'));
    await attention(auth);
    await auth.outbox.tick();
    expect(auth.deliveries()[0]).toMatchObject({ status: 'dead', reason: 'auth', attempts: 1 });
    expect(auth.deliveries()[0]?.lastError).toBe('auth: Unauthorized');
  });

  it('recovers jobs a crash left sending', async () => {
    const t = await setup();
    await attention(t);
    const job = t.deliveries()[0];
    if (job === undefined) throw new Error('no job');
    expect(await t.repos.notificationDeliveries.claim(job.seq, t.clock.now())).toBe(true);
    expect(await t.outbox.tick()).toMatchObject({ processed: 0 });
    expect(await t.outbox.recover()).toBe(1);
    await t.outbox.tick();
    expect(t.deliveries()[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('opens the breaker after 5 consecutive failures: broken, in-app notice, no degradation, no loop', async () => {
    const t = await setup();
    t.fake.script(...Array.from({ length: 5 }, () => new Error('down')));
    await attention(t);
    for (let i = 0; i < 5; i++) {
      await t.outbox.tick();
      await t.clock.advance(20 * 60_000);
    }
    await t.service.idle();
    expect((await t.repos.notificationChannels.get('nc-000000000001'))?.status).toBe('broken');
    expect(t.registry.get('nc-000000000001')?.record.status).toBe('broken');
    expect(t.deliveries()[0]).toMatchObject({ status: 'suppressed', reason: 'channel_paused' });
    const changed = t.bus.published.filter((p) => p.name === 'notification.channel.changed');
    expect(changed).toHaveLength(1);
    // The in-app notice exists and was never enqueued for the (or any) external channel.
    const notice = [...t.repos.notifications.rows.values()].find(
      (r) => r.kind === 'channel.broken',
    );
    expect(notice?.title).toBe('Notification channel phone is failing');
    expect(t.deliveries().some((d) => d.notificationId === notice?.notificationId)).toBe(false);
    // Structural cut: nothing was reported as a degradation.
    expect(t.bus.names().filter((n) => n === 'system.degraded')).toEqual([]);
    expect(t.repos.systemEvents.rows).toEqual([]);
    // Later notifications are logged as suppressed while the channel is broken.
    await attention(t, 'a-000000000002');
    expect(t.statuses().at(-1)).toEqual(['send', 1, 'suppressed', 'channel_paused']);
    await t.outbox.tick();
    expect(t.fake.calls).toHaveLength(5);
  });
});

describe('backlog', () => {
  it('collapses more than 20 pending info sends into the newest with a note', async () => {
    const t = await setup();
    for (let i = 1; i <= 22; i++) {
      const id = `n-${String(i).padStart(12, '0')}`;
      const message = buildMessage({
        id,
        revision: 1,
        thread: `session:s${i}`,
        kind: 'session.finished',
        severity: 'info',
        state: 'final',
        alert: true,
        createdAt: i,
        updatedAt: i,
        title: `Session ${i} finished`,
        summary: '',
        blocks: [],
        actions: [],
        entities: {},
      });
      await t.repos.notifications.insert({
        notificationId: id,
        principalId: null,
        type: 'lifecycle',
        title: message.title,
        body: null,
        sessionId: null,
        target: null,
        sourceEventId: null,
        createdAt: i,
        updatedAt: i,
        count: 1,
        groupKey: null,
        readAt: null,
        dismissedAt: null,
        kind: 'session.finished',
        category: 'wrap-ups',
        severity: 'info',
        state: 'final',
        revision: 1,
        thread: message.thread,
        messageJson: encodeMessage(message),
      });
      await t.repos.notificationDeliveries.enqueue(t.outbox.plan(message, t.clock.now()));
    }
    const pass = await t.outbox.tick();
    expect(pass?.collapsed).toBe(21);
    expect(t.fake.ops('send')).toHaveLength(1);
    const sent = t.fake.ops('send')[0]?.delivery?.message;
    expect(sent?.title).toBe('Session 22 finished');
    expect(JSON.stringify(sent?.blocks)).toContain('You missed 21 earlier notifications');
    expect(t.deliveries().filter((d) => d.reason === 'collapsed')).toHaveLength(21);
  });
});

describe('TTL', () => {
  it('deletes a message when its TTL is due and logs a late delete', async () => {
    const t = await setup({ rules: { ttl_ms: { 'needs-you': 60_000 } } });
    await attention(t);
    await t.outbox.tick();
    const cm = [...t.repos.notificationChannelMessages.rows.values()][0];
    expect(cm?.expiresAt).toBe(t.clock.now() + 60_000);
    await t.clock.advance(59_999);
    await t.outbox.tick();
    expect(t.fake.ops('delete')).toHaveLength(0);
    await t.clock.advance(3 * 60_000); // BrowserHive was busy (or off): the delete is late
    const pass = await t.outbox.tick();
    expect(pass?.deletesEnqueued).toBe(1);
    expect(t.fake.ops('delete')[0]?.ref).toEqual({ message_id: 1 });
    expect([...t.repos.notificationChannelMessages.rows.values()][0]?.deletedAt).not.toBeNull();
    expect(t.statuses().at(-1)).toEqual(['delete', 1, 'sent', null]);
    expect(t.logger.records.some((r) => r.msg === 'late message delete')).toBe(true);
    await t.outbox.tick();
    expect(t.fake.ops('delete')).toHaveLength(1); // never enqueued twice
  });

  it('deletes when resolved where the category opts in', async () => {
    const t = await setup({ rules: { delete_when_resolved: { 'needs-you': true } } });
    await attention(t);
    await t.outbox.tick();
    await t.clock.advance(3_000);
    await resolve(t);
    await t.outbox.tick(); // the edit sets expires_at = now
    await t.outbox.tick(); // the sweep deletes it
    expect(t.fake.calls.map((c) => c.op)).toEqual(['send', 'edit', 'delete']);
  });

  it('cannot delete past the platform window (Telegram 48 h) or without delete support', async () => {
    const old = await setup({
      rules: { ttl_ms: { 'needs-you': 72 * 3_600_000 } },
      caps: capabilities({ deleteWindowMs: 48 * 3_600_000 }),
    });
    await attention(old);
    await old.outbox.tick();
    await old.clock.advance(72 * 3_600_000);
    await old.outbox.tick();
    expect(old.fake.ops('delete')).toHaveLength(0);
    expect(old.statuses().at(-1)).toEqual(['delete', 1, 'dead', 'could_not_delete: too_old']);
    const platform = await setup({ rules: { ttl_ms: { 'needs-you': 1_000 } } });
    platform.fake.script('ok', new ChannelSendError('too_old', "message can't be deleted"));
    await attention(platform);
    await platform.outbox.tick();
    await platform.clock.advance(1_000);
    await platform.outbox.tick();
    expect(platform.statuses().at(-1)).toEqual(['delete', 1, 'dead', 'could_not_delete: too_old']);
    expect((await platform.repos.notificationChannels.get('nc-000000000001'))?.failureCount).toBe(
      0,
    );
    const none = await setup({
      rules: { ttl_ms: { 'needs-you': 1_000 } },
      caps: capabilities({ delete: false }),
    });
    await attention(none);
    await none.outbox.tick();
    await none.clock.advance(1_000);
    await none.outbox.tick();
    expect(none.statuses().at(-1)).toEqual(['delete', 1, 'suppressed', 'delete_unsupported']);
  });
});
