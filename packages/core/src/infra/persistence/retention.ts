/** @module infra/persistence/retention — one retention pass over the retention classes of spec 03 §7.1. */

import { type Kysely, sql } from 'kysely';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  RetentionFailure,
  RetentionPolicy,
  RetentionResult,
} from '../../ports/persistence/maintenance.ts';
import { withSpan } from './dialect/spans.ts';
import type { DB } from './generated/db.d.ts';
import { asNumber } from './repositories/common.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rounds of the byte-cap loop before giving up, so a sweep always terminates even when deletes free no space. */
const MAX_BYTE_CAP_ROUNDS = 64;
/** `incremental_vacuum` chunks issued per sweep at most. */
const MAX_VACUUM_CHUNKS = 16;

/** Collaborators of {@link sweepRetention}. */
export interface RetentionContext {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Current size of the database file in bytes. */
  databaseSize(): Promise<number>;
  /** `PRAGMA incremental_vacuum(N)`. */
  incrementalVacuum(pages: number): Promise<void>;
}

class Sweep {
  readonly pruned: Record<string, number> = {};
  readonly failures: RetentionFailure[] = [];
  artifacts = 0;

  constructor(private readonly ctx: RetentionContext) {}

  /** Runs one isolated step; a failure is recorded and never propagates. */
  async step(name: string, fn: () => Promise<number>): Promise<void> {
    try {
      const n = await fn();
      this.pruned[name] = (this.pruned[name] ?? 0) + n;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failures.push({ step: name, message });
      this.ctx.logger.warn('retention step failed', { step: name, error: message });
    }
  }

  async deleteWhere(
    table:
      | 'tool_calls'
      | 'pages'
      | 'events'
      | 'resource_samples'
      | 'logs'
      | 'vault_access'
      | 'blocked_requests'
      | 'auth_events'
      | 'operator_actions',
    col: string,
    cutoff: number,
  ): Promise<number> {
    const result =
      await sql`DELETE FROM ${sql.table(table)} WHERE ${sql.ref(col)} < ${cutoff}`.execute(
        this.ctx.db,
      );
    return Number(result.numAffectedRows ?? 0n);
  }

  /** Telemetry rows older than `cutoff`; screenshots go through the outbox in the same transaction. */
  async pruneTelemetry(cutoff: number): Promise<void> {
    await this.step('screenshots', () =>
      this.ctx.db.transaction().execute(async (trx) => {
        const shots = await trx
          .selectFrom('screenshots')
          .select(['event_id', 'path', 'session_id'])
          .where('ts', '<', cutoff)
          .execute();
        if (shots.length === 0) return 0;
        const now = this.ctx.clock.now();
        await trx
          .insertInto('artifact_outbox')
          .values(
            shots.map((s) => ({
              kind: 'screenshot',
              path: s.path,
              session_id: s.session_id,
              enqueued_at: now,
            })),
          )
          .execute();
        await trx
          .deleteFrom('screenshots')
          .where(
            'event_id',
            'in',
            shots.map((s) => s.event_id),
          )
          .execute();
        this.artifacts += shots.length;
        return shots.length;
      }),
    );
    await this.step('tool_calls', () => this.deleteWhere('tool_calls', 'ts', cutoff));
    await this.step('pages', () => this.deleteWhere('pages', 'ts', cutoff));
    await this.step('events', () => this.deleteWhere('events', 'occurred_at', cutoff));
    await this.step('resource_samples', () => this.deleteWhere('resource_samples', 'ts', cutoff));
    await this.step('logs', () => this.deleteWhere('logs', 'ts', cutoff));
  }

  async pruneAudit(cutoff: number): Promise<void> {
    await this.step('vault_access', () => this.deleteWhere('vault_access', 'ts', cutoff));
    await this.step('blocked_requests', () => this.deleteWhere('blocked_requests', 'ts', cutoff));
    await this.step('auth_events', () => this.deleteWhere('auth_events', 'occurred_at', cutoff));
    await this.step('operator_actions', () =>
      this.deleteWhere('operator_actions', 'occurred_at', cutoff),
    );
    await this.step('operator_requests', async () => {
      const result = await this.ctx.db
        .deleteFrom('operator_requests')
        .where('status', '<>', 'pending')
        .where('created_at', '<', cutoff)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    });
  }

  /** Closed, non-archived sessions past the cutoff whose children are all gone. */
  async pruneSessions(cutoff: number): Promise<void> {
    await this.step('sessions', () =>
      this.ctx.db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('sessions as s')
          .select('s.session_id')
          .where('s.closed_at', 'is not', null)
          .where('s.closed_at', '<', cutoff)
          .where('s.archived_at', 'is', null)
          .where(
            sql<boolean>`NOT EXISTS (SELECT 1 FROM tool_calls c WHERE c.session_id = s.session_id)`,
          )
          .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM pages c WHERE c.session_id = s.session_id)`)
          .where(
            sql<boolean>`NOT EXISTS (SELECT 1 FROM vault_access c WHERE c.session_id = s.session_id)`,
          )
          .where(
            sql<boolean>`NOT EXISTS (SELECT 1 FROM blocked_requests c WHERE c.session_id = s.session_id)`,
          )
          .where(
            sql<boolean>`NOT EXISTS (SELECT 1 FROM operator_requests c WHERE c.session_id = s.session_id)`,
          )
          .where(
            sql<boolean>`NOT EXISTS (SELECT 1 FROM events c WHERE c.session_id = s.session_id)`,
          )
          .execute();
        if (rows.length === 0) return 0;
        const ids = rows.map((r) => r.session_id);
        const now = this.ctx.clock.now();
        await trx
          .insertInto('artifact_outbox')
          .values(
            ids.map((id) => ({
              kind: 'session_dir',
              path: `sessions/${id}`,
              session_id: id,
              enqueued_at: now,
            })),
          )
          .execute();
        await trx.deleteFrom('sessions').where('session_id', 'in', ids).execute();
        this.artifacts += ids.length;
        return ids.length;
      }),
    );
  }

  async pruneNotifications(seenCutoff: number, unseenCutoff: number): Promise<void> {
    await this.step('notifications', async () => {
      const result = await this.ctx.db
        .deleteFrom('notifications')
        .where((eb) =>
          eb.or([
            eb('dismissed_at', '<', seenCutoff),
            eb('read_at', '<', seenCutoff),
            eb('created_at', '<', unseenCutoff),
          ]),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    });
  }

  async oldestTelemetryTs(): Promise<number | null> {
    const result = await sql<{ m: number | null }>`
      SELECT MIN(ts) AS m FROM (
        SELECT ts FROM tool_calls UNION ALL SELECT ts FROM pages UNION ALL SELECT occurred_at AS ts FROM events
      )`.execute(this.ctx.db);
    const m = result.rows[0]?.m;
    return m === null || m === undefined ? null : asNumber(m);
  }
}

/**
 * One pass: age-prune telemetry, audit, sessions and notifications; enforce the byte cap by
 * pruning progressively older telemetry slices; reclaim pages in bounded `incremental_vacuum`
 * chunks. Never throws; failed steps are reported in `failures`.
 */
export async function sweepRetention(
  ctx: RetentionContext,
  policy: RetentionPolicy,
): Promise<RetentionResult> {
  return withSpan('retention.sweep', {}, async (span) => {
    const startedAt = ctx.clock.now();
    const bytesBefore = await ctx.databaseSize().catch(() => 0);
    const sweep = new Sweep(ctx);
    const now = startedAt;
    const telemetryCutoff = now - Math.max(1, policy.retentionDays) * DAY_MS;
    const auditCutoff = now - Math.max(1, policy.auditRetentionDays) * DAY_MS;
    const chunk = Math.max(1, policy.vacuumChunkPages ?? 256);

    await sweep.pruneTelemetry(telemetryCutoff);
    await sweep.pruneAudit(auditCutoff);
    await sweep.pruneSessions(telemetryCutoff);
    await sweep.pruneNotifications(
      now - (policy.notificationSeenDays ?? 30) * DAY_MS,
      now - (policy.notificationDays ?? 90) * DAY_MS,
    );
    await sweep.step('idempotency_keys', async () => {
      const result = await ctx.db
        .deleteFrom('idempotency_keys')
        .where('created_at', '<', now - DAY_MS)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    });

    // Byte cap: advance a cutoff ~20% from the oldest telemetry toward now each round.
    for (let round = 0; round < MAX_BYTE_CAP_ROUNDS; round++) {
      let size = 0;
      try {
        await ctx.incrementalVacuum(chunk);
        size = await ctx.databaseSize();
      } catch (error) {
        sweep.failures.push({ step: 'byte_cap', message: String(error) });
        break;
      }
      if (size <= policy.retentionBytes) break;
      const oldest = await sweep.oldestTelemetryTs().catch(() => null);
      if (oldest === null) break;
      const step = Math.max(1, Math.floor((now - oldest) * 0.2));
      const cutoff = oldest + step >= now ? now + 1 : oldest + step;
      await sweep.pruneTelemetry(cutoff);
      await sweep.pruneSessions(cutoff);
    }

    for (let i = 0; i < MAX_VACUUM_CHUNKS; i++) {
      let freelist = 0;
      try {
        const result = await sql<{
          n: number;
        }>`SELECT freelist_count AS n FROM pragma_freelist_count`.execute(ctx.db);
        freelist = asNumber(result.rows[0]?.n);
        if (freelist === 0) break;
        await ctx.incrementalVacuum(chunk);
      } catch (error) {
        sweep.failures.push({ step: 'incremental_vacuum', message: String(error) });
        break;
      }
    }

    const bytesAfter = await ctx.databaseSize().catch(() => bytesBefore);
    const durationMs = Math.max(0, ctx.clock.now() - startedAt);
    const prunedTotal = Object.values(sweep.pruned).reduce((a, b) => a + b, 0);
    span.setAttribute('browserhive.pruned', prunedTotal);
    span.setAttribute('browserhive.failed', sweep.failures.length);
    ctx.logger.info('retention pass', {
      pruned: prunedTotal,
      artifacts: sweep.artifacts,
      failures: sweep.failures.length,
      bytes_before: bytesBefore,
      bytes_after: bytesAfter,
      duration_ms: durationMs,
    });
    return {
      startedAt,
      durationMs,
      prunedRows: sweep.pruned,
      artifactsEnqueued: sweep.artifacts,
      bytesBefore,
      bytesAfter,
      failures: sweep.failures,
    };
  });
}
