/** @module test/notifications/adapters.test — every platform adapter against the `Bun.serve` fakes (spec 09 §3.2): send, edit, delete, screenshots, and the classification of 429, 5xx, timeouts, auth failures and vanished messages; no secret in any error. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  callPlatform,
  createDiscordChannel,
  createNtfyChannel,
  createTelegramChannel,
  createWebhookChannel,
  DISCORD_WEBHOOK_CAPABILITIES,
  NTFY_CAPABILITIES,
  TELEGRAM_CAPABILITIES,
  telegramAcceptsUrl,
  telegramRenderer,
  WEBHOOK_CAPABILITIES,
} from '../../src/infra/notifications/index.ts';
import { ChannelSendError } from '../../src/ports/notification-channel.ts';
import {
  FAKE_DISCORD,
  FAKE_DISCORD_BOT_TOKEN,
  FAKE_DISCORD_TOKEN,
  FAKE_TG_TOKEN,
  FakePlatforms,
} from '../helpers/fake-platforms.ts';
import { delivery, LOCAL_LINKS, platformRecord, SAMPLE_IMAGES } from './helpers.ts';

let fakes: FakePlatforms;
beforeEach(() => {
  fakes = new FakePlatforms().start();
});
afterEach(async () => {
  await fakes.stop();
});

function required<T>(fn: T | undefined): T {
  if (fn === undefined) throw new Error('the adapter lacks this method');
  return fn;
}

async function failure(promise: Promise<unknown>): Promise<ChannelSendError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ChannelSendError) return err;
    throw err;
  }
  throw new Error('expected a ChannelSendError');
}

function telegram(overrides = {}) {
  return createTelegramChannel(
    platformRecord('telegram', { target: { chat_id: '-100123' }, ...overrides }),
    {
      token: FAKE_TG_TOKEN,
      images: SAMPLE_IMAGES,
      apiBase: fakes.telegramBase,
    },
  );
}

describe('telegram', () => {
  const richOf = (req: { json: unknown; form: Record<string, string> | null } | undefined) => {
    const raw =
      ((req?.json ?? {}) as { rich_message?: unknown } | null)?.rich_message ??
      req?.form?.['rich_message'];
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      html: string;
      media?: { id: string; media: { type: string; media: string } }[];
      skip_entity_detection?: boolean;
    };
  };

  it('sends a Rich Message with an inline keyboard and returns the ref', async () => {
    const channel = telegram();
    const { ref } = await channel.send(delivery('attention', TELEGRAM_CAPABILITIES));
    expect(ref).toEqual({ chat_id: -100123, message_id: 101, photo: 0, rich: 1 });
    const [req] = fakes.of('telegram');
    expect(req?.path).toBe('sendRichMessage');
    expect(req?.json).toMatchObject({ chat_id: '-100123', disable_notification: false });
    const rich = richOf(req);
    expect(rich.html.startsWith('<h3>⚠️ Attention requested</h3>')).toBe(true);
    expect(rich.html).toContain('<table compact>');
    expect(rich.skip_entity_detection).toBe(true);
    expect(rich.media).toBeUndefined();
    const body = req?.json as { reply_markup: { inline_keyboard: { url: string }[][] } };
    expect(body.reply_markup.inline_keyboard.flat().map((b) => b.url)).toContain(
      'https://bh.example.net/sessions/checkout-a1b2c3d4?live=1&takeover=1',
    );
  });

  it('sends a screenshot as a media block and edits it again by its file id', async () => {
    const channel = telegram();
    const { ref } = await channel.send(
      delivery('attention', TELEGRAM_CAPABILITIES, { image: 'masked' }),
    );
    expect(ref).toMatchObject({ photo: 1, rich: 1, photo_file_id: 'rp-large' });
    const [send] = fakes.of('telegram');
    expect(send?.path).toBe('sendRichMessage');
    expect(send?.files).toEqual([
      { field: 'shot', name: 'screenshot.jpg', type: 'image/jpeg', size: 8 },
    ]);
    const rich = richOf(send);
    expect(rich.html).toContain('<img src="tg://photo?id=shot"/>');
    expect(rich.media).toEqual([{ id: 'shot', media: { type: 'photo', media: 'attach://shot' } }]);
    await channel.edit?.(
      ref,
      delivery('attention-resolved', TELEGRAM_CAPABILITIES, { image: 'masked' }),
    );
    const edit = fakes.of('telegram')[1];
    expect(edit?.path).toBe('editMessageText');
    expect(edit?.files).toEqual([]);
    expect(edit?.json).toMatchObject({ chat_id: -100123, message_id: 101 });
    expect(richOf(edit).media).toEqual([
      { id: 'shot', media: { type: 'photo', media: 'rp-large' } },
    ]);
    expect(((edit?.json ?? {}) as { reply_markup: unknown } | undefined)?.reply_markup).toEqual({
      inline_keyboard: [],
    });
  });

  it('sends the message without its screenshot when the image is gone', async () => {
    const channel = createTelegramChannel(
      platformRecord('telegram', { target: { chat_id: '1' } }),
      {
        token: FAKE_TG_TOKEN,
        images: { read: async () => null },
        apiBase: fakes.telegramBase,
      },
    );
    const { ref } = await channel.send(
      delivery('attention', TELEGRAM_CAPABILITIES, { image: 'masked' }),
    );
    const [req] = fakes.of('telegram');
    expect(req?.path).toBe('sendRichMessage');
    expect(richOf(req).html).not.toContain('tg://photo');
    expect(ref['photo']).toBe(0);
  });

  it('falls back to classic HTML when Telegram refuses the Rich Message, and stays classic after a 404', async () => {
    const channel = telegram();
    fakes.script('telegram:sendRichMessage', {
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" },
    });
    const first = await channel.send(delivery('attention', TELEGRAM_CAPABILITIES));
    expect(first.ref).toMatchObject({ rich: 0, photo: 0 });
    expect(fakes.of('telegram').map((r) => r.path)).toEqual(['sendRichMessage', 'sendMessage']);
    const classic = fakes.of('telegram')[1]?.json as { text: string; parse_mode: string };
    expect(classic.parse_mode).toBe('HTML');
    expect(classic.text).toContain('<b>Attention requested</b>');
    // A content refusal is per message: the next send tries a Rich Message again.
    await channel.send(delivery('crash', TELEGRAM_CAPABILITIES));
    expect(fakes.of('telegram')[2]?.path).toBe('sendRichMessage');
    // A server without the method (404) keeps the channel classic.
    fakes.script('telegram:sendRichMessage', {
      status: 404,
      body: { ok: false, error_code: 404, description: 'Not Found' },
    });
    await channel.send(delivery('crash', TELEGRAM_CAPABILITIES));
    await channel.send(delivery('test', TELEGRAM_CAPABILITIES));
    expect(
      fakes
        .of('telegram')
        .map((r) => r.path)
        .slice(3),
    ).toEqual(['sendRichMessage', 'sendMessage', 'sendMessage']);
  });

  it('edits a message in the format it was sent in, and falls back when a rich edit is refused', async () => {
    const channel = telegram();
    await channel.edit?.(
      { chat_id: 1, message_id: 9, photo: 1 },
      delivery('attention-resolved', TELEGRAM_CAPABILITIES),
    );
    expect(fakes.of('telegram')[0]?.path).toBe('editMessageCaption');
    fakes.script('telegram:editMessageText', {
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: rich message is invalid' },
    });
    const { ref } = await required(channel.edit)(
      { chat_id: 1, message_id: 10, photo: 1, rich: 1, photo_file_id: 'rp-large' },
      delivery('attention-resolved', TELEGRAM_CAPABILITIES),
    );
    const [rich, classic] = fakes.of('telegram').slice(1);
    expect(richOf(rich).html).toContain('Attention requested');
    expect(classic?.path).toBe('editMessageText');
    expect(classic?.json).toMatchObject({ parse_mode: 'HTML', message_id: 10 });
    expect(ref).toMatchObject({ rich: 0, photo: 0 });
  });

  it('draws act buttons as styled callback buttons carrying the minted tokens', async () => {
    const channel = telegram({ rules: { act_buttons: true } });
    expect(channel.capabilities.actButtons).toBe(true);
    const d = delivery('attention', channel.capabilities);
    await channel.send({
      ...d,
      actTokens: new Map([
        ['resolve', 'bh1:AAAAAAAAAAA'],
        ['reject', 'bh1:BBBBBBBBBBB'],
      ]),
    });
    const body = fakes.of('telegram')[0]?.json as {
      reply_markup: {
        inline_keyboard: { text: string; callback_data?: string; style?: string }[][];
      };
    };
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons.find((b) => b.text === 'Mark resolved')).toEqual({
      text: 'Mark resolved',
      callback_data: 'bh1:AAAAAAAAAAA',
    });
    expect(buttons.find((b) => b.text === 'Reject')).toEqual({
      text: 'Reject',
      callback_data: 'bh1:BBBBBBBBBBB',
      style: 'danger',
    });
    expect(buttons.find((b) => b.text === 'Take over')?.style).toBe('primary');
    // A delivery without the tokens is refused rather than sent with dead buttons.
    const refused = await failure(channel.send(d));
    expect(refused.code).toBe('rejected');
  });

  it('edits text, treats "not modified" as done, and replies within a thread', async () => {
    const channel = telegram({ target: { chat_id: '-100123', thread_id: '7' } });
    await channel.send(
      delivery('crash', TELEGRAM_CAPABILITIES, { replyTo: { chat_id: 1, message_id: 55 } }),
    );
    expect(fakes.of('telegram')[0]?.json).toMatchObject({
      message_thread_id: 7,
      reply_parameters: { message_id: 55, allow_sending_without_reply: true },
    });
    fakes.script('telegram:editMessageText', {
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: message is not modified' },
    });
    const ref = { chat_id: 1, message_id: 9, photo: 0 };
    expect(await channel.edit?.(ref, delivery('crash', TELEGRAM_CAPABILITIES))).toEqual({ ref });
  });

  it('classifies vanished, too old, rate limited, auth and 5xx failures', async () => {
    const channel = telegram();
    const ref = { chat_id: 1, message_id: 9, photo: 0, rich: 1 };
    fakes.script('telegram:editMessageText', {
      status: 400,
      body: { ok: false, description: 'Bad Request: message to edit not found' },
    });
    expect(
      (await failure(required(channel.edit)(ref, delivery('crash', TELEGRAM_CAPABILITIES)))).code,
    ).toBe('message_gone');
    fakes.script('telegram:deleteMessage', {
      status: 400,
      body: { ok: false, description: "Bad Request: message can't be deleted for everyone" },
    });
    expect((await failure(required(channel.delete)(ref))).code).toBe('too_old');
    fakes.script('telegram:sendRichMessage', {
      status: 429,
      body: {
        ok: false,
        description: 'Too Many Requests: retry after 7',
        parameters: { retry_after: 7 },
      },
    });
    const limited = await failure(channel.send(delivery('crash', TELEGRAM_CAPABILITIES)));
    expect([limited.code, limited.retryAfterMs, limited.retryable]).toEqual([
      'rate_limited',
      7000,
      true,
    ]);
    fakes.script('telegram:sendRichMessage', {
      status: 401,
      body: { ok: false, description: 'Unauthorized' },
    });
    const auth = await failure(channel.send(delivery('crash', TELEGRAM_CAPABILITIES)));
    expect([auth.code, auth.retryable]).toEqual(['auth', false]);
    expect(auth.message).not.toContain(FAKE_TG_TOKEN);
    fakes.script('telegram:sendRichMessage', {
      status: 502,
      body: { ok: false, description: 'Bad Gateway' },
    });
    expect((await failure(channel.send(delivery('crash', TELEGRAM_CAPABILITIES)))).code).toBe(
      'unavailable',
    );
  });

  it('puts links in the text instead of buttons without a public address', async () => {
    await telegram().send(delivery('test', TELEGRAM_CAPABILITIES, { links: LOCAL_LINKS }));
    const req = fakes.of('telegram')[0];
    expect(((req?.json ?? {}) as { reply_markup?: unknown }).reply_markup).toBeUndefined();
    const html = richOf(req).html;
    expect(html).toContain('Open on this computer');
    expect(html).toContain('<code>http://127.0.0.1:9876/notifications/channels</code>');
  });
});

describe('discord (webhook mode)', () => {
  const discord = () =>
    createDiscordChannel(platformRecord('discord'), {
      webhookUrl: fakes.discordWebhook,
      images: SAMPLE_IMAGES,
    });

  it('sends one embed with link buttons and waits for the message id', async () => {
    const { ref } = await discord().send(delivery('tool-errors', DISCORD_WEBHOOK_CAPABILITIES));
    const [req] = fakes.of('discord');
    expect(req?.query).toEqual({ wait: 'true', with_components: 'true' });
    const body = req?.json as {
      embeds: { title: string; color: number }[];
      components: unknown[];
      allowed_mentions: unknown;
    };
    expect(body.embeds[0]?.title).toContain('checkout · 3 tool errors');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.components).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: 'Open errors',
            url: 'https://bh.example.net/sessions/checkout-a1b2c3d4?kinds=tool&errors_only=1',
          },
        ],
      },
    ]);
    expect(ref).toEqual({ message_id: '101', channel_id: '42' });
  });

  it('uploads a screenshot and keeps it when editing', async () => {
    const channel = discord();
    const { ref } = await channel.send(
      delivery('attention', DISCORD_WEBHOOK_CAPABILITIES, { image: 'masked' }),
    );
    const [send] = fakes.of('discord');
    expect(send?.files.map((f) => f.field)).toEqual(['files[0]']);
    expect(
      ((send?.json ?? {}) as { embeds: { image: { url: string } }[] } | undefined)?.embeds[0]?.image
        .url,
    ).toBe('attachment://screenshot.jpg');
    expect(ref['attachment_id']).toBe('900101');
    await channel.edit?.(
      ref,
      delivery('attention-resolved', DISCORD_WEBHOOK_CAPABILITIES, { image: 'masked' }),
    );
    const edit = fakes.of('discord')[1];
    expect([edit?.method, edit?.path]).toEqual(['PATCH', 'messages/101']);
    expect(((edit?.json ?? {}) as { attachments: unknown } | undefined)?.attachments).toEqual([
      { id: '900101' },
    ]);
  });

  it('classifies a deleted message, a deleted webhook and rate limits', async () => {
    const channel = discord();
    fakes.script('discord:PATCH', {
      status: 404,
      body: { code: 10008, message: 'Unknown Message' },
    });
    const gone = await failure(
      required(channel.edit)({ message_id: '5' }, delivery('crash', DISCORD_WEBHOOK_CAPABILITIES)),
    );
    expect(gone.code).toBe('message_gone');
    fakes.script('discord:POST', {
      status: 404,
      body: { code: 10015, message: 'Unknown Webhook' },
    });
    const auth = await failure(channel.send(delivery('crash', DISCORD_WEBHOOK_CAPABILITIES)));
    expect(auth.code).toBe('auth');
    fakes.script('discord:POST', {
      status: 429,
      body: { message: 'You are being rate limited.', retry_after: 1.25, global: false },
    });
    const limited = await failure(channel.send(delivery('crash', DISCORD_WEBHOOK_CAPABILITIES)));
    expect([limited.code, limited.retryAfterMs]).toEqual(['rate_limited', 1250]);
    expect(limited.message).not.toContain(FAKE_DISCORD_TOKEN);
    await channel.delete?.({ message_id: '5' });
    expect(fakes.of('discord').at(-1)?.method).toBe('DELETE');
  });

  it('refuses a bot-mode channel without its token or channel', () => {
    expect(() =>
      createDiscordChannel(platformRecord('discord', { mode: 'bot' }), {
        images: SAMPLE_IMAGES,
      }),
    ).toThrow(/bot token/);
    expect(() =>
      createDiscordChannel(platformRecord('discord', { mode: 'bot' }), {
        botToken: FAKE_DISCORD_BOT_TOKEN,
        images: SAMPLE_IMAGES,
      }),
    ).toThrow(/names no Discord channel/);
  });
});

describe('discord (bot mode)', () => {
  const bot = (rules = {}) =>
    createDiscordChannel(
      platformRecord('discord', {
        mode: 'bot',
        target: { channel_id: FAKE_DISCORD.channelId, guild_id: FAKE_DISCORD.guildId },
        rules,
      }),
      { botToken: FAKE_DISCORD_BOT_TOKEN, images: SAMPLE_IMAGES, apiBase: fakes.discordApi },
    );

  it('sends through the bot API with interactive act buttons, edits and deletes', async () => {
    const channel = bot({ act_buttons: true });
    expect(channel.capabilities.actButtons).toBe(true);
    const d = delivery('attention', channel.capabilities, { image: 'masked' });
    const { ref } = await channel.send({
      ...d,
      actTokens: new Map([
        ['resolve', 'bh1:AAAAAAAAAAA'],
        ['reject', 'bh1:BBBBBBBBBBB'],
      ]),
    });
    const [send] = fakes.of('discord-bot');
    expect([send?.method, send?.path]).toEqual([
      'POST',
      `/channels/${FAKE_DISCORD.channelId}/messages`,
    ]);
    expect(send?.headers['authorization']).toBe(`Bot ${FAKE_DISCORD_BOT_TOKEN}`);
    expect(send?.files.map((f) => f.field)).toEqual(['files[0]']);
    const buttons = (
      (send?.json ?? {}) as {
        components: { components: { custom_id?: string; style: number; label: string }[] }[];
      }
    ).components.flatMap((row) => row.components);
    expect(buttons.filter((b) => b.custom_id !== undefined)).toEqual([
      { type: 2, style: 2, label: 'Mark resolved', custom_id: 'bh1:AAAAAAAAAAA' },
      { type: 2, style: 4, label: 'Reject', custom_id: 'bh1:BBBBBBBBBBB' },
    ] as never);
    expect(ref['attachment_id']).toBeDefined();
    await channel.edit?.(
      ref,
      delivery('attention-resolved', channel.capabilities, { image: 'masked' }),
    );
    const edit = fakes.of('discord-bot')[1];
    expect([edit?.method, edit?.path]).toEqual([
      'PATCH',
      `/channels/${FAKE_DISCORD.channelId}/messages/${ref['message_id']}`,
    ]);
    expect(((edit?.json ?? {}) as { components: unknown[] }).components).toEqual([]);
    await channel.delete?.(ref);
    const del = fakes.of('discord-bot')[2];
    expect([del?.method, del?.path]).toEqual([
      'DELETE',
      `/channels/${FAKE_DISCORD.channelId}/messages/${ref['message_id']}`,
    ]);
  });

  it('names the field of an Invalid Form Body', async () => {
    fakes.script('discord-bot:POST channels', {
      status: 400,
      body: {
        message: 'Invalid Form Body',
        code: 50035,
        errors: {
          components: {
            '0': {
              components: {
                '1': { custom_id: { _errors: [{ code: 'X', message: 'Duplicate custom_id' }] } },
              },
            },
          },
        },
      },
    });
    const err = await failure(bot().send(delivery('crash', DISCORD_WEBHOOK_CAPABILITIES)));
    expect(err.message).toBe(
      'Discord 400: Invalid Form Body (components.0.components.1.custom_id: Duplicate custom_id)',
    );
  });

  it('keeps act buttons as links while they are off, and never leaks the bot token', async () => {
    const channel = bot();
    expect(channel.capabilities.actButtons).toBe(false);
    expect(channel.presses).toBeUndefined();
    fakes.script('discord-bot:POST channels', {
      status: 401,
      body: { message: `401: Unauthorized ${FAKE_DISCORD_BOT_TOKEN}`, code: 0 },
    });
    const err = await failure(channel.send(delivery('attention', channel.capabilities)));
    expect(err.code).toBe('auth');
    expect(err.message).not.toContain(FAKE_DISCORD_BOT_TOKEN);
  });
});

describe('telegram button URLs', () => {
  it('accepts domains and IPv4, refuses dotless hosts and IPv6 literals (Bot API behaviour)', () => {
    expect(telegramAcceptsUrl('https://bh.example.net/x')).toBe(true);
    expect(telegramAcceptsUrl('http://100.101.102.103:9876/x')).toBe(true);
    expect(telegramAcceptsUrl('http://127.0.0.1:9876/x')).toBe(true);
    expect(telegramAcceptsUrl('http://localhost:9876/x')).toBe(false);
    expect(telegramAcceptsUrl('http://mybox:9876/x')).toBe(false);
    expect(telegramAcceptsUrl('http://[::1]:9876/x')).toBe(false);
  });

  it('puts links in the text when publicUrl is a host Telegram refuses', () => {
    const links = { local: false, url: (path: string) => `http://localhost:9876${path}` };
    const [request] = telegramRenderer.render(
      { ...delivery('test', TELEGRAM_CAPABILITIES), links },
      { mode: null, target: { chat_id: '1' }, op: 'send', ref: null, actToken: () => 'x' },
    );
    expect(request?.body['reply_markup']).toBeUndefined();
    expect(JSON.stringify(request?.body['rich_message'])).toContain('🔗 Links');
  });
});

describe('ntfy', () => {
  const ntfy = (overrides = {}, token: string | null = null, topic: string | null = null) =>
    createNtfyChannel(
      platformRecord('ntfy', {
        target: { server: fakes.ntfyServer, topic: 'bh-alerts' },
        ...overrides,
      }),
      { token, topic, images: SAMPLE_IMAGES },
    );

  it('publishes JSON with the notification id as sequence id and replaces it on edit', async () => {
    const channel = ntfy();
    const { ref } = await channel.send(delivery('attention', NTFY_CAPABILITIES));
    const [send] = fakes.of('ntfy');
    expect(send?.json).toMatchObject({
      topic: 'bh-alerts',
      title: 'Attention requested',
      priority: 4,
      tags: ['warning'],
      markdown: false,
      sequence_id: 'n-sample000001',
    });
    expect(((send?.json ?? {}) as { actions: unknown[] } | undefined)?.actions).toHaveLength(2);
    expect(ref['sequence_id']).toBe('n-sample000001');
    await channel.edit?.(ref, delivery('attention-resolved', NTFY_CAPABILITIES));
    expect(fakes.of('ntfy')[1]?.json).toMatchObject({
      sequence_id: 'n-sample000001',
      priority: 2,
      tags: ['white_check_mark'],
    });
    await channel.delete?.(ref);
    expect([fakes.of('ntfy')[2]?.method, fakes.of('ntfy')[2]?.path]).toEqual([
      'DELETE',
      '/bh-alerts/n-sample000001',
    ]);
  });

  it('uploads a screenshot with the fields as query parameters and sends the token', async () => {
    const channel = ntfy({}, 'tk_x', null);
    await channel.send(delivery('attention', NTFY_CAPABILITIES, { image: 'unmasked' }));
    const [put] = fakes.of('ntfy');
    expect([put?.method, put?.path, put?.bytes]).toEqual(['PUT', '/bh-alerts/n-sample000001', 8]);
    expect(put?.query['filename']).toBe('screenshot.jpg');
    expect(JSON.parse(put?.query['actions'] ?? '[]')).toHaveLength(2);
    expect(put?.headers['authorization']).toBe('Bearer tk_x');
  });

  it('falls back to the text when the server refuses attachments (self-hosted, no cache)', async () => {
    fakes.script('ntfy:PUT', {
      status: 400,
      body: { code: 40014, http: 400, error: 'invalid request: attachments not allowed' },
    });
    const channel = ntfy();
    const { ref } = await channel.send(
      delivery('attention', NTFY_CAPABILITIES, { image: 'unmasked' }),
    );
    const [put, post] = fakes.of('ntfy');
    expect(put?.method).toBe('PUT');
    expect([post?.method, post?.path]).toEqual(['POST', '/']);
    expect(post?.json).toMatchObject({
      sequence_id: 'n-sample000001',
      title: 'Attention requested',
    });
    expect(ref['sequence_id']).toBe('n-sample000001');
  });

  it('reads the topic from a variable and never stores it in the ref', async () => {
    const channel = ntfy({ target: { server: fakes.ntfyServer } }, null, 'secret-topic-x');
    const { ref } = await channel.send(delivery('crash', NTFY_CAPABILITIES));
    expect(fakes.of('ntfy')[0]?.json).toMatchObject({ topic: 'secret-topic-x' });
    expect(JSON.stringify(ref)).not.toContain('secret-topic-x');
  });

  it('labels the first action "Open on this computer" without a public address', async () => {
    await ntfy().send(delivery('test', NTFY_CAPABILITIES, { links: LOCAL_LINKS }));
    const body = fakes.of('ntfy')[0]?.json as { actions: { label: string }[] };
    expect(body.actions[0]?.label).toBe('Open on this computer');
  });
  it('turns act buttons into http actions that post the token to the reply topic', async () => {
    const channel = createNtfyChannel(
      platformRecord('ntfy', {
        target: { server: fakes.ntfyServer, topic: 'bh-alerts' },
        secretRefs: { reply_topic: 'BH_REPLY' },
        rules: { act_buttons: true },
      }),
      { token: null, topic: null, replyTopic: 'bh-replies-x', images: SAMPLE_IMAGES },
    );
    expect(channel.capabilities.actButtons).toBe(true);
    expect(channel.presses).toBeDefined();
    const d = delivery('vault-confirm', channel.capabilities);
    await channel.send({
      ...d,
      actTokens: new Map([
        ['approve', 'bh1:AAAAAAAAAAA'],
        ['deny', 'bh1:BBBBBBBBBBB'],
      ]),
    });
    const body = fakes.of('ntfy')[0]?.json as {
      actions: { action: string; label: string; url: string; body?: string; clear: boolean }[];
      click?: string;
    };
    expect(body.actions).toEqual([
      {
        action: 'http',
        label: 'Approve',
        url: `${fakes.ntfyServer}/bh-replies-x`,
        method: 'POST',
        body: 'bh1:AAAAAAAAAAA',
        clear: true,
      },
      {
        action: 'http',
        label: 'Deny',
        url: `${fakes.ntfyServer}/bh-replies-x`,
        method: 'POST',
        body: 'bh1:BBBBBBBBBBB',
        clear: true,
      },
      {
        action: 'view',
        label: 'Review',
        url: 'https://bh.example.net/vault?tab=confirm',
        clear: false,
      },
    ] as never);
    expect(body.click).toBe('https://bh.example.net/vault?tab=confirm');
  });
});

describe('generic webhook', () => {
  it('posts the signed contract', async () => {
    const channel = createWebhookChannel(
      platformRecord('webhook', { target: { url: fakes.webhookUrl } }),
      {
        url: null,
        secret: 'k'.repeat(24),
        now: () => 1_790_000_000_500,
      },
    );
    await channel.send(delivery('attention', WEBHOOK_CAPABILITIES));
    const [req] = fakes.of('webhook');
    const body = req?.json as Record<string, unknown>;
    expect(body).toMatchObject({
      schema: 1,
      event: 'notification',
      op: 'send',
      delivered_at: 1_790_000_000_500,
      channel: { id: 'nc-000000000009', name: 'my-webhook' },
      local_links: false,
    });
    expect((body['message'] as { id: string }).id).toBe('n-sample000001');
    const expected = `sha256=${createHmac('sha256', 'k'.repeat(24))
      .update(req?.raw ?? '')
      .digest('hex')}`;
    expect(req?.headers['x-browserhive-signature']).toBe(expected);
    expect(req?.headers['x-browserhive-timestamp']).toBe('1790000000500');
  });

  it('refuses other schemes and cross-host redirects', async () => {
    expect(() =>
      createWebhookChannel(platformRecord('webhook', { target: { url: 'file:///etc/passwd' } }), {
        url: null,
        secret: null,
      }),
    ).toThrow(/http/);
    const redirecting = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        new URL(req.url).pathname === '/same'
          ? Response.redirect(`${fakes.webhookUrl}`, 307)
          : Response.redirect('http://localhost:1/elsewhere', 307),
    });
    try {
      const away = createWebhookChannel(
        platformRecord('webhook', { target: { url: `http://127.0.0.1:${redirecting.port}/away` } }),
        { url: null, secret: null },
      );
      const err = await failure(away.send(delivery('crash', WEBHOOK_CAPABILITIES)));
      expect([err.code, err.message]).toEqual([
        'rejected',
        'Webhook redirect: refused a redirect to another scheme or host',
      ]);
    } finally {
      await redirecting.stop(true);
    }
  });
});

describe('http helper', () => {
  it('times out a hanging platform', async () => {
    fakes.script('telegram:sendMessage', { hang: true });
    const err = await failure(
      callPlatform(
        {
          url: `${fakes.telegramBase}/bot${FAKE_TG_TOKEN}/sendMessage`,
          method: 'POST',
          timeoutMs: 100,
        },
        { fetch, secrets: [FAKE_TG_TOKEN], platform: 'Telegram' },
      ),
    );
    expect([err.code, err.retryable]).toEqual(['timeout', true]);
  });

  it('reports an unreachable host without the URL', async () => {
    const err = await failure(
      callPlatform(
        { url: `http://127.0.0.1:1/bot${FAKE_TG_TOKEN}/getMe`, method: 'POST' },
        { fetch, secrets: [FAKE_TG_TOKEN], platform: 'Telegram' },
      ),
    );
    expect(err.code).toBe('unavailable');
    expect(err.message).not.toContain(FAKE_TG_TOKEN);
  });
});
