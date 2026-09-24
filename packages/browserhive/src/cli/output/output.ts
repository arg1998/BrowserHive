/** @module cli/output/output — `createOutput`: the CLI's only writer to stdout/stderr (status lines, tables, JSON, stdio discipline, the `OutputSinks` adapter for `bootServer`) (spec 08 §7.4) */
import { createStyle, type Style } from './style.ts';
import { clampWidth, renderTable, type TableColumn } from './text.ts';

/** A raw text writer (one chunk, newline included by the caller). */
export type ChunkWriter = (chunk: string) => void;

/** Line sinks handed to the composition root (structurally the seam's `OutputSinks`). */
export interface CliOutputSinks {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly isTty: { readonly stdout: boolean; readonly stderr: boolean };
}

/** Inputs of {@link createOutput}. */
export interface OutputOptions {
  readonly stdout: ChunkWriter;
  readonly stderr: ChunkWriter;
  readonly isTty: { readonly stdout: boolean; readonly stderr: boolean };
  /** Colour decision already resolved (see `resolveColorEnabled`). */
  readonly color: boolean;
  /** Terminal columns of stdout when known; clamped to 60–120, 100 otherwise. */
  readonly columns?: number;
  /**
   * `true` under `--transport stdio`: every write, including primary output, goes to stderr so
   * stdout carries only MCP frames (spec 08 §7.4).
   */
  readonly stdio?: boolean;
}

/** Status marker of one line. */
export type StatusKind = 'ok' | 'fail' | 'warn' | 'skip';

/** The CLI output surface. Primary output → stdout, diagnostics → stderr. */
export interface Output {
  readonly style: Style;
  /** Rendering width for help and tables. */
  readonly width: number;
  readonly isTty: { readonly stdout: boolean; readonly stderr: boolean };
  /** Writes one line of primary output. */
  line(text?: string): void;
  /** Writes several lines of primary output. */
  lines(texts: readonly string[]): void;
  /** Writes one diagnostic line to stderr. */
  diagnostic(text: string): void;
  /** Pretty-printed JSON on stdout (2-space indent). */
  json(value: unknown): void;
  /** `✓ label  detail` / `✗ …` / `! …` / `– …` (not present, nothing to do). */
  status(kind: StatusKind, label: string, detail?: string): void;
  /** Aligned table on stdout. */
  table(columns: readonly TableColumn[], rows: readonly (readonly string[])[]): void;
  /** The same output re-targeted for stdio discipline (everything to stderr). */
  forStdio(): Output;
  /** Line sinks for `bootServer`; under stdio both go to stderr. */
  sinks(): CliOutputSinks;
}

/** Glyphs of the three status kinds (spec 08 §7.1). */
export const STATUS_GLYPH: Readonly<Record<StatusKind, string>> = {
  ok: '✓',
  fail: '✗',
  warn: '!',
  skip: '–',
};

/**
 * Builds the {@link Output}.
 *
 * @returns The output surface.
 */
export function createOutput(options: OutputOptions): Output {
  const style = createStyle(options.color);
  const stdio = options.stdio === true;
  const primary: ChunkWriter = stdio ? options.stderr : options.stdout;
  const width = clampWidth(options.columns);

  const glyph = (kind: StatusKind): string => {
    switch (kind) {
      case 'ok':
        return style.green(STATUS_GLYPH.ok);
      case 'fail':
        return style.red(STATUS_GLYPH.fail);
      case 'warn':
        return style.yellow(STATUS_GLYPH.warn);
      case 'skip':
        return style.dim(STATUS_GLYPH.skip);
    }
  };

  const output: Output = {
    style,
    width,
    isTty: options.isTty,
    line: (text = '') => primary(`${text}\n`),
    lines: (texts) => {
      if (texts.length > 0) primary(`${texts.join('\n')}\n`);
    },
    diagnostic: (text) => options.stderr(`${text}\n`),
    json: (value) => primary(`${JSON.stringify(value, null, 2)}\n`),
    status: (kind, label, detail) => {
      const suffix = detail === undefined || detail === '' ? '' : `  ${style.dim(detail)}`;
      primary(`${glyph(kind)} ${label}${suffix}\n`);
    },
    table: (columns, rows) => {
      output.lines(renderTable(columns, rows, style.bold));
    },
    forStdio: () => (stdio ? output : createOutput({ ...options, stdio: true })),
    sinks: () => ({
      stdout: (line) => primary(`${line}\n`),
      stderr: (line) => options.stderr(`${line}\n`),
      isTty: {
        stdout: stdio ? options.isTty.stderr : options.isTty.stdout,
        stderr: options.isTty.stderr,
      },
    }),
  };
  return output;
}

/** An in-memory output for tests: captured stdout/stderr text. */
export interface CapturedOutput {
  readonly output: Output;
  stdout(): string;
  stderr(): string;
}

/**
 * Builds an {@link Output} writing into memory (colour off unless asked, width 100, not a TTY).
 *
 * @returns The output and accessors for what was written.
 */
export function captureOutput(
  overrides: Partial<Omit<OutputOptions, 'stdout' | 'stderr'>> = {},
): CapturedOutput {
  let out = '';
  let err = '';
  const output = createOutput({
    stdout: (chunk) => {
      out += chunk;
    },
    stderr: (chunk) => {
      err += chunk;
    },
    isTty: overrides.isTty ?? { stdout: false, stderr: false },
    color: overrides.color ?? false,
    ...(overrides.columns !== undefined && { columns: overrides.columns }),
    ...(overrides.stdio !== undefined && { stdio: overrides.stdio }),
  });
  return { output, stdout: () => out, stderr: () => err };
}
