/** @module infra/logging/sinks — stream, ring and fan-out sinks that never throw; a sink is disabled after repeated failures (spec 10 §4.3). */

import type { LogRecord } from './record.ts';
import type { LogRingBuffer } from './ring-buffer.ts';

/** Consecutive failures after which the fan-out disables a sink. */
export const MAX_SINK_FAILURES = 10;

/** A destination for log records. Implementations may throw; the fan-out contains it. */
export interface LogSink {
  readonly name: string;
  write(record: LogRecord): void;
  /** Optional: drain buffered output (shutdown). */
  flush?(): Promise<void> | void;
}

/** The subset of a writable stream the stream sink needs (`process.stdout`, a file, a test buffer). */
export interface LineStream {
  write(chunk: string): unknown;
}

/** Sink health event reported by {@link fanOutSink} when a sink is disabled or recovers. */
export interface SinkFailure {
  readonly sink: string;
  readonly consecutiveFailures: number;
  readonly error: unknown;
}

/** Writes one rendered line per record (plus `\n`) to `stream`. */
export function streamSink(
  name: string,
  stream: LineStream,
  render: (record: LogRecord) => string,
): LogSink {
  return {
    name,
    write(record) {
      stream.write(`${render(record)}\n`);
    },
  };
}

/** Pushes records into the ring buffer. */
export function ringSink(ring: LogRingBuffer, name = 'ring'): LogSink {
  return {
    name,
    write(record) {
      ring.push(record);
    },
  };
}

/** Options for {@link fanOutSink}. */
export interface FanOutOptions {
  /** Consecutive failures before a sink is disabled. Default {@link MAX_SINK_FAILURES}. */
  readonly maxConsecutiveFailures?: number;
  /** Called once when a sink is disabled (feeds `system.degraded`). Must not throw. */
  readonly onSinkDisabled?: (failure: SinkFailure) => void;
}

/** A composite sink with runtime membership and failure isolation. */
export interface FanOutSink extends LogSink {
  add(sink: LogSink): void;
  remove(name: string): void;
  /** Names of currently enabled sinks. */
  names(): readonly string[];
  /** Consecutive failure count of a sink (`0` when healthy or unknown). */
  failures(name: string): number;
  flush(): Promise<void>;
  /** Flushes every sink and returns the names of those whose flush rejected. */
  flushAll(): Promise<readonly string[]>;
}

/**
 * Delivers every record to every enabled sink. A throwing sink never propagates; after
 * `maxConsecutiveFailures` in a row it is removed and `onSinkDisabled` is called once. A
 * successful write resets the count.
 */
export function fanOutSink(sinks: readonly LogSink[], options: FanOutOptions = {}): FanOutSink {
  const max = options.maxConsecutiveFailures ?? MAX_SINK_FAILURES;
  const members = new Map<string, { sink: LogSink; failures: number }>();
  for (const sink of sinks) members.set(sink.name, { sink, failures: 0 });

  return {
    name: 'fan-out',
    write(record) {
      for (const [name, member] of [...members]) {
        try {
          member.sink.write(record);
          member.failures = 0;
        } catch (error) {
          member.failures += 1;
          if (member.failures >= max) {
            members.delete(name);
            try {
              options.onSinkDisabled?.({ sink: name, consecutiveFailures: member.failures, error });
            } catch {
              // The degradation reporter itself failed; nothing left to tell.
            }
          }
        }
      }
    },
    add(sink) {
      members.set(sink.name, { sink, failures: 0 });
    },
    remove(name) {
      members.delete(name);
    },
    names() {
      return [...members.keys()];
    },
    failures(name) {
      return members.get(name)?.failures ?? 0;
    },
    async flush() {
      await this.flushAll();
    },
    async flushAll() {
      const entries = [...members.values()];
      const results = await Promise.allSettled(
        entries.map((m) => Promise.resolve().then(() => m.sink.flush?.())),
      );
      // Flush failures are reported, never thrown: shutdown must proceed regardless.
      const failed: string[] = [];
      results.forEach((result, i) => {
        const name = entries[i]?.sink.name;
        if (result.status === 'rejected' && name !== undefined) failed.push(name);
      });
      return failed;
    },
  };
}
