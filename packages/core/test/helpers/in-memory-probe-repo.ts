/** @module test/helpers/in-memory-probe-repo — `template_probes` in memory, newest first like the SQLite repository. */

import type { Page } from '../../src/ports/persistence/queries.ts';
import type { TemplateProbeRecord } from '../../src/ports/persistence/records-templates.ts';
import type {
  TemplateProbeQuery,
  TemplateProbeRepository,
} from '../../src/ports/persistence/templates.ts';

/** `template_probes` in memory. */
export class InMemoryTemplateProbeRepository implements TemplateProbeRepository {
  readonly rows: TemplateProbeRecord[] = [];
  #seq = 0;

  async insert(record: TemplateProbeRecord): Promise<number> {
    this.#seq += 1;
    this.rows.push({ ...record, seq: this.#seq });
    return this.#seq;
  }

  async list(templateId: string, query: TemplateProbeQuery): Promise<Page<TemplateProbeRecord>> {
    const limit = query.limit ?? 50;
    // Keyset on (at, seq) like SQLite: `<at>:<seq>` of the last row of the previous page.
    const [afterAt, afterSeq] = (query.cursor ?? '').split(':').map(Number);
    const after =
      query.cursor == null || afterAt === undefined || afterSeq === undefined
        ? null
        : { at: afterAt, seq: afterSeq };
    const rows = this.rows
      .filter(
        (r) =>
          r.templateId === templateId &&
          (query.siteId === undefined || r.siteId === query.siteId) &&
          (query.outcomes === undefined || query.outcomes.includes(r.outcome)) &&
          (query.triggers === undefined || query.triggers.includes(r.trigger)) &&
          (query.since === undefined || r.at >= query.since) &&
          (query.until === undefined || r.at < query.until),
      )
      .sort((a, b) => b.at - a.at || b.seq - a.seq)
      .filter((r) => after === null || r.at < after.at || (r.at === after.at && r.seq < after.seq));
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > limit && last !== undefined ? `${last.at}:${last.seq}` : null,
    };
  }

  async since(since: number, until: number): Promise<readonly TemplateProbeRecord[]> {
    return this.rows
      .filter((r) => r.at >= since && r.at < until)
      .sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  async prune(before: number): Promise<number> {
    const keep = this.rows.filter((r) => r.at >= before);
    const removed = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return removed;
  }
}
