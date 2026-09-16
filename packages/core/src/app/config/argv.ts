/** @module app/config/argv — pure argv tokenizer for `--key value`, `--key=value`, booleans, `--noKey`, `--` (spec 08 §2, §7) */

/** Result of {@link tokenizeArgs}. */
export interface TokenizedArgs {
  /** Long flags by bare name (without `--`), every occurrence in order (rightmost wins for scalars, all kept for lists). */
  readonly flags: ReadonlyMap<string, readonly string[]>;
  /** Single-dash short flags (`-h`, `-v`), one entry per letter, in order. */
  readonly shortFlags: readonly string[];
  /** Non-flag tokens, including everything after `--`. */
  readonly positionals: readonly string[];
  /** Long flags the `known` predicate rejected, as typed (`--max-sessions`), in order, de-duplicated. */
  readonly unknown: readonly string[];
  /** Value-taking flags that ended the argv without a value (`--port`), as typed. */
  readonly missingValue: readonly string[];
}

/** Predicates the tokenizer needs to disambiguate `--flag value` from `--flag positional`. */
export interface TokenizeOptions {
  /**
   * `true` when the bare flag name is a boolean: the flag never consumes the next token
   * (`--admin serve` keeps `serve` a positional) and `--no<Name>` negates it.
   */
  readonly isBoolean?: (name: string) => boolean;
  /** `true` when the bare flag name is registered; unknown flags are collected, never consume a value. */
  readonly known?: (name: string) => boolean;
}

/** Bare name of the `--no<Name>` negation of a boolean flag, or `undefined` when `name` is not of that shape. */
export function negatedName(name: string): string | undefined {
  const match = /^no([A-Z][A-Za-z0-9]*)$/.exec(name);
  const rest = match?.[1];
  if (rest === undefined) return undefined;
  return rest.charAt(0).toLowerCase() + rest.slice(1);
}

/**
 * Tokenize argv with the flag grammar of spec 08 §2.1: `--key value`, `--key=value`, `--bool`,
 * `--bool=false`, `--noBool`, repeated flags kept in order, `--` ends flag parsing. Pure; no
 * registry knowledge beyond the injected predicates (defaults: every flag is known and value-taking).
 *
 * @returns The tokenized flags, positionals and the flags that need reporting.
 */
export function tokenizeArgs(
  argv: readonly string[],
  options: TokenizeOptions = {},
): TokenizedArgs {
  const isBoolean = options.isBoolean ?? (() => false);
  const known = options.known ?? (() => true);
  const flags = new Map<string, string[]>();
  const shortFlags: string[] = [];
  const positionals: string[] = [];
  const unknown: string[] = [];
  const missingValue: string[] = [];

  const push = (name: string, value: string): void => {
    const list = flags.get(name);
    if (list === undefined) flags.set(name, [value]);
    else list.push(value);
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? '';
    index += 1;
    if (token === '--') {
      positionals.push(...argv.slice(index));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      const inlineValue = eq < 0 ? undefined : token.slice(eq + 1);
      if (name === '') {
        positionals.push(token);
        continue;
      }
      if (isBoolean(name) && known(name)) {
        push(name, inlineValue ?? 'true');
        continue;
      }
      const negated = negatedName(name);
      if (
        negated !== undefined &&
        isBoolean(negated) &&
        known(negated) &&
        inlineValue === undefined
      ) {
        push(negated, 'false');
        continue;
      }
      if (!known(name)) {
        if (!unknown.includes(`--${name}`)) unknown.push(`--${name}`);
        // An unknown flag is fatal anyway; swallow its probable value so it is reported once.
        const next = argv[index];
        if (inlineValue === undefined && next !== undefined && !next.startsWith('-')) index += 1;
        continue;
      }
      if (inlineValue !== undefined) {
        push(name, inlineValue);
        continue;
      }
      const next = argv[index];
      if (next === undefined || next.startsWith('--')) {
        missingValue.push(`--${name}`);
        continue;
      }
      push(name, next);
      index += 1;
      continue;
    }
    if (token.length > 1 && token.startsWith('-') && /^-[A-Za-z]+$/.test(token)) {
      shortFlags.push(...[...token.slice(1)].map((letter) => `-${letter}`));
      continue;
    }
    positionals.push(token);
  }

  return { flags, shortFlags, positionals, unknown, missingValue };
}
