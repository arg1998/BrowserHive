/** @module test/helpers/in-memory-repos-facts — Map-backed fact repositories (tool calls, pages, screenshots, vault access, blocked requests) for app-layer tests. */

import type {
  BlockedRequestListRow,
  BlocklistAuditRepository,
} from '../../src/ports/persistence/blocklist-audit.ts';
import type {
  DomainCount,
  PageFacets,
  PageListRow,
  PageRepository,
} from '../../src/ports/persistence/pages.ts';
import type {
  BlockedRequestListQuery,
  BlockedStats,
  Page,
  PageListQuery,
  PageQuery,
  ScreenshotListQuery,
  TimeWindow,
  ToolCallListQuery,
  TopDomainsQuery,
  VaultAccessListQuery,
} from '../../src/ports/persistence/queries.ts';
import type {
  BlockedRequestRecord,
  PageRecord,
  ScreenshotRecord,
  ToolCallRecord,
  VaultAccessRecord,
} from '../../src/ports/persistence/records.ts';
import type {
  ScreenshotListRow,
  ScreenshotRepository,
} from '../../src/ports/persistence/screenshots.ts';
import type {
  ToolCallListRow,
  ToolCallRepository,
} from '../../src/ports/persistence/tool-calls.ts';
import type {
  VaultAccessListRow,
  VaultAuditRepository,
} from '../../src/ports/persistence/vault-audit.ts';

/** Pages a whole list (no cursor support: tests read everything). */
export function pageOf<T>(items: readonly T[], query: PageQuery): Page<T> {
  const limit = query.limit ?? 50;
  const slice = items.slice(0, limit);
  return { items: slice, nextCursor: null, ...(query.total === true && { total: items.length }) };
}

/** Keeps rows whose `ts` falls in the window. */
export function inWindow<T extends { readonly ts: number }>(
  rows: readonly T[],
  window: TimeWindow,
): T[] {
  return rows.filter(
    (r) =>
      (window.since === undefined || r.ts >= window.since) &&
      (window.until === undefined || r.ts < window.until),
  );
}

/** Slug lookup shared by the fact repos (rows join `sessions.slug`). */
export type SlugLookup = (sessionId: string | null) => string | null;

/** `tool_calls` in memory. */
export class InMemoryToolCallRepository implements ToolCallRepository {
  readonly rows = new Map<string, ToolCallRecord>();
  /** Event ids that have a screenshot (set by the screenshot repo). */
  readonly withScreenshot = new Set<string>();

  constructor(private readonly slugOf: SlugLookup) {}

  async insert(record: ToolCallRecord): Promise<void> {
    if (!this.rows.has(record.eventId)) this.rows.set(record.eventId, record);
  }

  async get(eventId: string): Promise<ToolCallListRow | null> {
    const row = this.rows.get(eventId);
    return row === undefined ? null : this.row(row);
  }

  async listBySession(sessionId: string, query: ToolCallListQuery): Promise<Page<ToolCallListRow>> {
    return this.listAll({ ...query, sessionId });
  }

  async listAll(query: ToolCallListQuery): Promise<Page<ToolCallListRow>> {
    const rows = inWindow([...this.rows.values()], query)
      .filter((r) => query.sessionId === undefined || r.sessionId === query.sessionId)
      .filter((r) => query.hasSession === undefined || (r.sessionId !== null) === query.hasSession)
      .filter((r) => query.tools === undefined || query.tools.includes(r.tool))
      .filter((r) => query.ok === undefined || r.ok === query.ok)
      .filter((r) => query.hasError === undefined || (r.errorCode !== null) === query.hasError)
      .sort((a, b) => b.ts - a.ts);
    return pageOf(
      rows.map((r) => this.row(r)),
      query,
    );
  }

  private row(record: ToolCallRecord): ToolCallListRow {
    return {
      ...record,
      sessionSlug: this.slugOf(record.sessionId),
      hasScreenshot: this.withScreenshot.has(record.eventId),
      // Connections are not joined in memory: every call reads `unknown`.
      harness: 'unknown',
    };
  }
}

/** `pages` in memory. */
export class InMemoryPageRepository implements PageRepository {
  readonly rows = new Map<string, PageRecord>();

  constructor(private readonly slugOf: SlugLookup) {}

  async insert(record: PageRecord): Promise<void> {
    if (!this.rows.has(record.eventId)) this.rows.set(record.eventId, record);
  }

  async list(query: PageListQuery): Promise<Page<PageListRow>> {
    const rows = inWindow([...this.rows.values()], query)
      .filter((r) => query.sessionId === undefined || r.sessionId === query.sessionId)
      .filter((r) => query.categories === undefined || query.categories.includes(r.category))
      .filter((r) => query.domain === undefined || r.domain === query.domain)
      .filter((r) => query.tabId === undefined || r.tabId === query.tabId)
      .sort((a, b) => b.ts - a.ts);
    return pageOf(
      rows.map((r) => this.row(r)),
      query,
    );
  }

  async facets(query: PageListQuery): Promise<PageFacets> {
    const { categories: _categories, ...rest } = query;
    const counts = new Map<string, number>();
    for (const r of (await this.list({ ...rest, limit: Number.MAX_SAFE_INTEGER })).items)
      counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    return {
      categories: [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, count]) => ({ value, count })),
    };
  }

  async recent(limit: number): Promise<readonly PageListRow[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map((r) => this.row(r));
  }

  async topDomains(query: TopDomainsQuery): Promise<readonly DomainCount[]> {
    const counts = new Map<string, number>();
    for (const r of inWindow([...this.rows.values()], query))
      counts.set(r.domain, (counts.get(r.domain) ?? 0) + 1);
    return [...counts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, query.limit ?? 5);
  }

  private row(record: PageRecord): PageListRow {
    return { ...record, sessionSlug: this.slugOf(record.sessionId) };
  }
}

/** `screenshots` in memory. */
export class InMemoryScreenshotRepository implements ScreenshotRepository {
  readonly rows = new Map<string, ScreenshotRecord>();

  constructor(private readonly toolCalls: InMemoryToolCallRepository) {}

  async insert(record: ScreenshotRecord): Promise<void> {
    if (this.rows.has(record.eventId)) return;
    this.rows.set(record.eventId, record);
    this.toolCalls.withScreenshot.add(record.eventId);
  }

  async get(eventId: string): Promise<ScreenshotListRow | null> {
    const row = this.rows.get(eventId);
    return row === undefined ? null : this.row(row);
  }

  async listBySession(
    sessionId: string,
    query: ScreenshotListQuery,
  ): Promise<Page<ScreenshotListRow>> {
    const rows = inWindow([...this.rows.values()], query)
      .filter((r) => r.sessionId === sessionId)
      .filter((r) => query.kinds === undefined || query.kinds.includes(r.kind))
      .sort((a, b) => b.ts - a.ts);
    return pageOf(
      rows.map((r) => this.row(r)),
      query,
    );
  }

  private row(record: ScreenshotRecord): ScreenshotListRow {
    return { ...record, tool: this.toolCalls.rows.get(record.eventId)?.tool ?? null };
  }
}

/** `vault_access` in memory. */
export class InMemoryVaultAuditRepository implements VaultAuditRepository {
  readonly rows = new Map<string, VaultAccessRecord>();

  constructor(private readonly slugOf: SlugLookup) {}

  async insert(record: VaultAccessRecord): Promise<void> {
    if (!this.rows.has(record.eventId)) this.rows.set(record.eventId, record);
  }

  async list(query: VaultAccessListQuery): Promise<Page<VaultAccessListRow>> {
    const rows = inWindow([...this.rows.values()], query)
      .filter((r) => query.sessionId === undefined || r.sessionId === query.sessionId)
      .filter((r) => query.results === undefined || query.results.includes(r.result))
      .sort((a, b) => b.ts - a.ts);
    return pageOf(
      rows.map((r) => ({ ...r, sessionSlug: this.slugOf(r.sessionId) })),
      query,
    );
  }
}

/** `blocked_requests` in memory. */
export class InMemoryBlocklistAuditRepository implements BlocklistAuditRepository {
  readonly rows = new Map<string, BlockedRequestRecord>();

  constructor(private readonly slugOf: SlugLookup) {}

  async insert(record: BlockedRequestRecord): Promise<void> {
    if (!this.rows.has(record.eventId)) this.rows.set(record.eventId, record);
  }

  async list(query: BlockedRequestListQuery): Promise<Page<BlockedRequestListRow>> {
    const rows = inWindow([...this.rows.values()], query)
      .filter((r) => query.sessionId === undefined || r.sessionId === query.sessionId)
      .filter((r) => query.pattern === undefined || r.pattern === query.pattern)
      .filter((r) => query.sources === undefined || query.sources.includes(r.source))
      .sort((a, b) => b.ts - a.ts);
    return pageOf(
      rows.map((r) => ({ ...r, sessionSlug: this.slugOf(r.sessionId) })),
      query,
    );
  }

  async stats(window: TimeWindow, topLimit = 5): Promise<BlockedStats> {
    const rows = inWindow([...this.rows.values()], window);
    const patterns = new Map<string, { count: number; lastTs: number }>();
    const domains = new Map<string, number>();
    for (const r of rows) {
      const p = patterns.get(r.pattern) ?? { count: 0, lastTs: 0 };
      patterns.set(r.pattern, { count: p.count + 1, lastTs: Math.max(p.lastTs, r.ts) });
      if (r.domain !== null) domains.set(r.domain, (domains.get(r.domain) ?? 0) + 1);
    }
    return {
      attempts: rows.length,
      sessions: new Set(rows.map((r) => r.sessionId)).size,
      domains: domains.size,
      totalAllTime: this.rows.size,
      topPatterns: [...patterns.entries()]
        .map(([pattern, v]) => ({ pattern, ...v }))
        .sort((a, b) => b.count - a.count)
        .slice(0, topLimit),
      topDomains: [...domains.entries()]
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, topLimit),
    };
  }
}
