/** @module cli/plan-args — argv classification helpers for `planCli`: tokenizing against the registry, unknown/stray flag messages with "did you mean" hints, subcommand matching and command-flag value parsing */
import {
  CONFIG_KEYS,
  type ConfigKey,
  lookupKey,
  zBool,
  zDuration,
  zUrl,
} from '@browserhive/contracts/config';
import {
  camelFromKebab,
  keyKind,
  suggest,
  suggestKey,
  type TokenizedArgs,
  tokenizeArgs,
  UNSUPPORTED_HINT,
  withSuggestion,
} from '@browserhive/core/config';
import {
  type AcceptedFlags,
  allCommandFlags,
  COMMAND_NAMES,
  type CommandDescriptor,
  commandsAccepting,
  type SubcommandDescriptor,
} from './registry.ts';

const COMMAND_FLAGS = allCommandFlags();

/**
 * Tokenize argv against the whole registry (every command flag and every config key is "known",
 * so a flag of another command is reported as stray, not unknown).
 *
 * @returns The tokenized argv.
 */
export function tokenizeCli(argv: readonly string[]): TokenizedArgs {
  return tokenizeArgs(argv, {
    known: (name) => COMMAND_FLAGS.has(name) || lookupKey('cli', `--${name}`).kind !== 'unknown',
    isBoolean: (name) => {
      const flag = COMMAND_FLAGS.get(name);
      if (flag !== undefined) return flag.kind === 'boolean';
      const found = lookupKey('cli', `--${name}`);
      return found.kind === 'key' && keyKind(found.key) === 'boolean';
    },
  });
}

/**
 * `browserhive --help` or `browserhive <command> --help`: the hint appended to usage errors.
 *
 * @returns The help command text.
 */
export function helpCommand(invocationName: string | null): string {
  return invocationName === null || invocationName === 'serve'
    ? "'browserhive --help'"
    : `'browserhive ${invocationName} --help'`;
}

/**
 * The message for one unknown long flag: an unsupported spelling (kebab-case, or a registry alias
 * such as `--pretty-logs`) gets "did you mean --logFormat"-style hints naming the supported flag; a
 * removed key gets the removed-key hint; otherwise Damerau-Levenshtein over the invocation's flags,
 * then over every flag.
 *
 * @returns The message without the `browserhive: ` prefix.
 */
export function unknownFlagMessage(
  flag: string,
  accepted: AcceptedFlags,
  invocationName: string | null,
): string {
  const base = `unknown flag '${flag}'.`;
  const tail = ` Run ${helpCommand(invocationName)}.`;
  const bare = flag.replace(/^--?/, '');
  const ownNames = [...accepted.flags.keys()];
  const camel = camelFromKebab(bare);
  if (camel !== bare) {
    const own = ownNames.find((name) => name.toLowerCase() === camel.toLowerCase());
    if (own !== undefined) return `${withSuggestion(base, [`--${own}`])}${tail}`;
  }
  const configKeys: readonly ConfigKey[] = [...accepted.configKeys];
  const fromConfig = suggestKey(flag, 'cli', configKeys.length > 0 ? configKeys : CONFIG_KEYS);
  if (fromConfig.removed) return `${base} ${UNSUPPORTED_HINT}${tail}`;
  const ownSuggestions = suggest(
    bare,
    ownNames.filter((name) => name !== 'help' && name !== 'version'),
  ).map((name) => `--${name}`);
  const suggestions = [...ownSuggestions, ...fromConfig.suggestions].slice(0, 3);
  if (suggestions.length > 0) return `${withSuggestion(base, suggestions)}${tail}`;
  const anywhere = suggest(bare, [...COMMAND_FLAGS.keys()]).map((name) => `--${name}`);
  return `${withSuggestion(base, anywhere.slice(0, 2))}${tail}`;
}

/**
 * The message for an unknown command word (`browserhive doctr`).
 *
 * @returns The message without the `browserhive: ` prefix.
 */
export function unknownCommandMessage(word: string): string {
  const suggestions = suggest(word, COMMAND_NAMES);
  return `${withSuggestion(`unknown command '${word}'.`, suggestions)} Run 'browserhive --help'.`;
}

/**
 * The message for a flag that exists but is not accepted by this invocation.
 *
 * @returns The message without the `browserhive: ` prefix.
 */
export function strayFlagMessage(name: string, invocationName: string): string {
  const owners = COMMAND_FLAGS.has(name) ? commandsAccepting(name) : [];
  const where =
    owners.length === 1
      ? `--${name} only applies to 'browserhive ${owners[0]}'.`
      : `--${name} is not accepted by 'browserhive ${invocationName}'.`;
  return `${where} Run ${helpCommand(invocationName)}.`;
}

/** Whether `name` is accepted by the invocation (command flag, config key, or reserved key where all keys are). */
export function isAccepted(name: string, accepted: AcceptedFlags): boolean {
  if (accepted.flags.has(name)) return true;
  const found = lookupKey('cli', `--${name}`);
  if (found.kind === 'key') return accepted.configKeys.has(found.key);
  if (found.kind === 'reserved') return accepted.configKeys.size === CONFIG_KEYS.length;
  return false;
}

/** Outcome of matching positionals against a command's subcommands. */
export type SubcommandMatch =
  | {
      readonly ok: true;
      readonly subcommand: SubcommandDescriptor | undefined;
      readonly args: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Longest subcommand whose words prefix the positionals; the default subcommand when none are
 * given; otherwise a usage message.
 *
 * @returns The match or the usage error.
 */
export function matchSubcommand(
  command: CommandDescriptor,
  positionals: readonly string[],
): SubcommandMatch {
  if (command.subcommands.length === 0)
    return { ok: true, subcommand: undefined, args: positionals };
  const matches = command.subcommands
    .filter((sub) => sub.words.every((word, index) => positionals[index] === word))
    .sort((a, b) => b.words.length - a.words.length);
  const found = matches[0];
  if (found !== undefined) {
    return { ok: true, subcommand: found, args: positionals.slice(found.words.length) };
  }
  if (positionals.length === 0 && command.defaultSubcommand !== null) {
    const words = command.defaultSubcommand;
    const fallback = command.subcommands.find((sub) => sub.words.join(' ') === words.join(' '));
    return { ok: true, subcommand: fallback, args: [] };
  }
  // A group prefix (`admin tokens`) narrows the expected words.
  const first = positionals[0];
  const group = command.subcommands.filter((sub) => sub.words.length > 1 && sub.words[0] === first);
  if (first !== undefined && group.length > 0) {
    const second = positionals[1];
    const options = group.map((sub) => sub.words[1] ?? '').join(', ');
    return {
      ok: false,
      message:
        second === undefined
          ? `'${command.name} ${first}' requires a subcommand: ${options}. Run 'browserhive ${command.name} --help'.`
          : `unknown subcommand '${second}' for '${command.name} ${first}'. Expected one of: ${options}.`,
    };
  }
  const options = [...new Set(command.subcommands.map((sub) => sub.words[0] ?? ''))].join(', ');
  if (first === undefined) {
    return {
      ok: false,
      message: `'${command.name}' requires a subcommand: ${options}. Run 'browserhive ${command.name} --help'.`,
    };
  }
  const suggestions = suggest(first, [
    ...new Set(command.subcommands.map((s) => s.words[0] ?? '')),
  ]);
  return {
    ok: false,
    message: withSuggestion(
      `unknown subcommand '${first}' for '${command.name}'. Expected one of: ${options}.`,
      suggestions,
    ),
  };
}

/** Last value of a flag, if given. */
export function lastValue(tokens: TokenizedArgs, name: string): string | undefined {
  return tokens.flags.get(name)?.at(-1);
}

/** Collects usage problems while reading command-flag values. */
export class FlagReader {
  readonly problems: string[] = [];

  constructor(private readonly tokens: TokenizedArgs) {}

  /** A boolean command flag (absent → `false`). */
  bool(name: string): boolean {
    const raw = lastValue(this.tokens, name);
    if (raw === undefined) return false;
    const parsed = zBool.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.problems.push(
      `invalid value for --${name}: '${raw}'. Expected a boolean: 'true', 'false', '1', '0', 'yes' or 'no'.`,
    );
    return false;
  }

  /** A string command flag; empty values are usage errors. */
  text(name: string): string | undefined {
    const raw = lastValue(this.tokens, name);
    if (raw === undefined) return undefined;
    if (raw.trim() === '') {
      this.problems.push(`--${name} is set but empty. Unset it or provide a value.`);
      return undefined;
    }
    return raw;
  }

  /** A duration command flag, in milliseconds. */
  duration(name: string): number | undefined {
    const raw = this.text(name);
    if (raw === undefined) return undefined;
    const parsed = zDuration.safeParse(raw);
    if (parsed.success && parsed.data > 0) return parsed.data;
    this.problems.push(
      `invalid value for --${name}: '${raw}'. Expected a duration like '30d', '12h', '90m'.`,
    );
    return undefined;
  }

  /** An absolute http(s) URL command flag. */
  url(name: string): string | undefined {
    const raw = this.text(name);
    if (raw === undefined) return undefined;
    const parsed = zUrl.safeParse(raw);
    if (parsed.success) return parsed.data.replace(/\/+$/, '');
    this.problems.push(
      `invalid value for --${name}: '${raw}'. Expected an absolute http: or https: URL like 'http://127.0.0.1:9876'.`,
    );
    return undefined;
  }

  /** An enum command flag. */
  oneOf(name: string, members: readonly string[]): string | undefined {
    const raw = this.text(name);
    if (raw === undefined) return undefined;
    if (members.includes(raw)) return raw;
    this.problems.push(
      `invalid value for --${name}: '${raw}'. Expected one of: ${members.join(', ')}.`,
    );
    return undefined;
  }
}

/**
 * Rebuilds the server-flag argv (config keys only, `--key=value`, in order) for `resolveConfig`.
 *
 * @returns The argv to resolve.
 */
export function serverArgv(tokens: TokenizedArgs): readonly string[] {
  const argv: string[] = [];
  for (const [name, values] of tokens.flags) {
    if (lookupKey('cli', `--${name}`).kind === 'unknown') continue;
    for (const value of values) argv.push(`--${name}=${value}`);
  }
  return argv;
}
