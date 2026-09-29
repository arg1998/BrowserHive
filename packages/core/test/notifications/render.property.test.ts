/** @module test/notifications/render.property.test — escaping and length properties of the renderers over seeded random text (spec 09 §3.2): Telegram HTML never carries an unescaped `<`, `>` or `&` from text and stays within 4096 / 1024 visible characters; Discord embeds stay within Discord's limits; ntfy bodies stay under 4096 bytes with at most three actions. 500 cases per platform. */

import { describe, expect, it } from 'bun:test';
import {
  NOTIFICATION_LABEL_MAX,
  NOTIFICATION_SUMMARY_MAX,
  NOTIFICATION_TITLE_MAX,
  NotificationMessage,
  PREVIEW_SAMPLES,
} from '@browserhive/contracts/notifications';
import { degrade } from '../../src/app/notifications/degrade.ts';
import { sampleMessage } from '../../src/app/notifications/samples.ts';
import {
  DISCORD_LIMITS,
  discordRenderer,
  ntfyRenderer,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_RICH_MAX,
  TELEGRAM_TEXT_MAX,
  telegramClassicRenderer,
  telegramRenderer,
} from '../../src/infra/notifications/index.ts';
import type { ChannelRenderer, RenderContext } from '../../src/ports/notification-channel.ts';
import { LOCAL_LINKS, PUBLIC_LINKS } from './helpers.ts';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const PIECES = [
  '<b>',
  '</i>',
  '&amp;',
  '&',
  '<',
  '>',
  '"',
  "'",
  '*',
  '_',
  '~',
  '`',
  '```',
  '|',
  '#',
  '- ',
  '@everyone',
  '<t:1:R>',
  '[x](http://evil)',
  '\n',
  ' ',
  'ü',
  '日本',
  '🔥',
  'word',
  'lorem ipsum ',
  'https://example.com/a?b=c&d=<e>',
];

function randomText(next: () => number, max: number): string {
  const target = Math.floor(next() ** 3 * max);
  let out = '';
  while (out.length < target) out += PIECES[Math.floor(next() * PIECES.length)];
  return out.slice(0, max);
}

/** A sample with every free-text leaf replaced by random text, still valid against the contract. */
function randomMessage(next: () => number): NotificationMessage {
  const sample = PREVIEW_SAMPLES[Math.floor(next() * PREVIEW_SAMPLES.length)] ?? 'attention';
  const base = sampleMessage(sample, { image: next() < 0.3 ? 'masked' : 'none' });
  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === 'string') {
      if (key === 'text') return randomText(next, next() < 0.1 ? 4000 : 900);
      if (key === 'label') return randomText(next, NOTIFICATION_LABEL_MAX) || 'x';
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    return value;
  };
  const mutated = walk(base, '') as NotificationMessage;
  return NotificationMessage.parse({
    ...mutated,
    title: randomText(next, NOTIFICATION_TITLE_MAX) || 'x',
    summary: randomText(next, NOTIFICATION_SUMMARY_MAX),
  });
}

function render(
  renderer: ChannelRenderer,
  message: NotificationMessage,
  next: () => number,
  mode: string | null,
) {
  const target = { chat_id: '1', topic: 't', reply_topic: 'r', channel_id: '112233445566778899' };
  const capabilities = renderer.capabilities({
    mode,
    target,
    secretRefs: {},
    rules: { act_buttons: true },
  });
  const context: RenderContext = {
    mode,
    target,
    op: 'send',
    ref: null,
    actToken: () => 'bh1:x',
  };
  return renderer.render(
    {
      message: degrade(message, capabilities),
      links: next() < 0.5 ? PUBLIC_LINKS : LOCAL_LINKS,
      replyTo: null,
    },
    context,
  );
}

const TG_TAG = /<\/?(b|i|code|pre|blockquote|a|tg-time)(\s[^<>]*)?>/g;
const RICH_TAG =
  /<\/?(h3|h4|p|br|img|b|i|code|pre|blockquote|a|tg-time|table|tr|td|th|ul|ol|li|footer|hr)(\s[^<>]*)?\/?>/g;
const TG_ENTITY = /&(lt|gt|amp|quot);/g;

/** Visible text of Telegram HTML, or an error sentence when it is not well formed. */
function telegramVisible(html: string): { visible: string } | { error: string } {
  const stack: string[] = [];
  for (const match of html.matchAll(TG_TAG)) {
    const tag = match[1] ?? '';
    if (match[0].startsWith('</')) {
      if (stack.pop() !== tag) return { error: `unbalanced </${tag}>` };
    } else {
      stack.push(tag);
    }
  }
  if (stack.length > 0) return { error: `unclosed <${stack.join(',')}>` };
  const stripped = html.replace(TG_TAG, '');
  if (/[<>]/.test(stripped)) return { error: 'raw < or > outside a tag' };
  if (/&/.test(stripped.replace(TG_ENTITY, ''))) return { error: 'raw & outside an entity' };
  return {
    visible: stripped.replace(
      TG_ENTITY,
      (_m, e: string) => ({ lt: '<', gt: '>', amp: '&', quot: '"' })[e] ?? '',
    ),
  };
}

describe('renderer properties', () => {
  it('classic Telegram HTML (the fallback) is well formed and within the text and caption limits', () => {
    const next = rng(7);
    const problems: string[] = [];
    let nearLimit = 0;
    for (let i = 0; i < 500; i++) {
      const [request] = render(telegramClassicRenderer, randomMessage(next), next, null);
      const body = request?.body as { text?: string; caption?: string };
      const html = body.caption ?? body.text ?? '';
      const limit = body.caption !== undefined ? TELEGRAM_CAPTION_MAX : TELEGRAM_TEXT_MAX;
      const result = telegramVisible(html);
      if ('error' in result) problems.push(`case ${i}: ${result.error}`);
      else if (result.visible.length > limit * 0.8) nearLimit++;
      if ('visible' in result && result.visible.length > limit)
        problems.push(`case ${i}: ${result.visible.length} > ${limit}`);
    }
    expect(problems).toEqual([]);
    // Not vacuous: many cases come close to a limit and are clipped.
    expect(nearLimit).toBeGreaterThan(20);
  });

  it('Rich Message HTML is well formed, escaped and within the rich limit; buttons fit 64 bytes', () => {
    const next = rng(8);
    const problems: string[] = [];
    for (let i = 0; i < 500; i++) {
      const [request] = render(telegramRenderer, randomMessage(next), next, null);
      const rich = request?.body['rich_message'] as { html: string } | undefined;
      const html = rich?.html ?? '';
      if (html.length > TELEGRAM_RICH_MAX) problems.push(`case ${i}: ${html.length} too long`);
      const stack: string[] = [];
      for (const match of html.matchAll(RICH_TAG)) {
        const tag = match[1] ?? '';
        if (match[0].endsWith('/>') || tag === 'br') continue;
        if (match[0].startsWith('</')) {
          if (stack.pop() !== tag) problems.push(`case ${i}: unbalanced </${tag}>`);
        } else stack.push(tag);
      }
      if (stack.length > 0) problems.push(`case ${i}: unclosed ${stack.join(',')}`);
      const stripped = html.replace(RICH_TAG, '');
      if (/[<>]/.test(stripped)) problems.push(`case ${i}: raw < or > outside a tag`);
      if (/&/.test(stripped.replace(TG_ENTITY, ''))) problems.push(`case ${i}: raw &`);
      const markup = request?.body['reply_markup'] as
        | { inline_keyboard: { callback_data?: string }[][] }
        | undefined;
      for (const b of markup?.inline_keyboard.flat() ?? []) {
        if (b.callback_data !== undefined && new TextEncoder().encode(b.callback_data).length > 64)
          problems.push(`case ${i}: callback_data over 64 bytes`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('Discord embeds stay within Discord limits and never ping', () => {
    const next = rng(11);
    const problems: string[] = [];
    for (let i = 0; i < 500; i++) {
      const [request] = render(
        discordRenderer,
        randomMessage(next),
        next,
        next() < 0.5 ? 'webhook' : 'bot',
      );
      const payload = (request?.body['payload_json'] ?? request?.body) as {
        embeds: {
          title: string;
          description?: string;
          fields?: { name: string; value: string }[];
          footer: { text: string };
        }[];
        components: { components: { label: string }[] }[];
        allowed_mentions: { parse: string[] };
      };
      const e = payload.embeds[0];
      if (e === undefined) {
        problems.push(`case ${i}: no embed`);
        continue;
      }
      const fields = e.fields ?? [];
      const total =
        e.title.length +
        (e.description?.length ?? 0) +
        e.footer.text.length +
        fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
      if (e.title.length > DISCORD_LIMITS.title) problems.push(`case ${i}: title`);
      if ((e.description?.length ?? 0) > DISCORD_LIMITS.description)
        problems.push(`case ${i}: description`);
      if (fields.length > DISCORD_LIMITS.fields) problems.push(`case ${i}: fields`);
      if (
        fields.some(
          (f) =>
            f.name.length > DISCORD_LIMITS.fieldName || f.value.length > DISCORD_LIMITS.fieldValue,
        )
      ) {
        problems.push(`case ${i}: field size`);
      }
      if (total > DISCORD_LIMITS.total) problems.push(`case ${i}: total ${total}`);
      if (payload.components.length > 5) problems.push(`case ${i}: rows`);
      if (
        payload.components.some((r) =>
          r.components.some((b) => b.label.length > DISCORD_LIMITS.buttonLabel),
        )
      ) {
        problems.push(`case ${i}: button label`);
      }
      if (payload.allowed_mentions.parse.length !== 0) problems.push(`case ${i}: mentions`);
    }
    expect(problems).toEqual([]);
  });

  it('ntfy bodies stay under 4096 bytes with at most three actions', () => {
    const next = rng(13);
    const encoder = new TextEncoder();
    const problems: string[] = [];
    for (let i = 0; i < 500; i++) {
      const [request] = render(ntfyRenderer, randomMessage(next), next, null);
      const body = request?.body as { message: string; title: string; actions?: unknown[] };
      if (encoder.encode(body.message).length > 4096) problems.push(`case ${i}: message bytes`);
      if (body.title.length > 250) problems.push(`case ${i}: title`);
      if ((body.actions?.length ?? 0) > 3) problems.push(`case ${i}: actions`);
    }
    expect(problems).toEqual([]);
  });
});
