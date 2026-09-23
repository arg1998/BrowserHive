/** @module interface/ws/input-audit — the `operator.input` audit: accepted takeover input, coalesced per second per session and principal into `operator_actions` rows (spec 03 §6.3). */

import type { LiveInput } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { OperatorActionRepository } from '../../ports/persistence/operations.ts';
import type { Schedule } from './live-view-support.ts';

/** How long one audit row gathers input before it is written. */
export const INPUT_AUDIT_WINDOW_MS = 1_000;

/** Who sent an input, and through which door. */
export interface OperatorActor {
  readonly principalId: string;
  readonly via: 'ws' | 'rest';
}

type InputKind = z.output<typeof LiveInput>['type'];

/** Dependencies of {@link OperatorInputAudit}. */
export interface OperatorInputAuditDeps {
  readonly actions: Pick<OperatorActionRepository, 'append'>;
  readonly eventId: () => string;
  readonly now: () => number;
  readonly schedule: Schedule;
  readonly logger: Logger;
  readonly windowMs?: number;
}

interface Window {
  readonly sessionId: string;
  readonly principalId: string;
  readonly startedAt: number;
  readonly counts: Record<InputKind, number>;
  readonly via: Set<OperatorActor['via']>;
  readonly cancel: () => void;
}

/**
 * Coalesces accepted operator input into one `operator_actions` row per session, principal and
 * window: `action: 'input'`, `details: { inputs, mouse, key, touch, via, window_ms }`,
 * `occurred_at` = the window's first input. Only counts are stored — never keys, text or
 * coordinates, because takeover is how an operator types a password. Writes never throw.
 */
export class OperatorInputAudit {
  private readonly windows = new Map<string, Window>();
  private readonly writes = new Set<Promise<void>>();
  private readonly windowMs: number;
  private readonly log: Logger;

  constructor(private readonly deps: OperatorInputAuditDeps) {
    this.windowMs = deps.windowMs ?? INPUT_AUDIT_WINDOW_MS;
    this.log = deps.logger.child({ module: 'ws.input_audit' });
  }

  /** Counts one accepted input; opens a window when none is running for this session and actor. */
  record(sessionId: string, actor: OperatorActor, kind: InputKind): void {
    const key = `${sessionId}\u0000${actor.principalId}`;
    let window = this.windows.get(key);
    if (window === undefined) {
      window = {
        sessionId,
        principalId: actor.principalId,
        startedAt: this.deps.now(),
        counts: { mouse: 0, key: 0, touch: 0 },
        via: new Set(),
        cancel: this.deps.schedule(() => this.flush(key), this.windowMs),
      };
      this.windows.set(key, window);
    }
    window.counts[kind] += 1;
    window.via.add(actor.via);
  }

  /** Writes every open window now (shutdown) and waits for all pending writes. */
  async flushAll(): Promise<void> {
    for (const [key, window] of [...this.windows]) {
      window.cancel();
      this.flush(key);
    }
    await Promise.all([...this.writes]);
  }

  private flush(key: string): void {
    const window = this.windows.get(key);
    if (window === undefined) return;
    this.windows.delete(key);
    const { mouse, key: keys, touch } = window.counts;
    const write = this.deps.actions
      .append({
        eventId: this.deps.eventId(),
        principalId: window.principalId,
        action: 'input',
        resourceKind: 'session',
        resourceId: window.sessionId,
        details: {
          inputs: mouse + keys + touch,
          mouse,
          key: keys,
          touch,
          via: [...window.via].sort(),
          window_ms: this.windowMs,
        },
        occurredAt: window.startedAt,
      })
      .then(
        () => undefined,
        (err: unknown) =>
          this.log.warn('input audit write failed', {
            session_id: window.sessionId,
            err: serializeError(err),
          }),
      );
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write));
  }
}
