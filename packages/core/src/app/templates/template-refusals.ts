/** @module app/templates/template-refusals — the agents a template's access rules refused (spec 13 §6.1, §11.1; deferred D60): which refusals count, a fire-and-forget recorder that holds a looping agent's refusals for a minute and writes them as one batch (one upsert per row, one prune per template), and the operator's read (`GET /templates/{id}/refusals`). The agent's answer never depends on any of it. */

import { UNKNOWN_HARNESS } from '@browserhive/contracts/harness';
import {
  REFUSAL_NAMES_PER_PRINCIPAL,
  TEMPLATE_REFUSALS_MAX,
  type TemplateRefusalsResponse,
} from '@browserhive/contracts/http';
import type { AccessSubject } from '../../domain/policies/access-rule.ts';
import type { TemplateRefusal } from '../../domain/templates/model.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Repositories, TemplateRecord, WriteQueue } from '../../ports/persistence/index.ts';
import type {
  TemplateRefusalKind,
  TemplateRefusalReason,
  TemplateRefusalRecord,
} from '../../ports/persistence/template-refusals.ts';
import { notFoundForOperator } from './template-errors.ts';

/** A declared harness name is stored up to this length (a rule entry is at most 64). */
const DECLARED_MAX = 128;

/** Where the agent-facing gate reports a refusal; `note` never throws and never waits. */
export interface TemplateRefusalSink {
  note(refusal: TemplateRefusalRecord): void;
}

/**
 * The refusal to record, or `null` when this one does not count: only a template that is `ready`
 * and refused by its access rule (principal or harness list). A template being recorded or one the
 * operator disabled is closed to every agent, so it says nothing about the access rule.
 */
export function refusalOf(
  template: TemplateRecord,
  reason: TemplateRefusal,
  subject: AccessSubject,
  kind: TemplateRefusalKind,
  at: number,
): TemplateRefusalRecord | null {
  if (template.status !== 'ready' || reason === 'recording') return null;
  const harness = subject.harness ?? '';
  const declared = subject.declared ?? '';
  return {
    templateId: template.templateId,
    principal: subject.principal,
    harness: harness === '' ? UNKNOWN_HARNESS : harness,
    harnessDeclared: declared === '' ? null : declared.slice(0, DECLARED_MAX),
    kind,
    reason: reason satisfies TemplateRefusalReason,
    count: 1,
    firstAt: at,
    lastAt: at,
  };
}

function keyOf(r: TemplateRefusalRecord): string {
  return [r.templateId, r.principal, r.harness, r.harnessDeclared ?? '', r.kind].join('\u0000');
}

/** Refusals are held this long and then written together (review #93 L1). */
export const REFUSAL_FLUSH_MS = 60_000;

/** Runs `fn` once after `ms`; returns a cancel. The default timer never keeps the process alive. */
export type RefusalTimer = (ms: number, fn: () => void) => () => void;

const unrefTimer: RefusalTimer = (ms, fn) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
};

/** Dependencies of {@link TemplateRefusals}. */
export interface TemplateRefusalsDeps {
  readonly queue: Pick<WriteQueue, 'enqueue' | 'drain'>;
  readonly repos: Pick<Repositories, 'templates' | 'templateRefusals'>;
  readonly logger: Logger;
  /** Rows kept per template (default {@link TEMPLATE_REFUSALS_MAX}). */
  readonly maxRows?: number;
  /** Harness names kept apart per principal (default {@link REFUSAL_NAMES_PER_PRINCIPAL}). */
  readonly namesPerPrincipal?: number;
  /** The flush timer (default an unref'd `setTimeout`). */
  readonly timer?: RefusalTimer;
}

/** Records refusals through the write queue and serves the operator's list. */
export class TemplateRefusals implements TemplateRefusalSink {
  readonly #deps: TemplateRefusalsDeps;
  readonly #log: Logger;
  readonly #max: number;
  readonly #names: number;
  readonly #timer: RefusalTimer;
  /** Refusals waiting for the next flush, by row: a client's refusals in a minute become one upsert. */
  readonly #pending = new Map<string, TemplateRefusalRecord>();
  #cancel: (() => void) | null = null;

  constructor(deps: TemplateRefusalsDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.refusals' });
    this.#max = deps.maxRows ?? TEMPLATE_REFUSALS_MAX;
    this.#names = deps.namesPerPrincipal ?? REFUSAL_NAMES_PER_PRINCIPAL;
    this.#timer = deps.timer ?? unrefTimer;
  }

  note(refusal: TemplateRefusalRecord): void {
    try {
      const key = keyOf(refusal);
      const waiting = this.#pending.get(key);
      this.#pending.set(
        key,
        waiting === undefined
          ? refusal
          : {
              ...waiting,
              reason: refusal.reason,
              count: waiting.count + refusal.count,
              lastAt: Math.max(waiting.lastAt, refusal.lastAt),
            },
      );
      this.#cancel ??= this.#timer(REFUSAL_FLUSH_MS, () => this.flush());
    } catch (error) {
      this.#log.warn('refusal not recorded', { err: serializeError(error) });
    }
  }

  /**
   * Hands what is held to the write queue as one job: an upsert per row, then one prune per
   * template touched. Called by the timer, before the operator's read, and at shutdown.
   */
  flush(): void {
    this.#cancel?.();
    this.#cancel = null;
    if (this.#pending.size === 0) return;
    const batch = [...this.#pending.values()];
    this.#pending.clear();
    try {
      const accepted = this.#deps.queue.enqueue('template_refusals.record', async (repos) => {
        for (const delta of batch) await repos.templateRefusals.record(delta, this.#names);
        for (const id of new Set(batch.map((d) => d.templateId))) {
          await repos.templateRefusals.prune(id, this.#max);
        }
      });
      if (!accepted) this.#log.warn('refusals dropped', { rows: batch.length });
    } catch (error) {
      this.#log.warn('refusals not recorded', { err: serializeError(error) });
    }
  }

  /** Shutdown: what is held goes to the write queue now. */
  stop(): void {
    this.flush();
  }

  /**
   * `GET /templates/{template_id}/refusals`: newest first, after every refusal noted so far.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`.
   */
  async list(templateId: string): Promise<TemplateRefusalsResponse> {
    if ((await this.#deps.repos.templates.get(templateId)) === null) {
      throw notFoundForOperator(templateId);
    }
    this.flush();
    await this.#deps.queue.drain();
    const rows = await this.#deps.repos.templateRefusals.list(templateId);
    return {
      data: rows.map((r) => ({
        principal: r.principal,
        harness: r.harness,
        harness_declared: r.harnessDeclared,
        kind: r.kind,
        reason: r.reason,
        count: r.count,
        first_at: r.firstAt,
        last_at: r.lastAt,
      })),
      max_rows: this.#max,
    };
  }
}
