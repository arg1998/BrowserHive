/** @module composition/process-handlers — SIGINT/SIGTERM (on Windows also SIGBREAK and SIGHUP) graceful stop, a second signal forces exit 130, unhandled failures become `UNHANDLED` degradations; exit 1 only on storage corruption (spec 01 §6). */
import type { Logger } from '@browserhive/core/runtime';
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
  /** Host platform; picks the stop signals ({@link stopSignalsFor}). Default `process.platform`. */
  readonly platform?: NodeJS.Platform;
}
/** Exit code of a forced stop by a second signal (spec 08 §7.3). */
export declare const FORCED_EXIT_CODE = 130;
/** Signals that request a graceful stop on every platform. */
export declare const STOP_SIGNALS: readonly ['SIGINT', 'SIGTERM'];
/**
 * Windows-only stop signals. Windows cannot deliver SIGTERM to another process (`kill` is
 * TerminateProcess), so its graceful paths are console events: Ctrl+Break arrives as `SIGBREAK`, and
 * closing the console window as `SIGHUP` (Windows then allows about 10 s before ending the process).
 * Unhandled, both end the daemon at once and skip the browser and database shutdown. On POSIX, SIGHUP
 * keeps its default meaning and is not handled here.
 */
export declare const WINDOWS_STOP_SIGNALS: readonly ['SIGBREAK', 'SIGHUP'];
/** The signals that request a graceful stop on `platform`. */
export declare function stopSignalsFor(platform: NodeJS.Platform): readonly string[];
/** True for failures that mean the database can no longer be trusted. */
export declare function isStorageCorruption(error: unknown): boolean;
/**
 * Installs the handlers and returns a once-only uninstall function. The first SIGINT/SIGTERM starts
 * a graceful stop (exit 0); a second one prints a message and exits 130 immediately. Unhandled
 * rejections/exceptions are reported as `UNHANDLED` and the process keeps serving, unless the
 * failure is storage corruption (graceful stop, exit 1).
 */
export declare function installProcessHandlers(deps: ProcessHandlerDeps): () => void;
//# sourceMappingURL=process-handlers.d.ts.map
