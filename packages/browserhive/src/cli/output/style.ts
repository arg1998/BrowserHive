/** @module cli/output/style — colour decision (`--color`, `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, TTY) and picocolors-based styling (spec 08 §7.2, D-19) */
import picocolors from 'picocolors';

/** The `color` config key. */
export type ColorMode = 'auto' | 'always' | 'never';

/** Styling functions; identity functions when colour is off. */
export interface Style {
  readonly enabled: boolean;
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly underline: (text: string) => string;
  readonly cyan: (text: string) => string;
  readonly green: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly red: (text: string) => string;
}

/**
 * Whether to emit colour on a stream. `always`/`never` short-circuit; `auto` honours
 * `FORCE_COLOR` (≠ `0`) → on, `NO_COLOR` (non-empty) → off, `TERM=dumb` → off, else the TTY.
 *
 * @returns `true` when ANSI styling should be written.
 */
export function resolveColorEnabled(
  mode: ColorMode,
  env: Readonly<Record<string, string | undefined>>,
  isTty: boolean,
): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '' && force !== '0') return true;
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  if (env['TERM'] === 'dumb') return false;
  return isTty;
}

/**
 * Builds a {@link Style}; with `enabled=false` every function returns its input unchanged.
 *
 * @returns The style functions.
 */
export function createStyle(enabled: boolean): Style {
  const colors = picocolors.createColors(enabled);
  return {
    enabled,
    bold: (text) => colors.bold(text),
    dim: (text) => colors.dim(text),
    underline: (text) => colors.underline(text),
    cyan: (text) => colors.cyan(text),
    green: (text) => colors.green(text),
    yellow: (text) => colors.yellow(text),
    red: (text) => colors.red(text),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces the SGR sequences we strip.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Removes SGR sequences (width measurement, goldens).
 *
 * @returns `text` without ANSI styling.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Printable width of `text` (ANSI stripped; code points, not UTF-16 units).
 *
 * @returns The column count.
 */
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

/**
 * Pads `text` on the right to `width` visible columns.
 *
 * @returns The padded text.
 */
export function padVisible(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const gap = Math.max(0, width - visibleWidth(text));
  return align === 'left' ? `${text}${' '.repeat(gap)}` : `${' '.repeat(gap)}${text}`;
}
