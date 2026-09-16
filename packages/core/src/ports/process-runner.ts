/** @module ports/process-runner — child-process capability used by CLI-backed adapters (the `bw` vault backend). */

/** Options for one {@link ProcessRunner.run} call. */
export interface ProcessRunOptions {
  /** The child's complete environment (callers build a minimal one; nothing is inherited). */
  readonly env: Readonly<Record<string, string>>;
  /** Hard ceiling; the child is killed and `timedOut` is set when it elapses. */
  readonly timeoutMs: number;
  /** Written to the child's stdin then closed. An early exit (EPIPE) is not an error. */
  readonly stdin?: string;
  /** Aborting kills the child; the result reports `code: null`. */
  readonly signal?: AbortSignal;
  /** Cap on captured stdout/stderr bytes each (default 16 MiB); beyond it the child is killed. */
  readonly maxOutputBytes?: number;
}

/** Outcome of a finished child process. */
export interface ProcessRunResult {
  /** Exit code, or `null` when killed by a signal / timeout / abort. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Why a process could not be started at all (as opposed to exiting non-zero). */
export type ProcessSpawnFailure = 'not_found' | 'spawn_failed';

/** Thrown by {@link ProcessRunner.run} when the child never started. */
export class ProcessSpawnError extends Error {
  readonly kind: ProcessSpawnFailure;
  readonly command: string;
  override readonly cause: unknown;

  constructor(kind: ProcessSpawnFailure, command: string, cause?: unknown) {
    super(`cannot spawn ${command}: ${kind}`);
    this.name = 'ProcessSpawnError';
    this.kind = kind;
    this.command = command;
    this.cause = cause;
  }
}

/** Runs one child process to completion with a bounded lifetime and captured output. */
export interface ProcessRunner {
  /**
   * Spawns `command` with `args` (passed verbatim, never through a shell) and resolves when it
   * exits. Rejects with {@link ProcessSpawnError} only when the process could not be started.
   */
  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult>;
}
