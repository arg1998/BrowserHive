/** @module infra/logging/console-redirect — route every `console.*` call into the Logger under stdio, unconditionally (spec 10 §4.3). */

import type { Logger, LogLevel } from '../../ports/logger.ts';

/** The console methods this redirect replaces. */
export type RedirectableConsole = Pick<
  Console,
  'log' | 'info' | 'debug' | 'warn' | 'error' | 'trace'
>;

/** Console method → log level. Plumbing lands at `debug`; warnings and errors keep their level. */
const METHODS: readonly { readonly method: keyof RedirectableConsole; readonly level: LogLevel }[] =
  [
    { method: 'log', level: 'debug' },
    { method: 'info', level: 'debug' },
    { method: 'debug', level: 'debug' },
    { method: 'trace', level: 'debug' },
    { method: 'warn', level: 'warn' },
    { method: 'error', level: 'error' },
  ];

/** Cap on the collapsed remainder of a multi-line console call. */
const DETAIL_MAX = 300;

/** The tag a library stamps on its own lines — `[FastMCP info]`, `[mcp-proxy]`. */
const LIBRARY_TAG = /^\[[^\]]*\]\s*/;

/** Fields extracted from a console call by {@link describeConsoleCall}. */
export interface ConsoleCallDescription {
  /** First line, library tag stripped; `(empty)` when nothing is left. */
  readonly event: string;
  /** Remaining lines, whitespace-collapsed and capped. */
  readonly detail?: string;
}

/**
 * Reduces a console call's arguments to `{ event, detail? }`: the first line becomes `event`,
 * anything after it (typically a stack trace) is collapsed into `detail`.
 */
export function describeConsoleCall(args: readonly unknown[]): ConsoleCallDescription {
  const text = args.map(renderArg).join(' ').replace(LIBRARY_TAG, '').trim();
  const cut = text.indexOf('\n');
  const event = (cut === -1 ? text : text.slice(0, cut)).trim();
  const rest =
    cut === -1
      ? ''
      : text
          .slice(cut + 1)
          .replace(/\s+/g, ' ')
          .trim();
  return {
    event: event.length > 0 ? event : '(empty)',
    ...(rest.length > 0 && { detail: truncate(rest, DETAIL_MAX) }),
  };
}

/**
 * Replaces `console.log/info/debug/trace/warn/error` on `target` (default the global console)
 * with calls into `logger` so nothing can reach stdout under the stdio transport. Every call is
 * captured, not only known library prefixes, so an unexpected writer cannot corrupt the stdio
 * protocol stream. Returns a once-only restore function.
 */
export function redirectConsoleToLogger(
  logger: Logger,
  target: RedirectableConsole = globalThis.console,
): () => void {
  const log = logger.child({ module: 'system.console' });
  const original = METHODS.map(({ method }) => ({ method, fn: target[method] }));
  for (const { method, level } of METHODS) {
    target[method] = (...args: unknown[]): void => {
      const description = describeConsoleCall(args);
      log[level]('console output', { source: 'console', method, ...description });
    };
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const { method, fn } of original) target[method] = fn;
  };
}

function renderArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
