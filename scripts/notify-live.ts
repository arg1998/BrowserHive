/** @module scripts/notify-live — the live notification check (`notify-live.yml`, spec 09 §8): for each platform whose secrets are present, send a real message with a screenshot through the real adapter, read it back where the platform allows, edit it, and delete it. A platform without secrets is skipped with a note. Never prints a secret. */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviewSample } from '../packages/contracts/src/notifications/index.ts';
import { restrictContent } from '../packages/core/src/app/notifications/content-level.ts';
import { degrade } from '../packages/core/src/app/notifications/degrade.ts';
import { SAMPLE_IMAGE_REF, sampleMessage } from '../packages/core/src/app/notifications/samples.ts';
import {
  createDiscordChannel,
  createNtfyChannel,
  createTelegramChannel,
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
const SECRETS = [env['TG_BOT_TOKEN'], env['DISCORD_WEBHOOK_URL'], env['NTFY_TOPIC']].filter(
  (v): v is string => v !== undefined && v !== '',
);

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
  const channel = createTelegramChannel(record('telegram', { chat_id: chat }), {
    token,
    images: IMAGES,
  });
  const photo = await channel.send(deliveryOf(channel, 'attention', true));
  check(photo.ref['photo'] === 1, 'the send result is a photo message');
  await channel.edit?.(photo.ref, deliveryOf(channel, 'attention-resolved', true));
  await channel.delete?.(photo.ref);
  const text = await channel.send(deliveryOf(channel, 'tool-errors', false));
  await channel.edit?.(text.ref, deliveryOf(channel, 'tool-errors', false));
  await channel.delete?.(text.ref);
  return { platform: 'Telegram', status: 'passed', detail: 'photo and text: send, edit, delete' };
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
  const { ref } = await channel.send(deliveryOf(channel, 'attention', true));
  const id = ref['message_id'] ?? '';
  let back = await read(id);
  const embeds = (back.body?.['embeds'] ?? []) as { title?: string }[];
  check(
    back.status === 200 && (embeds[0]?.title ?? '').includes('Attention requested'),
    'the embed title',
  );
  check(
    ((back.body?.['attachments'] ?? []) as unknown[]).length === 1,
    'the screenshot attachment',
  );
  await channel.edit?.(ref, deliveryOf(channel, 'attention-resolved', true));
  back = await read(id);
  const edited = (back.body?.['embeds'] ?? []) as { title?: string }[];
  check((edited[0]?.title ?? '').startsWith('✅'), 'the edited embed');
  check(((back.body?.['attachments'] ?? []) as unknown[]).length === 1, 'the kept attachment');
  await channel.delete?.(ref);
  back = await read(id);
  check(back.status === 404, 'the message is gone after delete');
  return {
    platform: 'Discord',
    status: 'passed',
    detail: 'send, read back, edit (screenshot kept), delete',
  };
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
  return {
    platform: 'ntfy',
    status: 'passed',
    detail: `send with screenshot, replace, delete on ${new URL(server).host}`,
  };
}

const outcomes: Outcome[] = [];
for (const [name, run] of [
  ['Telegram', telegram],
  ['Discord', discord],
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
