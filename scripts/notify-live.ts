/** @module scripts/notify-live — the live notification check (`notify-live.yml`, spec 09 §8): for each platform whose secrets are present, send a real message with a screenshot through the real adapter, read it back where the platform allows, edit it, and delete it; Telegram as a Rich Message with act buttons, a Discord bot (when its secrets exist) with interactive buttons and a gateway connection, and ntfy's reply topic round trip (D-40..D-42). A platform without secrets is skipped with a note. Never prints a secret. */

import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviewSample } from '../packages/contracts/src/notifications/index.ts';
import { restrictContent } from '../packages/core/src/app/notifications/content-level.ts';
import { degrade } from '../packages/core/src/app/notifications/degrade.ts';
import { SAMPLE_IMAGE_REF, sampleMessage } from '../packages/core/src/app/notifications/samples.ts';
import {
  createDiscordChannel,
  createNtfyChannel,
  createNtfyReplySource,
  createTelegramChannel,
  DiscordGatewayHub,
  scrubDetail,
} from '../packages/core/src/infra/notifications/index.ts';
import type {
  ChannelDelivery,
  LinkBuilder,
  NotificationChannel,
  NotificationImageReader,
} from '../packages/core/src/ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../packages/core/src/ports/persistence/records.ts';

const env = process.env;
const SECRETS = [
  env['TG_BOT_TOKEN'],
  env['DISCORD_WEBHOOK_URL'],
  env['DISCORD_BOT_TOKEN'],
  env['NTFY_TOPIC'],
].filter((v): v is string => v !== undefined && v !== '');

/** A real JPEG, so Telegram accepts the photo. */
const JPEG = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', 'notify-live.jpg')));
const IMAGES: NotificationImageReader = {
  read: async (ref) =>
    ref === SAMPLE_IMAGE_REF
      ? { bytes: JPEG, contentType: 'image/jpeg', filename: 'screenshot.jpg' }
      : null,
};
/** Links point at the public website so every platform accepts them as buttons. */
const LINKS: LinkBuilder = { local: false, url: (path) => `https://browserhive.ai${path}` };

type Outcome = { platform: string; status: 'passed' | 'failed' | 'skipped'; detail: string };

function record(kind: string, target: Record<string, string>): NotificationChannelRecord {
  return {
    channelId: `nc-live-${kind}`,
    name: `live-${kind}`,
    kind,
    mode: kind === 'discord' ? 'webhook' : null,
    source: 'db',
    status: 'active',
    target,
    secretRefs: {},
    rules: {},
    failureCount: 0,
    lastError: null,
    lastOkAt: null,
    lastFailureAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function deliveryOf(
  channel: NotificationChannel,
  sample: PreviewSample,
  image: boolean,
): ChannelDelivery {
  const message = sampleMessage(sample, { now: Date.now(), image: image ? 'masked' : 'none' });
  const marked = { ...message, title: `Live check · ${message.title}`.slice(0, 120) };
  return {
    message: degrade(restrictContent(marked, 'full'), channel.capabilities),
    links: LINKS,
    replyTo: null,
  };
}

function safe(err: unknown): string {
  return scrubDetail(err instanceof Error ? err.message : 'unknown failure', SECRETS);
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`read-back: ${what}`);
}

async function telegram(): Promise<Outcome> {
  const token = env['TG_BOT_TOKEN'];
  const chat = env['TG_CHAT_ID'];
  if (!token || !chat)
    return {
      platform: 'Telegram',
      status: 'skipped',
      detail: 'TG_BOT_TOKEN or TG_CHAT_ID not set',
    };
  // Act buttons on (D-41): the Rich Message carries callback buttons; the tokens here are dummies
  // that no BrowserHive knows, so a stray press is answered "no longer valid".
  const channel = createTelegramChannel(
    { ...record('telegram', { chat_id: chat }), rules: { act_buttons: true } },
    { token, images: IMAGES },
  );
  const withTokens = (d: ChannelDelivery): ChannelDelivery => ({
    ...d,
    actTokens: new Map(
      d.message.actions.filter((a) => a.kind === 'act').map((a) => [a.id, 'bh1:LIVECHECK00']),
    ),
  });
  const photo = await channel.send(withTokens(deliveryOf(channel, 'attention', true)));
  check(photo.ref['rich'] === 1, 'the send was a Rich Message (not the classic fallback)');
  check(photo.ref['photo'] === 1, 'the Rich Message carries the screenshot');
  check(typeof photo.ref['photo_file_id'] === 'string', 'Telegram returned the photo file id');
  await channel.edit?.(photo.ref, deliveryOf(channel, 'attention-resolved', true));
  await channel.delete?.(photo.ref);
  const text = await channel.send(deliveryOf(channel, 'tool-errors', false));
  check(text.ref['rich'] === 1, 'the text send was a Rich Message');
  await channel.edit?.(text.ref, deliveryOf(channel, 'tool-errors', false));
  await channel.delete?.(text.ref);
  return {
    platform: 'Telegram',
    status: 'passed',
    detail: 'Rich Messages with a screenshot and act buttons: send, edit (buttons removed), delete',
  };
}

async function discord(): Promise<Outcome> {
  const webhook = env['DISCORD_WEBHOOK_URL'];
  if (!webhook)
    return { platform: 'Discord', status: 'skipped', detail: 'DISCORD_WEBHOOK_URL not set' };
  const channel = createDiscordChannel(record('discord', {}), {
    webhookUrl: webhook,
    images: IMAGES,
  });
  const read = async (id: string | number) => {
    const response = await fetch(`${webhook.replace(/\/+$/, '')}/messages/${id}`);
    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as Record<string, unknown> | null,
    };
  };
  // A file an embed shows (`attachment://`) moves into the embed: the message's `attachments` list
  // stays empty and `embeds[0].image.url` points at Discord's CDN.
  const shown = (body: Record<string, unknown> | null) => {
    const url = ((body?.['embeds'] ?? []) as { image?: { url?: string } }[])[0]?.image?.url ?? '';
    return (
      /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(url) && url.includes('screenshot.jpg')
    );
  };
  const { ref } = await channel.send(deliveryOf(channel, 'attention', true));
  const id = ref['message_id'] ?? '';
  let back = await read(id);
  const embeds = (back.body?.['embeds'] ?? []) as { title?: string }[];
  check(
    back.status === 200 && (embeds[0]?.title ?? '').includes('Attention requested'),
    'the embed title',
  );
  check(shown(back.body), 'the screenshot in the embed');
  await channel.edit?.(ref, deliveryOf(channel, 'attention-resolved', true));
  back = await read(id);
  const edited = (back.body?.['embeds'] ?? []) as { title?: string }[];
  check((edited[0]?.title ?? '').startsWith('✅'), 'the edited embed');
  check(shown(back.body), 'the screenshot kept by the edit');
  await channel.delete?.(ref);
  back = await read(id);
  check(back.status === 404, 'the message is gone after delete');
  return {
    platform: 'Discord',
    status: 'passed',
    detail: 'send, read back, edit (screenshot kept), delete',
  };
}

async function discordBot(): Promise<Outcome> {
  const token = env['DISCORD_BOT_TOKEN'];
  const channelId = env['DISCORD_CHANNEL_ID'];
  if (!token || !channelId) {
    return {
      platform: 'Discord bot',
      status: 'skipped',
      detail: 'DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID not set',
    };
  }
  const gateway = new DiscordGatewayHub({ lingerMs: 0 });
  const channel = createDiscordChannel(
    { ...record('discord', { channel_id: channelId }), mode: 'bot', rules: { act_buttons: true } },
    { botToken: token, images: IMAGES, gateway },
  );
  try {
    const presses = channel.presses;
    check(presses !== undefined, 'bot mode with act buttons listens for presses');
    const states: string[] = [];
    const stop = presses?.listen(
      async () => ({ outcome: 'unknown', text: 'Live check: nothing to do.', refused: true }),
      (s) => states.push(s.state),
    );
    for (let i = 0; i < 100 && !states.includes('connected'); i++) await Bun.sleep(100);
    check(states.includes('connected'), 'the gateway session became Ready');
    const d = deliveryOf(channel, 'attention', true);
    const { ref } = await channel.send({
      ...d,
      actTokens: new Map(
        d.message.actions.filter((a) => a.kind === 'act').map((a) => [a.id, 'bh1:LIVECHECK00']),
      ),
    });
    await channel.edit?.(ref, deliveryOf(channel, 'attention-resolved', true));
    await channel.delete?.(ref);
    stop?.();
    return {
      platform: 'Discord bot',
      status: 'passed',
      detail: 'gateway Ready; send with interactive buttons, edit (buttons removed), delete',
    };
  } finally {
    gateway.stop();
  }
}

async function ntfy(): Promise<Outcome> {
  const topic = env['NTFY_TOPIC'];
  if (!topic) return { platform: 'ntfy', status: 'skipped', detail: 'NTFY_TOPIC not set' };
  const server = (env['NTFY_SERVER'] || 'https://ntfy.sh').replace(/\/+$/, '');
  const channel = createNtfyChannel(record('ntfy', { server }), {
    token: null,
    topic,
    images: IMAGES,
  });
  const since = Math.floor(Date.now() / 1000) - 5;
  const poll = async () => {
    const response = await fetch(`${server}/${topic}/json?poll=1&since=${since}`);
    const text = await response.text();
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map(
        (l) =>
          JSON.parse(l) as {
            event: string;
            sequence_id?: string;
            message?: string;
            attachment?: unknown;
          },
      );
  };
  // ntfy.sh's cache can lag a publish by a moment: poll until the expected event shows up.
  const until = async (
    what: string,
    found: (events: Awaited<ReturnType<typeof poll>>) => boolean,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (found(await poll())) return;
      await Bun.sleep(500);
    }
    check(false, what);
  };
  const { ref } = await channel.send(deliveryOf(channel, 'attention', true));
  const sequence = String(ref['sequence_id']);
  const mine = (events: Awaited<ReturnType<typeof poll>>) =>
    events.filter((e) => e.event === 'message' && e.sequence_id === sequence);
  await until('the upload', (events) => mine(events).some((e) => e.attachment !== undefined));
  await channel.edit?.(ref, deliveryOf(channel, 'attention-resolved', false));
  await until('the replacement', (events) =>
    (mine(events).at(-1)?.message ?? '').includes('Resolved'),
  );
  await channel.delete?.(ref);
  await until('the delete event', (events) =>
    events.some((e) => e.event === 'message_delete' && e.sequence_id === sequence),
  );
  // The reply topic (D-42): a throwaway topic B; post like the phone's `http` action does and
  // check the subscription receives the token.
  const reply = `bh-live-${randomBytes(9).toString('hex')}`;
  const received: string[] = [];
  const source = createNtfyReplySource({ server, topic: reply, token: null, cursorKey: 'live' });
  const stop = source.listen(
    async (p) => {
      received.push(p.token);
      return { outcome: 'done', text: '', refused: false };
    },
    () => undefined,
  );
  try {
    for (let i = 0; i < 50 && source.status().state !== 'connected'; i++) await Bun.sleep(100);
    await fetch(`${server}/${reply}`, { method: 'POST', body: 'bh1:LIVECHECK00' });
    for (let i = 0; i < 100 && received.length === 0; i++) await Bun.sleep(100);
    check(received[0] === 'LIVECHECK00', 'the reply topic delivered the token');
  } finally {
    stop();
  }
  return {
    platform: 'ntfy',
    status: 'passed',
    detail: `send with screenshot, replace, delete and a reply-topic round trip on ${new URL(server).host}`,
  };
}

const outcomes: Outcome[] = [];
for (const [name, run] of [
  ['Telegram', telegram],
  ['Discord', discord],
  ['Discord bot', discordBot],
  ['ntfy', ntfy],
] as const) {
  try {
    outcomes.push(await run());
  } catch (err) {
    outcomes.push({ platform: name, status: 'failed', detail: safe(err) });
  }
}

const icon = { passed: '✅', failed: '❌', skipped: '⏭️' } as const;
const table = [
  '### Live notification check',
  '',
  '| Platform | Result | Detail |',
  '|---|---|---|',
  ...outcomes.map(
    (o) => `| ${o.platform} | ${icon[o.status]} ${o.status} | ${o.detail.replace(/\|/g, '/')} |`,
  ),
  '',
].join('\n');
console.log(table);
const summary = env['GITHUB_STEP_SUMMARY'];
if (summary) appendFileSync(summary, `${table}\n`);
process.exit(outcomes.some((o) => o.status === 'failed') ? 1 : 0);
