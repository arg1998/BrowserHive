/** @module app/maintenance/artifact-outbox-sweeper.test — unlink/rm by kind, markFailed with bounded retries, abandonment degradation. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import type { Degradation } from '../../ports/degradation-reporter.ts';
import type { ArtifactOutboxRepository } from '../../ports/persistence/operations.ts';
import type { ArtifactOutboxRecord, NewArtifact } from '../../ports/persistence/records.ts';
import { ArtifactOutboxSweeper } from './artifact-outbox-sweeper.ts';
import { MemoryFileSystem } from './test-support.ts';

class MemoryOutbox implements ArtifactOutboxRepository {
  rows: ArtifactOutboxRecord[] = [];
  async enqueue(a: NewArtifact) {
    const outboxId = this.rows.length + 1;
    this.rows.push({ ...a, outboxId, attempts: 0, lastError: null });
    return outboxId;
  }
  async pending(limit: number) {
    return this.rows.slice(0, limit);
  }
  async markFailed(id: number, error: string) {
    this.rows = this.rows.map((r) =>
      r.outboxId === id ? { ...r, attempts: r.attempts + 1, lastError: error } : r,
    );
  }
  async remove(id: number) {
    this.rows = this.rows.filter((r) => r.outboxId !== id);
  }
  async count() {
    return this.rows.length;
  }
}

function setup() {
  const fs = new MemoryFileSystem();
  const outbox = new MemoryOutbox();
  const reported: Degradation[] = [];
  const sweeper = new ArtifactOutboxSweeper({
    outbox,
    fs,
    logger: new CollectingLogger(),
    degradations: { report: (d) => void reported.push(d), recovered: () => undefined },
    maxAttempts: 3,
  });
  return { fs, outbox, reported, sweeper };
}

describe('ArtifactOutboxSweeper', () => {
  it('removes session dirs recursively and unlinks files; missing files count as deleted', async () => {
    const { fs, outbox, sweeper } = setup();
    fs.addFile('/d/sessions/s1/trace.zip', 'zip');
    fs.addFile('/d/shot.jpg', 'jpg');
    await outbox.enqueue({
      kind: 'session_dir',
      path: '/d/sessions/s1',
      sessionId: 's1',
      enqueuedAt: 1,
    });
    await outbox.enqueue({
      kind: 'screenshot',
      path: '/d/shot.jpg',
      sessionId: null,
      enqueuedAt: 1,
    });
    await outbox.enqueue({ kind: 'trace', path: '/d/gone.zip', sessionId: null, enqueuedAt: 1 });
    expect(await sweeper.sweepOnce()).toEqual({ deleted: 3, failed: 0, abandoned: 0 });
    expect(fs.calls).toEqual(['rm -r /d/sessions/s1', 'unlink /d/shot.jpg', 'unlink /d/gone.zip']);
    expect(fs.files.size).toBe(0);
    expect(await outbox.count()).toBe(0);
  });

  it('retries a failing entry up to maxAttempts, then abandons it with a degradation', async () => {
    const { fs, outbox, reported, sweeper } = setup();
    fs.addFile('/d/busy.jpg', 'x');
    fs.failing.add('/d/busy.jpg');
    await outbox.enqueue({
      kind: 'screenshot',
      path: '/d/busy.jpg',
      sessionId: null,
      enqueuedAt: 1,
    });

    expect(await sweeper.sweepOnce()).toEqual({ deleted: 0, failed: 1, abandoned: 0 });
    expect(outbox.rows[0]).toMatchObject({ attempts: 1, lastError: 'EBUSY: /d/busy.jpg' });
    await sweeper.sweepOnce();
    expect(outbox.rows[0]?.attempts).toBe(2);
    expect(reported).toHaveLength(0);

    expect(await sweeper.sweepOnce()).toEqual({ deleted: 0, failed: 0, abandoned: 1 });
    expect(await outbox.count()).toBe(0);
    expect(reported).toEqual([
      expect.objectContaining({ code: 'RETENTION_FAILED', details: { step: 'artifact_outbox' } }),
    ]);
    expect(fs.calls.filter((c) => c === 'unlink /d/busy.jpg')).toHaveLength(3);
  });
});
