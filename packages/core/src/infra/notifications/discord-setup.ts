/** @module infra/notifications/discord-setup — the Discord bot-mode setup calls (spec 03 §4.8.1, D-38): the bot's identity and servers, a server's text channels, and the "This is me" claim over the shared gateway. */

import { randomBytes } from 'node:crypto';
import {
  ChannelSendError,
  type DiscordBotIdentity,
  type DiscordChannelInfo,
  type DiscordSetup,
} from '../../ports/notification-channel.ts';
import { refineDiscord } from './discord.ts';
import { CLAIM_PREFIX, DISCORD_API_BASE, DiscordGatewayHub } from './discord-gateway.ts';
import { callPlatform, type FetchFn } from './http.ts';

/** Options of {@link createDiscordSetup}. */
export interface DiscordSetupOptions {
  readonly fetch?: FetchFn;
  readonly apiBase?: string;
  /** The gateway connections shared with the channels' act buttons (a private hub otherwise). */
  readonly gateway?: DiscordGatewayHub;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === 'object' ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Channel types listed by the picker: text (0) and announcement (5); categories are type 4. */
const TEXT = 0;
const ANNOUNCEMENT = 5;
const CATEGORY = 4;

/**
 * The Discord setup calls over the bot REST API.
 *
 * @returns The setup port.
 */
export function createDiscordSetup(options: DiscordSetupOptions = {}): DiscordSetup {
  const base = (options.apiBase ?? DISCORD_API_BASE).replace(/\/+$/, '');
  const fetchFn = options.fetch ?? fetch;
  const gateway =
    options.gateway ??
    new DiscordGatewayHub({
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      ...(options.apiBase !== undefined && { apiBase: options.apiBase }),
    });
  const call = (token: string, method: string, path: string, body?: unknown) =>
    callPlatform(
      {
        url: `${base}${path}`,
        method,
        headers: {
          authorization: `Bot ${token}`,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      },
      { fetch: fetchFn, secrets: [token], platform: 'Discord', refine: refineDiscord },
    );

  return {
    async bot(token: string): Promise<DiscordBotIdentity> {
      const me = obj((await call(token, 'GET', '/users/@me')).json);
      const app = obj((await call(token, 'GET', '/applications/@me')).json);
      const guilds = (await call(token, 'GET', '/users/@me/guilds')).json;
      const botId = str(me?.['id']);
      const applicationId = str(app?.['id']) ?? botId;
      if (botId === null || applicationId === null) {
        throw new ChannelSendError('rejected', 'Discord did not say who the bot is');
      }
      return {
        applicationId,
        botId,
        username: str(me?.['username']) ?? botId,
        guilds: (Array.isArray(guilds) ? guilds : [])
          .map(obj)
          .filter((g): g is Json => g !== null && str(g['id']) !== null)
          .map((g) => ({ id: String(g['id']), name: str(g['name']) ?? String(g['id']) })),
      };
    },

    async channels(token: string, guildId: string): Promise<readonly DiscordChannelInfo[]> {
      const answer = await call(token, 'GET', `/guilds/${encodeURIComponent(guildId)}/channels`);
      const rows = (Array.isArray(answer.json) ? answer.json : [])
        .map(obj)
        .filter((c): c is Json => c !== null);
      const categories = new Map<string, { name: string; position: number }>();
      for (const c of rows) {
        if (c['type'] === CATEGORY && str(c['id']) !== null) {
          categories.set(String(c['id']), {
            name: str(c['name']) ?? '',
            position: Number(c['position'] ?? 0),
          });
        }
      }
      return rows
        .filter((c) => (c['type'] === TEXT || c['type'] === ANNOUNCEMENT) && str(c['id']) !== null)
        .map((c) => {
          const parent = str(c['parent_id']);
          const category = parent === null ? null : (categories.get(parent) ?? null);
          return {
            info: {
              id: String(c['id']),
              name: str(c['name']) ?? String(c['id']),
              type: c['type'] === ANNOUNCEMENT ? ('announcement' as const) : ('text' as const),
              category: category?.name ?? null,
            },
            order: [category === null ? -1 : category.position, Number(c['position'] ?? 0)],
          };
        })
        .sort(
          (a, b) => (a.order[0] ?? 0) - (b.order[0] ?? 0) || (a.order[1] ?? 0) - (b.order[1] ?? 0),
        )
        .map((c) => c.info);
    },

    async claim(token, channelId, { signal, deadline }) {
      const code = randomBytes(12).toString('base64url');
      const posted = obj(
        (
          await call(token, 'POST', `/channels/${encodeURIComponent(channelId)}/messages`, {
            content:
              '**BrowserHive** · Press **This is me** to allow your Discord account to answer BrowserHive requests in this channel. The button works for 2 minutes.',
            allowed_mentions: { parse: [] },
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 1, label: 'This is me', custom_id: `${CLAIM_PREFIX}${code}` },
                ],
              },
            ],
          })
        ).json,
      );
      const messageId = str(posted?.['id']);
      try {
        return await gateway.waitForClaim(token, code, { signal, deadline });
      } finally {
        if (messageId !== null) {
          await call(
            token,
            'DELETE',
            `/channels/${encodeURIComponent(channelId)}/messages/${messageId}`,
          ).catch(() => undefined);
        }
      }
    },
  };
}
