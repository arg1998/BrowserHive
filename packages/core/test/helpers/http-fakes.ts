/** @module test/helpers/http-fakes — port doubles for the HTTP/WS suites: analytics, blocklist, notifications, preferences, logs, system, files, desktop, live control, realtime, idempotency. */

import type { BootPhase, HealthCheckState, HealthStatus } from '@browserhive/contracts/http';
import type { LiveInput } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type {
  BlocklistPort,
  HealthProbe,
  IdempotencyStore,
  LiveControlPort,
  LogEntry,
  LogQueryLike,
  LogsPort,
  NotificationsPort,
  PreferencesPort,
  RealtimeIntrospection,
  SystemFacts,
} from '../../src/interface/http/services.ts';
import type { Desktop, RevealResult } from '../../src/ports/desktop.ts';
import type {
  ActivityQuery,
  AnalyticsQueries,
  TimelineItem,
  TimelineQuery,
  ToolMetricsQuery,
} from '../../src/ports/persistence/analytics.ts';
import type { Page } from '../../src/ports/persistence/queries.ts';
import type { IdempotencyRecord } from '../../src/ports/persistence/records.ts';
import type { ArtifactFiles } from '../../src/ports/static-assets.ts';
import type { InMemoryNotificationRepository, InMemoryRepositories } from './in-memory-repos.ts';

/** Fixed test clock origin. */
export const NOW = 1_700_000_000_000;

/** Analytics over the in-memory fact repositories. */
export class FakeAnalytics implements AnalyticsQueries {
  constructor(private readonly repos: InMemoryRepositories) {}

  async activity(query: ActivityQuery) {
    const bucketMs = query.bucketMs ?? 3_600_000;
    return {
      buckets: [
        {
          ts: query.since,
          toolCalls: 2,
          errors: 1,
          sessionsStarted: 1,
          sessionsClosed: 0,
          blocked: 0,
          attention: 0,
        },
      ],
      window: { since: query.since, until: query.until, bucketMs },
    };
  }

  async toolMetrics(_query: ToolMetricsQuery) {
    return [
      {
        tool: 'navigate',
        errorCode: null,
        calls: 2,
        errors: 1,
        errorRate: 0.5,
        p50Ms: 10,
        p95Ms: 20,
        p99Ms: 20,
        maxMs: 20,
      },
    ];
  }

  async timeline(sessionId: string, query: TimelineQuery): Promise<Page<TimelineItem>> {
    const calls = await this.repos.toolCalls.listBySession(sessionId, { limit: 500 });
    const items: TimelineItem[] = calls.items.map((item) => ({
      kind: 'tool',
      ts: item.ts,
      id: `tool:${item.eventId}`,
      item,
    }));
    return { items: items.slice(0, query.limit ?? 50), nextCursor: null };
  }

  async summary() {
    return {
      sessionsTotal: this.repos.sessions.rows.size,
      sessionsLive: 0,
      sessionsWindow: 1,
      toolCallsWindow: 2,
      toolCallsTotal: this.repos.toolCalls.rows.size,
      errorsWindow: 1,
      errorsTotal: 1,
      blockedWindow: 0,
      blockedTotal: 0,
      attentionOpen: 0,
    };
  }

  async databaseSize(): Promise<number> {
    return 4096;
  }

  async topDomains() {
    return this.repos.pages.topDomains({});
  }
}

/** A configured blocklist with one pattern. */
export function fakeBlocklist(): BlocklistPort & { reloads: number } {
  const state = { reloads: 0 };
  return {
    configured: true,
    path: '/data/blocklist.txt',
    patterns: () => [{ pattern: 'evil.example', line: 1 }],
    skipped: () => [{ line: 2, text: '*', reason: 'wildcard_all' }],
    loadedAt: () => NOW,
    reload: async () => {
      state.reloads += 1;
      return { patterns: 1, skipped: 1 };
    },
    get reloads() {
      return state.reloads;
    },
  };
}

/** Notifications over the in-memory repository (anonymous inbox). */
export function fakeNotifications(repo: InMemoryNotificationRepository): NotificationsPort {
  return {
    list: (query) => repo.list({ ...query, principalId: null }),
    unreadCount: () => repo.unreadCount(null),
    markRead: (id) => repo.markRead(id, NOW),
    markAllRead: () => repo.markAllRead(null, NOW),
    dismiss: (id) => repo.dismiss(id, NOW),
    dismissAll: () => repo.dismissAll(null, NOW),
  };
}

/** Preferences in a map. */
export function fakePreferences(): PreferencesPort {
  const store = new Map<
    string,
    { preferences: Readonly<Record<string, unknown>>; updatedAt: number }
  >();
  return {
    list: async (principal) => store.get(principal) ?? { preferences: {}, updatedAt: null },
    replaceAll: async (principal, values) => {
      store.set(principal, { preferences: values, updatedAt: NOW });
      return { updatedAt: NOW };
    },
  };
}

/** A small ring buffer. */
export class FakeLogs implements LogsPort {
  readonly entries: LogEntry[] = [
    { seq: 1, record: { ts: NOW, level: 'info', msg: 'server started', module: 'system' } },
    { seq: 2, record: { ts: NOW + 1, level: 'warn', msg: 'login failed', module: 'auth' } },
  ];
  private readonly listeners = new Set<(entry: LogEntry) => void>();

  get latestSeq(): number {
    return this.entries.length;
  }

  query(query: LogQueryLike = {}) {
    const desc = query.order === 'desc';
    const ordered = desc ? [...this.entries].reverse() : this.entries;
    const filtered = ordered.filter(
      (e) =>
        (query.cursor === undefined || (desc ? e.seq < query.cursor : e.seq > query.cursor)) &&
        (query.afterSeq === undefined || e.seq > query.afterSeq) &&
        (query.level === undefined || query.level.includes(e.record.level)),
    );
    const limit = query.limit ?? 100;
    const items = filtered.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: filtered.length > limit && last !== undefined ? last.seq : null };
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  push(entry: LogEntry): void {
    this.entries.push(entry);
    for (const l of this.listeners) l(entry);
  }
}

/** Fixed server facts. */
export const SYSTEM_FACTS: SystemFacts = {
  version: '0.1.0',
  transport: 'http',
  startedAt: NOW - 60_000,
  traceEnabled: true,
};

/** Mutable health probe. */
export function fakeHealth(): HealthProbe & {
  set(status: HealthStatus, phase: BootPhase, check?: HealthCheckState): void;
} {
  let snapshot = {
    status: 'ready' as HealthStatus,
    phase: 'ready' as BootPhase,
    checks: {
      db: 'ok' as HealthCheckState,
      browser: 'ok' as HealthCheckState,
      listeners: 'ok' as HealthCheckState,
    },
  };
  return {
    snapshot: () => snapshot,
    set(status, phase, check = 'pending') {
      snapshot = { status, phase, checks: { db: check, browser: check, listeners: check } };
    },
  };
}

/** Files in memory. */
export class FakeFiles implements ArtifactFiles {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();

  async stat(path: string) {
    const bytes = this.files.get(path);
    return bytes === undefined
      ? null
      : { size: bytes.byteLength, isFile: true, isDirectory: false };
  }

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  stream(path: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
    const bytes = this.files.get(path) ?? new Uint8Array();
    const slice = range === undefined ? bytes : bytes.slice(range.start, range.end + 1);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(slice);
        controller.close();
      },
    });
  }

  async sizeOf(path: string): Promise<number> {
    let total = 0;
    for (const [p, b] of this.files) if (p.startsWith(path)) total += b.byteLength;
    return total;
  }
}

/** Desktop that records reveals. */
export function fakeDesktop(result: Partial<RevealResult> = {}): Desktop & { revealed: string[] } {
  const revealed: string[] = [];
  return {
    revealed,
    hasDesktopEnvironment: () => true,
    reveal: async (path) => {
      revealed.push(path);
      return { path, exists: true, desktop: true, opened: true, ...result };
    },
  };
}

/** Live control that records calls. */
export class FakeLiveControl implements LiveControlPort {
  readonly inputs: z.output<typeof LiveInput>[] = [];
  readonly viewports: { width: number; height: number }[] = [];

  async setViewport(_sessionId: string, width: number, height: number) {
    this.viewports.push({ width, height });
    return { width, height };
  }

  async sendInput(_sessionId: string, input: z.output<typeof LiveInput>): Promise<void> {
    this.inputs.push(input);
  }
}

/** Realtime introspection with no connections. */
export function fakeRealtime(): RealtimeIntrospection {
  return { connections: () => [], activeScreencasts: () => 0, hasViewers: () => false };
}

/** Idempotency in a map. */
export function fakeIdempotency(): IdempotencyStore & { rows: Map<string, IdempotencyRecord> } {
  const rows = new Map<string, IdempotencyRecord>();
  return {
    rows,
    get: async (key, principalId, route) => rows.get(`${principalId}:${route}:${key}`) ?? null,
    put: async (record) => {
      const k = `${record.principalId}:${record.route}:${record.key}`;
      if (rows.has(k)) return false;
      rows.set(k, record);
      return true;
    },
  };
}
