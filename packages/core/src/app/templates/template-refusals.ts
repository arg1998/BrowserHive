/** @module app/templates/template-refusals — the agents a template's access rules refused (spec 13 §6.1, §11.1; deferred D60): which refusals count, a fire-and-forget recorder that coalesces a looping agent's refusals into one write, and the operator's read (`GET /templates/{id}/refusals`). The agent's answer never depends on any of it. */

import { UNKNOWN_HARNESS } from '@browserhive/contracts/harness';
import { TEMPLATE_REFUSALS_MAX, type TemplateRefusalsResponse } from '@browserhive/contracts/http';
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

/** Dependencies of {@link TemplateRefusals}. */
export interface TemplateRefusalsDeps {
  readonly queue: Pick<WriteQueue, 'enqueue' | 'drain'>;
  readonly repos: Pick<Repositories, 'templates' | 'templateRefusals'>;
  readonly logger: Logger;
  /** Rows kept per template (default {@link TEMPLATE_REFUSALS_MAX}). */
  readonly maxRows?: number;
}

/** Records refusals through the write queue and serves the operator's list. */
export class TemplateRefusals implements TemplateRefusalSink {
  readonly #deps: TemplateRefusalsDeps;
  readonly #log: Logger;
  readonly #max: number;
  /** Refusals waiting for their write, by row: a burst of one client becomes one upsert. */
  readonly #pending = new Map<string, TemplateRefusalRecord>();

  constructor(deps: TemplateRefusalsDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.refusals' });
    this.#max = deps.maxRows ?? TEMPLATE_REFUSALS_MAX;
  }

  note(refusal: TemplateRefusalRecord): void {
    try {
      const key = keyOf(refusal);
      const waiting = this.#pending.get(key);
      if (waiting !== undefined) {
        this.#pending.set(key, {
          ...waiting,
          reason: refusal.reason,
          count: waiting.count + refusal.count,
          lastAt: Math.max(waiting.lastAt, refusal.lastAt),
        });
        return;
      }
      this.#pending.set(key, refusal);
      const accepted = this.#deps.queue.enqueue('template_refusals.record', async (repos) => {
        const delta = this.#pending.get(key);
        this.#pending.delete(key);
        if (delta !== undefined) await repos.templateRefusals.record(delta, this.#max);
      });
      if (!accepted) this.#pending.delete(key);
    } catch (error) {
      this.#log.warn('refusal not recorded', { err: serializeError(error) });
    }
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
