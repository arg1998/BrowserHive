/** @module app/notifications/actions.test — act buttons (spec 03 §9.6, D-41): minting stores only hashes before the call; a press is checked (unknown, wrong channel or chat, disabled, used, expired, stale, not on the allow-list) and run through the executor with the chat actor, audited once, published, and answered; concurrent presses run once; the audit pages newest first. */

import { describe, expect, it } from 'bun:test';
import { ACTION_TOKEN_TTL_MS } from '@browserhive/contracts/notifications';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { capabilities, channelRecord, FakeChannel } from '../../../test/helpers/fake-channel.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { sha256Hex } from '../../domain/auth/digest.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { PressEvent } from '../../ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../../ports/persistence/records.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { type ActionExecutor, actorOf, NotificationActionService } from './actions.ts';
import { ChannelRegistry } from './channel-registry.ts';
import { decodeMessage } from './message.ts';
import { NotificationService } from './notification-service.ts';
import { attentionCreated, vaultConfirmCreated } from './test-fixtures.ts';

const CHAT = '-1001';

interface Options {
  readonly channel?: Partial<NotificationChannelRecord>;
  readonly executor?: ActionExecutor['run'];
}

async function setup(opts: Options = {}) {
  const clock = new FakeClock();
  const repos = new InMemoryRepositories();
  const uow = new InMemoryUnitOfWork(repos);
  const bus = new RecordingEventBus<DomainEvents>();
  const logger = new CollectingLogger();
  const ids = new FakeIdGenerator();
  const record = channelRecord({
    kind: 'telegram',
    target: { chat_id: CHAT },
    rules: { act_buttons: true, allow_list: ['42'] },
    ...opts.channel,
  });
  await repos.notificationChannels.upsert(record);
  const fake = new FakeChannel(
    record.channelId,
    capabilities({ actButtons: true }),
    'phone',
    'telegram',
  );
  const registry = new ChannelRegistry({
    repo: repos.notificationChannels,
    clock,
    ids,
    logger,
    factories: new Map([['telegram', () => fake]]),
  });
  await registry.load();
  const runs: { args: unknown; actor: string }[] = [];
  const executors = new Map<string, ActionExecutor>([
    [
      'attention.resolve',
      {
        scope: 'attention:resolve',
        run:
          opts.executor ??
          (async (args, actor) => {
            runs.push({ args, actor });
            return args['decision'] === 'reject' ? 'Rejected.' : 'Marked resolved.';
          }),
      },
    ],
  ]);
  const counted: { channel_kind: string; outcome: string }[] = [];
  const actions = new NotificationActionService({
    repos,
    registry,
    clock,
    ids,
    logger,
    executors,
    bus,
    counter: { add: (_n, a) => void counted.push({ ...a }) },
  });
  const notifications = new NotificationService({
    repo: repos.notifications,
    bus,
    clock,
    ids,
    logger,
    uow,
  });
  await notifications.produce(attentionCreated('a-000000000001', 'takeover'));
  const row = [...repos.notifications.rows.values()][0];
  const message = decodeMessage(row?.messageJson ?? null);
  if (row === undefined || message === null) throw new Error('no notification');
  const tokens = await actions.mint(record.channelId, message, clock.now());
  const token = (actionId: string) => (tokens.get(actionId) ?? '').slice('bh1:'.length);
  const press = (actionId: string, overrides: Partial<PressEvent> = {}) =>
    actions.press({
      token: token(actionId),
      origin: CHAT,
      actor: { platform: 'telegram', id: '42', name: 'Amir' },
      ...overrides,
    });
  return {
    logger,
    clock,
    repos,
    bus,
    registry,
    actions,
    notifications,
    row,
    message,
    tokens,
    token,
    press,
    runs,
    counted,
  };
}

describe('mint', () => {
  it('writes one hashed token per act action before the call, bound to the command', async () => {
    const t = await setup();
    expect([...t.tokens.keys()]).toEqual(['resolve', 'reject']);
    for (const payload of t.tokens.values()) expect(payload).toMatch(/^bh1:[A-Za-z0-9_-]{11}$/);
    const rows = [...t.repos.notificationActionTokens.rows.values()];
    expect(rows.map((r) => [r.actionId, r.op, r.args['decision']])).toEqual([
      ['resolve', 'attention.resolve', 'resolve'],
      ['reject', 'attention.resolve', 'reject'],
    ]);
    // Only the hash is stored.
    expect(rows[0]?.tokenHash).toBe(sha256Hex(t.token('resolve')));
    expect(JSON.stringify(rows)).not.toContain(t.token('resolve'));
    expect(rows[0]?.expiresAt).toBe((rows[0]?.createdAt ?? 0) + ACTION_TOKEN_TTL_MS);
  });

  it('mints fresh tokens on every call (only hashes exist to re-use)', async () => {
    const t = await setup();
    const again = await t.actions.mint('nc-000000000001', t.message, t.clock.now());
    expect(again.get('resolve')).not.toBe(t.tokens.get('resolve'));
    expect(t.repos.notificationActionTokens.rows.size).toBe(4);
  });
});

describe('press', () => {
  it('runs the command as the chat actor, audits once, publishes and answers', async () => {
    const t = await setup();
    const answer = await t.press('reject');
    expect(answer).toEqual({ outcome: 'done', text: 'Rejected.', refused: false });
    expect(t.runs).toEqual([
      { args: { request_id: 'a-000000000001', decision: 'reject' }, actor: 'telegram:42' },
    ]);
    const [audit] = t.repos.notificationActions.rows;
    expect(audit).toMatchObject({
      channelName: 'phone',
      channelKind: 'telegram',
      notificationId: t.row.notificationId,
      actionId: 'reject',
      actionLabel: 'Reject',
      op: 'attention.resolve',
      actor: 'telegram:42',
      actorName: 'Amir',
      outcome: 'done',
    });
    const published = t.bus.published.filter((e) => e.name === 'action.recorded');
    expect(published).toHaveLength(1);
    expect(JSON.stringify(published)).not.toContain(t.token('reject'));
    expect(t.counted).toEqual([{ channel_kind: 'telegram', outcome: 'done' }]);
  });

  it('is single use, also for two presses at once', async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.press('resolve'), t.press('resolve')]);
    expect([a.outcome, b.outcome].sort()).toEqual(['done', 'used']);
    expect(t.runs).toHaveLength(1);
    expect((await t.press('resolve')).outcome).toBe('used');
  });

  it('answers an unknown token without auditing it', async () => {
    const t = await setup();
    const answer = await t.actions.press({
      token: 'zzzzzzzzzzz',
      origin: CHAT,
      actor: { platform: 'telegram', id: '42', name: null },
    });
    expect(answer).toEqual({
      outcome: 'unknown',
      text: 'This button is no longer valid.',
      refused: true,
    });
    expect(t.repos.notificationActions.rows).toHaveLength(0);
    expect(t.counted).toEqual([{ channel_kind: 'telegram', outcome: 'unknown' }]);
  });

  it('refuses a press from another chat or platform', async () => {
    const t = await setup();
    expect((await t.press('resolve', { origin: '-999' })).outcome).toBe('wrong_channel');
    expect(
      (await t.press('resolve', { actor: { platform: 'discord', id: '42', name: null } })).outcome,
    ).toBe('wrong_channel');
    expect(t.runs).toHaveLength(0);
    // The refusals did not use the token.
    expect((await t.press('resolve')).outcome).toBe('done');
  });

  it('refuses a presser who is not on the allow-list, naming their id', async () => {
    const t = await setup();
    const answer = await t.press('resolve', {
      actor: { platform: 'telegram', id: '7', name: 'Stranger' },
    });
    expect(answer.outcome).toBe('not_allowed');
    expect(answer.text).toContain('7');
    expect(t.repos.notificationActions.rows[0]).toMatchObject({
      actor: 'telegram:7',
      outcome: 'not_allowed',
    });
    const empty = await setup({ channel: { rules: { act_buttons: true } } });
    expect((await empty.press('resolve')).outcome).toBe('not_allowed');
  });

  it('refuses while act buttons are off or the channel is paused', async () => {
    const off = await setup({ channel: { rules: { allow_list: ['42'] } } });
    expect((await off.press('resolve')).outcome).toBe('disabled');
    const paused = await setup({ channel: { status: 'paused' } });
    expect((await paused.press('resolve')).outcome).toBe('disabled');
  });

  it('refuses an expired token and a notification that is no longer open', async () => {
    const t = await setup();
    await t.clock.advance(ACTION_TOKEN_TTL_MS + 1);
    expect((await t.press('resolve')).outcome).toBe('expired');
    const s = await setup();
    await s.repos.notifications.revise(s.row.notificationId, {
      state: 'resolved',
      severity: 'warn',
      revision: 2,
      messageJson: s.row.messageJson,
    });
    const answer = await s.press('resolve');
    expect(answer).toMatchObject({ outcome: 'stale', text: 'This request is no longer waiting.' });
    expect(s.runs).toHaveLength(0);
  });

  it('reports a request settled meanwhile as stale and any other failure as failed', async () => {
    const stale = await setup({
      executor: async () => {
        throw new AppError('ATTENTION_NOT_OPEN', { request_id: 'a', status: 'resolved' });
      },
    });
    expect((await stale.press('resolve')).outcome).toBe('stale');
    const broken = await setup({
      executor: async () => {
        throw new Error('database is locked');
      },
    });
    const answer = await broken.press('resolve');
    expect(answer.outcome).toBe('failed');
    expect(answer.text).toContain('database is locked');
    expect(broken.repos.notificationActions.rows[0]?.outcome).toBe('failed');
  });

  it('refuses an op no producer offers (no executor)', async () => {
    const t = await setup();
    await t.notifications.produce(vaultConfirmCreated('a-000000000009', 'github'));
    const row = [...t.repos.notifications.rows.values()].find((r) => r.kind === 'vault.confirm');
    const message = decodeMessage(row?.messageJson ?? null);
    if (message === null) throw new Error('no vault message');
    const tokens = await t.actions.mint('nc-000000000001', message, t.clock.now());
    const answer = await t.actions.press({
      token: (tokens.get('approve') ?? '').slice(4),
      origin: CHAT,
      actor: { platform: 'telegram', id: '42', name: null },
    });
    expect(answer.outcome).toBe('failed');
    expect(answer.text).toContain('cannot be answered from a chat');
  });
});

describe('secrets', () => {
  it('never writes a token to a log line, the audit, a bus event or a delivery', async () => {
    const t = await setup();
    await t.press('resolve', { actor: { platform: 'telegram', id: '7', name: null } });
    await t.press('resolve');
    await t.press('resolve');
    await t.actions.press({
      token: 'zzzzzzzzzzz',
      origin: CHAT,
      actor: { platform: 'telegram', id: '42', name: null },
    });
    const sinks = JSON.stringify([
      t.logger.records,
      t.repos.notificationActions.rows,
      t.bus.published,
      t.repos.notificationDeliveries.rows,
      [...t.repos.notifications.rows.values()],
    ]);
    for (const payload of t.tokens.values()) {
      expect(sinks).not.toContain(payload.slice(4));
    }
    expect(sinks).not.toContain('zzzzzzzzzzz');
  });
});

describe('list', () => {
  it('pages the audit newest first with the notification title', async () => {
    const t = await setup();
    await t.press('resolve', { actor: { platform: 'telegram', id: '7', name: null } });
    await t.press('resolve', { origin: '-5' });
    await t.press('resolve');
    const first = await t.actions.list({ limit: 2 });
    expect(first.items.map((a) => a.outcome)).toEqual(['done', 'wrong_channel']);
    expect(first.items[0]?.notification_title).toBe('Attention requested');
    expect(first.nextCursor).not.toBeNull();
    const second = await t.actions.list({ limit: 2, cursor: first.nextCursor ?? '' });
    expect(second.items.map((a) => a.outcome)).toEqual(['not_allowed']);
    expect(second.nextCursor).toBeNull();
    const filtered = await t.actions.list({ limit: 10, outcomes: ['not_allowed'] });
    expect(filtered.items).toHaveLength(1);
  });
});

describe('actorOf', () => {
  it('names the platform and the user, or the ntfy reply topic', () => {
    expect(actorOf({ platform: 'telegram', id: '42', name: null })).toBe('telegram:42');
    expect(actorOf({ platform: 'discord', id: '9', name: 'x' })).toBe('discord:9');
    expect(actorOf({ platform: 'ntfy', id: null, name: null })).toBe('ntfy:topic-b');
  });
});
