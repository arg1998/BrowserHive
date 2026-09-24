/** @module cli/registry — the command surface as data: commands, subcommands, positional arguments and command-owned flags (spec 08 §7, spec 12 §11) */
import { CONFIG_KEYS, type ConfigKey } from '@browserhive/contracts/config';

/** Every command word. */
export const COMMAND_NAMES = [
  'serve',
  'init',
  'doctor',
  'purge',
  'config',
  'db',
  'admin',
  'version',
  'help',
] as const;
/** A command word. */
export type CommandName = (typeof COMMAND_NAMES)[number];

/**
 * Whether `word` is a command word.
 *
 * @returns `true` for the words in {@link COMMAND_NAMES}.
 */
export function isCommandName(word: string): word is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(word);
}

/** A flag owned by a command (not a config key). */
export interface FlagDescriptor {
  /** Bare name, camelCase (`dryRun`). */
  readonly name: string;
  /** Booleans never consume the next token; `--noName` negates. */
  readonly kind: 'boolean' | 'value';
  /** Value placeholder for help (`<path>`). */
  readonly placeholder?: string;
  readonly describe: string;
  /** Human default for help. */
  readonly defaultText?: string;
}

/** A positional argument of a subcommand. */
export interface ArgumentDescriptor {
  readonly name: string;
  readonly required: boolean;
  readonly describe: string;
}

/** A subcommand (`db restore`, `admin tokens create`). */
export interface SubcommandDescriptor {
  /** Words after the command (`['tokens', 'create']`). */
  readonly words: readonly string[];
  readonly summary: string;
  readonly args: readonly ArgumentDescriptor[];
  readonly flags: readonly FlagDescriptor[];
  /** Config keys accepted as flags in addition to the command's own. */
  readonly configKeys: readonly ConfigKey[];
}

/** A command. */
export interface CommandDescriptor {
  readonly name: CommandName;
  readonly summary: string;
  /** Longer help paragraph. */
  readonly description: string;
  /** Flags accepted by the command and every subcommand. */
  readonly flags: readonly FlagDescriptor[];
  /** Config keys accepted as flags by the command and every subcommand. */
  readonly configKeys: readonly ConfigKey[];
  readonly subcommands: readonly SubcommandDescriptor[];
  /** Subcommand words used when none is given (`config` → `show`); `null` = a subcommand is required. */
  readonly defaultSubcommand: readonly string[] | null;
  /** Positional arguments of a command without subcommands (`help [command]`). */
  readonly args: readonly ArgumentDescriptor[];
}

const json: FlagDescriptor = {
  name: 'json',
  kind: 'boolean',
  describe: 'Print machine-readable JSON instead of text.',
};
const dataDirKeys: readonly ConfigKey[] = ['dataDir', 'config', 'color'];
const remoteFlags: readonly FlagDescriptor[] = [
  {
    name: 'url',
    kind: 'value',
    placeholder: '<url>',
    describe:
      'Talk to a running server over its REST API instead of opening the database (http://127.0.0.1:9876).',
  },
  {
    name: 'token',
    kind: 'value',
    placeholder: '<bearer>',
    describe: 'Operator bearer token for --url (bh_operator_…).',
  },
  {
    name: 'cookie',
    kind: 'value',
    placeholder: '<value>',
    describe: 'Dashboard session cookie value for --url (browserhive_session).',
  },
];

function sub(
  words: readonly string[],
  summary: string,
  options: {
    readonly args?: readonly ArgumentDescriptor[];
    readonly flags?: readonly FlagDescriptor[];
    readonly configKeys?: readonly ConfigKey[];
  } = {},
): SubcommandDescriptor {
  return {
    words,
    summary,
    args: options.args ?? [],
    flags: options.flags ?? [],
    configKeys: options.configKeys ?? [],
  };
}

/** The command registry, in help order. */
export const COMMANDS: readonly CommandDescriptor[] = [
  {
    name: 'serve',
    summary: 'Start the MCP server (default)',
    description:
      'Resolves the configuration (defaults < environment < browserhive.config.json < flags), starts the server and waits for a signal. Every configuration key is a flag.',
    flags: [],
    configKeys: CONFIG_KEYS,
    subcommands: [],
    defaultSubcommand: null,
    args: [],
  },
  {
    name: 'init',
    summary: 'Install browsers and prepare the data directory',
    description:
      'Creates the data directory (0700), installs Chromium for Playwright (and Patchright when stealthDriver is auto or patchright), reports the browsers on this host and whether each can run sandboxed, lets you pick the default browser on a terminal (Enter keeps the current one), creates and migrates the database, then prints the next steps. Safe to re-run; never prompts without a terminal, in CI or in a container.',
    flags: [
      {
        name: 'browsers',
        kind: 'value',
        placeholder: '<chromium>',
        describe: 'Browsers to install. chrome and edge are branded channels installed by the OS.',
        defaultText: 'chromium',
      },
      { name: 'force', kind: 'boolean', describe: 'Re-download browsers even when installed.' },
      {
        name: 'skipBrowsers',
        kind: 'boolean',
        describe: 'Skip the browser download (data directory and database only).',
      },
      {
        name: 'writeSchema',
        kind: 'boolean',
        describe: 'Write browserhive.schema.json next to the config file in use.',
      },
      {
        name: 'channel',
        kind: 'value',
        placeholder: '<chromium|chrome|edge>',
        describe:
          'Make this the default browser (defaultChannel) and save it to the config file. Without a terminal it needs --yes.',
      },
      {
        name: 'installChrome',
        kind: 'boolean',
        describe:
          "Install Google Chrome with Google's installer (playwright install chrome; needs administrator rights).",
      },
      {
        name: 'yes',
        kind: 'boolean',
        describe: 'Save the --channel choice without asking.',
      },
    ],
    configKeys: ['dataDir', 'config', 'stealthDriver', 'color'],
    subcommands: [],
    defaultSubcommand: null,
    args: [],
  },
  {
    name: 'doctor',
    summary: 'Check the host, browsers, and configuration',
    description:
      'Runs every host check and prints a table. Exit 0 when all checks pass, 1 when any fails, 2 for warnings only. Accepts the server flags so the checks see the configuration serve would use. Checks launch each installed browser once to test the sandbox.',
    flags: [
      json,
      {
        name: 'printApparmorProfile',
        kind: 'boolean',
        describe:
          'Print an AppArmor profile that lets the configured browser sandbox on Ubuntu 23.10+, then exit. Install it with sudo tee /etc/apparmor.d/<name>; nothing is installed for you.',
      },
    ],
    configKeys: CONFIG_KEYS,
    subcommands: [],
    defaultSubcommand: null,
    args: [],
  },
  {
    name: 'purge',
    summary: 'Delete local state after an inventory and confirmation',
    description:
      'Prints an inventory of the data directory and asks you to type YES. Deletes the database and session directories; --all also deletes saved auth states, uploads, backups and admin credentials (asks twice). Only the data directory is resolved, so purge works with an otherwise invalid configuration.',
    flags: [
      {
        name: 'all',
        kind: 'boolean',
        describe: 'Also delete auth states, uploads, backups and admin credentials.',
      },
      { name: 'dryRun', kind: 'boolean', describe: 'Print the inventory and delete nothing.' },
      {
        name: 'yes',
        kind: 'boolean',
        describe: 'Skip the confirmation prompts (required without a terminal).',
      },
    ],
    configKeys: dataDirKeys,
    subcommands: [],
    defaultSubcommand: null,
    args: [],
  },
  {
    name: 'config',
    summary: 'Show, validate, or export the configuration schema',
    description:
      'Every key exists as an environment variable (BROWSERHIVE_<SCREAMING_SNAKE>), a flag (--camelCase) and a JSON key (camelCase) in browserhive.config.json. A string in the file may reference an environment variable with {env:NAME} or {env:NAME:-default}; show names the variable in the SOURCE column (config-file via $NAME) and never prints a secret.',
    flags: [],
    configKeys: [],
    subcommands: [
      sub(['show'], 'Print the effective configuration with the source of every value', {
        flags: [json],
        configKeys: CONFIG_KEYS,
      }),
      sub(['schema'], 'Print the JSON Schema of browserhive.config.json'),
      sub(['validate'], 'Resolve the configuration and exit 64 on any problem, like serve', {
        configKeys: CONFIG_KEYS,
      }),
    ],
    defaultSubcommand: ['show'],
    args: [],
  },
  {
    name: 'db',
    summary: 'Inspect, back up, restore, or migrate the database',
    description:
      'Operates on <dataDir>/browserhive.db. restore refuses while a server is running on the data directory.',
    flags: [],
    configKeys: dataDirKeys,
    subcommands: [
      sub(
        ['status'],
        'Schema versions, application id, pending migrations, size, last backup, integrity',
        {
          flags: [json],
        },
      ),
      sub(['backup'], 'Write a consistent copy with VACUUM INTO', {
        flags: [
          {
            name: 'out',
            kind: 'value',
            placeholder: '<path>',
            describe: 'Backup file to write.',
            defaultText: '<dataDir>/backups/browserhive-v<N>-<timestamp>.db',
          },
        ],
      }),
      sub(['restore'], 'Replace the database with a backup (the current file is backed up first)', {
        args: [{ name: 'file', required: true, describe: 'Backup file to restore.' }],
        flags: [{ name: 'yes', kind: 'boolean', describe: 'Skip the confirmation prompt.' }],
      }),
      sub(['migrate'], 'Apply pending migrations', {
        flags: [
          {
            name: 'dryRun',
            kind: 'boolean',
            describe: 'List pending migrations and apply nothing.',
          },
          json,
        ],
      }),
    ],
    defaultSubcommand: null,
    args: [],
  },
  {
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
  },
  {
    name: 'version',
    summary: 'Print version information',
    description: 'Prints the BrowserHive, Bun, SQLite, Playwright and Patchright versions.',
    flags: [json],
    configKeys: [],
    subcommands: [],
    defaultSubcommand: null,
    args: [],
  },
  {
    name: 'help',
    summary: 'Show help for a command',
    description: "'browserhive help config' also lists the environment variable of every key.",
    flags: [],
    configKeys: [],
    subcommands: [],
    defaultSubcommand: null,
    args: [{ name: 'command', required: false, describe: 'Command to describe.' }],
  },
];

/**
 * The descriptor of a command.
 *
 * @returns The descriptor.
 */
export function commandDescriptor(name: CommandName): CommandDescriptor {
  const found = COMMANDS.find((command) => command.name === name);
  if (found === undefined) throw new TypeError(`unregistered command ${name}`);
  return found;
}

/** Global flags accepted everywhere (spec 08 §7). */
export const GLOBAL_FLAGS: readonly FlagDescriptor[] = [
  { name: 'help', kind: 'boolean', describe: 'Show help (also -h).' },
  { name: 'version', kind: 'boolean', describe: 'Print the version (also -v).' },
];

/** Flags and config keys accepted by one invocation. */
export interface AcceptedFlags {
  readonly flags: ReadonlyMap<string, FlagDescriptor>;
  readonly configKeys: ReadonlySet<ConfigKey>;
}

/**
 * The flags a command (and optional subcommand) accepts, globals included.
 *
 * @returns The accepted command flags and config keys.
 */
export function acceptedFlags(
  command: CommandDescriptor,
  subcommand: SubcommandDescriptor | undefined,
): AcceptedFlags {
  const flags = new Map<string, FlagDescriptor>();
  for (const flag of [...GLOBAL_FLAGS, ...command.flags, ...(subcommand?.flags ?? [])]) {
    flags.set(flag.name, flag);
  }
  return {
    flags,
    configKeys: new Set([...command.configKeys, ...(subcommand?.configKeys ?? [])]),
  };
}

/**
 * Every command-owned flag across the registry, by name (the "known anywhere" universe).
 *
 * @returns The flags by bare name.
 */
export function allCommandFlags(): ReadonlyMap<string, FlagDescriptor> {
  const flags = new Map<string, FlagDescriptor>();
  for (const flag of GLOBAL_FLAGS) flags.set(flag.name, flag);
  for (const command of COMMANDS) {
    for (const flag of command.flags) flags.set(flag.name, flag);
    for (const subcommand of command.subcommands) {
      for (const flag of subcommand.flags) flags.set(flag.name, flag);
    }
  }
  return flags;
}

/**
 * The commands (and subcommands) that accept a flag, for the stray-flag hint.
 *
 * @returns Invocation names like `purge` or `db migrate`.
 */
export function commandsAccepting(name: string): readonly string[] {
  const owners: string[] = [];
  for (const command of COMMANDS) {
    if (command.flags.some((flag) => flag.name === name)) owners.push(command.name);
    for (const subcommand of command.subcommands) {
      if (subcommand.flags.some((flag) => flag.name === name)) {
        owners.push(`${command.name} ${subcommand.words.join(' ')}`);
      }
    }
  }
  return owners;
}
