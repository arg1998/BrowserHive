/** @module infra/persistence/write-queue — bounded FIFO of recorder writes drained in one transaction (spec 03 §7.2). */

import type { Logger } from '../../ports/logger.ts';
import type { UnitOfWork } from '../../ports/persistence/unit-of-work.ts';
import type { WriteJob, WriteQueue } from '../../ports/persistence/write-queue.ts';
import { withSpan } from './dialect/spans.ts';

/** Options of {@link SqliteWriteQueue}. */
export interface WriteQueueOptions {
  readonly uow: UnitOfWork;
  readonly logger: Logger;
  /** Jobs held before new ones are dropped. Default 10 000. */
  readonly maxDepth?: number;
  /** Jobs per drain transaction; larger queues drain in several rounds. Default 1 000. */
  readonly batchSize?: number;
}

interface Queued {
  readonly operation: string;
  readonly job: WriteJob;
}

/**
 * Writes are enqueued and drained on a microtask (one `BEGIN IMMEDIATE` per drain). A job that
 * throws (constraint violation, corrupt payload) is logged and counted as dropped; the drain
 * continues with the next job. After {@link close} every enqueue is refused.
 */
export class SqliteWriteQueue implements WriteQueue {
  readonly #uow: UnitOfWork;
  readonly #logger: Logger;
  readonly #maxDepth: number;
  readonly #batchSize: number;
  #queue: Queued[] = [];
  #draining: Promise<void> | null = null;
  #scheduled = false;
  #closed = false;
  #dropped = 0;

  constructor(options: WriteQueueOptions) {
    this.#uow = options.uow;
    this.#logger = options.logger;
    this.#maxDepth = options.maxDepth ?? 10_000;
    this.#batchSize = options.batchSize ?? 1_000;
  }

  get depth(): number {
    return this.#queue.length;
  }

  get droppedWrites(): number {
    return this.#dropped;
  }

  enqueue(operation: string, job: WriteJob): boolean {
    if (this.#closed || this.#queue.length >= this.#maxDepth) {
      this.#dropped += 1;
      this.#logger.warn('write dropped', { operation, reason: this.#closed ? 'closed' : 'full' });
      return false;
    }
    this.#queue.push({ operation, job });
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        void this.drain();
      });
    }
    return true;
  }

  drain(): Promise<void> {
    if (this.#draining !== null) {
      // Coalesce: wait for the running drain, then drain whatever arrived meanwhile.
      return this.#draining.then(() => (this.#queue.length > 0 ? this.drain() : undefined));
    }
    if (this.#queue.length === 0) return Promise.resolve();
    const run = this.#drainOnce().finally(() => {
      this.#draining = null;
    });
    this.#draining = run;
    return run.then(() => (this.#queue.length > 0 ? this.drain() : undefined));
  }

  async #drainOnce(): Promise<void> {
    const batch = this.#queue.splice(0, this.#batchSize);
    await withSpan(
      'db.drain',
      { 'db.operation': 'drain', 'browserhive.rows': batch.length },
      async () => {
        try {
          await this.#uow.transaction(async (repos) => {
            for (const item of batch) {
              try {
                await item.job(repos);
              } catch (error) {
                this.#dropped += 1;
                this.#logger.error('write failed', {
                  operation: item.operation,
                  error: String(error),
                });
              }
            }
          });
        } catch (error) {
          // The transaction itself failed (lock timeout, I/O): every job of the batch is lost.
          this.#dropped += batch.length;
          this.#logger.error('drain failed', { jobs: batch.length, error: String(error) });
        }
      },
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.drain();
    this.#closed = true;
  }
}
