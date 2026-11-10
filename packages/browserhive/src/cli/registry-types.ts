/** @module cli/registry-types — the registry's vocabulary (command words, flag, argument, subcommand and command descriptors); a leaf module so the registry files share it without import cycles */
import type { ConfigKey } from '@browserhive/contracts/config';

/** Every command word. */
export const COMMAND_NAMES = [
  'serve',
  'init',
  'doctor',
  'purge',
  'config',
  'db',
  'admin',
  'channels',
  'templates',
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
