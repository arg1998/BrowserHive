/** @module test/notifications/act-buttons.sqlite.test — the whole act-button path per platform on SQLite against the fakes (spec 09, 03 §9.6, D-41, D-42): bus event → outbox → send with minted tokens → a press arrives over the platform's listener → the command runs as the chat actor → the request's revision → a silent edit that removes the buttons and names who answered; the press is audited once and a second press is refused. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { NotificationActionListeners } from '../../src/app/notifications/action-listeners.ts';
import {
  type ActionExecutor,
  NotificationActionService,
} from '../../src/app/notifications/actions.ts';
import { ChannelRegistry } from '../../src/app/notifications/channel-registry.ts';
import { NotificationService } from '../../src/app/notifications/notification-service.ts';
import { NotificationOutbox } from '../../src/app/notifications/outbox.ts';
import { attentionCreated, attentionResolved } from '../../src/app/notifications/test-fixtures.ts';
import { sha256Hex } from '../../src/domain/auth/digest.ts';
import {
  type CursorStore,
  channelFactories,
  DiscordGatewayHub,
  TelegramUpdatesHub,
} from '../../src/infra/notifications/index.ts';
import type { NotificationChannelRecord } from '../../src/ports/persistence/records.ts';
import { CollectingLogger } from '../helpers/collecting-logger.ts';
import { FakeIdGenerator } from '../helpers/fake-id-generator.ts';
import {
  FAKE_DISCORD,
  FAKE_DISCORD_BOT_TOKEN,
  FAKE_TG_TOKEN,
  FakePlatforms,
} from '../helpers/fake-platforms.ts';
import { RecordingEventBus } from '../helpers/recording-event-bus.ts';
import { sessionRecord } from '../persistence/helpers.ts';
import { openMemory, type TestDb } from '../persistence/setup.ts';
import { PUBLIC_LINKS, platformRecord, SAMPLE_IMAGES } from './helpers.ts';

let t: TestDb;
let fakes: FakePlatforms;
let stops: (() => void)[] = [];
beforeEach(async () => {
  t = await openMemory();
  await t.repos.sessions.insert(sessionRecord());
  fakes = new FakePlatforms().start();
  stops = [];
});
afterEach(async () => {
  for (const stop of stops) stop();
  await fakes.stop();
  await t.close();
});

async function until(check: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await Bun.sleep(5);
  }
}

async function wire(record: NotificationChannelRecord, env: Record<string, string>) {
  const bus = new RecordingEventBus<DomainEvents>();
  const logger = new CollectingLogger();
  const ids = new FakeIdGenerator();
  const cursors: CursorStore = {
    get: (key) => t.repos.notificationCursors.get(key),
    set: (key, value) => t.repos.notificationCursors.set(key, value, t.clock.now()),
  };
  const telegramUpdates = new TelegramUpdatesHub({
    apiBase: fakes.telegramBase,
    cursors,
    pollSeconds: 1,
    lingerMs: 0,
  });
  const discordGateway = new DiscordGatewayHub({
    apiBase: fakes.discordApi,
    random: () => 0.5,
    lingerMs: 0,
  });
  stops.push(
    () => telegramUpdates.stop(),
    () => discordGateway.stop(),
  );
  await t.repos.notificationChannels.upsert(record);
  const registry = new ChannelRegistry({
    repo: t.repos.notificationChannels,
    clock: t.clock,
    ids,
    logger,
    factories: channelFactories({
      images: SAMPLE_IMAGES,
      apiBases: { telegram: fakes.telegramBase, discord: fakes.discordApi },
      telegramUpdates,
      discordGateway,
      cursors,
    }),
    env: (name) => env[name],
  });
  await registry.load();
  let service: NotificationService | undefined;
  const actors: string[] = [];
  const executors = new Map<string, ActionExecutor>([
    [
      'attention.resolve',
      {
        scope: 'attention:resolve',
        async run(args, actor) {
          actors.push(actor);
          // What the broker publishes when the operator resolves the request.
          const event = attentionResolved(String(args['request_id']), 'resolved');
          const payload = event.payload as DomainEvents['attention.resolved'];
          await service?.produce({
            ...event,
            payload: { ...payload, request: { ...payload.request, resolved_by: actor } },
          } as typeof event);
          return 'Marked resolved.';
        },
      },
    ],
  ]);
  const actions = new NotificationActionService({
    repos: t.repos,
    registry,
    clock: t.clock,
    ids,
    logger,
    executors,
    bus,
  });
  const outbox = new NotificationOutbox({
    uow: t.uow,
    repos: t.repos,
    registry,
    links: PUBLIC_LINKS,
    clock: t.clock,
    logger,
    bus,
    actions,
  });
  service = new NotificationService({
    repo: t.repos.notifications,
    bus,
    clock: t.clock,
    ids,
    logger,
    uow: t.uow,
    outbox: { plan: (m, now) => outbox.plan(m, now), kick: () => undefined },
  });
  const listeners = new NotificationActionListeners({
    registry,
    handler: (press) => actions.press(press),
    logger,
  });
  listeners.start();
  stops.push(() => listeners.stop());
  const produce = service.produce.bind(service);
  return { outbox, produce, actions, actors, listeners, record };
}

const REQUEST = 'a-000000000001';

describe('act buttons end to end', () => {
  it('telegram: press a callback button, the request resolves, the edit removes the buttons', async () => {
    const w = await wire(
      platformRecord('telegram', {
        target: { chat_id: '-100123' },
        secretRefs: { token: 'BH_TG_TOKEN' },
        rules: { content: 'full', act_buttons: true, allow_list: ['42'] },
      }),
      { BH_TG_TOKEN: FAKE_TG_TOKEN },
    );
    await w.produce(attentionCreated(REQUEST, 'takeover', { reason: 'captcha' }));
    await w.outbox.tick();
    const send = fakes.of('telegram').find((r) => r.path === 'sendRichMessage');
    const keyboard = (
      (send?.json ?? {}) as {
        reply_markup: { inline_keyboard: { text: string; callback_data?: string }[][] };
      }
    ).reply_markup.inline_keyboard.flat();
    const resolve = keyboard.find((b) => b.text === 'Mark resolved')?.callback_data ?? '';
    expect(resolve).toMatch(/^bh1:[A-Za-z0-9_-]{11}$/);
    // The token was stored (hashed) before the send.
    expect(await t.repos.notificationActionTokens.get(sha256Hex(resolve.slice(4)))).not.toBeNull();
    fakes.updates.push({
      update_id: 900,
      callback_query: {
        id: 'cb900',
        from: { id: 42, first_name: 'Amir' },
        message: { message_id: 101, chat: { id: -100123, type: 'supergroup' } },
        data: resolve,
      },
    });
    await until(() => fakes.of('telegram').some((r) => r.path === 'answerCallbackQuery'));
    expect(w.actors).toEqual(['telegram:42']);
    expect(fakes.of('telegram').find((r) => r.path === 'answerCallbackQuery')?.json).toEqual({
      callback_query_id: 'cb900',
      text: 'Marked resolved.',
    });
    t.clock.advance(5_000);
    await w.outbox.tick();
    const edit = fakes.of('telegram').find((r) => r.path === 'editMessageText');
    const body = edit?.json as { rich_message: { html: string }; reply_markup: unknown };
    expect(body.rich_message.html).toContain('Resolved on Telegram by 42');
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
    const audit = await t.repos.notificationActions.list({});
    expect(audit.map((a) => [a.actor, a.outcome, a.actionLabel])).toEqual([
      ['telegram:42', 'done', 'Mark resolved'],
    ]);
    // The same button again (Telegram re-sends, or a second tap): refused, the command is not re-run.
    fakes.updates.push({
      update_id: 901,
      callback_query: {
        id: 'cb901',
        from: { id: 42 },
        message: { message_id: 101, chat: { id: -100123 } },
        data: resolve,
      },
    });
    await until(
      () => fakes.of('telegram').filter((r) => r.path === 'answerCallbackQuery').length === 2,
    );
    expect(w.actors).toHaveLength(1);
    expect((await t.repos.notificationActions.list({}))[0]?.outcome).toBe('used');
    expect(await t.repos.notificationCursors.get('telegram:1234')).toBe('902');
  });

  it('discord bot: press an interactive button over the gateway', async () => {
    const w = await wire(
      platformRecord('discord', {
        mode: 'bot',
        target: { channel_id: FAKE_DISCORD.channelId },
        secretRefs: { token: 'BH_DISCORD_BOT' },
        rules: { act_buttons: true, allow_list: [FAKE_DISCORD.userId] },
      }),
      { BH_DISCORD_BOT: FAKE_DISCORD_BOT_TOKEN },
    );
    await until(() => w.listeners.status(w.record.channelId)?.state === 'connected');
    await w.produce(attentionCreated(REQUEST, 'takeover'));
    await w.outbox.tick();
    const send = fakes
      .of('discord-bot')
      .find((r) => r.method === 'POST' && r.path.endsWith('/messages'));
    const buttons = (
      (send?.json ?? {}) as {
        components: { components: { label: string; custom_id?: string }[] }[];
      }
    ).components.flatMap((r) => r.components);
    const reject = buttons.find((b) => b.label === 'Reject')?.custom_id ?? '';
    expect(reject).toMatch(/^bh1:/);
    fakes.discordPress(reject);
    await until(() => fakes.of('discord-bot').some((r) => r.path.startsWith('/interactions/')));
    expect(w.actors).toEqual([`discord:${FAKE_DISCORD.userId}`]);
    t.clock.advance(5_000);
    await w.outbox.tick();
    const edit = fakes.of('discord-bot').find((r) => r.method === 'PATCH');
    expect(JSON.stringify(edit?.json)).toContain(`Resolved on Discord by ${FAKE_DISCORD.userId}`);
    expect(((edit?.json ?? {}) as { components: unknown[] }).components).toEqual([]);
    // A stranger's press is refused and audited with their id.
    fakes.discordPress(buttons.find((b) => b.label === 'Mark resolved')?.custom_id ?? '', {
      userId: '999999999999999999',
    });
    await until(
      () => fakes.of('discord-bot').filter((r) => r.path.startsWith('/interactions/')).length === 2,
    );
    expect((await t.repos.notificationActions.list({}))[0]?.outcome).toBe('stale');
  });

  it('ntfy: the phone posts the token to the reply topic', async () => {
    const w = await wire(
      platformRecord('ntfy', {
        target: { server: fakes.ntfyServer, topic: 'bh-alerts', reply_topic: 'bh-replies' },
        rules: { act_buttons: true },
      }),
      {},
    );
    await until(() => w.listeners.status(w.record.channelId)?.state === 'connected');
    await w.produce(attentionCreated(REQUEST, 'takeover'));
    await w.outbox.tick();
    const send = fakes.of('ntfy').find((r) => r.method === 'POST');
    const actions = (
      (send?.json ?? {}) as {
        actions: { action: string; label: string; body?: string; url: string }[];
      }
    ).actions;
    const resolve = actions.find((a) => a.label === 'Mark resolved');
    expect(resolve?.url).toBe(`${fakes.ntfyServer}/bh-replies`);
    fakes.ntfyPost('bh-replies', resolve?.body ?? '');
    await until(() => w.actors.length === 1);
    expect(w.actors).toEqual(['ntfy:topic-b']);
    t.clock.advance(5_000);
    await w.outbox.tick();
    const replaced = fakes.ntfyTopic('bh-alerts').at(-1);
    expect(replaced?.['sequence_id']).toBe(
      send && (send.json as { sequence_id: string }).sequence_id,
    );
    expect(String(replaced?.['message'])).toContain('Resolved from ntfy');
  });
});
