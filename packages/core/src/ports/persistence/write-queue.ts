/** @module ports/persistence/write-queue — non-blocking FIFO for recorder writes (spec 03 §7.2). */

import type { Repositories } from './unit-of-work.ts';

/** A queued write; runs inside the drain transaction with repositories bound to it. */
export type WriteJob = (repos: Repositories) => Promise<void>;

/**
 * Buffers writes so tool responses never wait on SQLite. One transaction per drain; reads call
 * {@link WriteQueue.drain} first so they observe every prior write.
 */
export interface WriteQueue {
  /**
   * Enqueues a write. Returns false (and counts a dropped write) when the queue is closed or full.
   * `operation` names the write for logs and spans (e.g. `tool_calls.insert`).
   */
  enqueue(operation: string, job: WriteJob): boolean;
  /** Runs every queued job in one transaction. Safe to call concurrently; calls coalesce. */
  drain(): Promise<void>;
  /** Jobs waiting to run. */
  readonly depth: number;
  /** Writes refused or failed since start (`dropped_writes_total`). */
  readonly droppedWrites: number;
  /** Drains and refuses further writes. Idempotent. */
  close(): Promise<void>;
}
