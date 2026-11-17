/** @module test/helpers/in-memory-site-pack-repos — `site_pack_state`, `site_pack_changes` and `site_guard_hits` in memory, ordered and paged like the SQLite repositories. */

import type { Page } from '../../src/ports/persistence/queries.ts';
import type {
  SiteGuardHitQuery,
  SiteGuardHitRecord,
  SiteGuardHitRepository,
  SitePackChangeQuery,
  SitePackChangeRecord,
  SitePackChangeRepository,
  SitePackDecisionValue,
  SitePackSourceId,
  SitePackStateRecord,
  SitePackStateRepository,
  UnreadableRowOptions,
} from '../../src/ports/persistence/site-packs.ts';

const PENDING: readonly SitePackDecisionValue[] = ['available', 'downloaded'];

/** Like the SQLite mapping: a corrupt row throws, or is reported and left out. */
function readable(
  corrupt: ReadonlySet<string>,
  packId: string,
  options: UnreadableRowOptions,
): boolean {
  if (!corrupt.has(packId)) return true;
  const error = new Error(`corrupt site-pack row ${packId}`);
  if (options.onUnreadable === undefined) throw error;
  options.onUnreadable(packId, error);
  return false;
}

/** `site_pack_state` in memory. */
export class InMemorySitePackStateRepository implements SitePackStateRepository {
  readonly rows = new Map<string, SitePackStateRecord>();

  /** Packs whose rows read as corrupt (tests of unreadable rows). */
  readonly corrupt = new Set<string>();

  async list(options: UnreadableRowOptions = {}): Promise<readonly SitePackStateRecord[]> {
    return [...this.rows.values()]
      .filter((r) => readable(this.corrupt, r.packId, options))
      .sort((a, b) => (a.packId < b.packId ? -1 : 1));
  }

  async get(packId: string): Promise<SitePackStateRecord | null> {
    if (this.corrupt.has(packId)) throw new Error(`corrupt site_pack_state row ${packId}`);
    return this.rows.get(packId) ?? null;
  }

  async put(record: SitePackStateRecord): Promise<void> {
    this.rows.set(record.packId, { ...record, approvedDomains: [...record.approvedDomains] });
  }
}

/** Keyset cursor `<key>:<id>` of the last row of the previous page. */
function splitCursor(cursor: string | null | undefined): { key: number; id: string } | null {
  if (cursor == null || cursor === '') return null;
  const at = cursor.indexOf(':');
  return { key: Number(cursor.slice(0, at)), id: cursor.slice(at + 1) };
}

/** `site_pack_changes` in memory. */
export class InMemorySitePackChangeRepository implements SitePackChangeRepository {
  readonly rows: SitePackChangeRecord[] = [];
  #seq = 0;

  async insert(record: SitePackChangeRecord): Promise<SitePackChangeRecord> {
    if (this.rows.some((r) => r.eventId === record.eventId)) {
      throw new Error(`UNIQUE constraint failed: site_pack_changes.event_id (${record.eventId})`);
    }
    this.#seq += 1;
    const stored = { ...record, seq: this.#seq };
    this.rows.push(stored);
    return stored;
  }

  async decide(
    eventId: string,
    decision: SitePackDecisionValue,
    by: string | null,
    at: number,
  ): Promise<void> {
    const i = this.rows.findIndex((r) => r.eventId === eventId);
    const row = this.rows[i];
    if (row !== undefined) this.rows[i] = { ...row, decision, decidedBy: by, decidedAt: at };
  }

  async findCandidate(
    packId: string,
    sha256: string,
    source: SitePackSourceId,
  ): Promise<SitePackChangeRecord | null> {
    const matches = this.rows.filter(
      (r) => r.packId === packId && r.toSha256 === sha256 && r.source === source,
    );
    return matches.sort((a, b) => b.seq - a.seq)[0] ?? null;
  }

  /** Packs whose rows read as corrupt (tests of unreadable rows). */
  readonly corrupt = new Set<string>();

  async listPending(options: UnreadableRowOptions = {}): Promise<readonly SitePackChangeRecord[]> {
    return this.rows
      .filter((r) => PENDING.includes(r.decision))
      .filter((r) => readable(this.corrupt, r.packId, options))
      .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
  }

  async list(query: SitePackChangeQuery): Promise<Page<SitePackChangeRecord>> {
    const limit = query.limit ?? 50;
    const after = splitCursor(query.cursor);
    const since = query.window?.since;
    const until = query.window?.until;
    const rows = this.rows
      .filter(
        (r) =>
          (query.packId === undefined || r.packId === query.packId) &&
          (query.decisions === undefined ||
            query.decisions.length === 0 ||
            query.decisions.includes(r.decision)) &&
          (since === undefined || r.createdAt >= since) &&
          (until === undefined || r.createdAt < until),
      )
      .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)
      .filter(
        (r) =>
          after === null ||
          r.createdAt < after.key ||
          (r.createdAt === after.key && r.seq < Number(after.id)),
      );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last !== undefined ? `${last.createdAt}:${last.seq}` : null,
    };
  }

  async pruneBefore(before: number): Promise<number> {
    const keep = this.rows.filter((r) => r.createdAt >= before || PENDING.includes(r.decision));
    const removed = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return removed;
  }
}

/** `site_guard_hits` in memory. */
export class InMemorySiteGuardHitRepository implements SiteGuardHitRepository {
  readonly rows: SiteGuardHitRecord[] = [];

  async insert(record: SiteGuardHitRecord): Promise<void> {
    if (this.rows.some((r) => r.eventId === record.eventId)) return;
    this.rows.push(record);
  }

  async list(query: SiteGuardHitQuery): Promise<Page<SiteGuardHitRecord>> {
    const limit = query.limit ?? 50;
    const after = splitCursor(query.cursor);
    const since = query.window?.since;
    const until = query.window?.until;
    const rows = this.rows
      .filter(
        (r) =>
          (query.templateId === undefined || r.templateId === query.templateId) &&
          (query.sessionId === undefined || r.sessionId === query.sessionId) &&
          (query.packId === undefined || r.packId === query.packId) &&
          (query.actions === undefined ||
            query.actions.length === 0 ||
            query.actions.includes(r.action)) &&
          (since === undefined || r.ts >= since) &&
          (until === undefined || r.ts <= until) &&
          (query.excludeApproved !== true || r.outcome !== 'approved') &&
          (query.q === undefined ||
            query.q === '' ||
            [r.url, r.packId, r.guardId].some((v) =>
              v.toLowerCase().includes((query.q ?? '').toLowerCase()),
            )),
      )
      .sort((a, b) => b.ts - a.ts || (a.eventId < b.eventId ? 1 : -1))
      .filter(
        (r) => after === null || r.ts < after.key || (r.ts === after.key && r.eventId < after.id),
      );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > limit && last !== undefined ? `${last.ts}:${last.eventId}` : null,
    };
  }

  async countByTemplate(templateId: string, since: number): Promise<number> {
    return this.rows.filter((r) => r.templateId === templateId && r.ts >= since).length;
  }

  async pruneBefore(before: number): Promise<number> {
    const keep = this.rows.filter((r) => r.ts >= before);
    const removed = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return removed;
  }
}
