/** @module app/sessions/session-service.test — ownership, cap, lease controller, crash reap, close, tabs. */
import { describe, expect, it } from 'bun:test';
import { ERROR_REGISTRY } from '@browserhive/contracts/errors';
import {
  BlockedRequestRow,
  OperatorRequestRow,
  PageRow,
  ToolCallRow,
} from '@browserhive/contracts/http';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeBrowserDriver } from '../../../test/helpers/fake-browser-driver.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { LOCAL_PRINCIPAL, type SessionPrincipal } from '../../domain/session/principal.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { InProcessEventBus } from '../events/bus.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { SessionServiceConfig } from './service-deps.ts';
import { SessionService } from './session-service.ts';
import { FakeSessionDirFs, testConfig } from './test-support.ts';

const ALICE: SessionPrincipal = { subject: 'alice' };
const BOB: SessionPrincipal = { subject: 'bob' };

function setup(config: Partial<SessionServiceConfig> = {}) {
  const clock = new FakeClock(1_700_000_000_000);
  const logger = new CollectingLogger();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });
  const closed: DomainEvents['session.closed'][] = [];
  const updated: DomainEvents['session.updated'][] = [];
  bus.subscribe('session.closed', (e) => {
    closed.push(e.payload);
  });
  bus.subscribe('session.updated', (e) => {
    updated.push(e.payload);
  });
  const driver = new FakeBrowserDriver();
  const fs = new FakeSessionDirFs();
  const service = new SessionService({
    clock,
    ids: new FakeIdGenerator(),
    logger,
    bus,
    driver,
    proxyResolver: { resolve: async (r) => r.requested },
    config: testConfig(config),
    fs,
  });
  return { clock, logger, bus, closed, updated, driver, fs, service };
}

describe('SessionService ownership and lookup', () => {
  it('SESSION_ACCESS_DENIED is byte-identical to SESSION_NOT_FOUND', async () => {
    const { service } = setup();
    const session = await service.create({ slug: 'shop' }, ALICE);
    let denied: unknown;
    try {
      service.get(session.id, BOB);
    } catch (err) {
      denied = err;
    }
    let missing: unknown;
    try {
      service.get('ghost-00000009', BOB);
    } catch (err) {
      missing = err;
    }
    expect(isAppError(denied, 'SESSION_ACCESS_DENIED')).toBe(true);
    expect(isAppError(missing, 'SESSION_NOT_FOUND')).toBe(true);
    if (isAppError(denied) && isAppError(missing)) {
      expect(denied.publicMessage).toBe(`No browser session with id '${session.id}'`);
      expect(denied.publicMessage.replace(session.id, 'X')).toBe(
        missing.publicMessage.replace('ghost-00000009', 'X'),
      );
      expect(denied.httpStatus).toBe(missing.httpStatus);
      expect(ERROR_REGISTRY.SESSION_ACCESS_DENIED.message).toBe(
        ERROR_REGISTRY.SESSION_NOT_FOUND.message,
      );
    }
    expect(service.get(session.id, ALICE)).toBe(session);
  });

  it('list is filtered to the caller; close with a foreign principal answers false', async () => {
    const { service, closed } = setup({ maxSessions: 'unbounded' });
    const a = await service.create({ slug: 'shop' }, ALICE);
    const b = await service.create({ slug: 'docs' }, BOB);
    expect(service.list(ALICE).map((s) => s.id)).toEqual([a.id]);
    expect(service.list(BOB).map((s) => s.id)).toEqual([b.id]);
    expect(service.listAll()).toHaveLength(2);
    expect(await service.close(a.id, 'user', { principal: BOB })).toBe(false);
    expect(await service.close('ghost-00000001', 'user', { principal: BOB })).toBe(false);
    expect(await service.close(a.id, 'user', { principal: ALICE })).toBe(true);
    expect(await service.close(a.id, 'user')).toBe(false);
    expect(closed.map((c) => c.reason)).toEqual(['user']);
    expect(service.registry.size).toBe(1);
  });

  it('get resets the sliding lease and stamps lastToolAt', async () => {
    const { service, clock } = setup();
    const session = await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    const seeded = session.lease.expiresAt;
    await clock.advance(60_000);
    service.get(session.id, LOCAL_PRINCIPAL);
    expect(session.lease.expiresAt).toBe(seeded + 60_000);
    expect(session.lastToolAt).toBe(clock.now());
  });

  it('respects the session cap with a typed retryable error', async () => {
    const { service } = setup({ maxSessions: 1 });
    await service.create({ slug: 'aa' }, LOCAL_PRINCIPAL);
    let caught: unknown;
    try {
      await service.create({ slug: 'bb' }, LOCAL_PRINCIPAL);
    } catch (err) {
      caught = err;
    }
    expect(isAppError(caught, 'SESSION_LIMIT_REACHED')).toBe(true);
    if (isAppError(caught, 'SESSION_LIMIT_REACHED')) {
      expect(caught.details).toEqual({ limit: 1, live: 1 });
      expect(caught.retryable).toBe('backoff');
    }
    expect(service.serverStatus()).toEqual({
      count: 1,
      limit: 1,
      driver: 'playwright',
      persistenceMode: 'memory',
    });
  });

  it('serialises concurrent creates under the cap (no overshoot)', async () => {
    const { service } = setup({ maxSessions: 2 });
    const results = await Promise.allSettled([
      service.create({ slug: 'aa' }, LOCAL_PRINCIPAL),
      service.create({ slug: 'bb' }, LOCAL_PRINCIPAL),
      service.create({ slug: 'cc' }, LOCAL_PRINCIPAL),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(service.registry.size).toBe(2);
  });
});

describe('SessionService lifecycle', () => {
  it('a crash flips the session dead, tools get SESSION_DEAD, and the session is reaped as crash', async () => {
    const { service, driver, closed } = setup();
    const session = await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    driver.handles[0]?.crash('browser disconnected');
    expect(session.dead).toBe(true);
    let caught: unknown;
    try {
      service.get(session.id, LOCAL_PRINCIPAL);
    } catch (err) {
      caught = err;
    }
    // Either still registered (SESSION_DEAD) or already reaped (SESSION_NOT_FOUND); the reap is async.
    expect(isAppError(caught)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed.map((c) => c.reason)).toEqual(['crash']);
    expect(service.registry.size).toBe(0);
    expect(service.metadata(session).current_url).toBeNull();
  });

  it('close finalizes the trace, closes the handle within the deadline and settles once', async () => {
    const { service, driver, closed, updated, fs } = setup({ trace: true });
    const session = await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    const handle = driver.handles[0];
    expect(await service.close(session.id, 'operator', { deadlineMs: 250 })).toBe(true);
    expect(handle?.tracing?.stopPaths).toEqual(['/data/sessions/shop-00000001/trace.zip']);
    expect(handle?.closes).toEqual([{ deadlineMs: 250, aborted: false }]);
    expect(session.state.kind).toBe('closed');
    expect(session.closedReason).toBe('operator');
    expect(session.handle).toBeNull();
    expect(closed).toHaveLength(1);
    expect(updated.at(-1)?.session.state).toBe('draining');
    expect(fs.ops).toContain('rm /data/sessions/shop-00000001/trace-parts');
  });

  it('closeAll drains every session with the shutdown reason', async () => {
    const { service, closed } = setup({ maxSessions: 'unbounded' });
    await service.create({ slug: 'aa' }, LOCAL_PRINCIPAL);
    await service.create({ slug: 'bb' }, LOCAL_PRINCIPAL);
    await service.closeAll('shutdown', 100);
    expect(closed.map((c) => c.reason)).toEqual(['shutdown', 'shutdown']);
    expect(service.registry.size).toBe(0);
  });

  it('LeaseController pauses/resumes the state and banks the lease; unknown ids are a no-op', async () => {
    const { service, clock, updated } = setup();
    const session = await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    const expiresAt = session.lease.expiresAt;
    await clock.advance(1000);
    service.lease.pause(session.id, clock.now());
    expect(session.state.kind).toBe('paused');
    expect(session.lease.pausedAt).toBe(clock.now());
    // Tools still work while paused, and touching does not move the deadline.
    service.get(session.id, LOCAL_PRINCIPAL);
    expect(session.lease.expiresAt).toBe(expiresAt);
    await clock.advance(50_000_000);
    expect(session.isLeaseExpired(clock.now())).toBe(false);
    service.lease.resume(session.id, clock.now());
    expect(session.state.kind).toBe('live');
    expect(session.lease.expiresAt).toBe(clock.now() + (expiresAt - (clock.now() - 50_000_000)));
    service.lease.resume(session.id, clock.now());
    service.lease.pause('ghost-00000001', clock.now());
    expect(updated.filter((u) => u.session.state === 'paused')).toHaveLength(1);
  });

  it('tabs: new tab becomes active, popups are adopted, close/switch/list behave', async () => {
    const { service, driver } = setup();
    const session = await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    const first = session.tabs.activeTabId();
    const { tabId } = await service.newTab(session);
    expect(session.tabs.activeTabId()).toBe(tabId);
    expect(driver.handles[0]?.identityPages).toHaveLength(1);
    driver.handles[0]?.fakeContext.openPopup('https://popup.example/');
    expect(session.tabs.size()).toBe(3);
    const rows = await service.listTabs(session);
    expect(rows.map((r) => r.active)).toEqual([false, true, false]);
    expect(rows[2]?.url).toBe('https://popup.example/');
    if (first !== undefined) {
      service.switchTab(session, first);
      expect(session.tabs.activeTabId()).toBe(first);
    }
    await service.closeTab(session, tabId);
    expect(session.tabs.has(tabId)).toBe(false);
    expect(() => service.page(session, tabId)).toThrow(
      `Tab '${tabId}' not found in session '${session.id}'.`,
    );
    expect(service.pages(session)).toHaveLength(2);
  });

  it('metadata reports the driver and the current url; setCurrentUrl publishes', async () => {
    const { service, driver, updated } = setup();
    driver.stealthName = 'patchright';
    driver.handleOptions = () => ({ driver: 'patchright' });
    const session = await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    expect(service.metadata(session).driver).toBe('patchright');
    const before = updated.length;
    service.setCurrentUrl(session, 'https://example.com/');
    expect(session.currentUrl).toBe('https://example.com/');
    expect(updated).toHaveLength(before + 1);
    expect(service.summary(session).state).toBe('live');
  });
});

describe('SessionService live counters', () => {
  const EID = 'e-01J00000000000000000000001';

  function toolCalled(sessionId: string, errorCode: string | null): DomainEvents['tool.called'] {
    const row = ToolCallRow.parse({
      event_id: EID,
      session_id: sessionId,
      tool: 'click',
      tab_id: null,
      ok: errorCode === null,
      error_code: errorCode,
      error_message: null,
      duration_ms: 1,
      result_size_bytes: 0,
      ts: 1,
      trace_id: null,
      has_screenshot: false,
    });
    return {
      type: 'tool.called',
      row,
      has_detail: false,
      observation: {
        eventId: EID,
        sessionId,
        connectionId: null,
        tool: 'click',
        tabId: null,
        args: {},
        ok: errorCode === null,
        errorCode,
        errorMessage: null,
        resultText: null,
        resultSizeBytes: 0,
        durationMs: 1,
        ts: 1,
        principal: 'local',
        traceId: null,
        spanId: null,
        seq: 1,
      },
    };
  }

  function request(sessionId: string, status: 'pending' | 'resolved') {
    return OperatorRequestRow.parse({
      request_id: 'a-000000000001',
      kind: 'attention',
      session_id: sessionId,
      session_slug: 'shop',
      owner: 'local',
      reason: 'captcha',
      mode: 'takeover',
      options: null,
      status,
      message: null,
      resolved_by: null,
      resolution_reason: null,
      created_at: 1,
      resolved_at: status === 'pending' ? null : 2,
      deadline_at: null,
      waited_ms: status === 'pending' ? null : 1,
      page_url: null,
      tool: 'request_attention',
      event_id: null,
      entry_name: null,
    });
  }

  it('counts tool calls, soft errors, pages, blocked and open attention, and broadcasts each change', async () => {
    const { bus, service, updated } = setup();
    const session = await service.create({ slug: 'shop' }, LOCAL_PRINCIPAL);
    const id = session.id;
    const before = updated.length;
    bus.publish('tool.called', toolCalled(id, null));
    bus.publish('tool.called', toolCalled(id, 'ELEMENT_NOT_FOUND'));
    bus.publish('tool.called', toolCalled('ghost-00000000', null));
    bus.publish('page.visited', {
      type: 'page.visited',
      row: PageRow.parse({
        event_id: EID,
        session_id: id,
        tab_id: 't-abc123',
        url: 'https://example.com/',
        title: null,
        domain: 'example.com',
        category: 'public',
        ts: 1,
      }),
    });
    bus.publish('blocklist.hit', {
      type: 'blocklist.hit',
      row: BlockedRequestRow.parse({
        event_id: EID,
        session_id: id,
        session_slug: 'shop',
        tool_event_id: null,
        url: 'https://ads.example/',
        domain: 'ads.example',
        pattern: 'ads.example',
        source: 'request',
        tool: null,
        ts: 1,
      }),
    });
    bus.publish('attention.created', {
      type: 'attention.created',
      request: request(id, 'pending'),
    });
    expect(service.summary(session).counts).toEqual({
      tool_calls: 2,
      errors: 1,
      pages: 1,
      blocked: 1,
      attention_open: 1,
      vault_access: 0,
    });
    expect(updated.at(-1)?.session.counts.attention_open).toBe(1);
    expect(updated.length - before).toBe(6);
    bus.publish('attention.resolved', {
      type: 'attention.resolved',
      request: request(id, 'resolved'),
    });
    expect(service.summary(session).counts.attention_open).toBe(0);
    expect(updated.at(-1)?.session.counts.attention_open).toBe(0);
  });
});
