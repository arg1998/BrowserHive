/** @module app/observability/log-persist-sink — optional durable `logs` table sink (`--logPersist info|warn`): batches records through the write queue, never throws, counts drops (spec 10 §4.3). */

import type { LogPersist } from '@browserhive/contracts/enums';
import type { JsonObject, LogRecordRow } from '../../ports/persistence/records.ts';
import type { WriteQueue } from '../../ports/persistence/write-queue.ts';

/** Retention of the `logs` table in days (spec 10 §4.3). */
export const LOG_PERSIST_RETENTION_DAYS = 3;

/** Records buffered before a batch is handed to the queue. */
export const DEFAULT_BATCH_SIZE = 100;
/** Idle time after which a partial batch is flushed. */
export const DEFAULT_FLUSH_INTERVAL_MS = 1000;

/** The slice of a logger record the sink persists; `infra/logging`'s `LogRecord` satisfies it. */
export interface PersistableLogRecord {
  readonly ts: number;
  readonly level: string;
  readonly msg: string;
  readonly module: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly request_id?: string;
  readonly session_id?: string;
  readonly principal?: string;
  readonly [field: string]: unknown;
}

/** A `logs` row before its `seq` is assigned. */
export type NewLogRow = Omit<LogRecordRow, 'seq'>;

/**
 * Destination of persisted rows. Defaults to the drain transaction's `repos.logs`; tests inject a
 * store. A store bound to the root handle must not be used with a real write queue (it would wait
 * for the very transaction that runs it).
 */
export interface LogRowStore {
  insertMany(rows: readonly NewLogRow[]): Promise<void>;
}

/** Timer seam so tests flush without real time. */
export interface TimerScheduler {
  setTimeout(fn: () => void, ms: number): () => void;
}

/** Dependencies of {@link LogPersistSink}. */
export interface LogPersistSinkDeps {
  readonly queue: Pick<WriteQueue, 'enqueue'> & Partial<Pick<WriteQueue, 'drain'>>;
  readonly store?: LogRowStore;
  /** Threshold: `info` keeps info and above, `warn` keeps warn and above. */
  readonly level: Exclude<LogPersist, 'off'>;
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly scheduler?: TimerScheduler;
}

const RANK: Readonly<Record<string, number>> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const INFO_RANK = 2;
const RESERVED: ReadonlySet<string> = new Set([
  'ts',
  'level',
  'msg',
  'module',
  'trace_id',
  'span_id',
  'request_id',
  'session_id',
  'principal',
]);

/** Real timers, unref'd so a pending flush never holds the process open. */
export const realTimerScheduler: TimerScheduler = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    const maybe: { unref?: () => void } = timer;
    maybe.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * A logger sink (`{ name, write, flush }`) that persists records at or above the configured
 * level. Records are buffered and handed to the write queue in batches; a refused enqueue or a
 * full buffer counts drops. `write` never throws.
 */
export class LogPersistSink {
  readonly name = 'persist';
  private readonly threshold: number;
  private readonly batchSize: number;
  private readonly scheduler: TimerScheduler;
  private buffer: NewLogRow[] = [];
  private cancelTimer: (() => void) | undefined;
  private closed = false;
  private dropped_ = 0;
  private written_ = 0;

  constructor(private readonly deps: LogPersistSinkDeps) {
    this.threshold = RANK[deps.level] ?? INFO_RANK;
    this.batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
    this.scheduler = deps.scheduler ?? realTimerScheduler;
  }

  /** Buffers one record (filtered by level). Never throws. */
  write(record: PersistableLogRecord): void {
    try {
      if (this.closed) {
        this.dropped_ += 1;
        return;
      }
      const rank = RANK[record.level];
      if (rank === undefined || rank > this.threshold) return;
      this.buffer.push(toRow(record));
      if (this.buffer.length >= this.batchSize) this.submit();
      else this.arm();
    } catch {
      this.dropped_ += 1;
    }
  }

  /** Hands the buffered rows to the queue and, when the queue supports it, drains it. */
  async flush(): Promise<void> {
    this.submit();
    try {
      await this.deps.queue.drain?.();
    } catch {
      // Drain failures are the queue's to report (dropped writes); a sink never throws.
    }
  }

  /** Flushes and refuses further records. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }

  /** Records refused (closed sink, refused or throwing enqueue, serialisation failure). */
  get dropped(): number {
    return this.dropped_;
  }

  /** Rows handed to the queue so far. */
  get written(): number {
    return this.written_;
  }

  /** Rows currently buffered. */
  get buffered(): number {
    return this.buffer.length;
  }

  private arm(): void {
    if (this.cancelTimer !== undefined) return;
    this.cancelTimer = this.scheduler.setTimeout(
      () => this.submit(),
      this.deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    );
  }

  private submit(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    let accepted = false;
    try {
      accepted = this.deps.queue.enqueue('logs.insert', (repos) =>
        (this.deps.store ?? repos.logs).insertMany(rows),
      );
    } catch {
      accepted = false;
    }
    if (accepted) this.written_ += rows.length;
    else this.dropped_ += rows.length;
  }
}

/**
 * Factory honouring the `logPersist` key: `off` yields `null` (no sink is installed).
 *
 * @returns The sink, or `null` when persistence is off.
 */
export function createLogPersistSink(
  deps: Omit<LogPersistSinkDeps, 'level'> & { readonly level: LogPersist },
): LogPersistSink | null {
  if (deps.level === 'off') return null;
  return new LogPersistSink({ ...deps, level: deps.level });
}

function toRow(record: PersistableLogRecord): NewLogRow {
  const fields: Record<string, unknown> = {};
  let any = false;
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED.has(key) || value === undefined) continue;
    fields[key] = jsonSafe(value);
    any = true;
  }
  return {
    ts: record.ts,
    level: record.level,
    module: record.module,
    msg: record.msg,
    traceId: record.trace_id ?? null,
    spanId: record.span_id ?? null,
    requestId: record.request_id ?? null,
    sessionId: record.session_id ?? null,
    principal: record.principal ?? null,
    fields: any ? asJsonObject(fields) : null,
  };
}

function asJsonObject(value: Readonly<Record<string, unknown>>): JsonObject {
  return value;
}

function jsonSafe(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : JSON.parse(text);
  } catch {
    return '[unserializable]';
  }
}
