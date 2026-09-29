/** @module app/notifications/routing.test — channel rules, quiet hours across time zones and DST, TTL deadlines and the outbox rows planned per change (D-34, D-35). */

import { describe, expect, it } from 'bun:test';
import type { NotificationMessage } from '@browserhive/contracts/notifications';
import { capabilities, channelRecord } from '../../../test/helpers/fake-channel.ts';
import { buildMessage } from './message.ts';
import {
  deleteWhenResolved,
  expiryFor,
  inQuietHours,
  localMinutes,
  planDeliveries,
  type RoutableChannel,
  route,
} from './routing.ts';

const NOW = Date.UTC(2026, 8, 27, 12, 0); // 12:00 UTC

function message(overrides: Partial<Parameters<typeof buildMessage>[0]> = {}): NotificationMessage {
  return buildMessage({
    id: 'n-000000000001',
    revision: 1,
    thread: 'tool-errors:shop-a1b2c3d4',
    kind: 'tool.errors',
    severity: 'warn',
    state: 'open',
    alert: true,
    createdAt: NOW,
    updatedAt: NOW,
    title: 'shop · 1 tool error',
    summary: 'navigate · X',
    blocks: [],
    actions: [],
    entities: { session_id: 'shop-a1b2c3d4', session_slug: 'shop', harness: 'claude-code' },
    ...overrides,
  });
}

describe('route', () => {
  const cases: ReadonlyArray<
    readonly [string, Parameters<typeof route>[0], NotificationMessage, ReturnType<typeof route>]
  > = [
    ['no rules delivers everything', {}, message(), { deliver: true }],
    ['category allowed', { categories: ['problems'] }, message(), { deliver: true }],
    [
      'category filtered',
      { categories: ['needs-you'] },
      message(),
      { deliver: false, reason: 'filtered' },
    ],
    [
      'below minimum severity',
      { min_severity: 'error' },
      message(),
      { deliver: false, reason: 'filtered' },
    ],
    ['at minimum severity', { min_severity: 'warn' }, message(), { deliver: true }],
    ['session glob matches', { sessions: ['sh*'] }, message(), { deliver: true }],
    [
      'session glob misses',
      { sessions: ['checkout-*'] },
      message(),
      { deliver: false, reason: 'filtered' },
    ],
    [
      'session filter drops session-less notifications',
      { sessions: ['*'] },
      message({ entities: {} }),
      { deliver: false, reason: 'filtered' },
    ],
    ['harness allowed', { harness: ['claude-code'] }, message(), { deliver: true }],
    ['harness filtered', { harness: ['codex'] }, message(), { deliver: false, reason: 'filtered' }],
    [
      'quiet hours hold an alert',
      { quiet_hours: { start: '11:00', end: '13:00', time_zone: 'UTC' } },
      message(),
      { deliver: false, reason: 'quiet_hours' },
    ],
    [
      'quiet hours never hold a silent edit',
      { quiet_hours: { start: '11:00', end: '13:00', time_zone: 'UTC' } },
      message({ alert: false, revision: 2 }),
      { deliver: true },
    ],
    [
      'critical bypasses quiet hours',
      { quiet_hours: { start: '11:00', end: '13:00', time_zone: 'UTC' } },
      message({ severity: 'critical' }),
      { deliver: true },
    ],
    [
      'outside quiet hours',
      { quiet_hours: { start: '22:00', end: '07:00', time_zone: 'UTC' } },
      message(),
      { deliver: true },
    ],
  ];
  for (const [name, rules, m, expected] of cases) {
    it(name, () => expect(route(rules, m, NOW)).toEqual(expected));
  }
});

describe('quiet hours', () => {
  it('reads the wall clock of the channel time zone', () => {
    expect(localMinutes(NOW, 'UTC')).toBe(12 * 60);
    expect(localMinutes(NOW, 'Asia/Tokyo')).toBe(21 * 60);
    expect(localMinutes(NOW, 'America/New_York')).toBe(8 * 60); // EDT in September
  });

  it('spans midnight when start is after end, and an empty window is never quiet', () => {
    const night = { start: '22:00', end: '07:00', time_zone: 'UTC' };
    expect(inQuietHours(Date.UTC(2026, 0, 1, 23, 30), night)).toBe(true);
    expect(inQuietHours(Date.UTC(2026, 0, 1, 6, 59), night)).toBe(true);
    expect(inQuietHours(Date.UTC(2026, 0, 1, 7, 0), night)).toBe(false);
    expect(inQuietHours(NOW, { start: '12:00', end: '12:00', time_zone: 'UTC' })).toBe(false);
  });

  it('follows daylight saving time', () => {
    const early = { start: '07:00', end: '08:00', time_zone: 'America/New_York' };
    // 12:30 UTC is 07:30 EST in January and 08:30 EDT in July.
    expect(inQuietHours(Date.UTC(2026, 0, 15, 12, 30), early)).toBe(true);
    expect(inQuietHours(Date.UTC(2026, 6, 15, 12, 30), early)).toBe(false);
    // The DST switch day: 2026-03-08 06:30 UTC is 01:30 EST; 07:30 UTC is 03:30 EDT.
    const night = { start: '01:00', end: '03:00', time_zone: 'America/New_York' };
    expect(inQuietHours(Date.UTC(2026, 2, 8, 6, 30), night)).toBe(true);
    expect(inQuietHours(Date.UTC(2026, 2, 8, 7, 30), night)).toBe(false);
  });

  it('an unknown time zone falls back to the host zone instead of throwing', () => {
    expect(() =>
      inQuietHours(NOW, { start: '00:00', end: '23:59', time_zone: 'Mars/Olympus' }),
    ).not.toThrow();
  });
});

describe('TTL', () => {
  it('is never by default and per category when set', () => {
    expect(expiryFor({}, message(), 100)).toBeNull();
    expect(expiryFor({ ttl_ms: { problems: 60_000 } }, message(), 100)).toBe(60_100);
    expect(expiryFor({ ttl_ms: { 'needs-you': 60_000 } }, message(), 100)).toBeNull();
  });

  it('deletes resolved messages only when the category opts in', () => {
    const resolved = message({ state: 'resolved' });
    expect(deleteWhenResolved({}, resolved)).toBe(false);
    expect(deleteWhenResolved({ delete_when_resolved: { problems: true } }, resolved)).toBe(true);
    expect(deleteWhenResolved({ delete_when_resolved: { problems: true } }, message())).toBe(false);
  });
});

describe('planDeliveries', () => {
  const editable: RoutableChannel = { record: channelRecord(), capabilities: capabilities() };

  it('plans nothing without channels and nothing for in-app-only kinds', () => {
    expect(planDeliveries(message(), [], NOW)).toEqual([]);
    expect(planDeliveries(message({ kind: 'channel.broken' }), [editable], NOW)).toEqual([]);
  });

  it('sends the first revision and edits later ones', () => {
    expect(planDeliveries(message(), [editable], NOW)).toEqual([
      {
        channelId: 'nc-000000000001',
        notificationId: 'n-000000000001',
        revision: 1,
        op: 'send',
        status: 'pending',
        reason: null,
        nextAttemptAt: NOW,
        createdAt: NOW,
      },
    ]);
    expect(
      planDeliveries(message({ revision: 3, alert: false }), [editable], NOW)[0],
    ).toMatchObject({
      op: 'edit',
      status: 'pending',
      revision: 3,
    });
  });

  it('logs suppressed rows with their reason', () => {
    const rows = planDeliveries(
      message(),
      [
        {
          record: channelRecord({ channelId: 'nc-paused', status: 'paused' }),
          capabilities: capabilities(),
        },
        {
          record: channelRecord({ channelId: 'nc-broken', status: 'broken' }),
          capabilities: capabilities(),
        },
        { record: channelRecord({ channelId: 'nc-noadapter' }), capabilities: null },
        {
          record: channelRecord({ channelId: 'nc-filtered', rules: { categories: ['reports'] } }),
          capabilities: capabilities(),
        },
      ],
      NOW,
    );
    expect(rows.map((r) => [r.channelId, r.status, r.reason])).toEqual([
      ['nc-paused', 'suppressed', 'channel_paused'],
      ['nc-broken', 'suppressed', 'channel_paused'],
      ['nc-noadapter', 'suppressed', 'no_adapter'],
      ['nc-filtered', 'suppressed', 'filtered'],
    ]);
  });

  it('on a platform that cannot edit, alerts become new sends and silent revisions are suppressed', () => {
    const plain: RoutableChannel = {
      record: channelRecord(),
      capabilities: capabilities({ edit: false }),
    };
    expect(planDeliveries(message({ revision: 2, alert: false }), [plain], NOW)[0]).toMatchObject({
      op: 'edit',
      status: 'suppressed',
      reason: 'edit_unsupported',
    });
    expect(planDeliveries(message({ revision: 2, alert: true }), [plain], NOW)[0]).toMatchObject({
      op: 'send',
      status: 'pending',
    });
  });
});
