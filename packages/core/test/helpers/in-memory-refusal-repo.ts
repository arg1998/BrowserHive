/** @module test/helpers/in-memory-refusal-repo — `template_refusals` in memory (deferred D60): the same aggregation, folding of further harness names, bound and order as the SQLite repository; rows of a template that no longer exists are dropped as the foreign key cascade would. */

import { REFUSAL_OTHER_HARNESSES } from '@browserhive/contracts/http';
import type {
  TemplateRefusalRecord,
  TemplateRefusalRepository,
} from '../../src/ports/persistence/template-refusals.ts';

function keyOf(e: TemplateRefusalRecord): string {
  return [e.templateId, e.principal, e.harness, e.harnessDeclared ?? '', e.kind].join('\u0000');
}

/** `template_refusals` in memory. */
export class InMemoryTemplateRefusalRepository implements TemplateRefusalRepository {
  readonly rows = new Map<string, TemplateRefusalRecord & { readonly order: number }>();
  readonly #exists: (templateId: string) => boolean;
  #order = 0;

  /** `exists` answers whether a template row exists (`() => true` when not linked). */
  constructor(exists: (templateId: string) => boolean = () => true) {
    this.#exists = exists;
  }

  async record(delta: TemplateRefusalRecord, namesPerPrincipal: number): Promise<void> {
    if (!this.#exists(delta.templateId)) return;
    const declared = delta.harnessDeclared ?? '';
    const names = new Set(
      [...this.rows.values()]
        .filter(
          (r) =>
            r.templateId === delta.templateId &&
            r.principal === delta.principal &&
            r.harness !== REFUSAL_OTHER_HARNESSES,
        )
        .map((r) => `${r.harness}\u0000${r.harnessDeclared ?? ''}`),
    );
    const fold = !names.has(`${delta.harness}\u0000${declared}`) && names.size >= namesPerPrincipal;
    const effective: TemplateRefusalRecord = fold
      ? { ...delta, harness: REFUSAL_OTHER_HARNESSES, harnessDeclared: null }
      : { ...delta, harnessDeclared: declared === '' ? null : declared };
    const key = keyOf(effective);
    const row = this.rows.get(key);
    this.#order += 1;
    this.rows.set(key, {
      ...effective,
      count: (row?.count ?? 0) + delta.count,
      firstAt: Math.min(row?.firstAt ?? delta.firstAt, delta.firstAt),
      lastAt: Math.max(row?.lastAt ?? delta.lastAt, delta.lastAt),
      order: row?.order ?? this.#order,
    });
  }

  async prune(templateId: string, maxRows: number): Promise<void> {
    const own = [...this.rows.entries()]
      .filter(([, r]) => r.templateId === templateId)
      .sort(([, a], [, b]) => b.lastAt - a.lastAt || b.order - a.order);
    for (const [k] of own.slice(maxRows)) this.rows.delete(k);
  }

  async list(templateId: string): Promise<readonly TemplateRefusalRecord[]> {
    if (!this.#exists(templateId)) return [];
    return [...this.rows.values()]
      .filter((r) => r.templateId === templateId)
      .sort(
        (a, b) =>
          b.lastAt - a.lastAt ||
          (a.principal < b.principal ? -1 : a.principal > b.principal ? 1 : 0) ||
          (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
      )
      .map(({ order: _order, ...r }) => r);
  }
}
