/** @module infra/logging/color — ANSI helpers and FORCE_COLOR/NO_COLOR/TERM/TTY resolution from an injected env (spec 10 §4.2). */

/** Environment variables as an immutable record (the injected `HostEnvironment.env`). */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** The `color` config key: `auto` honours the environment, the others force. */
export type ColorMode = 'auto' | 'always' | 'never';

/** ANSI SGR sequences. Kept tiny so colour output needs no dependency. */
export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
} as const;

/** Wraps `text` in the given SGR codes when painting is enabled; returns it unchanged otherwise. */
export type Paint = (text: string, ...codes: string[]) => string;

/** Builds a {@link Paint} that emits ANSI only when `enabled`. Empty text is never painted. */
export function createPaint(enabled: boolean): Paint {
  return (text, ...codes) =>
    enabled && text.length > 0 && codes.length > 0 ? `${codes.join('')}${text}${ANSI.reset}` : text;
}

/**
 * Resolves whether to emit colour for a stream, given the injected environment.
 * Precedence (the common CLI convention): `FORCE_COLOR` (≠ `0`) → on; `NO_COLOR` non-empty → off;
 * `TERM=dumb` → off; else the stream's TTY-ness. `mode` `always`/`never` short-circuits.
 */
export function resolveColor(mode: ColorMode, env: EnvRecord, isTTY: boolean): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '0') return true;
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  if (env['TERM'] === 'dumb') return false;
  return isTTY;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the SGR introducer we strip.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Removes SGR sequences (tests, width measurement). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
