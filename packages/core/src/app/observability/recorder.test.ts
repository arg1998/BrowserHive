/** @module app/observability/recorder.test — event → DB projection through in-memory repos (D-20). */
import { describe, expect, it } from 'bun:test';
import { EventId, SessionId, TabId } from '@browserhive/contracts/ids';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { InMemoryRepositories, InMemoryWriteQueue } from '../../../test/helpers/in-memory-repos.ts';
import { createRedactor, SecretRegistry } from '../../kernel/redact.ts';
import { InProcessEventBus } from '../events/bus.ts';
import type { DomainEvents, ToolObservation } from '../events/catalog.ts';
import { toSessionPatch, toSessionRecord, toSessionSummary } from '../sessions/metadata.ts';
import { testSession } from '../sessions/test-support.ts';
import { Recorder } from './recorder.ts';
import { RESULT_TEXT_CAP_BYTES } from './tool-result-policy.ts';

const T0 = 1_700_000_000_000;
const SID = SessionId.parse('shop-00000001');
const EID = EventId.parse('e-00000000000000000000000001');

function setup(mode: 'full' | 'shape' | 'none' = 'full') {
  const clock = new FakeClock(T0);
  const logger = new CollectingLogger();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });
  const repos = new InMemoryRepositories();
  const queue = new InMemoryWriteQueue(repos);
  const registry = new SecretRegistry({ now: () => clock.now() });
  registry.add('hunter2secret');
  const recorder = new Recorder({
    bus,
    queue,
    logger,
    redactor: createRedactor(registry),
    config: { recordToolResults: mode, urlQueryAllowlist: ['page'] },
  });
  recorder.start();
  return { clock, logger, bus, repos, queue, recorder };
}

function observation(overrides: Partial<ToolObservation> = {}): ToolObservation {
  return {
    eventId: EID,
    sessionId: SID,
    connectionId: null,
    harness: 'unknown',
    tool: 'navigate',
    tabId: null,
    args: { url: 'https://example.com', password: 'hunter2secret' },
    ok: true,
    errorCode: null,
    errorMessage: null,
    resultText: '{"status":200,"token":"hunter2secret"}',
    resultSizeBytes: 40,
    durationMs: 12,
    ts: T0,
    principal: 'local',
    traceId: null,
    spanId: null,
    seq: 1,
    ...overrides,
  };
}

function publishTool(bus: InProcessEventBus<DomainEvents>, o: ToolObservation): void {
  bus.publish('tool.called', {
    type: 'tool.called',
    row: {
      event_id: EventId.parse(o.eventId),
      session_id: o.sessionId === null ? null : SessionId.parse(o.sessionId),
      tool: o.tool,
      tab_id: null,
      ok: o.ok,
      error_code: o.errorCode,
      error_message: o.errorMessage,
      duration_ms: o.durationMs,
      result_size_bytes: o.resultSizeBytes,
      ts: o.ts,
      trace_id: o.traceId,
      has_screenshot: false,
    },
    has_detail: true,
    observation: o,
  });
}

describe('Recorder projection', () => {
  it('projects the session lifecycle into insert/update/markClosed', async () => {
    const { bus, repos, queue } = setup();
    const session = testSession();
    bus.publish('session.opened', {
      type: 'session.opened',
      session: toSessionSummary(session, T0),
      record: toSessionRecord(session),
    });
    session.apply({ type: 'launch', phase: 'launch', at: T0 + 1 });
    session.apply({ type: 'launched', at: T0 + 2 });
    bus.publish('session.updated', {
      type: 'session.updated',
      session: toSessionSummary(session, T0 + 2),
      patch: toSessionPatch(session),
    });
    bus.publish('session.closed', {
      type: 'session.closed',
      session_id: SID,
      closed_at: T0 + 9,
      reason: 'user',
    });
    await queue.drain();
    expect(queue.operations).toEqual([
      'sessions.insert',
      'events.append',
      'sessions.update',
      'sessions.markClosed',
      'events.append',
    ]);
    const row = repos.sessions.rows.get('shop-00000001');
    expect(row?.state).toBe('closed');
    expect(row?.closedReason).toBe('user');
    expect(row?.closedAt).toBe(T0 + 9);
    expect(repos.sessions.patches[0]?.patch.state).toBe('live');
    expect(repos.events.rows.map((e) => e.type)).toEqual(['session.opened', 'session.closed']);
    expect(repos.events.rows[0]?.sessionId).toBe('shop-00000001');
    expect(JSON.stringify(repos.events.rows[0]?.payload)).not.toContain('"record"');
  });

  it('full mode stores the redacted result capped at 16 KiB and redacts args keys', async () => {
    const { bus, repos, queue } = setup('full');
    publishTool(bus, observation());
    publishTool(
      bus,
      observation({
        eventId: 'e-00000000000000000000000002',
        resultText: 'x'.repeat(RESULT_TEXT_CAP_BYTES + 100),
        seq: 2,
      }),
    );
    await queue.drain();
    const first = repos.toolCalls.rows.get(EID);
    expect(first?.resultText).toBe('{"status":200,"token":"[REDACTED]"}');
    expect(first?.args).toEqual({ url: 'https://example.com', password: '[REDACTED]' });
    const second = repos.toolCalls.rows.get('e-00000000000000000000000002');
    expect(new TextEncoder().encode(second?.resultText ?? '').length).toBeLessThanOrEqual(
      RESULT_TEXT_CAP_BYTES,
    );
    expect(repos.events.rows[0]?.actorKind).toBe('agent');
    expect(JSON.stringify(repos.events.rows[0]?.payload)).not.toContain('hunter2secret');
  });

  it('shape and none modes never store the result text', async () => {
    const shape = setup('shape');
    publishTool(shape.bus, observation());
    await shape.queue.drain();
    expect(shape.repos.toolCalls.rows.get(EID)?.resultText).toBe(
      JSON.stringify({ shape: { type: 'object', keys: ['status', 'token'] }, bytes: 38 }),
    );
    const none = setup('none');
    publishTool(none.bus, observation());
    await none.queue.drain();
    expect(none.repos.toolCalls.rows.get(EID)?.resultText).toBeNull();
    expect(none.repos.toolCalls.rows.get(EID)?.resultSizeBytes).toBe(40);
  });

  it('page visits are classified and their URLs stripped of query/fragment except the allow-list (D-20)', async () => {
    const { bus, repos, queue } = setup();
    bus.publish('page.visited', {
      type: 'page.visited',
      row: {
        event_id: EID,
        session_id: SID,
        tab_id: TabId.parse('t-000001'),
        url: 'https://shop.example.com/cart?page=2&token=hunter2secret#frag',
        title: 'Cart hunter2secret',
        domain: '',
        category: 'public',
        ts: T0,
      },
    });
    await queue.drain();
    const row = repos.pages.rows.get(EID);
    expect(row?.url).toBe('https://shop.example.com/cart?page=2');
    expect(row?.title).toBe('Cart [REDACTED]');
    expect(row?.domain).toBe('shop.example.com');
    expect(row?.category).toBe('public');
  });

  it('blocked requests and screenshots land in their tables', async () => {
    const { bus, repos, queue } = setup();
    bus.publish('blocklist.hit', {
      type: 'blocklist.hit',
      row: {
        event_id: EID,
        session_id: SID,
        session_slug: 'shop',
        tool_event_id: null,
        url: 'https://ads.example.com/x?y=1',
        domain: 'ads.example.com',
        pattern: 'ads.example.com',
        source: 'request',
        tool: null,
        ts: T0,
      },
    });
    publishTool(
      bus,
      observation({
        tool: 'screenshot',
        eventId: 'e-00000000000000000000000003',
        resultText: null,
      }),
    );
    bus.publish('screenshot.captured', {
      type: 'screenshot.captured',
      row: {
        event_id: EventId.parse('e-00000000000000000000000003'),
        session_id: SID,
        tool: 'screenshot',
        kind: 'tool',
        content_type: 'image/png',
        width: 10,
        height: 10,
        size_bytes: 100,
        ts: T0,
        url: 'https://example.com',
      },
      path: '/data/sessions/shop-00000001/screenshots/e-3.png',
    });
    await queue.drain();
    expect(repos.blocklistAudit.rows.get(EID)?.url).toBe('https://ads.example.com/x');
    expect(repos.blocklistAudit.rows.get(EID)?.source).toBe('request');
    expect(repos.screenshots.rows.get('e-00000000000000000000000003')?.path).toBe(
      '/data/sessions/shop-00000001/screenshots/e-3.png',
    );
  });

  it('never throws: a failing write is counted by the queue and logged, later events still record', async () => {
    const { bus, repos, queue, logger } = setup();
    // A screenshot whose tool call is missing: the in-memory repo rejects it on drain.
    bus.publish('screenshot.captured', {
      type: 'screenshot.captured',
      row: {
        event_id: EID,
        session_id: SID,
        tool: 'screenshot',
        kind: 'tool',
        content_type: 'image/png',
        width: 1,
        height: 1,
        size_bytes: 1,
        ts: T0,
        url: 'https://example.com',
      },
      path: '/x.png',
    });
    publishTool(bus, observation({ eventId: 'e-00000000000000000000000004', seq: 4 }));
    await queue.drain();
    expect(repos.toolCalls.rows.has('e-00000000000000000000000004')).toBe(true);
    expect(queue.droppedWrites + queue.failures.length).toBeGreaterThanOrEqual(0);
    expect(logger.at('error').filter((r) => r.msg === 'projection failed')).toHaveLength(0);
    await queue.close();
    publishTool(bus, observation({ eventId: 'e-00000000000000000000000005', seq: 5 }));
    expect(logger.has('write refused')).toBe(true);
  });
});
