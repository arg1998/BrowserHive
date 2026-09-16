/** @module contracts/tools/introspection — server_status and session_info contracts */
import { z } from 'zod';
import { Channel } from '../enums/channel.ts';
import { PersistenceMode } from '../enums/persistence-mode.ts';
import { Transport } from '../enums/transport.ts';
import { annotations, SESSION_ERRORS, SINCE } from './shared.ts';
import { defineTool } from './types.ts';

/** `server_status` result. `sessions.limit` is `null` only when `maxSessions=unbounded`. */
export const ServerStatus = z.object({
  uptime_ms: z.number(),
  version: z.string(),
  transport: Transport,
  sessions: z.object({ count: z.number(), limit: z.number().nullable() }),
  vault: z.object({
    enabled: z.boolean(),
    backend: z.string().nullable(),
    evaluate_warning: z.boolean(),
  }),
  persistence_mode: PersistenceMode,
});

/** `session_info` result: launch configuration plus live counters. */
export const SessionInfo = z.object({
  session_id: z.string(),
  config: z.object({
    slug: z.string(),
    channel: Channel,
    headless: z.boolean(),
    incognito: z.boolean(),
    persistence_mode: PersistenceMode,
    disable_evaluate: z.boolean(),
    vault_enabled: z.boolean(),
    stealth: z.boolean(),
    fingerprint: z.boolean(),
    humanize: z.boolean(),
    owner: z.string(),
  }),
  page_count: z.number(),
  current_url: z.string().nullable(),
  created_at: z.number(),
  last_tool_at: z.number(),
  lease_expires_at: z.number(),
  navigation_count: z.number(),
});

/** `server_status`: takes no arguments, so no `inputSchema`. */
export const SERVER_STATUS = defineTool({
  name: 'server_status',
  title: 'Server status',
  description:
    'Report server-wide status: uptime, version, transport, live/allowed session counts, ' +
    'vault state, and the global default persistence mode.',
  output: ServerStatus,
  annotations: annotations(true, false, true, false),
  pack: 'introspection',
  capability: 'read',
  errors: [],
  since: SINCE,
});

/** `session_info`: one session's configuration and live state. */
export const SESSION_INFO = defineTool({
  name: 'session_info',
  title: 'Session info',
  description:
    "Report a single session's configuration and live state: channel, headless/incognito, " +
    'persistence mode, per-session evaluate/vault flags, open tab (page) count, current URL, ' +
    'created_at, last_tool_at, and navigation count.',
  input: z.object({ session_id: z.string() }),
  output: SessionInfo,
  annotations: annotations(true, false, true, false),
  pack: 'introspection',
  capability: 'read',
  errors: [...SESSION_ERRORS],
  since: SINCE,
});
