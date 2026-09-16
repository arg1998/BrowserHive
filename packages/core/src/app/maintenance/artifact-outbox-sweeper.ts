/** @module app/maintenance/artifact-outbox-sweeper — unlinks files queued in `artifact_outbox` with bounded retries (spec 03 §7.1 artifacts class). */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { FileSystem } from '../../ports/file-system.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ArtifactOutboxRepository } from '../../ports/persistence/operations.ts';
import type { ArtifactOutboxRecord } from '../../ports/persistence/records.ts';
import { RETENTION_FAILED } from './retention-scheduler.ts';
import { type IntervalScheduler, realIntervalScheduler } from './timer.ts';

/** Failed attempts after which an entry is abandoned (row removed, degradation raised). */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Entries handled per pass. */
export const DEFAULT_OUTBOX_BATCH = 100;
/** Default cadence: every minute. */
export const DEFAULT_OUTBOX_INTERVAL_MS = 60_000;
/** `details.step` of the degradation raised for abandoned entries. */
export const OUTBOX_STEP = 'artifact_outbox';

/** Dependencies of {@link ArtifactOutboxSweeper}. */
export interface ArtifactOutboxSweeperDeps {
  readonly outbox: ArtifactOutboxRepository;
  readonly fs: Pick<FileSystem, 'unlink' | 'rm'>;
  readonly logger: Logger;
  readonly degradations?: DegradationReporter;
  readonly maxAttempts?: number;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly scheduler?: IntervalScheduler;
}

/** Counts of one pass. */
export interface OutboxSweepResult {
  readonly deleted: number;
  readonly failed: number;
  readonly abandoned: number;
}

/**
 * Drains the outbox: `session_dir` entries are removed recursively, files are unlinked (a
 * missing path counts as success). A failure records the attempt; once an entry has failed
 * `maxAttempts` times it is abandoned so it cannot block the queue head forever.
 */
export class ArtifactOutboxSweeper {
  private cancel: (() => void) | undefined;
  private running = false;
  private readonly log: Logger;

  constructor(private readonly deps: ArtifactOutboxSweeperDeps) {
    this.log = deps.logger.child({ module: 'retention.outbox' });
  }

  /** Starts the timer. Idempotent. */
  start(): void {
    if (this.cancel !== undefined) return;
    this.cancel = (this.deps.scheduler ?? realIntervalScheduler).setInterval(() => {
      void this.sweepOnce().catch((err: unknown) => {
        this.log.error('outbox sweep failed', { err: serializeError(err) });
      });
    }, this.deps.intervalMs ?? DEFAULT_OUTBOX_INTERVAL_MS);
  }

  /** Stops the timer. Idempotent. */
  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  /**
   * One pass over the oldest entries. Overlapping calls coalesce.
   *
   * @returns Per-pass counts.
   */
  async sweepOnce(): Promise<OutboxSweepResult> {
    if (this.running) return { deleted: 0, failed: 0, abandoned: 0 };
    this.running = true;
    let deleted = 0;
    let failed = 0;
    let abandoned = 0;
    try {
      const entries = await this.deps.outbox.pending(this.deps.batchSize ?? DEFAULT_OUTBOX_BATCH);
      for (const entry of entries) {
        const outcome = await this.handle(entry);
        if (outcome === 'deleted') deleted += 1;
        else if (outcome === 'failed') failed += 1;
        else abandoned += 1;
      }
      if (failed === 0 && abandoned === 0 && deleted > 0) {
        this.log.debug('outbox drained', { deleted });
      }
      return { deleted, failed, abandoned };
    } finally {
      this.running = false;
    }
  }

  private async handle(entry: ArtifactOutboxRecord): Promise<'deleted' | 'failed' | 'abandoned'> {
    try {
      if (entry.kind === 'session_dir') await this.deps.fs.rm(entry.path, { recursive: true });
      else await this.deps.fs.unlink(entry.path);
      await this.deps.outbox.remove(entry.outboxId);
      return 'deleted';
    } catch (err) {
      const message = serializeError(err).message;
      const attempts = entry.attempts + 1;
      if (attempts >= (this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        this.log.error('artifact abandoned', { path: entry.path, attempts, detail: message });
        await this.safely(() => this.deps.outbox.remove(entry.outboxId));
        this.deps.degradations?.report({
          code: RETENTION_FAILED,
          severity: 'warn',
          message: `artifact could not be deleted after ${attempts} attempts: ${entry.path}`,
          details: { step: OUTBOX_STEP },
        });
        return 'abandoned';
      }
      this.log.warn('artifact delete failed', { path: entry.path, attempts, detail: message });
      await this.safely(() => this.deps.outbox.markFailed(entry.outboxId, message));
      return 'failed';
    }
  }

  private async safely(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.error('outbox update failed', { err: serializeError(err) });
    }
  }
}
