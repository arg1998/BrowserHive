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
  WEBHOOK_CAPABILITIES,
} from '../../src/infra/notifications/index.ts';
import { ChannelSendError } from '../../src/ports/notification-channel.ts';
import { FAKE_DISCORD_TOKEN, FAKE_TG_TOKEN, FakePlatforms } from '../helpers/fake-platforms.ts';
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
  it('sends HTML text with an inline keyboard and returns the ref', async () => {
    const channel = telegram();
    const { ref } = await channel.send(delivery('attention', TELEGRAM_CAPABILITIES));
    expect(ref).toEqual({ chat_id: -100123, message_id: 101, photo: 0 });
    const [req] = fakes.of('telegram');
    expect(req?.path).toBe('sendMessage');
    expect(req?.json).toMatchObject({
      chat_id: '-100123',
      parse_mode: 'HTML',
      disable_notification: false,
    });
    const body = req?.json as {
      text: string;
      reply_markup: { inline_keyboard: { url: string }[][] };
    };
    expect(body.text).toContain('<b>Attention requested</b>');
    expect(body.reply_markup.inline_keyboard.flat().map((b) => b.url)).toContain(
      'https://bh.example.net/sessions/checkout-a1b2c3d4?live=1&takeover=1',
    );
  });

  it('sends a screenshot as a photo and edits its caption', async () => {
    const channel = telegram();
    const { ref } = await channel.send(
      delivery('attention', TELEGRAM_CAPABILITIES, { image: 'masked' }),
    );
    expect(ref['photo']).toBe(1);
    const [photo] = fakes.of('telegram');
    expect(photo?.path).toBe('sendPhoto');
    expect(photo?.files).toEqual([
      { field: 'photo', name: 'screenshot.jpg', type: 'image/jpeg', size: 8 },
    ]);
    expect(photo?.form?.['caption']).toContain('Attention requested');
    await channel.edit?.(
      ref,
      delivery('attention-resolved', TELEGRAM_CAPABILITIES, { image: 'masked' }),
    );
    const edit = fakes.of('telegram')[1];
    expect(edit?.path).toBe('editMessageCaption');
    expect(edit?.json).toMatchObject({ chat_id: -100123, message_id: 101 });
    expect((edit?.json as { reply_markup: unknown } | undefined)?.reply_markup).toEqual({
      inline_keyboard: [],
    });
  });

  it('falls back to a text message when the screenshot is gone', async () => {
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
    expect(fakes.of('telegram')[0]?.path).toBe('sendMessage');
    expect(ref['photo']).toBe(0);
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
    const ref = { chat_id: 1, message_id: 9, photo: 0 };
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
    fakes.script('telegram:sendMessage', {
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
    fakes.script('telegram:sendMessage', {
      status: 401,
      body: { ok: false, description: 'Unauthorized' },
    });
    const auth = await failure(channel.send(delivery('crash', TELEGRAM_CAPABILITIES)));
    expect([auth.code, auth.retryable]).toEqual(['auth', false]);
    expect(auth.message).not.toContain(FAKE_TG_TOKEN);
    fakes.script('telegram:sendMessage', {
      status: 502,
      body: { ok: false, description: 'Bad Gateway' },
    });
    expect((await failure(channel.send(delivery('crash', TELEGRAM_CAPABILITIES)))).code).toBe(
      'unavailable',
    );
  });

  it('puts links in the text instead of buttons without a public address', async () => {
    await telegram().send(delivery('test', TELEGRAM_CAPABILITIES, { links: LOCAL_LINKS }));
    const body = fakes.of('telegram')[0]?.json as { text: string; reply_markup?: unknown };
    expect(body.reply_markup).toBeUndefined();
    expect(body.text).toContain('Open on this computer');
    expect(body.text).toContain('<code>http://127.0.0.1:9876/notifications/channels</code>');
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
      (send?.json as { embeds: { image: { url: string } }[] } | undefined)?.embeds[0]?.image.url,
    ).toBe('attachment://screenshot.jpg');
    expect(ref['attachment_id']).toBe('900101');
    await channel.edit?.(
      ref,
      delivery('attention-resolved', DISCORD_WEBHOOK_CAPABILITIES, { image: 'masked' }),
    );
    const edit = fakes.of('discord')[1];
    expect([edit?.method, edit?.path]).toEqual(['PATCH', 'messages/101']);
    expect((edit?.json as { attachments: unknown } | undefined)?.attachments).toEqual([
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

  it('refuses bot mode until act buttons ship', () => {
    expect(() =>
      createDiscordChannel(platformRecord('discord', { mode: 'bot' }), {
        webhookUrl: fakes.discordWebhook,
        images: SAMPLE_IMAGES,
      }),
    ).toThrow(/bot mode/);
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
    expect((send?.json as { actions: unknown[] } | undefined)?.actions).toHaveLength(2);
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
