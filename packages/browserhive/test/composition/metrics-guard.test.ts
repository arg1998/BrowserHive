/**
 * @module test/composition/metrics-guard.test — documented == defined == recorded (spec 10 §7, spec
 * 09 §3.2). The metric tables of spec 10 §7 and `docs/guide/telemetry.md` must match the instrument
 * catalogue row for row (name, type, unit, attributes); then every source the composition root
 * wires is driven for real (the bus consumers, the write queue on SQLite, the realtime hub, the
 * browser-memory sampler over a real process tree, the event-loop monitor, and the notification
 * outbox, act buttons and report scheduler built by `buildOps` with the counters `build-domain`
 * passes) and every instrument must reach a real OTLP/HTTP receiver with the documented type, unit
 * and attribute keys. A metric documented or defined but never recorded fails here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHANNEL_RENDERERS, channelFactories } from '@browserhive/core/notifications';
import {
  openDatabase,
  SqliteAnalyticsQueries,
  SqliteMaintenanceService,
  SqliteUnitOfWork,
  SqliteWriteQueue,
} from '@browserhive/core/persistence';
import {
  createNanoidIdGenerator,
  createProcessTreeReader,
  createRedactor,
  createSystemClock,
  createTelemetry,
  DB_WRITE_TABLES,
  DegradationService,
  type DomainEvents,
  type Logger,
  METRIC_DEFINITIONS,
  type MetricDefinition,
  type MetricName,
  RetentionScheduler,
  retentionPolicyFromConfig,
  type Telemetry,
} from '@browserhive/core/runtime';
import { createRealtimeHub, InProcessEventBus, type Realtime } from '@browserhive/core/server';
import { startBrowserMemorySampler } from '../../src/composition/adapters/browser-memory.ts';
import {
  notificationCounters,
  realtimeMetrics,
  wireMetrics,
} from '../../src/composition/adapters/metrics.ts';
import { buildOps, type OpsParts } from '../../src/composition/phases/domain-ops.ts';
import { resolvedFor } from './support.ts';

const ROOT = resolve(import.meta.dir, '../../../..');

// ------------------------------------------------------------------------------------------------
// The documented tables
// ------------------------------------------------------------------------------------------------

interface DocumentedMetric {
  readonly name: string;
  readonly kind: string;
  readonly observable: boolean;
  readonly unit: string;
  readonly attributes: readonly string[];
}

const withoutParentheses = (cell: string) => cell.replace(/\([^)]*\)/g, '');
const ticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');

/** The rows of the metric table between `start` and `end` in a Markdown file. */
function metricTable(file: string, start: string, end: string): DocumentedMetric[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`${file}: cannot find the metric table`);
  return text
    .slice(from, to)
    .split('\n')
    .filter((line) => line.startsWith('| `browserhive.'))
    .map((line) => {
      const [name = '', type = '', unit = '', attributes = ''] = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      return {
        name: ticked(name)[0] ?? '',
        kind: withoutParentheses(type).trim(),
        observable: type.includes('(observable)'),
        unit: ticked(unit)[0] ?? '',
        attributes: ticked(withoutParentheses(attributes)),
      };
    });
}

const SPEC = metricTable(
  'specs/10-error-handling-and-telemetry.md',
  '## 7. Metrics catalogue',
  '## 8. OpenTelemetry wiring',
);
const DOCS = metricTable('docs/guide/telemetry.md', '### Metrics', '### Logs');
const CATALOGUE = METRIC_DEFINITIONS.map((d: MetricDefinition) => ({
  name: d.name,
  kind: d.kind,
  observable: d.observable,
  unit: d.unit,
  attributes: d.attributes,
}));

describe('documented == defined', () => {
  it('spec 10 §7 lists exactly the catalogue, row for row', () => {
    expect(SPEC).toEqual(CATALOGUE);
  });

  it('spec 10 §7 names the recorder tables the dropped-writes counter reports from the start', () => {
    const text = readFileSync(join(ROOT, 'specs/10-error-handling-and-telemetry.md'), 'utf8');
    const row = text.split('\n').find((l) => l.startsWith('| `browserhive.db.dropped_writes`'));
    const listed = /\(the recorder table: ([^)]*)\)/.exec(row ?? '')?.[1] ?? '';
    expect(ticked(listed)).toEqual([...DB_WRITE_TABLES]);
  });

  it('the telemetry guide lists exactly the catalogue (types without the observable note)', () => {
    expect(DOCS).toEqual(CATALOGUE.map((d) => ({ ...d, observable: false })));
  });
});

// ------------------------------------------------------------------------------------------------
// A real OTLP/HTTP receiver
// ------------------------------------------------------------------------------------------------

interface OtlpAttribute {
  readonly key: string;
  readonly value: Record<string, unknown>;
}
interface OtlpPoint {
  readonly attributes?: readonly OtlpAttribute[];
  readonly asInt?: number | string;
  readonly asDouble?: number;
  readonly count?: number | string;
  readonly sum?: number;
}
interface OtlpMetric {
  readonly name: string;
  readonly unit?: string;
  readonly sum?: { readonly dataPoints: readonly OtlpPoint[]; readonly isMonotonic?: boolean };
  readonly gauge?: { readonly dataPoints: readonly OtlpPoint[] };
  readonly histogram?: { readonly dataPoints: readonly OtlpPoint[] };
}
interface OtlpBody {
  readonly resourceMetrics?: readonly {
    readonly scopeMetrics?: readonly { readonly metrics?: readonly OtlpMetric[] }[];
  }[];
}

/** What a collector would store for one instrument. */
interface Received {
  readonly kind: string;
  readonly unit: string;
  readonly points: readonly { readonly value: number; readonly attrs: Record<string, unknown> }[];
}

function receivedMetrics(bodies: readonly OtlpBody[]): Map<string, Received> {
  const out = new Map<string, Received>();
  for (const body of bodies) {
    for (const rm of body.resourceMetrics ?? []) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          const kind =
            m.histogram !== undefined
              ? 'histogram'
              : m.gauge !== undefined
                ? 'gauge'
                : m.sum?.isMonotonic === true
                  ? 'counter'
                  : 'up-down counter';
          const raw = m.histogram?.dataPoints ?? m.gauge?.dataPoints ?? m.sum?.dataPoints ?? [];
          const points = raw.map((p) => ({
            value: Number(p.asDouble ?? p.asInt ?? p.sum ?? 0),
            attrs: Object.fromEntries(
              (p.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]),
            ),
          }));
          // Cumulative temporality: the latest export holds every series.
          out.set(m.name, { kind, unit: m.unit ?? '', points });
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// The world: every source wired as the composition root wires it
// ------------------------------------------------------------------------------------------------

const quiet: Logger = {
  child: () => quiet,
  isLevelEnabled: () => false,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
} as unknown as Logger;

interface World {
  readonly bus: InProcessEventBus<DomainEvents>;
  readonly queue: SqliteWriteQueue;
  readonly realtime: Realtime;
  readonly ops: OpsParts;
  readonly retention: RetentionScheduler;
  readonly sampler: ReturnType<typeof startBrowserMemorySampler>;
  readonly channelId: string;
  readonly hooks: string[];
}

const SESSION = 'guard-00000001';

function requestRow(id: string, kind: 'attention' | 'vault_confirm', extra = {}) {
  return {
    request_id: id,
    kind,
    session_id: SESSION,
    session_slug: 'guard',
    owner: 'admin',
    reason: 'solve the captcha',
    mode: kind === 'attention' ? ('takeover' as const) : null,
    options: null,
    status: 'pending' as const,
    message: null,
    resolved_by: null,
    resolution_reason: null,
    created_at: Date.now() - 2_000,
    resolved_at: null,
    deadline_at: null,
    waited_ms: null,
    page_url: 'https://example.test/login',
    tool: 'request_attention',
    event_id: null,
    entry_name: kind === 'vault_confirm' ? 'shop' : null,
    ...extra,
  };
}

function sessionSummary(extra = {}) {
  return {
    session_id: SESSION,
    slug: 'guard',
    created_at: Date.now() - 60_000,
    harness: 'nightly-scraper',
    channel: 'chromium',
    stealth: true,
    ...extra,
  };
}

/** One source of the composition root, what it drives, and the metrics it must produce. */
interface Source {
  readonly name: string;
  readonly drives: readonly MetricName[];
  run(w: World): Promise<void>;
}

const publish = <N extends keyof DomainEvents & string>(w: World, name: N, payload: unknown) =>
  w.bus.publish(name, payload as DomainEvents[N]);

/** Table-driven: every catalogue metric must appear in exactly one `drives` list. */
const SOURCES: readonly Source[] = [
  {
    name: 'MCP dispatcher (tool.called)',
    drives: ['browserhive.tool_calls', 'browserhive.tool_call.duration'],
    async run(w) {
      const observation = (ok: boolean) => ({
        tool: ok ? 'navigate' : 'click',
        ok,
        errorCode: ok ? null : 'ELEMENT_NOT_FOUND',
        durationMs: ok ? 120 : 40,
        harness: 'claude-code',
      });
      publish(w, 'tool.called', { type: 'tool.called', observation: observation(true) });
      publish(w, 'tool.called', { type: 'tool.called', observation: observation(false) });
    },
  },
  {
    name: 'session service (session.opened / updated / closed)',
    drives: [
      'browserhive.sessions.active',
      'browserhive.session.launch.duration',
      'browserhive.session.lifetime',
    ],
    async run(w) {
      publish(w, 'session.opened', { type: 'session.opened', session: sessionSummary() });
      publish(w, 'session.updated', {
        type: 'session.updated',
        session: sessionSummary(),
        patch: { launchMs: 900 },
      });
      publish(w, 'session.closed', {
        type: 'session.closed',
        session_id: SESSION,
        closed_at: Date.now(),
        reason: 'user',
      });
    },
  },
  {
    name: 'operator-request broker (attention.*, vault.confirm.*)',
    drives: ['browserhive.attention.open', 'browserhive.attention.wait'],
    async run(w) {
      // The notification producers listen from here on, as `wire-observers` starts them.
      w.ops.notifications.start();
      publish(w, 'attention.created', {
        type: 'attention.created',
        request: requestRow('a-000000000001', 'attention'),
      });
      publish(w, 'vault.confirm.created', {
        type: 'vault.confirm.created',
        request: requestRow('v-000000000001', 'vault_confirm'),
      });
      publish(w, 'attention.resolved', {
        type: 'attention.resolved',
        request: requestRow('a-000000000001', 'attention', {
          status: 'resolved',
          resolved_at: Date.now(),
          waited_ms: 2_000,
          resolved_by: 'admin',
        }),
      });
    },
  },
  {
    name: 'vault broker and blocklist (vault.access, blocklist.hit)',
    drives: ['browserhive.vault.fills', 'browserhive.blocklist.hits'],
    async run(w) {
      publish(w, 'vault.access', { type: 'vault.access', row: { result: 'success' } });
      publish(w, 'blocklist.hit', { type: 'blocklist.hit', row: { source: 'request' } });
    },
  },
  {
    name: 'retention scheduler (retention.completed)',
    drives: ['browserhive.retention.pruned_rows'],
    async run(w) {
      await w.retention.tick();
    },
  },
  {
    name: 'write queue (SQLite)',
    drives: [
      'browserhive.db.write_queue.depth',
      'browserhive.db.dropped_writes',
      'browserhive.db.size_bytes',
    ],
    async run(w) {
      w.queue.enqueue('tool_calls.insert', async () => {
        throw new Error('constraint');
      });
      await w.queue.drain();
    },
  },
  {
    name: 'realtime hub',
    drives: [
      'browserhive.ws.connections',
      'browserhive.ws.buffered_bytes',
      'browserhive.ws.frames_dropped',
    ],
    async run(w) {
      const socket = {
        buffered: 0,
        send: () => 1,
        bufferedAmount: () => socket.buffered,
        close: () => undefined,
      };
      const principal = {
        subject: 'admin',
        kind: 'operator',
        display: 'admin',
        auth: { method: 'password-session', sessionId: 'as-1' },
        scopes: [],
        tenantId: null,
        mustChangePassword: false,
      } as unknown as Parameters<Realtime['hub']['open']>[1];
      const conn = w.realtime.hub.open(socket, principal);
      await w.realtime.hub.message(conn, JSON.stringify({ type: 'logs.tail' }));
      socket.buffered = 3 * 1024 * 1024;
      w.realtime.hub.publishLog({
        seq: 1,
        record: { ts: Date.now(), level: 'info', msg: 'x', module: 'http' },
      });
    },
  },
  {
    name: 'browser-memory sampler (process tree)',
    drives: ['browserhive.browser.rss_bytes'],
    async run(w) {
      await w.sampler.sample();
    },
  },
  {
    name: 'this process',
    drives: [
      'browserhive.process.rss_bytes',
      'browserhive.process.heap_bytes',
      'browserhive.process.event_loop_lag',
    ],
    async run() {
      await new Promise((r) => setTimeout(r, 60));
    },
  },
  {
    name: 'notification outbox (the attention request above, to a webhook channel)',
    drives: ['browserhive.notifications.deliveries'],
    async run(w) {
      await w.ops.notifications.idle();
      await w.ops.notificationOutbox.tick();
    },
  },
  {
    name: 'act buttons (a press of a token never minted)',
    drives: ['browserhive.notifications.actions'],
    async run(w) {
      await w.ops.actions.press({
        token: 'a'.repeat(11),
        origin: null,
        actor: { platform: 'ntfy', id: null, name: null },
      });
    },
  },
  {
    name: 'report scheduler (an on-demand digest)',
    drives: ['browserhive.notifications.reports'],
    async run(w) {
      const record = await w.ops.channels.channels().find((c) => c.record.channelId === w.channelId)
        ?.record;
      if (record === undefined) throw new Error('no channel');
      const built = await w.ops.reports.manualDigest(record);
      await w.ops.reports.storeManualCopy(built);
    },
  },
];

describe('documented == recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bh-metrics-guard-'));
  const bodies: OtlpBody[] = [];
  const hooks: string[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let telemetry: Telemetry | undefined;
  let received = new Map<string, Received>();
  let first = new Map<string, Received>();
  const stops: (() => unknown)[] = [];

  beforeAll(async () => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/v1/metrics') bodies.push((await request.json()) as OtlpBody);
        if (path === '/hook') hooks.push(await request.text());
        return Response.json({});
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    telemetry = await createTelemetry({
      enabled: true,
      registerGlobals: false,
      endpoint: base,
      protocol: 'http/json',
      signals: { traces: false, metrics: true, logs: false },
      metricsIntervalMs: 3_600_000,
    });
    const clock = createSystemClock();
    const ids = createNanoidIdGenerator({ clock });
    const handle = await openDatabase({
      path: join(dir, 'browserhive.db'),
      dataDir: dir,
      appVersion: '0.0.0-test',
      clock,
      logger: quiet,
    });
    stops.push(() => handle.close());
    const uow = new SqliteUnitOfWork(handle.db);
    const queue = new SqliteWriteQueue({ uow, logger: quiet });
    const analytics = new SqliteAnalyticsQueries(handle.db, uow.repos, queue);
    const maintenance = new SqliteMaintenanceService({
      handle,
      clock,
      logger: quiet,
      appVersion: '0.0.0-test',
      queue,
    });
    const bus = new InProcessEventBus<DomainEvents>({ clock, logger: quiet });
    const degradations = new DegradationService({
      repo: uow.repos.systemEvents,
      bus,
      clock,
      ids,
      logger: quiet,
    });
    const config = resolvedFor({ port: 0, dataDir: dir }).config;
    const env = { BHTEST_WEBHOOK_URL: `${base}/hook` };
    const ops = buildOps({
      // Exactly what `build-domain` passes.
      ...notificationCounters(telemetry.instruments),
      config,
      repos: uow.repos,
      queue,
      handle,
      analytics,
      maintenance,
      bus,
      clock,
      ids,
      logger: quiet,
      redactor: createRedactor(),
      degradations,
      uow,
      env,
      registerSecret: () => undefined,
      dashboardUrl: () => base,
      channelFactories: channelFactories({ images: { read: async () => null } }),
      renderers: CHANNEL_RENDERERS,
      probe: async () => ({ ok: true }) as never,
      instanceId: 'guard',
      capacity: () => ({ live: 0, max: 4 }),
    });
    const channelId = 'nc-000000guard';
    await uow.repos.notificationChannels.upsert({
      channelId,
      name: 'guard-hook',
      kind: 'webhook',
      mode: null,
      source: 'db',
      status: 'active',
      target: {},
      secretRefs: { url: 'BHTEST_WEBHOOK_URL' },
      rules: {},
      failureCount: 0,
      lastError: null,
      lastOkAt: null,
      lastFailureAt: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    await ops.channels.load([]);
    stops.push(() => ops.notifications.stop());
    // The session the operator requests and their notifications belong to.
    const now = clock.now();
    await uow.repos.sessions.insert({
      sessionId: SESSION,
      slug: 'guard',
      owner: 'admin',
      tenantId: null,
      connectionId: null,
      engine: 'chromium',
      channel: 'chromium',
      headless: true,
      incognito: false,
      persistenceMode: 'memory',
      disableEvaluate: false,
      vaultEnabled: false,
      stealth: true,
      fingerprint: false,
      humanize: false,
      identity: null,
      proxyLabel: null,
      state: 'live',
      createdAt: now - 60_000,
      launchedAt: now - 59_000,
      lastActivityAt: now,
      leaseExpiresAt: now + 600_000,
      leasePausedAt: null,
      closedAt: null,
      closedReason: null,
      archivedAt: null,
      lastUrl: null,
      launchMs: 900,
      config: { channel: 'chromium', headless: true },
      harness: null,
      sandboxed: null,
      browserVersion: null,
    });
    const retention = new RetentionScheduler({
      maintenance: {
        retentionSweep: async () => ({
          startedAt: clock.now(),
          durationMs: 1,
          prunedRows: { tool_calls: 4, pages: 0 },
          artifactsEnqueued: 0,
          bytesBefore: 0,
          bytesAfter: 0,
          failures: [],
        }),
      },
      policy: retentionPolicyFromConfig(config),
      clock,
      logger: quiet,
      degradations,
      bus,
    });
    const realtime = createRealtimeHub({
      clock,
      ids,
      logger: quiet,
      auth: { touchSession: async () => true },
      attention: { isInputPermitted: () => false },
      serverVersion: '0.0.0-test',
      epoch: 'guard',
      bus,
      sessions: { peek: () => undefined },
      pageOf: () => {
        throw new Error('no pages in the guard');
      },
      bridges: (() => {
        throw new Error('no bridges in the guard');
      }) as never,
      schedule: () => () => undefined,
      every: () => () => undefined,
    });
    // "Browsers" whose process trees are this test process and its parent: the real reader, the
    // real sampler. The second one closes before the last export.
    const browsers = [
      { id: SESSION, browserPid: async () => process.pid },
      { id: 'gone-00000001', browserPid: async () => process.ppid },
    ];
    const sampler = startBrowserMemorySampler({
      sessions: () => browsers,
      reader: createProcessTreeReader(),
      repeat: () => () => undefined,
    });
    stops.push(() => sampler.stop());
    // Exactly what `wire-observers` wires.
    stops.push(
      wireMetrics(telemetry.instruments, bus, {
        queue,
        analytics,
        realtime: () => realtimeMetrics(realtime.hub),
        browserMemory: () => sampler.latest(),
      }),
    );
    const world: World = { bus, queue, realtime, ops, retention, sampler, channelId, hooks };
    for (const source of SOURCES) await source.run(world);
    await telemetry.forceFlush();
    first = receivedMetrics(bodies);
    // A session closes; the next export no longer reports its browser. (The size gauge also
    // reports the value read at the previous collection.)
    browsers.pop();
    await sampler.sample();
    await telemetry.forceFlush();
    received = receivedMetrics(bodies);
  });

  afterAll(async () => {
    for (const stop of stops.reverse()) await stop();
    await telemetry?.shutdown();
    await server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('every catalogue metric is driven by exactly one source of the table', () => {
    const driven = SOURCES.flatMap((s) => s.drives);
    expect(new Set(driven).size).toBe(driven.length);
    expect([...driven].sort()).toEqual(METRIC_DEFINITIONS.map((d) => d.name).sort());
  });

  it('the webhook channel was really called', () => {
    expect(hooks).toHaveLength(2);
  });

  for (const d of METRIC_DEFINITIONS) {
    it(`${d.name} reaches the collector as a ${d.kind} in ${d.unit} with its documented attributes`, () => {
      const got = received.get(d.name);
      expect(got, `${d.name} was never exported`).toBeDefined();
      if (got === undefined) return;
      expect({ kind: got.kind, unit: got.unit }).toEqual({ kind: d.kind, unit: d.unit });
      expect(got.points.length).toBeGreaterThan(0);
      const keys = new Set(got.points.flatMap((p) => Object.keys(p.attrs)));
      expect([...keys].sort()).toEqual([...d.attributes].sort());
    });
  }

  it('stops reporting a gauge series that is no longer observed (a closed session)', () => {
    const sessions = (m: Map<string, Received>) =>
      (m.get('browserhive.browser.rss_bytes')?.points ?? []).map((p) => p.attrs['session_id']);
    expect(sessions(first).sort()).toEqual(['gone-00000001', SESSION]);
    expect(sessions(received)).toEqual([SESSION]);
  });

  it('carries the values of the driven sources', () => {
    const points = (name: MetricName) => received.get(name)?.points ?? [];
    expect(points('browserhive.tool_calls')).toContainEqual({
      value: 1,
      attrs: { tool: 'click', ok: false, harness: 'claude-code', error_code: 'ELEMENT_NOT_FOUND' },
    });
    expect(points('browserhive.sessions.active')).toContainEqual({
      value: 0,
      attrs: { harness: 'other' },
    });
    expect(points('browserhive.session.launch.duration')[0]?.attrs).toEqual({
      channel: 'chromium',
      stealth: true,
    });
    expect(points('browserhive.attention.open')).toContainEqual({
      value: 1,
      attrs: { kind: 'vault_confirm' },
    });
    expect(points('browserhive.retention.pruned_rows')).toEqual([
      { value: 4, attrs: { table: 'tool_calls' } },
    ]);
    expect(points('browserhive.db.dropped_writes')).toContainEqual({
      value: 1,
      attrs: { table: 'tool_calls' },
    });
    expect(points('browserhive.db.dropped_writes')).toContainEqual({
      value: 0,
      attrs: { table: 'logs' },
    });
    expect(points('browserhive.ws.connections')).toContainEqual({ value: 1, attrs: {} });
    expect(points('browserhive.ws.frames_dropped')).toContainEqual({
      value: 1,
      attrs: { channel: 'logs' },
    });
    expect(points('browserhive.browser.rss_bytes')[0]?.value).toBeGreaterThan(1024 * 1024);
    expect(points('browserhive.db.size_bytes')[0]?.value).toBeGreaterThan(0);
    // The attention request and the vault confirm, each one message to the webhook.
    expect(points('browserhive.notifications.deliveries')).toContainEqual({
      value: 2,
      attrs: { channel_kind: 'webhook', status: 'sent' },
    });
    expect(points('browserhive.notifications.actions')).toContainEqual({
      value: 1,
      attrs: { channel_kind: 'ntfy', outcome: 'unknown' },
    });
    expect(points('browserhive.notifications.reports')).toContainEqual({
      value: 1,
      attrs: { kind: 'digest.daily', outcome: 'manual' },
    });
  });
});
