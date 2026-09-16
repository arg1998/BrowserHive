/** @module contracts/config/keys-server — server and transport keys (spec 08 §5.1) */
import type { z } from 'zod';
import { AuthMode } from '../enums/auth-mode.ts';
import { isIPv4, isIPv6, zHost } from './host.ts';
import { derived, key } from './key.ts';
import { zBool, zDuration, zEnumOf, zList, zPath, zPort, zReservedEnum } from './parsers.ts';

const AUTH_TOKEN_ITEM_RE = /^[^:\s]+:.{32,}$/;

/** `authTokens` items: `name:token`, token ≥ 32 characters. */
const zAuthTokens = zList
  .refine((items) => items.every((item) => AUTH_TOKEN_ITEM_RE.test(item)), {
    message: "Expected items of the form 'name:token' with a token of at least 32 characters.",
  })
  .meta({ grammar: "a comma-separated list of 'name:token' pairs (token >= 32 characters)" });

const CIDR_RE = /^(.+?)(?:\/(\d{1,3}))?$/;

function isIpOrCidr(item: string): boolean {
  const match = CIDR_RE.exec(item);
  const address = match?.[1] ?? '';
  const prefix = match?.[2];
  const bits = isIPv4(address) ? 32 : isIPv6(address) ? 128 : 0;
  if (bits === 0) return false;
  return prefix === undefined || Number(prefix) <= bits;
}

/** `trustedProxies` items: IP literals or CIDR ranges. */
const zCidrList = zList
  .refine((items) => items.every(isIpOrCidr), {
    message: "Expected IP addresses or CIDR ranges like '10.0.0.0/8'.",
  })
  .meta({ grammar: 'a comma-separated list of IP addresses or CIDR ranges' });

/** Keys of the `server` group. */
export const SERVER_KEYS = {
  config: key(zPath, {
    optional: true,
    group: 'server',
    cliOnly: true,
    describe: 'Config file path. CLI and environment only: a config file cannot point at another.',
  }),
  transport: key(zReservedEnum(['http', 'stdio'], ['ws']), {
    default: 'http',
    group: 'server',
    describe:
      'Transport to serve. stdio is the single-client fallback without dashboard or attention.',
  }),
  host: key(zHost, {
    default: '127.0.0.1',
    group: 'server',
    describe: 'Bind address. A non-loopback host requires auth=token or allowInsecureBind=true.',
  }),
  port: key(zPort, {
    default: 9876,
    group: 'server',
    describe: 'Bind port for MCP, REST, WebSocket and the dashboard.',
  }),
  auth: key(zEnumOf(AuthMode.options), {
    default: 'off',
    group: 'server',
    describe: 'MCP authentication. token requires a bearer on /mcp and enforces session ownership.',
  }),
  authTokens: key(zAuthTokens, {
    default: [],
    group: 'server',
    secret: true,
    describe:
      'Agent bearer tokens as name:token pairs (env preferred). Merged with stored tokens, never persisted.',
    examples: ['ci-runner:REPLACE_WITH_32_PLUS_CHARS'],
  }),
  allowInsecureBind: key(zBool, {
    default: false,
    group: 'server',
    describe: 'Acknowledge binding a non-loopback host without authentication.',
  }),
  trustedProxies: key(zCidrList, {
    default: [],
    group: 'server',
    describe:
      'Peers whose X-Forwarded-For is honoured (IPs or CIDR ranges). Never used on a loopback bind.',
  }),
  admin: key(zBool, {
    default: false,
    group: 'server',
    describe: 'Enable the dashboard, REST API, WebSocket and trace viewer (http only).',
  }),
  dataDir: key(zPath, {
    default: derived('platform'),
    group: 'server',
    describe:
      'Data directory (database, sessions, auth states, uploads, backups). Defaults to the OS data dir.',
  }),
  shutdownTimeout: key(zDuration, {
    default: 20_000,
    defaultText: '20s',
    group: 'server',
    describe: 'Total budget for a graceful stop (listeners, then sessions, then storage).',
  }),
  sessionCloseTimeout: key(zDuration, {
    default: 10_000,
    defaultText: '10s',
    group: 'server',
    describe: 'Per-session close and trace-finalize cap.',
  }),
} as const;

/** Output type of the server keys (used by the cross-field rules). */
export type ServerKeysOutput = z.output<z.ZodObject<typeof SERVER_KEYS>>;
