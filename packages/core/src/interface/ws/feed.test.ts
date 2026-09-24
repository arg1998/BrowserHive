/** @module interface/ws/feed.test — bus → topics (incl. `vault.access` and `pages` double publication), internal keys stripped, session.updated coalescing, auth invalidation, logs. */

import { describe, expect, it } from 'bun:test';
import {
  PageRow,
  ScreenshotRow,
  SessionSummary,
  VaultAccessRow,
} from '@browserhive/contracts/http';
import { SessionId } from '@browserhive/contracts/ids';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeLogs, NOW } from '../../../test/helpers/http-fakes.ts';
import { InProcessEventBus } from '../../app/events/bus.ts';
import type { DomainEvents } from '../../app/events/catalog.ts';
import type { LogEntry } from '../http/services.ts';
import { topicsForEvent, wireFeed } from './feed.ts';
import type { FeedEvent } from './frames.ts';

function harness() {
  const clock = new FakeClock();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger: new CollectingLogger() });
  const published: { topic: string; event: FeedEvent }[] = [];
  const closed: string[] = [];
  const logs: LogEntry[] = [];
  const timers: (() => void)[] = [];
  const endedSessions: string[] = [];
  const source = new FakeLogs();
  const stop = wireFeed({
    bus,
    logger: new CollectingLogger(),
    schedule: (fn) => {
      timers.push(fn);
      return () => undefined;
    },
    logs: source,
    target: {
      publish: (topic, event) => published.push({ topic, event }),
      publishLog: (entry) => logs.push(entry),
      closeAuthSession: (id) => closed.push(id),
    },
    onSessionClosed: (id) => endedSessions.push(id),
  });
  return { bus, published, closed, logs, timers, endedSessions, source, stop };
}

const SID = SessionId.parse('shop-00000001');
const vaultRow = VaultAccessRow.parse({
  event_id: 'e-00000000000000000000000005',
  session_id: SID,
  session_slug: 'shop',
  tool_event_id: null,
  entry_name: 'work.github',
  handle: 'work.github',
  result: 'success' as const,
  reason: null,
  evaluate_enabled: false,
  page_url: 'https://github.com',
  origin_check: 'pass' as const,
  principal_id: 'agent-1',
  details: null,
  ts: NOW,
});
const pageRow = PageRow.parse({
  event_id: 'e-00000000000000000000000003',
  session_id: SID,
  tab_id: 't-000001',
  url: 'https://a/',
  title: null,
  domain: 'a',
  category: 'public' as const,
  ts: NOW,
});

describe('feed fan-out', () => {
  it('maps event types to static and session topics', () => {
    expect(topicsForEvent('vault.access', SID)).toEqual(['vault.access', `session:${SID}`]);
    expect(topicsForEvent('page.visited', SID)).toEqual(['pages', `session:${SID}`]);
    expect(topicsForEvent('session.closed', SID)).toEqual(['sessions', `session:${SID}`]);
    expect(topicsForEvent('system.tick', null)).toEqual(['system']);
  });

  it('publishes vault.access and page.visited on both their static topic and session:<id>', () => {
    const h = harness();
    h.bus.publish('vault.access', { type: 'vault.access', row: vaultRow });
    h.bus.publish('page.visited', { type: 'page.visited', row: pageRow });
    expect(h.published.map((p) => p.topic)).toEqual([
      'vault.access',
      `session:${SID}`,
      'pages',
      `session:${SID}`,
    ]);
  });

  it('strips internal payload keys before publishing', () => {
    const h = harness();
    h.bus.publish('screenshot.captured', {
      type: 'screenshot.captured',
      path: '/secret/path.png',
      row: ScreenshotRow.parse({
        event_id: 'e-00000000000000000000000001',
        session_id: SID,
        tool: 'screenshot',
        kind: 'tool',
        content_type: 'image/png',
        width: 1,
        height: 1,
        size_bytes: 1,
        ts: NOW,
        url: '/x',
      }),
    });
    expect(JSON.stringify(h.published[0]?.event)).not.toContain('/secret/path.png');
  });

  it('coalesces session.updated per session', () => {
    const h = harness();
    const summary = { session_id: SID, current_url: 'a' };
    for (const url of ['a', 'b', 'c']) {
      h.bus.publish('session.updated', {
        type: 'session.updated',
        patch: {},
        session: SessionSummary.parse({ ...fullSummary(), ...summary, current_url: url }),
      });
    }
    expect(h.published).toHaveLength(0);
    expect(h.timers).toHaveLength(1);
    h.timers[0]?.();
    expect(
      h.published.map((p) =>
        p.event.type === 'session.updated' ? p.event.session.current_url : null,
      ),
    ).toEqual(['c', 'c']);
  });

  it('closes sockets on auth.logout / auth.session_revoked and notifies live view on session.closed', () => {
    const h = harness();
    const payload = {
      eventId: 'e-01J00000000000000000000000',
      type: 'logout' as const,
      principalId: 'admin',
      ip: null,
      userAgent: null,
      details: { auth_session_id: 'as-9' },
      occurredAt: NOW,
    };
    h.bus.publish('auth.logout', payload);
    expect(h.closed).toEqual(['as-9']);
    h.bus.publish('session.closed', {
      type: 'session.closed',
      session_id: SID,
      closed_at: NOW,
      reason: 'crash',
    });
    expect(h.endedSessions).toEqual([SID]);
  });

  it('forwards ring-buffer records and stops on unsubscribe', () => {
    const h = harness();
    h.source.push({ seq: 3, record: { ts: NOW, level: 'info', msg: 'x', module: 'm' } });
    expect(h.logs).toHaveLength(1);
    h.stop();
    h.source.push({ seq: 4, record: { ts: NOW, level: 'info', msg: 'y', module: 'm' } });
    h.bus.publish('vault.access', { type: 'vault.access', row: vaultRow });
    expect(h.logs).toHaveLength(1);
    expect(h.published).toHaveLength(0);
  });
});

function fullSummary() {
  return {
    session_id: SID,
    slug: 'shop',
    owner: 'agent-1',
    tenant_id: null,
    channel: 'chromium' as const,
    engine: 'chromium' as const,
    headless: true,
    incognito: false,
    persistence_mode: 'memory' as const,
    current_url: null,
    created_at: NOW,
    last_activity_at: NOW,
    closed_at: null,
    closed_reason: null,
    archived_at: null,
    lease_expires_at: NOW,
    lease_paused_at: null,
    lease_remaining_ms: 0,
    state: 'live' as const,
    live: true,
    disable_evaluate: false,
    vault_enabled: true,
    stealth: false,
    fingerprint: false,
    humanize: false,
    stealth_recorded: false,
    identity: null,
    proxy_label: null,
    counts: { tool_calls: 0, errors: 0, pages: 0, blocked: 0, attention_open: 0, vault_access: 0 },
    has_live_viewers: false,
    harness: 'unknown',
    client: null,
  };
}
