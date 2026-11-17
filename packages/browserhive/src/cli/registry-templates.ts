/** @module cli/registry-templates — the `templates` command as registry data: list, show, create, finish, login, probe, seed, versions, save, restore, host, disable, enable and rm over a running server's REST API, and the local rekey (spec 13 §7.2, §8, §11.5) */

import { jsonFlag, serverFlags, sub } from './registry-parts.ts';
import type { CommandDescriptor, FlagDescriptor } from './registry-types.ts';

/** Default of `templates create --timeout` (spec 13 §11.5). */
export const TEMPLATE_CREATE_TIMEOUT_TEXT = '30m';

const createFlags: readonly FlagDescriptor[] = [
  {
    name: 'sites',
    kind: 'value',
    placeholder: '<site,…>',
    describe: 'Sites to sign in to, comma-separated (linkedin.com,indeed.com). Required.',
  },
  {
    name: 'displayName',
    kind: 'value',
    placeholder: '<text>',
    describe: 'Name shown in the dashboard.',
    defaultText: 'the name',
  },
  { name: 'description', kind: 'value', placeholder: '<text>', describe: 'What it is for.' },
  {
    name: 'channel',
    kind: 'value',
    placeholder: '<chromium|chrome|edge>',
    describe: "The template's browser.",
    defaultText: 'defaultChannel',
  },
  {
    name: 'headless',
    kind: 'boolean',
    describe: "Run the template's browser without a window. Sites may challenge it more often.",
  },
  {
    name: 'stealth',
    kind: 'value',
    placeholder: '<off|standard|max>',
    describe: "Stealth level of the template's browser.",
    defaultText: 'stealth',
  },
  {
    name: 'proxy',
    kind: 'value',
    placeholder: '<url>',
    describe: "Proxy the template's browser always uses (http://host:port).",
  },
  {
    name: 'proxyUsername',
    kind: 'value',
    placeholder: '<name>',
    describe: 'Proxy user name (needs --proxy).',
  },
  {
    name: 'proxyPasswordEnv',
    kind: 'value',
    placeholder: '<ENV>',
    describe:
      "Environment variable holding the proxy password on the server's machine (needs --proxy). The password itself is never passed.",
  },
  {
    name: 'locale',
    kind: 'value',
    placeholder: '<tag>',
    describe: 'Language the browser reports (en-CA).',
  },
  {
    name: 'timezone',
    kind: 'value',
    placeholder: '<iana>',
    describe: 'Time zone the browser reports (America/Toronto).',
  },
  {
    name: 'maxConcurrent',
    kind: 'value',
    placeholder: '<1-20>',
    describe: 'Sessions that may use the template at once.',
    defaultText: '5',
  },
  {
    name: 'allPrincipals',
    kind: 'boolean',
    describe: 'Let every agent principal use the template.',
  },
  {
    name: 'principal',
    kind: 'value',
    placeholder: '<subject>',
    describe:
      'Let this agent principal use the template (repeatable). Under auth=token one of --allPrincipals or --principal is required.',
  },
  {
    name: 'denyClipboardWrites',
    kind: 'boolean',
    describe:
      "Pages in the template's browser cannot write your clipboard (sites can detect it). Change it later with 'templates clipboard'.",
  },
  {
    name: 'noLogin',
    kind: 'boolean',
    describe: 'Create the template and exit without opening a sign-in window.',
  },
  {
    name: 'fromState',
    kind: 'value',
    placeholder: '<file>',
    describe:
      'Seed the template from a Playwright storage-state file (≤ 16 MiB) instead of opening a sign-in window. The file is read in memory and never stored in plain text.',
  },
  {
    name: 'timeout',
    kind: 'value',
    placeholder: '<duration>',
    describe:
      "How long to wait for the sign-ins. The template then stays in setup; 'templates finish' completes it.",
    defaultText: TEMPLATE_CREATE_TIMEOUT_TEXT,
  },
  {
    name: 'yes',
    kind: 'boolean',
    describe:
      'Approve the site packs of the sites without asking (each is printed with its version and SHA-256 first). Required without a terminal when a site has a pack to approve.',
  },
  jsonFlag,
  ...serverFlags,
];

const nameArg = { name: 'name', required: true, describe: 'Template name.' } as const;
const yesFlag: FlagDescriptor = {
  name: 'yes',
  kind: 'boolean',
  describe: 'Skip the confirmation prompt.',
};
const remoteJson: readonly FlagDescriptor[] = [jsonFlag, ...serverFlags];

/** `templates login | probe` (T2): sign a site in again, and check the sites now. */
const healthSubcommands = [
  sub(['login'], 'Sign a template in to one of its sites again', {
    args: [nameArg],
    flags: [
      {
        name: 'site',
        kind: 'value',
        placeholder: '<site>',
        describe: 'The site to sign in to again (linkedin.com). Required.',
      },
      {
        name: 'method',
        kind: 'value',
        placeholder: '<window|vault>',
        describe:
          "window opens a sign-in window at the site on the machine running the server; vault fills the site's linked vault login there, in the background.",
        defaultText: 'window',
      },
      {
        name: 'timeout',
        kind: 'value',
        placeholder: '<duration>',
        describe: 'How long to wait for the sign-in. The re-login is then cancelled.',
        defaultText: TEMPLATE_CREATE_TIMEOUT_TEXT,
      },
      {
        name: 'letAgentsContinue',
        kind: 'boolean',
        describe:
          "Do not pause the template's agents while the window is open. They may then type into or navigate pages while you sign in.",
      },
      ...remoteJson,
    ],
  }),
  sub(['probe'], "Check now whether a template's sites are still signed in", {
    args: [nameArg],
    flags: [
      {
        name: 'site',
        kind: 'value',
        placeholder: '<site>',
        describe: 'Check only this site.',
        defaultText: 'every enabled site',
      },
      ...remoteJson,
    ],
  }),
];

/** `templates show | seed | versions | save | restore | host | disable | enable | rekey` (T1b). */
const operationSubcommands = [
  sub(['show'], "Show a template, its browser and its sites' sign-in state", {
    args: [nameArg],
    flags: remoteJson,
  }),
  sub(['seed'], 'Replace the sign-ins of a template with a storage-state file', {
    args: [
      nameArg,
      {
        name: 'file',
        required: true,
        describe:
          'Playwright storage-state JSON (save_storage_state, --save-storage), ≤ 16 MiB. Read in memory, never stored in plain text.',
      },
    ],
    flags: [...remoteJson, yesFlag],
  }),
  sub(['versions'], 'List the saved versions of a template and its rolling checkpoint', {
    args: [nameArg],
    flags: remoteJson,
  }),
  sub(['save'], "Save the running browser's sign-ins as a new version", {
    args: [nameArg],
    flags: remoteJson,
  }),
  sub(['restore'], 'Roll a template back to a saved version or its rolling checkpoint', {
    args: [
      nameArg,
      {
        name: 'version',
        required: true,
        describe:
          'A version number (as listed by browserhive templates versions), or latest (the rolling checkpoint).',
      },
    ],
    flags: [
      ...remoteJson,
      {
        name: 'forceClose',
        kind: 'boolean',
        describe:
          "Close the template's sessions at once instead of waiting for them (up to templateDrainTimeout).",
      },
      yesFlag,
    ],
  }),
  sub(['host'], "Start, stop or restart a template's browser", {
    args: [nameArg, { name: 'action', required: true, describe: 'start, stop or restart.' }],
    flags: remoteJson,
  }),
  sub(['clipboard'], "Deny or allow clipboard writes by the pages in a template's browser", {
    args: [
      nameArg,
      {
        name: 'mode',
        required: true,
        describe: 'deny (pages cannot write your clipboard; sites can detect it) or allow.',
      },
    ],
    flags: remoteJson,
  }),
  sub(['disable'], 'Disable a template: close its sessions and refuse new ones', {
    args: [nameArg],
    flags: remoteJson,
  }),
  sub(['enable'], 'Enable a disabled template', { args: [nameArg], flags: remoteJson }),
  sub(['rekey'], 'Re-encrypt every template file with the current key (server stopped)', {
    flags: [
      {
        name: 'oldKeyEnv',
        kind: 'value',
        placeholder: '<ENV>',
        describe:
          'Environment variable holding the old key (base64 of 32 bytes). Required. The key itself is never passed as an argument.',
      },
      jsonFlag,
    ],
    configKeys: ['dataDir'],
  }),
];

/** `templates`. */
export const TEMPLATES_COMMAND: CommandDescriptor = {
  name: 'templates',
  summary: 'Create, inspect, check, sign in, seed, version, restore and delete session templates',
  description:
    'Talks to a running server over its REST API (--url, default the configured host and port) with an operator bearer (--token) or the dashboard cookie (--cookie). create and login open a sign-in window on the machine running the server, wherever the CLI runs, and wait until the sites are signed in, you press Enter, or --timeout passes. create, finish, login and probe exit 0 when every site is signed in, 2 when one is not, 1 on an API error. seed and restore run on the server and the CLI waits for them. rekey is the exception: it runs locally against the data directory with the server stopped.',
  flags: [],
  configKeys: ['host', 'port', 'config', 'color'],
  subcommands: [
    sub(['list'], 'List templates with their sites, status, browser state and sessions', {
      flags: [jsonFlag, ...serverFlags],
    }),
    sub(['create'], 'Create a template and sign in to its sites in a window on the server', {
      args: [
        {
          name: 'name',
          required: true,
          describe: 'Template name agents use: 2–32 characters, a–z first, then a–z, 0–9 or -.',
        },
      ],
      flags: createFlags,
    }),
    sub(['finish'], 'Complete a template left in setup: check its sign-ins and set it ready', {
      args: [{ name: 'name', required: true, describe: 'Template name.' }],
      flags: [jsonFlag, ...serverFlags],
    }),
    sub(['rm'], 'Delete a template and its browser profile (does not sign out at the sites)', {
      args: [{ name: 'name', required: true, describe: 'Template name.' }],
      flags: [
        jsonFlag,
        {
          name: 'force',
          kind: 'boolean',
          describe: 'Close the sessions launched from the template first.',
        },
        yesFlag,
        ...serverFlags,
      ],
    }),
    ...healthSubcommands,
    ...operationSubcommands,
  ],
  defaultSubcommand: ['list'],
  args: [],
};
