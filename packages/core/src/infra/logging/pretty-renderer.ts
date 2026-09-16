/** @module infra/logging/pretty-renderer — column-aligned TTY layout: `HH:MM:SS.mmm LEVEL message key=value …` (spec 10 §4.2). */

import type { SerializedError } from '../../kernel/errors/serialize-error.ts';
import type { LogLevel } from '../../ports/logger.ts';
import { ANSI, createPaint, type Paint } from './color.ts';
import type { LogRecord } from './record.ts';

/** Column widths. Chosen so the common lines align without wasting width. */
const TIME_WIDTH = 12; // `HH:MM:SS.mmm`
const LEVEL_WIDTH = 5; // `ERROR`

/**
 * Width of the message column. A longer message is not truncated — it pushes that line's fields
 * right, which breaks the alignment of the field column for as long as it keeps happening. So log
 * messages are written to fit: short fixed phrases, with the specifics as fields. The grep-rules
 * test scans the source and fails on any literal message wider than this.
 */
export const MAX_MESSAGE_LENGTH = 26;

/** Column the field tail starts at — also the indent continuation lines wrap to. */
export const FIELD_COLUMN = TIME_WIDTH + 1 + LEVEL_WIDTH + 1 + MAX_MESSAGE_LENGTH + 1;

/** Fallback terminal width when the stream reports none (a pipe, or a non-TTY). */
export const DEFAULT_TERMINAL_WIDTH = 120;

/** Narrowest width the renderer will lay out for. */
export const MIN_TERMINAL_WIDTH = 60;

/** Smallest field budget we'll wrap to, however narrow the terminal claims to be. */
const MIN_FIELD_BUDGET = 20;

/** Tag that stands in for the magenta highlight when colours are off. */
export const VAULT_TAG = '[vault]';

/**
 * Fields shown first, in this order, when present. They are the ones an operator scans for — what
 * happened to which session — so a fixed leading order makes consecutive lines comparable.
 */
export const FIELD_PRIORITY: readonly string[] = [
  'tool',
  'session_id',
  'slug',
  'url',
  'pattern',
  'code',
  'error_code',
  'result',
  'source',
  'event',
  'entry_name',
  'duration_ms',
  'result_size_bytes',
];

/**
 * Fields shown last, after everything else. These carry the long free text — a sentence of
 * advice, a stack trace — which wraps across lines, so anything short following it would be
 * marooned at the bottom of the block.
 */
export const FIELD_TRAILING: readonly string[] = ['detail', 'stack', 'err.stack'];

/** Record keys that are rendered elsewhere (columns) or are pure flags, never as `key=value`. */
const HIDDEN_KEYS: readonly string[] = [
  'ts',
  'level',
  'msg',
  'vault',
  'trace_id',
  'span_id',
  'err',
];

const LEVEL_COLOR: Readonly<Record<LogLevel, string>> = {
  error: ANSI.red,
  warn: ANSI.yellow,
  info: ANSI.cyan,
  debug: ANSI.dim,
  trace: ANSI.dim,
};

/** Options for {@link renderPretty}. */
export interface PrettyOptions {
  /** Emit ANSI colour. */
  readonly color: boolean;
  /** Terminal width for wrapping; clamped to {@link MIN_TERMINAL_WIDTH}. */
  readonly width?: number;
}

/**
 * Renders one human-readable line (or several, when the fields don't fit):
 *
 * ```
 * 14:23:07.412 INFO  tool call                  tool=navigate session_id=shop-a1b2 duration_ms=412
 * 14:23:07.998 WARN  tool call failed           tool=vault_fill session_id=shop-a1b2
 *                                               error_code=VAULT_FILL_AUTH_FAILED reported=true
 * ```
 *
 * Continuation lines are indented to the field column, which keeps the timestamp gutter
 * unambiguous: anything not starting with a time is a continuation. A token with no space in it
 * (a URL) overflows intact rather than being split.
 */
export function renderPretty(record: LogRecord, options: PrettyOptions): string {
  const paint = createPaint(options.color);
  const width = Math.max(MIN_TERMINAL_WIDTH, options.width ?? DEFAULT_TERMINAL_WIDTH);
  const isVault = record['vault'] === true;

  const timeCell = paint(clockTime(record.ts).padEnd(TIME_WIDTH), ANSI.dim);
  const levelCell = paint(
    record.level.toUpperCase().padEnd(LEVEL_WIDTH),
    ANSI.bold,
    LEVEL_COLOR[record.level],
  );
  // A message longer than its column pushes the fields right on that line rather than being cut.
  const messageText = isVault && !options.color ? `${record.msg} ${VAULT_TAG}` : record.msg;
  const messageCell = isVault
    ? paint(messageText, ANSI.magenta) +
      ' '.repeat(Math.max(0, MAX_MESSAGE_LENGTH - messageText.length))
    : messageText.padEnd(MAX_MESSAGE_LENGTH);

  const atoms = fieldAtoms(record);
  const head = `${timeCell} ${levelCell} ${messageCell}`;
  if (atoms.length === 0) return head.trimEnd();

  const budget = Math.max(MIN_FIELD_BUDGET, width - FIELD_COLUMN);
  const indent = ' '.repeat(FIELD_COLUMN);
  const lines = layoutAtoms(atoms, budget, paint);
  const first = `${head} ${lines[0] ?? ''}`.trimEnd();
  if (lines.length === 1) return first;
  return [first, ...lines.slice(1).map((l) => `${indent}${l}`)].join('\n');
}

/** One `key=value` field, still unpainted so the layout can measure and split it. */
interface FieldAtom {
  readonly key: string;
  readonly value: string;
  readonly colors: readonly string[];
}

/** Serialises fields to atoms: priority keys first, the rest sorted, trailing keys last. */
function fieldAtoms(record: LogRecord): FieldAtom[] {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!HIDDEN_KEYS.includes(key)) flat[key] = value;
  }
  if (record.err !== undefined) Object.assign(flat, flattenError(record.err));
  const keys = Object.keys(flat);
  const middle = (k: string): boolean => !FIELD_PRIORITY.includes(k) && !FIELD_TRAILING.includes(k);
  const ordered = [
    ...FIELD_PRIORITY.filter((k) => keys.includes(k)),
    ...keys.filter(middle).sort(),
    ...FIELD_TRAILING.filter((k) => keys.includes(k)),
  ];
  const atoms: FieldAtom[] = [];
  for (const key of ordered) {
    const value = renderValue(flat[key]);
    if (value === null) continue;
    atoms.push({ key, value, colors: valueColor(key, flat[key]) });
  }
  return atoms;
}

/** `err` → `err=Name: message`, `err.code`, `err.cause` (chain), `err.stack` (trailing). */
function flattenError(error: SerializedError): Record<string, unknown> {
  const out: Record<string, unknown> = { err: `${error.name}: ${error.message}` };
  if (error.code !== undefined) out['err.code'] = error.code;
  const chain: string[] = [];
  let cursor = error.cause;
  while (cursor !== undefined) {
    chain.push(`${cursor.name}: ${cursor.message}`);
    cursor = cursor.cause;
  }
  if (chain.length > 0) out['err.cause'] = chain.join(' <- ');
  if (error.stack !== undefined) out['err.stack'] = error.stack;
  return out;
}

/**
 * Lays the fields out into `budget`-wide lines, greedily packing whole atoms and giving an atom
 * too wide to fit on any line — a URL, a stack frame, a sentence of prose — lines of its own.
 */
function layoutAtoms(atoms: readonly FieldAtom[], budget: number, paint: Paint): string[] {
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  const flush = (): void => {
    if (currentWidth === 0) return;
    lines.push(current);
    current = '';
    currentWidth = 0;
  };
  for (const atom of atoms) {
    const width = atom.key.length + 1 + atom.value.length;
    if (width > budget) {
      flush();
      lines.push(...wrapAtom(atom, budget, paint));
      continue;
    }
    if (currentWidth + 1 + width > budget) flush();
    const text = `${paint(atom.key, ANSI.dim)}${paint('=', ANSI.dim)}${paint(atom.value, ...atom.colors)}`;
    current = currentWidth === 0 ? text : `${current} ${text}`;
    currentWidth = currentWidth === 0 ? width : currentWidth + 1 + width;
  }
  flush();
  return lines.length > 0 ? lines : [''];
}

/**
 * Splits one over-wide atom across as many lines as it needs, breaking at spaces. A token with no
 * space in it is kept whole on a line of its own even when that overflows: a soft wrap inserts no
 * character, so a URL stays one selectable string.
 */
function wrapAtom(atom: FieldAtom, budget: number, paint: Paint): string[] {
  const lines: string[] = [];
  const prefixWidth = atom.key.length + 1;
  let rest = atom.value;
  let first = true;
  while (rest.length > 0) {
    const room = Math.max(1, budget - (first ? prefixWidth : 0));
    const piece = rest.length <= room ? rest : rest.slice(0, breakPoint(rest, room));
    rest = rest.slice(piece.length).trimStart();
    const painted = paint(piece, ...atom.colors);
    lines.push(first ? `${paint(atom.key, ANSI.dim)}${paint('=', ANSI.dim)}${painted}` : painted);
    first = false;
  }
  return lines;
}

/** Characters of `text` to take for a line of `room`: up to the last fitting space, else the whole token. */
function breakPoint(text: string, room: number): number {
  const space = text.lastIndexOf(' ', room);
  if (space > 0) return space;
  const next = text.indexOf(' ', room);
  return next === -1 ? text.length : next;
}

/** Local `HH:MM:SS.mmm` — a date is noise on a live tail; the JSON mode keeps the epoch. */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Renders one field value as a compact string, or `null` to omit the field entirely. `undefined`
 * and `null` are omitted; strings containing whitespace are JSON-quoted (an embedded `=` is not
 * ambiguous and quoting for it would wrap almost every URL).
 */
function renderValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

/** Semantic colour per field, so failures and identities are findable by hue. */
function valueColor(key: string, value: unknown): string[] {
  if (key === 'error_code' || key === 'error' || key === 'code' || key.startsWith('err')) {
    return [ANSI.red];
  }
  if (key === 'pattern' || key === 'url') return [ANSI.yellow];
  if (key === 'session_id' || key === 'slug') return [ANSI.blue];
  if (key === 'result') return [value === 'success' ? ANSI.green : ANSI.red];
  if (typeof value === 'number') return [ANSI.cyan];
  if (typeof value === 'boolean') return [value ? ANSI.green : ANSI.dim];
  return [ANSI.white];
}
