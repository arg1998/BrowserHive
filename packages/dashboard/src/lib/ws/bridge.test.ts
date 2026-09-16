/** @module lib/ws/bridge.test — each event patches the intended keys; unclean patches invalidate (spec 04 §14) */

import { describe, expect, it } from 'bun:test';
import type { Notification, OperatorRequestRow, SessionSummary } from '@browserhive/contracts/http';
import type { WsFeedEvent } from '@browserhive/contracts/ws';
import { QueryClient } from '@tanstack/react-query';
import { keys } from '../api/keys.ts';
import { applyFeedEvent, canPrepend, canPrependWindowed, timelineItemKey } from './bridge.ts';

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    session_id: id,
    slug: id,
    state: 'live',
    live: true,
    archived_at: null,
    closed_at: null,
    closed_reason: null,
    has_live_viewers: false,
    counts: { tool_calls: 0, errors: 0, pages: 0, blocked: 0, attention_open: 0, vault_access: 0 },
    ...extra,
  }) as unknown as SessionSummary;
const page = (data: unknown[], total?: number) => ({
  data,
  page: { next_cursor: null, limit: 25, ...(total !== undefined && { total }) },
  applied: { filters: {}, sort: { key: 'created_at', dir: 'desc' } },
  meta: { now: 1 },
});

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('bridge', () => {
  it('decides when a list can take a prepend', () => {
    expect(canPrepend({}, ['created'])).toBe(true);
    expect(canPrepend({ page: 1, ps: 50, dir: 'desc', sort: 'created' }, ['created'])).toBe(true);
    expect(canPrepend({ page: 2 }, ['created'])).toBe(false);
    expect(canPrepend({ view: 'closed' }, ['created'])).toBe(false);
    expect(canPrepend({ sort: 'slug' }, ['created'])).toBe(false);
  });

  it('upserts session rows: replace in place, prepend on clean first pages, invalidate filtered lists', () => {
    const qc = client();
    const clean = keys.sessions.list({});
    const filtered = keys.sessions.list({ view: 'closed' });
    qc.setQueryData(clean, page([session('a')], 1));
    qc.setQueryData(filtered, page([], 0));
    qc.setQueryData(keys.sessions.detail('a'), {
      session: session('a'),
      counts: session('a').counts,
      now: 1,
    });
    applyFeedEvent(
      qc,
      {
        type: 'session.updated',
        session: session('a', { current_url: 'https://x' } as Partial<SessionSummary>),
      } as WsFeedEvent,
      'sessions',
    );
    expect((qc.getQueryData(clean) as { data: SessionSummary[] }).data[0]?.current_url).toBe(
      'https://x',
    );
    expect(
      (qc.getQueryData(keys.sessions.detail('a')) as { session: SessionSummary }).session
        .current_url,
    ).toBe('https://x');
    applyFeedEvent(
      qc,
      { type: 'session.opened', session: session('b') } as WsFeedEvent,
      'sessions',
    );
    const list = qc.getQueryData(clean) as { data: SessionSummary[]; page: { total: number } };
    expect(list.data.map((s) => String(s.session_id))).toEqual(['b', 'a']);
    expect(list.page.total).toBe(2);
    expect(qc.getQueryState(filtered)?.isInvalidated).toBe(true);
  });

  it('closes and removes sessions', () => {
    const qc = client();
    const key = keys.sessions.list({});
    qc.setQueryData(key, page([session('a'), session('b')], 2));
    applyFeedEvent(
      qc,
      { type: 'session.closed', session_id: 'a', closed_at: 9, reason: 'crash' } as WsFeedEvent,
      'sessions',
    );
    const closed = (qc.getQueryData(key) as { data: SessionSummary[] }).data[0];
    expect(closed).toMatchObject({
      state: 'closed',
      live: false,
      closed_at: 9,
      closed_reason: 'crash',
    });
    applyFeedEvent(
      qc,
      { type: 'session.removed', session_id: 'b', action: 'deleted', at: 10 } as WsFeedEvent,
      'sessions',
    );
    const after = qc.getQueryData(key) as { data: SessionSummary[]; page: { total: number } };
    expect(after.data.length).toBe(1);
    expect(after.page.total).toBe(1);
  });

  it('prepends tool calls to the all/tool timelines, bumps counts and patches the activity bucket', () => {
    const qc = client();
    const all = keys.sessions.timeline('a', 'all', {});
    const tool = keys.sessions.timeline('a', 'tool', { page: 2 });
    const pages = keys.sessions.timeline('a', 'page', {});
    qc.setQueryData(all, page([]));
    qc.setQueryData(tool, page([]));
    qc.setQueryData(pages, page([]));
    qc.setQueryData(keys.sessions.detail('a'), {
      session: session('a'),
      counts: session('a').counts,
      now: 1,
    });
    qc.setQueryData(keys.overview.activity({ range: '7d' }), {
      buckets: [
        { ts: 0, tool_calls: 1, errors: 0 },
        { ts: 100, tool_calls: 0, errors: 0 },
      ],
      window: { since: 0, until: 200, bucket_ms: 100 },
    });
    const row = { event_id: 'e', session_id: 'a', tool: 'navigate', ok: false, ts: 150 };
    expect(
      applyFeedEvent(
        qc,
        { type: 'tool.called', row, has_detail: true } as unknown as WsFeedEvent,
        'session:a',
      ),
    ).toBe(true);
    expect((qc.getQueryData(all) as { data: unknown[] }).data.length).toBe(1);
    expect(qc.getQueryState(tool)?.isInvalidated).toBe(true);
    expect((qc.getQueryData(pages) as { data: unknown[] }).data.length).toBe(0);
    const detail = qc.getQueryData(keys.sessions.detail('a')) as {
      counts: { tool_calls: number; errors: number };
    };
    expect(detail.counts).toMatchObject({ tool_calls: 1, errors: 1 });
    const activity = qc.getQueryData(keys.overview.activity({ range: '7d' })) as {
      buckets: { tool_calls: number; errors: number }[];
    };
    expect(activity.buckets[1]).toMatchObject({ tool_calls: 1, errors: 1 });
  });

  it('tracks attention open count and pending list', () => {
    const qc = client();
    qc.setQueryData(keys.attention.openCount(), 2);
    qc.setQueryData(keys.attention.pending(), page([]));
    const request = {
      request_id: 'r1',
      session_id: 'a',
      status: 'pending',
    } as unknown as OperatorRequestRow;
    applyFeedEvent(qc, { type: 'attention.created', request } as WsFeedEvent, 'attention');
    expect(qc.getQueryData<number>(keys.attention.openCount())).toBe(3);
    expect((qc.getQueryData(keys.attention.pending()) as { data: unknown[] }).data.length).toBe(1);
    applyFeedEvent(
      qc,
      { type: 'attention.resolved', request: { ...request, status: 'resolved' } } as WsFeedEvent,
      'attention',
    );
    expect(qc.getQueryData<number>(keys.attention.openCount())).toBe(2);
    expect((qc.getQueryData(keys.attention.pending()) as { data: unknown[] }).data.length).toBe(0);
  });

  it('prepends notifications and adjusts unread counts on update', () => {
    const qc = client();
    const list = keys.notifications.list({});
    qc.setQueryData(list, { ...page([]), unread_count: 0 });
    qc.setQueryData(keys.notifications.unreadCount(), 0);
    const n = {
      notification_id: 'n1',
      read_at: null,
      dismissed_at: null,
      title: 't',
    } as unknown as Notification;
    applyFeedEvent(
      qc,
      { type: 'notification.created', notification: n } as WsFeedEvent,
      'notifications',
    );
    expect(qc.getQueryData<number>(keys.notifications.unreadCount())).toBe(1);
    expect((qc.getQueryData(list) as { unread_count: number }).unread_count).toBe(1);
    applyFeedEvent(
      qc,
      { type: 'notification.updated', notification: { ...n, read_at: 5 } } as WsFeedEvent,
      'notifications',
    );
    expect(qc.getQueryData<number>(keys.notifications.unreadCount())).toBe(0);
  });

  it('upserts a growing notification group by id, moves it to the top and keeps unread counts', () => {
    const qc = client();
    const note = (id: string, updated: number, extra: Partial<Notification> = {}) =>
      ({
        notification_id: id,
        type: 'error',
        title: `${id} · 1 tool error`,
        read_at: null,
        dismissed_at: null,
        created_at: 10,
        updated_at: updated,
        count: 1,
        ...extra,
      }) as unknown as Notification;
    const bell = keys.notifications.list({ limit: 12, read: 'all' });
    const inbox = keys.notifications.list({
      limit: 25,
      total: true,
      read: 'all',
      since: 5,
      page: 1,
    });
    const unreadOnly = keys.notifications.list({ limit: 25, read: 'unread', page: 1 });
    const readOnly = keys.notifications.list({ limit: 25, read: 'read', page: 1 });
    const later = keys.notifications.list({ limit: 25, read: 'all', page: 2 });
    const rows = [note('b', 30), note('a', 20)];
    qc.setQueryData(bell, { ...page(rows), unread_count: 2 });
    qc.setQueryData(inbox, { ...page(rows, 2), unread_count: 2 });
    qc.setQueryData(unreadOnly, { ...page(rows, 2), unread_count: 2 });
    qc.setQueryData(readOnly, { ...page([], 0), unread_count: 2 });
    qc.setQueryData(later, { ...page([note('z', 1)], 3), unread_count: 2 });
    qc.setQueryData(keys.notifications.unreadCount(), 2);
    const ids = (key: readonly unknown[]) =>
      (qc.getQueryData(key) as { data: Notification[] }).data.map((n): string => n.notification_id);
    const total = (key: readonly unknown[]) =>
      (qc.getQueryData(key) as { page: { total?: number } }).page.total;
    const unread = (key: readonly unknown[]) =>
      (qc.getQueryData(key) as { unread_count: number }).unread_count;

    // The group `a` grows: one row, now first, count 2, no unread change anywhere.
    const grown = note('a', 40, { count: 2, title: 'a · 2 tool errors' } as Partial<Notification>);
    applyFeedEvent(qc, { type: 'notification.updated', notification: grown } as WsFeedEvent, 'n');
    expect(ids(bell)).toEqual(['a', 'b']);
    expect(ids(inbox)).toEqual(['a', 'b']);
    expect((qc.getQueryData(bell) as { data: Notification[] }).data[0]?.count).toBe(2);
    expect(total(inbox)).toBe(2);
    expect(unread(bell)).toBe(2);
    expect(qc.getQueryData<number>(keys.notifications.unreadCount())).toBe(2);
    expect(ids(later)).toEqual(['z']);

    // Replaying the same update (two topics, reconnect) changes nothing.
    applyFeedEvent(qc, { type: 'notification.updated', notification: grown } as WsFeedEvent, 'n');
    expect(ids(bell)).toEqual(['a', 'b']);
    expect(qc.getQueryData<number>(keys.notifications.unreadCount())).toBe(2);

    // Marked read elsewhere: stays in `all`, leaves `unread`, joins `read`; counts drop by one.
    const read = { ...grown, read_at: 50 };
    applyFeedEvent(qc, { type: 'notification.updated', notification: read } as WsFeedEvent, 'n');
    expect(ids(inbox)).toEqual(['a', 'b']);
    expect(ids(unreadOnly)).toEqual(['b']);
    expect(total(unreadOnly)).toBe(1);
    expect(ids(readOnly)).toEqual(['a']);
    expect(total(readOnly)).toBe(1);
    expect(unread(inbox)).toBe(1);
    expect(qc.getQueryData<number>(keys.notifications.unreadCount())).toBe(1);

    // An update for a group no page holds (it grew from an older page) is inserted by `updated_at`.
    const older = note('c', 35, { count: 4 } as Partial<Notification>);
    applyFeedEvent(qc, { type: 'notification.updated', notification: older } as WsFeedEvent, 'n');
    expect(ids(bell)).toEqual(['a', 'c', 'b']);
    expect(qc.getQueryData<number>(keys.notifications.unreadCount())).toBe(1);

    // A dismissed row leaves every list.
    const gone = { ...older, dismissed_at: 60 };
    applyFeedEvent(qc, { type: 'notification.updated', notification: gone } as WsFeedEvent, 'n');
    expect(ids(bell)).toEqual(['a', 'b']);
    expect(qc.getQueryData<number>(keys.notifications.unreadCount())).toBe(0);
  });

  it('ignores events without a table row', () => {
    const qc = client();
    expect(applyFeedEvent(qc, { type: 'system.tick', now: 1 } as WsFeedEvent, 'system')).toBe(
      false,
    );
    expect(
      applyFeedEvent(qc, { type: 'log.record', record: {} } as unknown as WsFeedEvent, 'logs'),
    ).toBe(false);
  });
  it('wraps timeline prepends as TimelineItem with a unique id and dedupes by id, not event id', () => {
    const qc = client();
    const all = keys.sessions.timeline('a', 'all', { limit: 100 });
    const tools = keys.sessions.timeline('a', 'page,tool', { limit: 100 });
    const pagesOnly = keys.sessions.timeline('a', 'page', { limit: 100 });
    const searched = keys.sessions.timeline('a', 'all', { q: 'login', limit: 100 });
    const detail = keys.sessions.timeline('a', 'tool-call', { event_id: 'e' });
    for (const key of [all, tools, pagesOnly, searched]) qc.setQueryData(key, page([]));
    qc.setQueryData(detail, { event_id: 'e' });
    const tool = { event_id: 'e', session_id: 'a', tool: 'navigate', ok: true, ts: 5 };
    const visit = { event_id: 'e', session_id: 'a', url: 'https://x.test/', ts: 5 };
    const toolEvent = {
      type: 'tool.called',
      row: tool,
      has_detail: true,
    } as unknown as WsFeedEvent;
    const pageEvent = { type: 'page.visited', row: visit } as unknown as WsFeedEvent;
    applyFeedEvent(qc, toolEvent, 'session:a');
    // The page visit shares the tool call's event id: it must still be added.
    applyFeedEvent(qc, pageEvent, 'session:a');
    // The same events delivered again (another topic, a replay) are not duplicated.
    applyFeedEvent(qc, toolEvent, 'sessions');
    applyFeedEvent(qc, pageEvent, 'pages');
    expect((qc.getQueryData(all) as { data: unknown[] }).data).toEqual([
      { kind: 'page', id: 'page:e', ts: 5, seq: 0, row: visit },
      { kind: 'tool', id: 'tool:e', ts: 5, seq: 0, row: tool },
    ]);
    expect(
      (qc.getQueryData(tools) as { data: { id: string }[] }).data.map((item) => item.id),
    ).toEqual(['page:e', 'tool:e']);
    expect(
      (qc.getQueryData(pagesOnly) as { data: { id: string }[] }).data.map((item) => item.id),
    ).toEqual(['page:e']);
    expect(qc.getQueryState(searched)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(detail)?.isInvalidated).toBe(false);
    expect(timelineItemKey('attention', { request_id: 'r-1' })).toBe('attention:r-1');
  });

  it('dedupes against cached items that carry no id and replaces attention rows when they resolve', () => {
    const qc = client();
    const all = keys.sessions.timeline('a', 'all', {});
    const rowWithoutId = { event_id: 'e', session_id: 'a', tool: 'click', ok: true, ts: 1 };
    qc.setQueryData(all, page([{ kind: 'tool', ts: 1, seq: 1, row: rowWithoutId }]));
    applyFeedEvent(
      qc,
      { type: 'tool.called', row: rowWithoutId, has_detail: true } as unknown as WsFeedEvent,
      'session:a',
    );
    expect((qc.getQueryData(all) as { data: unknown[] }).data).toHaveLength(1);
    const request = { request_id: 'r-1', session_id: 'a', status: 'pending', created_at: 9 };
    applyFeedEvent(
      qc,
      { type: 'attention.created', request } as unknown as WsFeedEvent,
      'attention',
    );
    applyFeedEvent(
      qc,
      { type: 'attention.created', request } as unknown as WsFeedEvent,
      'session:a',
    );
    applyFeedEvent(
      qc,
      {
        type: 'attention.resolved',
        request: { ...request, status: 'resolved' },
      } as unknown as WsFeedEvent,
      'session:a',
    );
    const items = (qc.getQueryData(all) as { data: { id?: string; row: { status?: string } }[] })
      .data;
    expect(items.map((item) => item.id)).toEqual(['attention:r-1', 'tool:e']);
    expect(items[0]?.row.status).toBe('resolved');
  });
  it('prepends page visits into windowed history, bumps domains and invalidates what the window excludes', () => {
    const qc = client();
    const row = {
      event_id: 'e-01HZX000000000000000000009',
      session_id: 'shop-a1b2c3d4',
      tab_id: 't-abc123',
      url: 'https://example.com/a',
      title: null,
      domain: 'example.com',
      category: 'public',
      ts: 5_000,
    };
    const open = keys.websites.history({
      since: 1_000,
      sort: 'ts',
      dir: 'desc',
      page: 1,
      limit: 25,
      total: true,
    });
    const closed = keys.websites.history({ since: 1_000, until: 4_000, page: 1 });
    const filtered = keys.websites.history({ since: 1_000, domain: 'other.com' });
    const domains = keys.websites.domains({ since: 1_000, limit: 5 });
    const staleDomains = keys.websites.domains({ since: 6_000, limit: 5 });
    for (const key of [open, closed, filtered]) qc.setQueryData(key, page([], 0));
    const domainData = (data: unknown[]) => ({
      data,
      window: { since: 1_000, until: null },
      now: 1,
    });
    qc.setQueryData(
      domains,
      domainData([
        { domain: 'other.com', count: 2 },
        { domain: 'example.com', count: 2 },
      ]),
    );
    qc.setQueryData(staleDomains, domainData([{ domain: 'example.com', count: 1 }]));
    qc.setQueryData(keys.websites.recent(), { data: [], now: 1 });
    applyFeedEvent(qc, { type: 'page.visited', row } as unknown as WsFeedEvent, 'pages');
    expect(qc.getQueryData<{ data: unknown[]; page: { total: number } }>(open)?.page.total).toBe(1);
    expect(qc.getQueryState(open)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(closed)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(filtered)?.isInvalidated).toBe(true);
    expect(
      qc.getQueryData<{ data: { domain: string; count: number }[] }>(domains)?.data[0],
    ).toEqual({
      domain: 'example.com',
      count: 3,
    });
    expect(qc.getQueryState(staleDomains)?.isInvalidated).toBe(true);
    expect(
      qc.getQueryData<{ data: { session_slug: null }[] }>(keys.websites.recent())?.data,
    ).toHaveLength(1);
    // A replayed event does not duplicate.
    applyFeedEvent(qc, { type: 'page.visited', row } as unknown as WsFeedEvent, 'pages');
    expect(qc.getQueryData<{ data: unknown[] }>(open)?.data).toHaveLength(1);
    expect(qc.getQueryData<{ data: unknown[] }>(keys.websites.recent())?.data).toHaveLength(1);
    expect(canPrependWindowed({ since: 1, until: 10, page: 2 }, ['ts'], 5)).toBe(false);
    expect(canPrependWindowed({ since: 1, until: 10 }, ['ts'], 10)).toBe(false);
  });
});
