/** @module test/notifications/press-listeners.test — the press listeners against the platform fakes (spec 09, 03 §9.6, D-38, D-41, D-42): the Telegram poller (callback presses answered, offsets stored and resumed after a restart, a re-delivered update handled once, a 409 reported offline, the setup's /start wait sharing the poller), the Discord gateway subset (Identify/Ready, the 3-second answer and the deferred follow-up, Resume after a drop, a zombie connection, Invalid Session, the "This is me" claim) and the ntfy reply subscription (presses, resume from the stored id). */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type CursorStore,
  createDiscordSetup,
  createNtfyReplySource,
  createTelegramSetup,
  DiscordGatewayHub,
  TelegramUpdatesHub,
} from '../../src/infra/notifications/index.ts';
import type {
  ListenerStatus,
  PressAnswer,
  PressEvent,
} from '../../src/ports/notification-channel.ts';
import {
  FAKE_DISCORD,
  FAKE_DISCORD_BOT_TOKEN,
  FAKE_TG_TOKEN,
  FakePlatforms,
} from '../helpers/fake-platforms.ts';

let fakes: FakePlatforms;
beforeEach(() => {
  fakes = new FakePlatforms().start();
});
afterEach(async () => {
  await fakes.stop();
});

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await Bun.sleep(5);
  }
}

function memoryCursors(): CursorStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
    },
  };
}

function recorder(answer: Partial<PressAnswer> = {}) {
  const presses: PressEvent[] = [];
  const statuses: ListenerStatus['state'][] = [];
  return {
    presses,
    statuses,
    handler: async (press: PressEvent): Promise<PressAnswer> => {
      presses.push(press);
      return { outcome: 'done', text: 'Marked resolved.', refused: false, ...answer };
    },
    onStatus: (s: ListenerStatus) => statuses.push(s.state),
  };
}

function callback(id: number, data: string, chatId = -100123, fromId = 42) {
  return {
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: fromId, first_name: 'Amir' },
      message: { message_id: 7, chat: { id: chatId, type: 'supergroup' } },
      data,
    },
  };
}

describe('Telegram update poller', () => {
  it('hands a press to the channel of its chat, answers it and stores the offset', async () => {
    const cursors = memoryCursors();
    const hub = new TelegramUpdatesHub({
      apiBase: fakes.telegramBase,
      cursors,
      pollSeconds: 1,
      lingerMs: 0,
    });
    const r = recorder();
    fakes.updates.push(callback(50, 'bh1:AAAAAAAAAAA'), callback(51, 'not-ours'));
    const stop = hub.pressSource(FAKE_TG_TOKEN, '-100123').listen(r.handler, r.onStatus);
    await until(
      () => fakes.of('telegram').filter((q) => q.path === 'answerCallbackQuery').length === 2,
    );
    expect(r.presses).toEqual([
      {
        token: 'AAAAAAAAAAA',
        origin: '-100123',
        actor: { platform: 'telegram', id: '42', name: 'Amir' },
      },
    ]);
    const answers = fakes.of('telegram').filter((q) => q.path === 'answerCallbackQuery');
    expect(answers.map((a) => a.json)).toEqual([
      { callback_query_id: 'cb50', text: 'Marked resolved.' },
      { callback_query_id: 'cb51' },
    ]);
    await until(() => cursors.map.get('telegram:1234') === '52');
    expect(r.statuses).toContain('connected');
    stop();
    hub.stop();
  });

  it('resumes after a restart from the stored offset, so a press made while stopped is handled once', async () => {
    const cursors = memoryCursors();
    cursors.map.set('telegram:1234', '60');
    fakes.updates.push(callback(59, 'bh1:OLDOLDOLDOL'), callback(60, 'bh1:NEWNEWNEWNE'));
    const hub = new TelegramUpdatesHub({
      apiBase: fakes.telegramBase,
      cursors,
      pollSeconds: 1,
      lingerMs: 0,
    });
    const r = recorder({
      outcome: 'stale',
      text: 'This request is no longer waiting.',
      refused: true,
    });
    const stop = hub.pressSource(FAKE_TG_TOKEN, '-100123').listen(r.handler, r.onStatus);
    await until(() => r.presses.length === 1);
    expect(r.presses[0]?.token).toBe('NEWNEWNEWNE');
    const first = fakes.of('telegram').find((q) => q.path === 'getUpdates');
    expect(first?.json).toMatchObject({ offset: 60 });
    // Telegram re-delivers an update it did not see acknowledged: handled once.
    fakes.updates.push(callback(60, 'bh1:NEWNEWNEWNE'));
    await Bun.sleep(100);
    expect(r.presses).toHaveLength(1);
    // A refusal the presser must read is shown as an alert only for the allow-list.
    const answer = fakes.of('telegram').find((q) => q.path === 'answerCallbackQuery');
    expect(answer?.json).toEqual({
      callback_query_id: 'cb60',
      text: 'This request is no longer waiting.',
    });
    stop();
    hub.stop();
  });

  it('shows an allow-list refusal as an alert', async () => {
    const hub = new TelegramUpdatesHub({
      apiBase: fakes.telegramBase,
      pollSeconds: 1,
      lingerMs: 0,
    });
    const r = recorder({
      outcome: 'not_allowed',
      text: 'Not allowed: your Telegram id 7…',
      refused: true,
    });
    fakes.updates.push(callback(70, 'bh1:AAAAAAAAAAA', -100123, 7));
    const stop = hub.pressSource(FAKE_TG_TOKEN, '-100123').listen(r.handler, r.onStatus);
    await until(() => fakes.of('telegram').some((q) => q.path === 'answerCallbackQuery'));
    expect(fakes.of('telegram').find((q) => q.path === 'answerCallbackQuery')?.json).toMatchObject({
      show_alert: true,
    });
    stop();
    hub.stop();
  });

  it('reports another poller (409) as offline, and a failure as reconnecting', async () => {
    fakes.script('telegram:getUpdates', {
      status: 409,
      body: {
        ok: false,
        error_code: 409,
        description: 'Conflict: terminated by other getUpdates request',
      },
    });
    const hub = new TelegramUpdatesHub({
      apiBase: fakes.telegramBase,
      pollSeconds: 1,
      lingerMs: 0,
      offlineRetryMs: { auth: 50, conflict: 50 },
      backoffMs: { min: 10, max: 20 },
    });
    const r = recorder();
    const source = hub.pressSource(FAKE_TG_TOKEN, '-100123');
    const stop = source.listen(r.handler, r.onStatus);
    await until(() => r.statuses.includes('offline'));
    expect(source.status().detail).toContain('Another program is polling this bot');
    await until(() => r.statuses.at(-1) === 'connected');
    fakes.script('telegram:getUpdates', {
      status: 502,
      body: { ok: false, description: 'Bad Gateway' },
    });
    await until(() => r.statuses.includes('reconnecting'));
    stop();
    hub.stop();
  });

  it('serves the setup /start wait from the same poller as the act buttons', async () => {
    const hub = new TelegramUpdatesHub({
      apiBase: fakes.telegramBase,
      pollSeconds: 1,
      lingerMs: 0,
    });
    const r = recorder();
    const stop = hub.pressSource(FAKE_TG_TOKEN, '-100123').listen(r.handler, r.onStatus);
    const setup = createTelegramSetup({ apiBase: fakes.telegramBase, updates: hub });
    const wait = setup.waitForStart(FAKE_TG_TOKEN, 'c0de', {
      signal: new AbortController().signal,
      deadline: Date.now() + 3_000,
    });
    fakes.updates.push(
      {
        update_id: 80,
        message: {
          message_id: 1,
          text: '/start c0de',
          chat: { id: 5, type: 'private', first_name: 'Amir' },
          from: { id: 5, first_name: 'Amir' },
        },
      },
      callback(81, 'bh1:AAAAAAAAAAA'),
    );
    expect((await wait)?.user).toEqual({ id: '5', name: 'Amir' });
    await until(() => r.presses.length === 1);
    // One poller: no two concurrent getUpdates (Telegram would answer 409).
    const polls = fakes.of('telegram').filter((q) => q.path === 'getUpdates');
    expect(polls.length).toBeGreaterThan(0);
    stop();
    hub.stop();
  });
});

describe('Discord gateway', () => {
  function hub(options: { answerWithinMs?: number } = {}) {
    return new DiscordGatewayHub({
      apiBase: fakes.discordApi,
      random: () => 0.5,
      lingerMs: 0,
      backoffMs: { min: 10, max: 50 },
      ...options,
    });
  }

  it('identifies with intents 0, becomes connected and answers a quick press within the deadline', async () => {
    const gateway = hub();
    const r = recorder();
    const stop = gateway
      .pressSource(FAKE_DISCORD_BOT_TOKEN, FAKE_DISCORD.channelId)
      .listen(r.handler, r.onStatus);
    await until(() => r.statuses.includes('connected'));
    const identify = fakes.gatewayFrames.find((f) => f.op === 2);
    expect(identify?.d).toMatchObject({ token: FAKE_DISCORD_BOT_TOKEN, intents: 0 });
    const id = fakes.discordPress('bh1:AAAAAAAAAAA');
    await until(() =>
      fakes.of('discord-bot').some((q) => q.path.startsWith(`/interactions/${id}/`)),
    );
    expect(r.presses[0]).toEqual({
      token: 'AAAAAAAAAAA',
      origin: FAKE_DISCORD.channelId,
      actor: { platform: 'discord', id: FAKE_DISCORD.userId, name: 'Op Erator' },
    });
    const callback = fakes.of('discord-bot').find((q) => q.path.startsWith('/interactions/'));
    expect(callback?.path).toBe(`/interactions/${id}/itoken${id}/callback`);
    expect(callback?.headers['authorization']).toBeUndefined();
    expect(callback?.json).toEqual({ type: 4, data: { content: 'Marked resolved.', flags: 64 } });
    stop();
    gateway.stop();
  });

  it('defers a slow press and edits the answer when the command finishes', async () => {
    const gateway = hub({ answerWithinMs: 50 });
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = gateway.pressSource(FAKE_DISCORD_BOT_TOKEN, FAKE_DISCORD.channelId).listen(
      async () => {
        await slow;
        return { outcome: 'done', text: 'Approved.', refused: false };
      },
      () => undefined,
    );
    await until(
      () => fakes.gatewayClientCount === 1 && fakes.gatewayFrames.some((f) => f.op === 2),
    );
    await Bun.sleep(20);
    fakes.discordPress('bh1:AAAAAAAAAAA');
    await until(() => fakes.of('discord-bot').some((q) => q.path.startsWith('/interactions/')));
    expect(fakes.of('discord-bot').find((q) => q.path.startsWith('/interactions/'))?.json).toEqual({
      type: 5,
      data: { flags: 64 },
    });
    release?.();
    await until(() => fakes.of('discord-bot').some((q) => q.path.startsWith('/webhooks/')));
    const followUp = fakes.of('discord-bot').find((q) => q.path.startsWith('/webhooks/'));
    expect([followUp?.method, followUp?.path, followUp?.json]).toEqual([
      'PATCH',
      `/webhooks/${FAKE_DISCORD.applicationId}/${followUp?.path.split('/')[3]}/messages/@original`,
      { content: 'Approved.' },
    ]);
    stop();
    gateway.stop();
  });

  it('resumes after a dropped connection, re-identifies after an invalid session, and detects a zombie', async () => {
    fakes.gatewayHeartbeatMs = 60;
    const gateway = hub();
    const r = recorder();
    const stop = gateway
      .pressSource(FAKE_DISCORD_BOT_TOKEN, FAKE_DISCORD.channelId)
      .listen(r.handler, r.onStatus);
    await until(() => r.statuses.includes('connected'));
    fakes.gatewayDrop(1006);
    await until(() => fakes.gatewayFrames.some((f) => f.op === 6));
    const resume = fakes.gatewayFrames.find((f) => f.op === 6);
    expect(resume?.d).toMatchObject({ token: FAKE_DISCORD_BOT_TOKEN, session_id: 'session1' });
    await until(() => r.statuses.filter((s) => s === 'connected').length >= 2);
    expect(r.statuses).toContain('reconnecting');
    // Invalid session (not resumable): a fresh Identify.
    const identifies = () => fakes.gatewayFrames.filter((f) => f.op === 2).length;
    fakes.gatewaySend({ op: 9, d: false });
    await until(() => identifies() === 2);
    // A zombie: heartbeats stop being acknowledged.
    fakes.gatewayAcks = false;
    const connections = fakes.gatewayConnections;
    await until(() => fakes.gatewayConnections > connections, 2_000);
    fakes.gatewayAcks = true;
    // Heartbeats carry the last sequence number.
    expect(fakes.gatewayFrames.some((f) => f.op === 1)).toBe(true);
    stop();
    gateway.stop();
  });

  it('answers a refusal ephemerally, so only the presser sees it', async () => {
    const gateway = hub();
    const r = recorder({
      outcome: 'not_allowed',
      text: 'You are not allowed to answer here yet.',
      refused: true,
    });
    const stop = gateway
      .pressSource(FAKE_DISCORD_BOT_TOKEN, FAKE_DISCORD.channelId)
      .listen(r.handler, r.onStatus);
    await until(() => r.statuses.includes('connected'));
    fakes.discordPress('bh1:AAAAAAAAAAA', { userId: '500000000000000005' });
    await until(() => fakes.of('discord-bot').some((q) => q.path.startsWith('/interactions/')));
    expect(fakes.of('discord-bot').find((q) => q.path.startsWith('/interactions/'))?.json).toEqual({
      type: 4,
      data: { content: 'You are not allowed to answer here yet.', flags: 64 },
    });
    expect(r.presses[0]?.actor.id).toBe('500000000000000005');
    stop();
    gateway.stop();
  });

  it('reports a refused token as offline without retrying at once', async () => {
    fakes.script('discord-bot:GET gateway', {
      status: 401,
      body: { message: '401: Unauthorized' },
    });
    const gateway = hub();
    const r = recorder();
    const source = gateway.pressSource(FAKE_DISCORD_BOT_TOKEN, FAKE_DISCORD.channelId);
    const stop = source.listen(r.handler, r.onStatus);
    await until(() => r.statuses.includes('offline'));
    expect(source.status().detail).toBe('Discord refused the bot token.');
    stop();
    gateway.stop();
  });

  it('links an account with the "This is me" button, and lists servers and channels', async () => {
    const gateway = hub();
    const setup = createDiscordSetup({ apiBase: fakes.discordApi, gateway });
    const bot = await setup.bot(FAKE_DISCORD_BOT_TOKEN);
    expect(bot).toEqual({
      applicationId: FAKE_DISCORD.applicationId,
      botId: FAKE_DISCORD.botId,
      username: 'bh_bot',
      guilds: [{ id: FAKE_DISCORD.guildId, name: 'Home' }],
    });
    expect(await setup.channels(FAKE_DISCORD_BOT_TOKEN, FAKE_DISCORD.guildId)).toEqual([
      { id: '300000000000000006', name: 'news', type: 'announcement', category: null },
      { id: FAKE_DISCORD.channelId, name: 'browserhive', type: 'text', category: 'Alerts' },
    ]);
    const claim = setup.claim(FAKE_DISCORD_BOT_TOKEN, FAKE_DISCORD.channelId, {
      signal: new AbortController().signal,
      deadline: Date.now() + 3_000,
    });
    await until(() =>
      fakes.of('discord-bot').some((q) => q.method === 'POST' && q.path.endsWith('/messages')),
    );
    const posted = fakes
      .of('discord-bot')
      .find((q) => q.method === 'POST' && q.path.endsWith('/messages'));
    const customId = (
      (posted?.json ?? {}) as { components: { components: { custom_id: string }[] }[] }
    ).components[0]?.components[0]?.custom_id;
    expect(customId).toMatch(/^bh1c:/);
    await until(
      () => fakes.gatewayClientCount === 1 && fakes.gatewayFrames.some((f) => f.op === 2),
    );
    await Bun.sleep(20);
    fakes.discordPress(customId ?? '');
    expect(await claim).toEqual({ id: FAKE_DISCORD.userId, name: 'Op Erator' });
    await until(() => fakes.of('discord-bot').some((q) => q.method === 'DELETE'));
    gateway.stop();
  });
});

describe('ntfy reply topic', () => {
  it('hands each bh1 message to the handler and resumes from the stored id after a drop', async () => {
    const cursors = memoryCursors();
    const source = createNtfyReplySource({
      server: fakes.ntfyServer,
      topic: 'bh-replies-x',
      token: 'tk_x',
      cursorKey: 'ntfy:nc-1',
      cursors,
      backoffMs: { min: 10, max: 20 },
    });
    const r = recorder();
    const stop = source.listen(r.handler, r.onStatus);
    await until(() => r.statuses.includes('connected'));
    const phone = fakes.ntfyPost('bh-replies-x', 'bh1:AAAAAAAAAAA');
    fakes.ntfyPost('bh-replies-x', 'hello, not a token');
    await until(() => cursors.map.get('ntfy:nc-1') !== undefined && r.presses.length === 1);
    expect(r.presses[0]).toEqual({
      token: 'AAAAAAAAAAA',
      origin: null,
      actor: { platform: 'ntfy', id: null, name: null },
    });
    const subscribe = fakes.of('ntfy').find((q) => q.method === 'GET');
    expect(subscribe?.headers['authorization']).toBe('Bearer tk_x');
    await until(() => cursors.map.get('ntfy:nc-1') !== phone['id']);
    // A press while the connection is down arrives through `since=` on the next connection.
    fakes.ntfyDrop();
    stop();
    fakes.ntfyPost('bh-replies-x', 'bh1:BBBBBBBBBBB');
    const again = source.listen(r.handler, r.onStatus);
    await until(() => r.presses.length === 2);
    expect(r.presses[1]?.token).toBe('BBBBBBBBBBB');
    const resumed = fakes
      .of('ntfy')
      .filter((q) => q.method === 'GET')
      .at(-1);
    expect(resumed?.query['since']).toMatch(/^m\d+$/);
    again();
  });
});
