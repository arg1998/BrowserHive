/** @module cli/help — help text generated from the command registry and the config schema: USAGE, COMMANDS, FLAGS grouped by config group, defaults, secrets; width-aware (spec 08 §7.2) */
import {
  CONFIG_GROUPS,
  CONFIG_KEYS,
  type ConfigGroup,
  type ConfigKey,
  keyMeta,
  keysInGroup,
  namesFor,
} from '@browserhive/contracts/config';
import { keyKind } from '@browserhive/core/config';
import type { HelpTopic } from './invocation.ts';
import { padVisible, type Style, visibleWidth } from './output/style.ts';
import { wrapWords } from './output/text.ts';
import {
  type ArgumentDescriptor,
  COMMANDS,
  type CommandDescriptor,
  commandDescriptor,
  type FlagDescriptor,
  type SubcommandDescriptor,
} from './registry.ts';

/** Tagline after the version in the global help. */
export const TAGLINE = 'local-first stealth browser MCP server';
/** Docs link printed at the end of the global help. */
export const DOCS_URL = 'https://browserhive.ai/docs/configuration';
const PRECEDENCE =
  'Precedence: defaults < environment < browserhive.config.json < flags (rightmost wins).';
const INDENT = '  ';
const GAP = '  ';
const MAX_LABEL = 32;
/** Keeps `default: value` on one line; replaced by a space after wrapping. */
const NBSP = '\u00a0';

/** Rendering options. */
export interface HelpOptions {
  readonly version: string;
  readonly width: number;
  readonly style: Style;
}

const DERIVED_TEXT: Readonly<Record<string, string>> = {
  hostMemory: 'derived from host RAM',
  platform: 'OS data directory',
  stealth: 'true when stealth=max',
  admin: 'same as admin',
};

/**
 * Value placeholder of a config key for help (`<http|stdio>`, `<duration>`, none for booleans).
 *
 * @returns The placeholder, or `''` for booleans.
 */
export function placeholderFor(key: ConfigKey): string {
  const grammar = keyMeta(key).grammar ?? '';
  const kind = keyKind(key);
  if (kind === 'boolean') return '';
  if (kind === 'path') return '<path>';
  if (kind === 'duration') return '<duration>';
  if (kind === 'bytes') return '<bytes>';
  if (kind === 'map') return '<k=v,...>';
  if (kind === 'levelSpec') return '<level[,module=level]>';
  const oneOf = /^one of: (.+)$/.exec(grammar);
  if (oneOf?.[1] !== undefined) return `<${oneOf[1].split(', ').join('|')}>`;
  const subset = /subset of: (.+)$/.exec(grammar);
  if (subset?.[1] !== undefined) return `<${subset[1].split(', ').join(',')}>`;
  if (kind === 'list') return '<a,b,...>';
  if (key === 'port') return '<1-65535>';
  if (key === 'host') return '<address>';
  if (key === 'maxSessions') return '<n|unbounded>';
  if (grammar.startsWith('an integer')) return '<n>';
  if (grammar.startsWith('a number')) return '<0-1>';
  if (grammar.startsWith('an absolute')) return '<url>';
  return '<text>';
}

function renderDefault(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(String).join(',');
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).length === 0 ? 'none' : JSON.stringify(value);
  }
  return String(value);
}

/**
 * Human default of a key (`2h`, `derived from host RAM`), or `undefined` when it has none.
 *
 * @returns The default text.
 */
export function defaultTextFor(key: ConfigKey): string | undefined {
  const meta = keyMeta(key);
  if (meta.defaultText !== undefined) return meta.defaultText;
  if (meta.derivedFrom !== undefined) return DERIVED_TEXT[meta.derivedFrom] ?? 'derived';
  if (meta.default === undefined) return undefined;
  return renderDefault(meta.default);
}

interface FlagRow {
  readonly label: string;
  readonly description: string;
}

function configFlagRow(key: ConfigKey, style: Style): FlagRow {
  const meta = keyMeta(key);
  const placeholder = placeholderFor(key);
  const label = `${style.bold(`--${key}`)}${placeholder === '' ? '' : ` ${style.dim(placeholder)}`}`;
  const parts = [meta.describe];
  const fallback = defaultTextFor(key);
  if (fallback !== undefined) parts.push(`${style.dim('default:')}${NBSP}${style.cyan(fallback)}`);
  if (meta.secret) parts.push(style.yellow('[secret]'));
  return { label, description: parts.join(' ') };
}

function commandFlagRow(flag: FlagDescriptor, style: Style): FlagRow {
  const placeholder = flag.placeholder === undefined ? '' : ` ${style.dim(flag.placeholder)}`;
  const parts = [flag.describe];
  if (flag.defaultText !== undefined) {
    parts.push(`${style.dim('default:')}${NBSP}${style.cyan(flag.defaultText)}`);
  }
  return { label: `${style.bold(`--${flag.name}`)}${placeholder}`, description: parts.join(' ') };
}

function renderRows(rows: readonly FlagRow[], options: HelpOptions): string[] {
  const labelWidth = Math.min(MAX_LABEL, Math.max(0, ...rows.map((r) => visibleWidth(r.label))));
  const textWidth = Math.max(20, options.width - INDENT.length - labelWidth - GAP.length);
  const pad = ' '.repeat(INDENT.length + labelWidth + GAP.length);
  const lines: string[] = [];
  for (const row of rows) {
    const wrapped = wrapWords(row.description, textWidth).map((text) => text.replaceAll(NBSP, ' '));
    if (visibleWidth(row.label) > labelWidth) {
      lines.push(`${INDENT}${row.label}`);
      for (const text of wrapped) lines.push(`${pad}${text}`);
      continue;
    }
    wrapped.forEach((text, index) => {
      lines.push(
        index === 0
          ? `${INDENT}${padVisible(row.label, labelWidth)}${GAP}${text}`.trimEnd()
          : `${pad}${text}`,
      );
    });
  }
  return lines;
}

function paragraph(text: string, options: HelpOptions): string[] {
  return wrapWords(text, options.width).map((line) => line);
}

function header(text: string, style: Style): string {
  return style.underline(style.bold(text));
}

const GLOBAL_ROWS = (style: Style): readonly FlagRow[] => [
  { label: `${style.bold('-h')}, ${style.bold('--help')}`, description: 'Show help.' },
  { label: `${style.bold('-v')}, ${style.bold('--version')}`, description: 'Print the version.' },
];

function serverFlagSections(options: HelpOptions): string[] {
  const { style } = options;
  const lines: string[] = [];
  for (const group of CONFIG_GROUPS) {
    const keys = keysInGroup(group as ConfigGroup);
    if (keys.length === 0) continue;
    lines.push('', header(`FLAGS — ${group}`, style));
    lines.push(
      ...renderRows(
        keys.map((key) => configFlagRow(key, style)),
        options,
      ),
    );
  }
  return lines;
}

function footer(options: HelpOptions): string[] {
  return [
    '',
    ...paragraph(PRECEDENCE, options),
    ...paragraph(
      `Environment variables and JSON keys: ${options.style.bold('browserhive help config')}.`,
      options,
    ),
    `Docs: ${DOCS_URL}`,
  ];
}

/**
 * The global help (`browserhive --help`).
 *
 * @returns The help lines.
 */
export function renderGlobalHelp(options: HelpOptions): readonly string[] {
  const { style } = options;
  const nameWidth = Math.max(...COMMANDS.map((command) => command.name.length));
  const lines = [
    `${style.bold('browserhive')} ${options.version} — ${TAGLINE}`,
    '',
    header('USAGE', style),
    `${INDENT}browserhive [serve] [flags]`,
    `${INDENT}browserhive <command> [flags]`,
    '',
    header('COMMANDS', style),
    ...renderRows(
      COMMANDS.map((command) => ({
        label: style.bold(command.name.padEnd(nameWidth)),
        description: command.summary,
      })),
      options,
    ),
    '',
    header('GLOBAL FLAGS', style),
    ...renderRows(GLOBAL_ROWS(style), options),
    ...serverFlagSections(options),
    ...footer(options),
  ];
  return lines;
}

function argsLabel(args: readonly ArgumentDescriptor[]): string {
  return args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(' ');
}

function usageLine(command: CommandDescriptor, sub: SubcommandDescriptor | undefined): string {
  const words = [
    'browserhive',
    command.name,
    ...(sub?.words ?? []),
    argsLabel(sub?.args ?? command.args),
  ];
  return `${INDENT}${words.filter((word) => word !== '').join(' ')} [flags]`;
}

function ownFlagRows(
  command: CommandDescriptor,
  sub: SubcommandDescriptor | undefined,
  style: Style,
): FlagRow[] {
  const flags = [...command.flags, ...(sub?.flags ?? [])].map((f) => commandFlagRow(f, style));
  const keys = [...command.configKeys, ...(sub?.configKeys ?? [])];
  const everyKey = keys.length >= CONFIG_KEYS.length;
  if (everyKey) {
    flags.push({
      label: style.bold('<server flags>'),
      description: "Every flag of 'browserhive serve' (see 'browserhive serve --help').",
    });
  } else {
    flags.push(...keys.map((key) => configFlagRow(key, style)));
  }
  return flags;
}

function namesSection(options: HelpOptions): string[] {
  const { style } = options;
  const rows = CONFIG_KEYS.map((key) => {
    const names = namesFor(key);
    return { label: style.bold(names.cli), description: style.dim(names.env) };
  });
  return [
    '',
    header('NAMES', style),
    ...paragraph(
      'Every key has one flag, one environment variable and one JSON key (the flag without --).',
      options,
    ).map((line) => `${INDENT}${line}`),
    ...renderRows(rows, options),
  ];
}

/**
 * Help of one command or subcommand.
 *
 * @returns The help lines.
 */
export function renderCommandHelp(topic: HelpTopic, options: HelpOptions): readonly string[] {
  const { style } = options;
  if (topic.command === null) return renderGlobalHelp(options);
  const command = commandDescriptor(topic.command);
  const words = topic.subcommand;
  const sub =
    words === null
      ? undefined
      : command.subcommands.find((candidate) => candidate.words.join(' ') === words.join(' '));
  const title = sub === undefined ? command.name : `${command.name} ${sub.words.join(' ')}`;
  const summary = sub?.summary ?? command.summary;
  const lines: string[] = [
    `${style.bold(`browserhive ${title}`)} — ${summary}`,
    '',
    header('USAGE', style),
  ];

  if (command.name === 'serve') {
    lines.push(
      `${INDENT}browserhive [serve] [flags]`,
      '',
      ...paragraph(command.description, options),
    );
    lines.push('', header('GLOBAL FLAGS', style), ...renderRows(GLOBAL_ROWS(style), options));
    lines.push(...serverFlagSections(options), ...footer(options));
    return lines;
  }

  if (sub === undefined && command.subcommands.length > 0) {
    lines.push(...command.subcommands.map((candidate) => usageLine(command, candidate)));
    lines.push('', ...paragraph(command.description, options), '', header('COMMANDS', style));
    lines.push(
      ...renderRows(
        command.subcommands.map((candidate) => ({
          label: style.bold(
            [...candidate.words, argsLabel(candidate.args)].filter((w) => w !== '').join(' '),
          ),
          description: candidate.summary,
        })),
        options,
      ),
    );
    const common = ownFlagRows(command, undefined, style);
    if (common.length > 0) {
      lines.push('', header('FLAGS', style), ...renderRows(common, options));
    }
    for (const candidate of command.subcommands) {
      const rows = ownFlagRows({ ...command, flags: [], configKeys: [] }, candidate, style);
      if (rows.length === 0) continue;
      lines.push('', header(`FLAGS — ${candidate.words.join(' ')}`, style));
      lines.push(...renderRows(rows, options));
    }
  } else {
    lines.push(usageLine(command, sub), '', ...paragraph(command.description, options));
    const args = sub?.args ?? command.args;
    if (args.length > 0) {
      lines.push('', header('ARGUMENTS', style));
      lines.push(
        ...renderRows(
          args.map((arg) => ({ label: style.bold(`<${arg.name}>`), description: arg.describe })),
          options,
        ),
      );
    }
    const rows = ownFlagRows(command, sub, style);
    if (rows.length > 0) lines.push('', header('FLAGS', style), ...renderRows(rows, options));
  }
  lines.push('', header('GLOBAL FLAGS', style), ...renderRows(GLOBAL_ROWS(style), options));
  if (command.name === 'config') lines.push(...namesSection(options));
  return lines;
}
