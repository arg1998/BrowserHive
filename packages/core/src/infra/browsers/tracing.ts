/** @module infra/browsers/tracing — TracingHandle over Playwright tracing with chunk pause/resume for vault fills (D-13) and idempotent, deadline-capped stop. */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { withDeadline } from '../../kernel/deadline.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { LaunchWarning, TracingHandle } from '../../ports/browser-driver.ts';
import type { Logger } from '../../ports/logger.ts';

/** Hard cap on the trace-finalize step at session close, so a stuck trace writer cannot hang the close. */
export const TRACE_FINALIZE_TIMEOUT_MS = 10_000;

/**
 * The Playwright `Tracing` surface the handle drives (structural, so tests pass a fake).
 *
 * Deliberately **not** `startChunk`/`stopChunk`: verified against Playwright 1.63, the chunk API
 * keeps the HAR/network tracer running across the pause, so a login POST body (decoded
 * `postData.params` with the password) lands in the resumed chunk's `trace-1.network`. A full
 * `stop({ path })` + `start(originalOptions)` around the fill is what actually excludes the window.
 */
export interface TracingLike {
  start(options: TracingStartOptions): Promise<void>;
  stop(options?: { path?: string }): Promise<void>;
}

/** The options every `start` uses (the same ones are replayed after a pause). */
export interface TracingStartOptions {
  readonly screenshots: boolean;
  readonly snapshots: boolean;
  readonly sources: boolean;
}

/** File operations the handle needs, injectable for tests. */
export interface TracingFs {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rm(path: string): Promise<void>;
}

const nodeFs: TracingFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  readFile: (path) => readFile(path),
  writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
  rm: (path) => rm(path, { recursive: true, force: true }),
};

/** Dependencies of {@link PlaywrightTracingHandle}. */
export interface TracingHandleDeps {
  readonly tracing: TracingLike;
  readonly partsDir: string;
  readonly screenshots: boolean;
  readonly snapshots: boolean;
  readonly logger: Logger;
  readonly fs?: TracingFs;
  readonly finalizeTimeoutMs?: number;
}

type State = 'idle' | 'recording' | 'paused' | 'stopped';

/**
 * State machine: `idle → recording ⇄ paused → stopped`. `pauseChunk` fully stops tracing, writing
 * the recording so far to `<partsDir>/part-N.zip`; `resumeChunk` starts a fresh trace with the
 * original options. `stop(path)` finalizes: with no parts it is a plain `tracing.stop({ path })`;
 * otherwise the last recording is written and every part is merged into `path` (each part keeps
 * its own `*.trace`/`*.network` ordinal, which the trace viewer loads as one timeline). Nothing —
 * not even the network tracer — records between a pause and a resume, so the credential and the
 * login POST body never land in any part — D-13.
 */
export class PlaywrightTracingHandle implements TracingHandle {
  private readonly deps: TracingHandleDeps;
  private readonly fs: TracingFs;
  private readonly parts: string[] = [];
  private readonly startOptions: TracingStartOptions;
  private state: State = 'idle';
  private stopping: Promise<void> | undefined;

  constructor(deps: TracingHandleDeps) {
    this.deps = deps;
    this.fs = deps.fs ?? nodeFs;
    this.startOptions = {
      screenshots: deps.screenshots,
      snapshots: deps.snapshots,
      sources: false,
    };
  }

  /** Current state, for tests and diagnostics. */
  get status(): State {
    return this.state;
  }

  /** Begin recording. Records screenshots + DOM snapshots per spec but never `sources` (local file contents). */
  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    await this.deps.tracing.start(this.startOptions);
    this.state = 'recording';
  }

  async pauseChunk(): Promise<void> {
    if (this.state !== 'recording') return;
    await this.fs.mkdir(this.deps.partsDir);
    const path = join(this.deps.partsDir, `part-${this.parts.length}.zip`);
    // D-13: tracing is fully stopped around the fill so the credential never lands in trace.zip
    // (`stopChunk` would leave the network tracer running and capture the login POST body).
    await this.deps.tracing.stop({ path });
    this.parts.push(path);
    this.state = 'paused';
  }

  async resumeChunk(): Promise<void> {
    if (this.state !== 'paused') return;
    await this.deps.tracing.start(this.startOptions);
    this.state = 'recording';
  }

  /** Finalizes into `path`. Idempotent: a second call awaits the first. */
  stop(path: string): Promise<void> {
    if (this.stopping === undefined) this.stopping = this.finalize(path);
    return this.stopping;
  }

  /** Discards an active trace at close when the caller never asked for a file. Never throws. */
  async abandon(): Promise<LaunchWarning | null> {
    if (this.state === 'idle' || this.state === 'stopped') return null;
    const previous = this.state;
    this.state = 'stopped';
    try {
      if (previous === 'recording') await this.deps.tracing.stop();
      await this.fs.rm(this.deps.partsDir);
      return null;
    } catch (err) {
      return {
        code: 'TRACE_FINALIZE_FAILED',
        message: 'tracing did not stop cleanly while closing the session',
        details: { error: serializeError(err) },
      };
    }
  }

  private async finalize(path: string): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') return;
    const previous = this.state;
    this.state = 'stopped';
    // A hard timeout so a hung trace-flush never blocks shutdown — on overrun we log and proceed.
    const deadline = withDeadline(
      undefined,
      this.deps.finalizeTimeoutMs ?? TRACE_FINALIZE_TIMEOUT_MS,
    );
    try {
      await Promise.race([this.write(path, previous), rejectOnAbort(deadline.signal)]);
    } finally {
      deadline.clear();
    }
  }

  private async write(path: string, previous: State): Promise<void> {
    if (this.parts.length === 0) {
      await this.deps.tracing.stop({ path });
      return;
    }
    if (previous === 'recording') {
      const last = join(this.deps.partsDir, `part-${this.parts.length}.zip`);
      await this.deps.tracing.stop({ path: last });
      this.parts.push(last);
    }
    const merged = await mergeTraceParts(this.parts, this.fs);
    await this.fs.writeFile(path, merged);
    await this.fs.rm(this.deps.partsDir);
    this.deps.logger.debug('trace parts merged', { parts: this.parts.length });
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * Concatenate chunk zips into one trace zip. Each chunk's `trace.trace` / `trace.network` /
 * `trace.stacks` gets the ordinal suffix `-<i>` (the viewer loads every `*.trace` it finds, in
 * order); `resources/*` entries are content-addressed and deduplicate by name.
 */
export async function mergeTraceParts(
  parts: readonly string[],
  fs: TracingFs,
): Promise<Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    const entries = unzipSync(await fs.readFile(part));
    for (const [name, data] of Object.entries(entries)) {
      const m = /^(.+)\.(trace|network|stacks)$/.exec(name);
      const target = m !== null && i > 0 ? `${m[1]}-${i}.${m[2]}` : name;
      out[target] = data;
    }
  }
  // `zipSync` because fflate's worker path breaks under Bun.
  return zipSync(out, { level: 6 });
}

/** The `TRACE_START_FAILED` warning (stable public text). */
export function traceStartWarning(err: unknown): LaunchWarning {
  return {
    code: 'TRACE_START_FAILED',
    message: 'failed to start Playwright tracing; continuing without a trace',
    details: { error: serializeError(err) },
  };
}

/** The `TRACE_FINALIZE_FAILED` warning (stable public text). */
export function traceFinalizeWarning(err: unknown): LaunchWarning {
  return {
    code: 'TRACE_FINALIZE_FAILED',
    message: 'tracing did not finalize, so this session has no trace.zip to view',
    details: { error: serializeError(err) },
  };
}
