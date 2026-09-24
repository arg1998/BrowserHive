/** @module composition/types — the seam shared with the CLI and the programmatic API: `BootInput`, `RunningServer`, `OutputSinks`. */

import type { Readable, Writable } from 'node:stream';
import type { ResolvedConfigBundle } from '@browserhive/core/config';
import type { HostEnvironment, LogSink } from '@browserhive/core/runtime';
import type { SandboxHost } from './sandbox.ts';

/**
 * Human output channels. Each call receives ONE line without its trailing newline; the sink
 * appends it. Under `transport=stdio` nothing is ever written to `stdout` (the MCP byte stream).
 */
export interface OutputSinks {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readonly isTty: { readonly stdout: boolean; readonly stderr: boolean };
}

/** Everything `bootServer` needs; the config is already resolved and validated. */
export interface BootInput {
  readonly resolved: ResolvedConfigBundle;
  readonly host: HostEnvironment;
  readonly output: OutputSinks;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly appVersion: string;
  /** SIGINT/SIGTERM/unhandled handlers on `process` (the CLI: true; `createServer`: false). */
  readonly installProcessHandlers: boolean;
  /** Extra log sink (programmatic `logger` option); receives every redacted record. */
  readonly logSink?: LogSink;
  /** stdio transport streams (default `process.stdin` / `process.stdout`). */
  readonly stdio?: { readonly stdin: Readable; readonly stdout: Writable };
  /** Test seam: the sandbox probes and browser detection (no real launches). */
  readonly sandboxHost?: SandboxHost;
}

/** A running server. */
export interface RunningServer {
  /** `http://host:port` with the bound port; `null` under stdio. */
  readonly url: string | null;
  readonly transport: 'http' | 'stdio';
  /** Graceful stop within `deadlineMs` (default `shutdownTimeout`). Idempotent. */
  stop(deadlineMs?: number): Promise<void>;
  /** Resolves with the process exit code once the server has fully stopped. */
  readonly done: Promise<number>;
}

/** `OutputSinks` over the real process streams. */
export function processOutput(): OutputSinks {
  return {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    isTty: { stdout: process.stdout.isTTY === true, stderr: process.stderr.isTTY === true },
  };
}
