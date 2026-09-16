/** @module app/observability/degradations — `DegradationReporter` over `system_events`: in-process aggregation by code + details fingerprint, `system.degraded/recovered` events, recovery (spec 10 §3). */

import type { SystemEvent } from '@browserhive/contracts/http';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Degradation, DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { SystemEventRepository } from '../../ports/persistence/operations.ts';
import type { JsonObject, SystemEventRecord } from '../../ports/persistence/records.ts';
import { type DomainEvents, isRecord } from '../events/catalog.ts';

/** Dependencies of {@link DegradationService}. */
export interface DegradationServiceDeps {
  readonly repo: SystemEventRepository;
  readonly bus: EventPublisher<DomainEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/** Running counters exposed for metrics and `/system`. */
export interface DegradationCounters {
  /** Reports accepted (including repeats of an open row). */
  readonly reported: number;
  /** Rows resolved through {@link DegradationService.resolve}. */
  readonly resolved: number;
  /** Repository failures swallowed (the reporter never throws). */
  readonly failed: number;
}

/** Severity of a degradation row. */
export type DegradationSeverity = Degradation['severity'];

/** Source of an unhandled failure handed to {@link DegradationService.unhandled}. */
export type UnhandledKind = 'exception' | 'rejection';

/**
 * Serialises details with keys sorted at every depth so equal details always produce the same
 * text (the aggregation key, and what the repository compares).
 *
 * @returns A canonical JSON string (`'null'` for absent details).
 */
export function fingerprint(details: Readonly<Record<string, unknown>> | undefined): string {
  return JSON.stringify(canonical(details ?? null));
}

/**
 * Sorted-key copy of `details` so the persisted JSON is byte-stable across producers.
 *
 * @returns The canonical object, or `null` when there are no details.
 */
export function stableDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): JsonObject | null {
  if (details === undefined) return null;
  return canonicalObject(details);
}

function canonicalObject(source: Readonly<Record<string, unknown>>): JsonObject {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const v = canonical(source[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item) ?? null);
  if (isRecord(value)) return canonicalObject(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  return value;
}

/**
 * Wire projection of a row (`SystemEvent` DTO).
 *
 * @returns The snake_case DTO.
 */
export function toSystemEvent(record: SystemEventRecord): SystemEvent {
  return {
    event_id: record.eventId,
    code: record.code,
    severity: record.severity,
    message: record.message,
    details: record.details,
    first_seen_at: record.firstSeenAt,
    last_seen_at: record.lastSeenAt,
    count: record.count,
    resolved_at: record.resolvedAt,
  };
}

/**
 * The one producer of `system_events`. Reports are aggregated in-process by `code` + details
 * fingerprint (one open row per pair, `count` growing), persisted through the repository and
 * published as `system.degraded`; `recovered(code)` resolves every open row of that code and
 * publishes `system.recovered`. The port methods are fire-and-forget (writes are serialised
 * on one chain; `idle()` awaits it) and never throw.
 */
export class DegradationService implements DegradationReporter {
  private readonly open_ = new Map<string, SystemEventRecord>();
  private readonly log: Logger;
  private tail: Promise<void> = Promise.resolve();
  private reported = 0;
  private resolved = 0;
  private failed = 0;

  constructor(private readonly deps: DegradationServiceDeps) {
    this.log = deps.logger.child({ module: 'system.degradations' });
  }

  /** Hydrates the in-process view from open rows (call once on boot, after migrations). */
  async load(): Promise<void> {
    for (const row of await this.deps.repo.open()) {
      this.open_.set(keyOf(row.code, row.details), row);
    }
  }

  report(degradation: Degradation): void {
    const at = this.deps.clock.now();
    this.chain(async () => {
      await this.record(degradation, at);
    });
  }

  recovered(code: string): void {
    const at = this.deps.clock.now();
    this.chain(async () => {
      await this.resolve(code, at);
    });
  }

  /** Records an unhandled exception/rejection from the process handlers as `UNHANDLED`. */
  unhandled(error: unknown, kind: UnhandledKind): void {
    const serialized = serializeError(error);
    this.report({
      code: 'UNHANDLED',
      severity: 'error',
      message: `unhandled ${kind}: ${serialized.message}`,
      details: { kind, name: serialized.name },
    });
  }

  /**
   * Records one occurrence and publishes `system.degraded`. Awaitable variant of {@link report}.
   *
   * @returns The stored row, or `null` when the repository failed.
   */
  async record(
    degradation: Degradation,
    at: number = this.deps.clock.now(),
  ): Promise<SystemEventRecord | null> {
    const details = stableDetails(degradation.details);
    const key = keyOf(degradation.code, details);
    const previous = this.open_.get(key);
    try {
      const row = await this.deps.repo.record({
        eventId: previous?.eventId ?? this.deps.ids.eventId(),
        code: degradation.code,
        severity: degradation.severity,
        message: degradation.message,
        details,
        at,
      });
      this.reported += 1;
      this.open_.set(key, row);
      this.log[degradation.severity === 'error' ? 'error' : 'warn']('degradation recorded', {
        code: degradation.code,
        count: row.count,
        severity: degradation.severity,
      });
      this.deps.bus.publish('system.degraded', {
        type: 'system.degraded',
        event: toSystemEvent(row),
      });
      return row;
    } catch (err) {
      this.failed += 1;
      this.log.error('degradation write failed', {
        code: degradation.code,
        err: serializeError(err),
      });
      return null;
    }
  }

  /**
   * Resolves every open row of `code` and publishes `system.recovered` per row. Awaitable
   * variant of {@link recovered}.
   *
   * @returns Number of rows resolved.
   */
  async resolve(code: string, at: number = this.deps.clock.now()): Promise<number> {
    const affected = [...this.open_.entries()].filter(([, row]) => row.code === code);
    if (affected.length === 0) return 0;
    try {
      const n = await this.deps.repo.resolve(code, at);
      this.resolved += n;
      for (const [key, row] of affected) {
        this.open_.delete(key);
        this.deps.bus.publish('system.recovered', {
          type: 'system.recovered',
          event: toSystemEvent({ ...row, resolvedAt: at }),
        });
      }
      this.log.info('degradation resolved', { code, rows: n });
      return n;
    } catch (err) {
      this.failed += 1;
      this.log.error('degradation resolve failed', { code, err: serializeError(err) });
      return 0;
    }
  }

  /** Unresolved rows from the repository, oldest first (`/system.degradations`). */
  async open(): Promise<readonly SystemEventRecord[]> {
    await this.idle();
    return this.deps.repo.open();
  }

  /** Unresolved rows as known in-process (no I/O). */
  openRows(): readonly SystemEventRecord[] {
    return [...this.open_.values()];
  }

  /** True when an unresolved row of the given severity (any when omitted) exists. */
  hasOpen(severity?: DegradationSeverity): boolean {
    for (const row of this.open_.values()) {
      if (severity === undefined || row.severity === severity) return true;
    }
    return false;
  }

  /** Counters for metrics. */
  get counters(): DegradationCounters {
    return { reported: this.reported, resolved: this.resolved, failed: this.failed };
  }

  /** Resolves once every queued report/recovery has been applied. */
  idle(): Promise<void> {
    return this.tail;
  }

  private chain(step: () => Promise<void>): void {
    this.tail = this.tail.then(step, step).catch((err: unknown) => {
      this.failed += 1;
      this.log.error('degradation step failed', { err: serializeError(err) });
    });
  }
}

function keyOf(code: string, details: JsonObject | null): string {
  return `${code}|${fingerprint(details ?? undefined)}`;
}
