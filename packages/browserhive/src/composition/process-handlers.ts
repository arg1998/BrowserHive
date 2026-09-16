/** @module composition/process-handlers — SIGINT/SIGTERM graceful stop, a second signal forces exit 130, unhandled failures become `UNHANDLED` degradations; exit 1 only on storage corruption (spec 01 §6). */

import type { Logger } from '@browserhive/core/runtime';
import { isAppError, serializeError } from '@browserhive/core/runtime';
import type { OutputSinks } from './types.ts';

/** The slice of `process` the handlers attach to (tests inject an `EventEmitter`). */
export interface SignalTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Collaborators of {@link installProcessHandlers}. */
export interface ProcessHandlerDeps {
  readonly target: SignalTarget;
  /** Starts a graceful stop that ends with `exitCode`; must be idempotent. */
  readonly stop: (exitCode: number) => void;
  readonly output: Pick<OutputSinks, 'stderr'>;
  /** Immediate exit (second signal). Default `process.exit`. */
  readonly exit?: (code: number) => void;
  /** `DegradationService.unhandled` (through the relay). */
  readonly unhandled: (error: unknown, kind: 'exception' | 'rejection') => void;
  readonly logger?: Logger;
}

/** Exit code of a forced stop by a second signal (spec 08 §7.3). */
export const FORCED_EXIT_CODE = 130;

/** Signals that request a graceful stop. */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const CORRUPTION_RE =
  /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i;

/** True for failures that mean the database can no longer be trusted. */
export function isStorageCorruption(error: unknown): boolean {
  if (isAppError(error)) return error.code === 'DB_CORRUPT';
  if (error instanceof Error) {
    const code: unknown = 'code' in error ? error.code : undefined;
    return CORRUPTION_RE.test(`${typeof code === 'string' ? code : ''} ${error.message}`);
  }
  return false;
}

/**
 * Installs the handlers and returns a once-only uninstall function. The first SIGINT/SIGTERM starts
 * a graceful stop (exit 0); a second one prints a message and exits 130 immediately. Unhandled
 * rejections/exceptions are reported as `UNHANDLED` and the process keeps serving, unless the
 * failure is storage corruption (graceful stop, exit 1).
 */
export function installProcessHandlers(deps: ProcessHandlerDeps): () => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let signals = 0;
  const onSignal = (signal: string) => (): void => {
    signals += 1;
    if (signals === 1) {
      deps.output.stderr(
        `browserhive: received ${signal}, shutting down (press Ctrl-C again to force)`,
      );
      deps.stop(0);
      return;
    }
    deps.output.stderr(`browserhive: received ${signal} again, forcing exit`);
    exit(FORCED_EXIT_CODE);
  };
  const onFailure =
    (kind: 'exception' | 'rejection') =>
    (error: unknown): void => {
      deps.unhandled(error, kind);
      deps.logger?.error(kind === 'exception' ? 'uncaught exception' : 'unhandled rejection', {
        err: serializeError(error),
      });
      if (isStorageCorruption(error)) {
        deps.output.stderr('browserhive: [DB_CORRUPT] storage corruption detected, stopping');
        deps.stop(1);
      }
    };
  const listeners: [string, (...args: unknown[]) => void][] = [
    ...STOP_SIGNALS.map((s): [string, () => void] => [s, onSignal(s)]),
    ['uncaughtException', onFailure('exception')],
    ['unhandledRejection', onFailure('rejection')],
  ];
  for (const [event, listener] of listeners) deps.target.on(event, listener);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    for (const [event, listener] of listeners) deps.target.off(event, listener);
  };
}
