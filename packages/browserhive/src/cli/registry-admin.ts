/** @module cli/registry-admin — the `admin` (reset-password, tokens) and `channels` commands as registry data */
import type { ConfigKey } from '@browserhive/contracts/config';
import { jsonFlag as json, remoteFlags, sub } from './registry-parts.ts';
import type { CommandDescriptor } from './registry-types.ts';

const dataDirKeys: readonly ConfigKey[] = ['dataDir', 'config', 'color'];

/** `admin`: works on the database, or on a running server for `tokens --url`. */
export const ADMIN_COMMAND: CommandDescriptor = {
  name: 'admin',
  summary: 'Administrative actions (reset-password, tokens)',
  description:
    'Works on the database directly and refuses while a server is running on the data directory; tokens subcommands can instead talk to a running server with --url.',
  flags: [],
  configKeys: dataDirKeys,
  subcommands: [
    sub(['reset-password'], 'Generate a new dashboard password (shown once)', {
      flags: [json],
    }),
    sub(['tokens', 'list'], 'List agent and operator bearer tokens', {
      flags: [json, ...remoteFlags],
    }),
    sub(['tokens', 'create'], 'Issue a bearer token for a principal (plaintext shown once)', {
      args: [{ name: 'principal', required: true, describe: 'Agent principal, e.g. agent-2.' }],
      flags: [
        json,
        {
          name: 'expiresIn',
          kind: 'value',
          placeholder: '<duration>',
          describe: 'Token lifetime, e.g. 30d. Never expires when omitted.',
        },
        ...remoteFlags,
      ],
    }),
    sub(['tokens', 'revoke'], "Revoke every active token of a principal (or one token's id)", {
      args: [
        {
          name: 'principal',
          required: true,
          describe: 'Principal, credential id, or public prefix.',
        },
      ],
      flags: [json, ...remoteFlags],
    }),
  ],
  defaultSubcommand: null,
  args: [],
};

/** `channels`: notification channels over a running server's REST API. */
export const CHANNELS_COMMAND: CommandDescriptor = {
  name: 'channels',
  summary: 'List, test and preview notification channels',
  description:
    'Talks to a running server over its REST API (--url, default the configured host and port) with an operator bearer (--token) or the dashboard cookie (--cookie). test sends a real message and exits 1 when the platform refused it; preview sends nothing.',
  flags: [],
  configKeys: ['host', 'port', 'config', 'color'],
  subcommands: [
    sub(['list'], 'List channels with status, target, secret variables and 24 h counts', {
      flags: [json, ...remoteFlags],
    }),
    sub(['test'], 'Send a real test message through a channel', {
      args: [{ name: 'name', required: true, describe: 'Channel name.' }],
      flags: [json, ...remoteFlags],
    }),
    sub(['preview'], 'Print the platform request a channel would send (sends nothing)', {
      args: [{ name: 'name', required: true, describe: 'Channel name.' }],
      flags: [
        json,
        {
          name: 'sample',
          kind: 'value',
          placeholder: '<kind>',
          describe:
            'Sample notification: attention, attention-resolved, vault-confirm, tool-errors, crash, degraded, test, digest or anomaly.',
          defaultText: 'attention',
        },
        ...remoteFlags,
      ],
    }),
  ],
  defaultSubcommand: ['list'],
  args: [],
};
